import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { digestAction, sameIdentity } from '@kirian/contracts';

const { outputFiles } = await build({
  stdin: { contents: `export { DurableLocalExecutor } from './src/main/local-executor.ts'; export { atomicWriteJsonSync, readJsonSync } from './src/main/persistence/atomic-json.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'es2022',
  plugins: [{ name: 'contracts-entry', setup(api) {
    api.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true }));
  } }],
});
const { DurableLocalExecutor, atomicWriteJsonSync, readJsonSync } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const identity = { instance_id: 'executor-tests', mode: 'personal', principal_id: 'owner' };
const now = 1_800_000_000_000;
const approve = draft => ({ draftId: draft.draftId, revision: draft.revision, payloadSha256: draft.payloadSha256 });
const hash = value => createHash('sha256').update(value).digest('hex');
function paths(root, owner = identity) {
  const directory = join(root, hash(JSON.stringify([owner.instance_id, owner.mode, owner.principal_id])));
  return { directory, store: join(directory, 'actions.json'), notes: join(directory, 'notes') };
}
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kirian-local-executor-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('kirian-local-executor-'));
    rmSync(root, { recursive: true, force: true });
  });
  const executor = new DurableLocalExecutor(root, identity, { now: () => now, ...options });
  await executor.initialize();
  return { root, executor, ...paths(root) };
}

function holdNextDigest(t) {
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let first = true, resume, notify;
  const entered = new Promise(resolve => { notify = resolve; });
  t.mock.method(globalThis.crypto.subtle, 'digest', (...args) => {
    if (!first) return digest(...args);
    first = false;
    return new Promise((resolve, reject) => {
      resume = () => { digest(...args).then(resolve, reject); };
      notify();
    });
  });
  const release = () => { const current = resume; resume = undefined; current?.(); };
  t.after(release);
  return { entered, release };
}

test('only exact approval creates a note, with a durable claim before I/O and durable receipt after readback', async t => {
  let expected, checked = false;
  const f = await fixture(t, { fault: point => {
    if (point !== 'before_note_open') return;
    const state = readJsonSync(f.store);
    assert.equal(state.ledger.claims.length, 1);
    assert.equal(state.ledger.claims[0].state, 'running');
    assert.equal(state.records[0].draft.payload_sha256, expected.payloadSha256);
    assert.equal(existsSync(expected.target), false); checked = true;
  } });
  expected = await f.executor.createDraft({ title: '정확한 제목', body: '원문 첫 줄\n둘째 줄 🙂' });
  assert.equal(readdirSync(f.notes).length, 0);
  assert.equal(expected.status, 'pending');
  const result = await f.executor.approve(approve(expected));
  assert(checked); assert.equal(result.status, 'succeeded');
  assert.equal(readFileSync(result.target, 'utf8'), '# 정확한 제목\n\n원문 첫 줄\n둘째 줄 🙂\n');
  const saved = readJsonSync(f.store);
  assert.equal(saved.ledger.claims[0].state, 'succeeded');
  assert.equal(saved.ledger.claims[0].receipt.execution_id, result.receipt.executionId);
  assert.equal(saved.records[0].evidence.sha256, hash(readFileSync(result.target)));
  result.body = 'mutated'; result.receipt.status = 'failed';
  assert.equal(f.executor.list()[0].body, '원문 첫 줄\n둘째 줄 🙂');
  assert.equal(f.executor.list()[0].receipt.status, 'succeeded');
});

test('concurrent duplicate approval executes once and replay stays rejected after restart', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '한 번', body: '한 번만 기록' });
  const results = await Promise.allSettled([f.executor.approve(approve(draft)), f.executor.approve(approve(draft))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(readdirSync(f.notes).length, 1);
  const restored = new DurableLocalExecutor(f.root, identity, { now: () => now }); await restored.initialize();
  assert.equal(restored.list()[0].status, 'succeeded');
  await assert.rejects(restored.approve(approve(draft)), /action_already_decided/);
  assert.equal(readdirSync(f.notes).length, 1);
});

test('a crash after the durable claim recovers unknown without writing or retrying the note', async t => {
  const f = await fixture(t, { fault: point => { if (point === 'after_claim_persist') throw new Error('simulated_crash'); } });
  const draft = await f.executor.createDraft({ title: '복구', body: '실행 전 종료' });
  await assert.rejects(f.executor.approve(approve(draft)), /simulated_crash/);
  assert.equal(readJsonSync(f.store).ledger.claims[0].state, 'running');
  assert.equal(existsSync(draft.target), false);
  const restored = new DurableLocalExecutor(f.root, identity, { now: () => now }); await restored.initialize();
  assert.equal(restored.list()[0].status, 'unknown');
  assert.equal(readJsonSync(f.store).ledger.claims[0].state, 'unknown');
  assert.equal(restored.list()[0].body, '실행 전 종료');
  await assert.rejects(restored.approve(approve(draft)), /action_already_decided/);
  assert.equal(existsSync(draft.target), false);
});

test('claim-save failure blocks filesystem effects and further commands in that instance', async t => {
  const f = await fixture(t, { fault: point => { if (point === 'before_claim_persist') throw new Error('save_failed'); } });
  const draft = await f.executor.createDraft({ title: '저장 실패', body: '실행하지 않음' });
  await assert.rejects(f.executor.approve(approve(draft)), /save_failed/);
  assert.equal(existsSync(draft.target), false);
  assert.equal(readJsonSync(f.store).ledger.claims.length, 0);
  assert.equal(f.executor.list()[0].status, 'unknown');
  await assert.rejects(f.executor.approve(approve(draft)), /action_store_unavailable/);
});

test('receipt-save failure never publishes success; restart retains unknown and does not repeat the write', async t => {
  const f = await fixture(t, { fault: point => { if (point === 'before_receipt_persist') throw new Error('receipt_save_failed'); } });
  const draft = await f.executor.createDraft({ title: '불확실', body: '파일은 기록됨' });
  await assert.rejects(f.executor.approve(approve(draft)), /receipt_save_failed/);
  assert.equal(existsSync(draft.target), true);
  assert.equal(f.executor.list()[0].status, 'unknown');
  assert.equal(f.executor.list()[0].receipt, undefined);
  const bytes = readFileSync(draft.target);
  const restored = new DurableLocalExecutor(f.root, identity, { now: () => now }); await restored.initialize();
  assert.equal(restored.list()[0].status, 'unknown');
  await assert.rejects(restored.approve(approve(draft)), /action_already_decided/);
  assert.deepEqual(readFileSync(draft.target), bytes);
});

test('partial note creation is unknown while a definitive pre-write error is failed', async t => {
  for (const point of ['before_note_open', 'after_note_open', 'after_note_write']) {
    const f = await fixture(t, { fault: current => { if (current === point) throw new Error('synthetic_io_failure'); } });
    const draft = await f.executor.createDraft({ title: point, body: '실패 경계' });
    const result = await f.executor.approve(approve(draft));
    assert.equal(result.status, point === 'before_note_open' ? 'failed' : 'unknown');
    assert.equal(existsSync(draft.target), point !== 'before_note_open');
    assert.equal(readJsonSync(f.store).ledger.claims[0].state, result.status);
    await assert.rejects(f.executor.approve(approve(draft)), /action_already_decided/);
  }
});

test('stale digest, revision, expiration and dismissed drafts cannot create files', async t => {
  let clock = now;
  const f = await fixture(t, { now: () => clock }), draft = await f.executor.createDraft({ title: '검토한 제목', body: '검토한 본문' });
  await assert.rejects(f.executor.approve({ ...approve(draft), revision: 2 }), /stale_draft/);
  await assert.rejects(f.executor.approve({ ...approve(draft), payloadSha256: '0'.repeat(64) }), /stale_draft/);
  await assert.rejects(f.executor.approve({ ...approve(draft), body: '실행 내용 바꾸기' }), /invalid_approval/);
  clock = draft.expiresAt;
  await assert.rejects(f.executor.approve(approve(draft)), /approval_expired/);
  const dismissed = await f.executor.createDraft({ title: '취소', body: '작성하지 않음' });
  await f.executor.dismiss(dismissed.draftId);
  await assert.rejects(f.executor.approve(approve(dismissed)), /action_already_decided/);
  assert.equal(readdirSync(f.notes).length, 0);
  const restored = new DurableLocalExecutor(f.root, identity, { now: () => clock }); await restored.initialize();
  assert.equal(restored.list().find(item => item.draftId === dismissed.draftId).status, 'dismissed');
});

test('existing note targets are never overwritten', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '충돌', body: '새 본문' });
  writeFileSync(draft.target, 'existing data');
  const result = await f.executor.approve(approve(draft));
  assert.equal(result.status, 'failed'); assert.equal(readFileSync(draft.target, 'utf8'), 'existing data');
});

test('accounts have isolated stores and reject another account snapshot', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '비공개', body: '개인 본문' });
  const otherIdentity = { ...identity, principal_id: 'other' };
  const other = new DurableLocalExecutor(f.root, otherIdentity, { now: () => now }); await other.initialize();
  assert.deepEqual(other.list(), []);
  await assert.rejects(other.approve(approve(draft)), /unknown_draft/);
  writeFileSync(paths(f.root, otherIdentity).store, readFileSync(f.store));
  const corrupted = new DurableLocalExecutor(f.root, otherIdentity);
  await assert.rejects(corrupted.initialize(), /foreign_execution_snapshot/);
  assert.equal(existsSync(draft.target), false);
});

test('corrupt JSON and forged note paths fail closed instead of resetting history', async t => {
  const f = await fixture(t); await f.executor.createDraft({ title: '원문', body: '복구할 내용' });
  const original = readFileSync(f.store);
  writeFileSync(f.store, '{ broken');
  await assert.rejects(new DurableLocalExecutor(f.root, identity).initialize());
  assert.equal(readFileSync(f.store, 'utf8'), '{ broken');
  const forged = JSON.parse(original);
  forged.records[0].draft.action.target = '../escape.md';
  atomicWriteJsonSync(f.store, forged);
  await assert.rejects(new DurableLocalExecutor(f.root, identity).initialize(), /invalid_action_store/);
  assert.equal(existsSync(join(f.root, 'escape.md')), false);
});

test('a symlink or junction substituted for the owned notes directory cannot receive a write', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '경계', body: '외부 쓰기 금지' });
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  renameSync(f.notes, f.notes + '-original');
  symlinkSync(outside, f.notes, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.executor.approve(approve(draft)), /unsafe_action_directory/);
  assert.deepEqual(readdirSync(outside), []);
  await assert.rejects(new DurableLocalExecutor(f.root, identity).initialize(), /unsafe_action_directory/);
});

test('stale instances cannot overwrite a newer durable action ledger', async t => {
  const f = await fixture(t);
  const stale = new DurableLocalExecutor(f.root, identity, { now: () => now }); await stale.initialize();
  await f.executor.createDraft({ title: '최신', body: '보존' });
  await assert.rejects(stale.createDraft({ title: '낡은 상태', body: '덮어쓰면 안 됨' }), /action_store_changed/);
  const restored = new DurableLocalExecutor(f.root, identity, { now: () => now }); await restored.initialize();
  assert.deepEqual(restored.list().map(item => item.title), ['최신']);
});

test('a changed store with an unchanged revision blocks approval before any note write', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '검토', body: '승인 이전' });
  const changed = readJsonSync(f.store); changed.records[0].disposition = 'dismissed';
  atomicWriteJsonSync(f.store, changed);
  await assert.rejects(f.executor.approve(approve(draft)), /action_store_changed/);
  assert.equal(existsSync(draft.target), false);
  assert.equal(readJsonSync(f.store).records[0].disposition, 'dismissed');
});

test('restoration rejects receipts and evidence that do not identify the approved local note', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '증거', body: '정확한 파일' });
  await f.executor.approve(approve(draft));
  const original = readJsonSync(f.store);
  for (const mutate of [state => { state.records[0].evidence.sha256 = '0'.repeat(64); },
    state => { state.ledger.claims[0].receipt.provider_operation_id = randomUUID(); },
    state => { state.ledger.claims[0].receipt.provider_id = 'foreign-provider'; }]) {
    const state = structuredClone(original); mutate(state); atomicWriteJsonSync(f.store, state);
    await assert.rejects(new DurableLocalExecutor(f.root, identity).initialize(), /invalid_action_store/);
  }
});

test('500 retained records block new drafts without forgetting consumed execution history', async t => {
  const f = await fixture(t), completed = await f.executor.createDraft({ title: '보관', body: '상한 표본' });
  await f.executor.approve(approve(completed));
  const saved = readJsonSync(f.store), template = saved.records[0];
  saved.records = [template, ...await Promise.all(Array.from({ length: 499 }, async () => {
    const record = structuredClone(template);
    delete record.evidence;
    record.draft.draft_id = randomUUID(); record.draft.action.target = 'notes/' + randomUUID() + '.md';
    record.draft.payload_sha256 = await digestAction(record.draft.action);
    return record;
  }))];
  atomicWriteJsonSync(f.store, saved);
  const restored = new DurableLocalExecutor(f.root, identity, { now: () => now }); await restored.initialize();
  assert.equal(restored.list().length, 500);
  await assert.rejects(restored.createDraft({ title: '초과', body: '저장 안 함' }), /action_record_limit/);
  await assert.rejects(restored.approve(approve(completed)), /action_already_decided/);
  assert.equal(readJsonSync(f.store).records.length, 500);
  assert.equal(readdirSync(f.notes).length, 1);
});

test('JSON helpers preserve the previous file on serialization failure and bound reads', async t => {
  const f = await fixture(t), file = join(f.root, 'settings.json');
  assert.equal(readJsonSync(file), undefined);
  atomicWriteJsonSync(file, { value: 'old' });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => atomicWriteJsonSync(file, cycle));
  assert.deepEqual(readJsonSync(file), { value: 'old' });
  atomicWriteJsonSync(file, { value: 'new' }); assert.deepEqual(readJsonSync(file), { value: 'new' });
  assert.throws(() => readJsonSync(file, 2), /invalid_json_file/);
  writeFileSync(file, Buffer.from([0x22, 0xff, 0x22]));
  assert.throws(() => readJsonSync(file), /invalid_json_encoding/);
  assert.equal(readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
});

test('draft input limits and arbitrary properties are rejected before persistence', async t => {
  const f = await fixture(t);
  for (const input of [{ title: '', body: 'body' }, { title: 'x'.repeat(121), body: 'body' }, { title: 'title', body: 'x'.repeat(8193) },
    { title: 'title', body: 'body', target: '../escape' }, { title: 'line\nbreak', body: 'body' }, { title: 'title', body: '\ud800' }])
    assert.throws(() => f.executor.createDraft(input), /invalid_note_draft/);
  assert.deepEqual(f.executor.list(), []);
  assert.equal(readdirSync(f.notes).length, 0);
});

for (const transition of ['identity switch', 'same-identity reconnect', 'renderer replacement']) {
  test('approval queued behind an actual async draft rejects a later ' + transition + ' before claim or note I/O', async t => {
    let noteOpens = 0;
    const f = await fixture(t, { fault: point => { if (point === 'before_note_open') noteOpens++; } });
    const draft = await f.executor.createDraft({ title: '승인한 원문', body: '연결이 바뀌면 작성하지 않음' });
    let activeIdentity = structuredClone(identity), generation = 7, rendererCurrent = true;
    const capturedIdentity = structuredClone(identity), capturedGeneration = generation;
    const context = () => rendererCurrent && generation === capturedGeneration && sameIdentity(capturedIdentity, activeIdentity);
    const held = holdNextDigest(t);
    const earlier = f.executor.createDraft({ title: '앞선 작업', body: '해시 계산을 기다리는 실제 대기열' });
    await held.entered;
    const rejected = assert.rejects(f.executor.approve(approve(draft), context), /context_changed/);
    if (transition === 'identity switch') activeIdentity = { ...identity, principal_id: 'another-owner' };
    else if (transition === 'same-identity reconnect') generation++;
    else rendererCurrent = false;
    held.release(); await earlier; await rejected;
    assert.equal(noteOpens, 0);
    assert.deepEqual(readdirSync(f.notes), []);
    assert.equal(existsSync(draft.target), false);
    assert.equal(readJsonSync(f.store).ledger.claims.length, 0);
    assert.equal(f.executor.list().find(item => item.draftId === draft.draftId).status, 'pending');
  });
}

test('queued creation and dismissal do not mutate records after their context becomes invalid', async t => {
  const f = await fixture(t), draft = await f.executor.createDraft({ title: '유지할 제안', body: '닫지 않음' });
  let current = true;
  const held = holdNextDigest(t);
  const earlier = f.executor.createDraft({ title: '앞선 작업', body: '실제 async 작업' });
  await held.entered;
  const creating = assert.rejects(f.executor.createDraft({ title: '늦은 초안', body: '저장하면 안 됨' }, () => current), /context_changed/);
  const dismissing = assert.rejects(f.executor.dismiss(draft.draftId, () => current), /context_changed/);
  current = false;
  held.release(); await earlier; await Promise.all([creating, dismissing]);
  assert.deepEqual(f.executor.list().map(item => item.title), ['유지할 제안', '앞선 작업']);
  assert.equal(f.executor.list()[0].status, 'pending');
  assert.equal(readJsonSync(f.store).records[0].disposition, 'pending');
  assert.equal(readdirSync(f.notes).length, 0);
});

test('context changing during the new draft hash cannot persist that draft', async t => {
  const f = await fixture(t), before = readFileSync(f.store);
  let current = true;
  const held = holdNextDigest(t);
  const rejected = assert.rejects(f.executor.createDraft({ title: '중단할 초안', body: '연결 변경 전 입력' }, () => current), /context_changed/);
  await held.entered;
  current = false; held.release(); await rejected;
  assert.deepEqual(readFileSync(f.store), before);
  assert.deepEqual(f.executor.list(), []);
  assert.deepEqual(readdirSync(f.notes), []);
});

test('a context change after the durable claim does not interrupt synchronous I/O or discard its receipt', async t => {
  let current = true, guardCalls = 0;
  const f = await fixture(t, { fault: point => { if (point === 'after_claim_persist') current = false; } });
  const draft = await f.executor.createDraft({ title: '이미 승인됨', body: '실제 결과를 끝까지 기록' });
  const result = await f.executor.approve(approve(draft), () => { guardCalls++; return current; });
  assert.equal(guardCalls, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(readFileSync(result.target, 'utf8'), '# 이미 승인됨\n\n실제 결과를 끝까지 기록\n');
  assert.equal(readJsonSync(f.store).ledger.claims[0].receipt.execution_id, result.receipt.executionId);
});
