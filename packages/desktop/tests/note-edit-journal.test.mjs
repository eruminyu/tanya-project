import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/main/notes/editing/note-edit-journal.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'es2022',
  plugins: [{ name: 'contracts-entry', setup(api) {
    api.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true }));
  } }],
});
const { NoteEditJournal, decodeNoteBytes, encodeNoteText } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const identity = { instance_id: 'note-edit-tests', mode: 'personal', principal_id: 'owner' };
const now = 1_800_000_000_000, guard = () => true;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const approval = draft => ({ draftId: draft.draftId, revision: draft.revision, payloadSha256: draft.payloadSha256 });
const succeeded = async () => ({ status: 'succeeded', error: null });
const unknown = async () => ({ status: 'unknown', error: 'note_write_unknown' });
function paths(root, owner = identity) {
  const directory = join(root, hash(JSON.stringify([owner.instance_id, owner.mode, owner.principal_id])));
  return { directory, store: join(directory, 'note-edits.json') };
}
async function fixture(t, options = {}) {
  const outer = mkdtempSync(join(tmpdir(), 'kirian-edit-journal-')), root = join(outer, 'journal');
  t.after(() => {
    assert.equal(dirname(resolve(outer)), resolve(tmpdir())); assert(basename(outer).startsWith('kirian-edit-journal-'));
    rmSync(outer, { recursive: true, force: true });
  });
  const journal = new NoteEditJournal(root, identity, { now: () => now, ...options }); await journal.initialize();
  const input = { folderId: 'vault-1', folderLabel: '테스트 금고', path: 'sub/원본.md', target: join(outer, 'vault', 'sub', '원본.md'),
    grantRevision: 2, rootIdentity: '1:22', fileIdentity: '1:33', before: Buffer.from('---\ntitle: 원본\n---\n# 전체 원문\n'),
    after: Buffer.from('---\ntitle: 변경\n---\n# 전체 변경\n'), kind: 'edit' };
  return { outer, root, journal, input, ...paths(root),
    saved: () => JSON.parse(readFileSync(paths(root).store, 'utf8')),
    async reopen() { const next = new NoteEditJournal(root, identity, { now: () => now }); await next.initialize(); return next; } };
}
function recovery(f, source, before, after = f.input.before) {
  return { ...f.input, kind: 'recovery', sourceActionId: source.draftId, before, after };
}

test('preview preserves full Markdown and durable raw backups; only exact approval invokes writer', async t => {
  const f = await fixture(t), original = Buffer.from('\ufeff---\r\ntitle: 한글 🙂\r\n---\r\n' + 'large paragraph\r\n'.repeat(2000));
  const edited = encodeNoteText(decodeNoteBytes(original).text.replace('한글', '변경'), original);
  const draft = await f.journal.create({ ...f.input, before: original, after: edited }, guard);
  assert.equal(draft.status, 'pending'); assert.equal(draft.beforeBytes, original.length);
  assert.equal(draft.beforeText, original.toString('utf8').slice(1)); assert.match(draft.encoding, /BOM.*CRLF/);
  assert.equal(existsSync(draft.target), false);
  assert.deepEqual(f.journal.original(draft.draftId), original);
  assert.equal(f.saved().records[0].before, original.toString('base64'));
  let calls = 0;
  const result = await f.journal.approve(approval(draft), guard, async input => {
    calls++; const state = f.saved();
    assert.equal(state.ledger.claims[0].state, 'running');
    assert.equal(state.records[0].before, original.toString('base64'));
    assert.equal(input.expectedSha256, hash(original)); assert.equal(input.expectedIdentity, f.input.fileIdentity);
    assert.deepEqual(input.bytes, edited); assert.equal(f.journal.hasUnresolved(f.input.folderId), true);
    input.bytes.fill(0); return { status: 'succeeded', error: null };
  });
  assert.equal(calls, 1); assert.equal(result.status, 'succeeded'); assert.equal(result.afterText, edited.toString('utf8').slice(1));
  assert.equal(f.saved().ledger.claims[0].receipt.status, 'succeeded'); assert.equal(f.journal.hasUnresolved(f.input.folderId), false);
  assert.equal((await f.reopen()).get(draft.draftId).status, 'succeeded');
});

test('concurrent duplicate approvals and restart replay cause one write', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard); let writes = 0;
  const writer = async () => { writes++; return succeeded(); };
  const results = await Promise.allSettled([f.journal.approve(approval(draft), guard, writer), f.journal.approve(approval(draft), guard, writer)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(writes, 1);
  await assert.rejects((await f.reopen()).approve(approval(draft), guard, writer), /action_already_decided/);
  assert.equal(writes, 1);
});

test('stale revision, digest, and expired approval never consume or execute a draft', async t => {
  let clock = now; const f = await fixture(t, { now: () => clock }), draft = await f.journal.create(f.input, guard);
  let calls = 0; const writer = async () => { calls++; return succeeded(); };
  await assert.rejects(f.journal.approve({ ...approval(draft), revision: 2 }, guard, writer), /stale_draft/);
  await assert.rejects(f.journal.approve({ ...approval(draft), payloadSha256: 'a'.repeat(64) }, guard, writer), /stale_draft/);
  clock = draft.expiresAt;
  await assert.rejects(f.journal.approve(approval(draft), guard, writer), /approval_expired/);
  assert.equal(calls, 0); assert.equal(f.saved().ledger.claims.length, 0); assert.equal(f.journal.get(draft.draftId).status, 'pending');
});

test('dismissal is durable and cannot masquerade as permission to write', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  await assert.rejects(f.journal.dismiss(draft.draftId, () => false), /context_changed/);
  await f.journal.dismiss(draft.draftId, guard);
  const next = await f.reopen(); assert.equal(next.get(draft.draftId).status, 'dismissed');
  await assert.rejects(next.approve(approval(draft), guard, succeeded), /action_already_decided/);
  await assert.rejects(next.dismiss(draft.draftId, guard), /action_already_decided/);
});

test('writer hash conflict is failed, retains original backup, and does not block subsequent reviewed work', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  const result = await f.journal.approve(approval(draft), guard, async () => ({ status: 'failed', error: 'note_file_changed' }));
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'note_file_changed'); assert.equal(result.canUndo, false);
  assert.equal(f.journal.hasUnresolved(f.input.folderId), false);
  assert.deepEqual(f.journal.original(draft.draftId), f.input.before);
  await f.journal.create({ ...f.input, before: Buffer.from('외부 수정\n') }, guard);
});

test('successful undo is a separate exact reviewed operation with a fresh current-file precondition', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(draft), guard, succeeded);
  const external = Buffer.from('다른 프로그램이 뒤에 추가한 원문\n');
  const undo = await f.journal.create({ ...f.input, kind: 'undo', sourceActionId: draft.draftId,
    before: external, after: f.journal.original(draft.draftId), fileIdentity: '1:44' }, guard);
  assert.equal(undo.beforeText, external.toString()); assert.equal(undo.afterText, f.input.before.toString());
  assert.equal(f.journal.get(draft.draftId).resolvedBy, null);
  await f.journal.approve(approval(undo), guard, async input => {
    assert.equal(input.expectedSha256, hash(external)); assert.equal(input.expectedIdentity, '1:44');
    assert.deepEqual(input.bytes, f.input.before); return succeeded();
  });
  const next = await f.reopen(); assert.equal(next.get(draft.draftId).resolvedBy, undo.draftId);
  assert.equal(next.get(draft.draftId).canUndo, false); assert.equal(next.get(undo.draftId).canUndo, true);
});

test('undo cannot substitute another target or arbitrary replacement bytes for its source backup', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(draft), guard, succeeded);
  const input = { ...f.input, kind: 'undo', sourceActionId: draft.draftId, before: f.input.after, after: f.input.before };
  for (const change of [{ folderId: 'other' }, { path: 'other.md' }, { target: join(f.outer, 'other.md') },
    { rootIdentity: '1:999' }, { after: Buffer.from('임의 변경') }, { kind: 'recovery' }])
    await assert.rejects(f.journal.create({ ...input, ...change }, guard), /invalid_note_recovery/);
});

for (const point of ['before_claim_persist', 'after_claim_persist']) test(`fault ${point} never calls writer and restart does not auto-execute`, async t => {
  const f = await fixture(t, { fault: at => { if (at === point) throw new Error('simulated_crash'); } });
  const draft = await f.journal.create(f.input, guard); let calls = 0;
  await assert.rejects(f.journal.approve(approval(draft), guard, async () => { calls++; return succeeded(); }), /simulated_crash/);
  assert.equal(calls, 0); assert.equal(f.journal.get(draft.draftId).status, 'unknown');
  const next = await f.reopen(); assert.equal(next.get(draft.draftId).status, point === 'before_claim_persist' ? 'pending' : 'unknown');
  if (point === 'after_claim_persist') {
    assert.equal(next.hasUnresolved(f.input.folderId), true); await assert.rejects(next.approve(approval(draft), guard, succeeded), /action_already_decided/);
    assert.equal(f.saved().ledger.claims[0].state, 'unknown');
  }
});

test('receipt persistence failure is unknown after a write, preserving backup and blocking automatic retry', async t => {
  const f = await fixture(t, { fault: point => { if (point === 'before_receipt_persist') throw new Error('disk_full'); } });
  const draft = await f.journal.create(f.input, guard); let calls = 0;
  await assert.rejects(f.journal.approve(approval(draft), guard, async () => { calls++; return succeeded(); }), /disk_full/);
  assert.equal(calls, 1); assert.equal(f.saved().ledger.claims[0].state, 'running');
  assert.equal(f.journal.get(draft.draftId).status, 'unknown'); assert.equal(f.journal.hasUnresolved(f.input.folderId), true);
  const next = await f.reopen(); assert.equal(next.get(draft.draftId).status, 'unknown');
  await assert.rejects(next.create(f.input, guard), /note_edit_unresolved/);
  const restore = await next.create(recovery(f, draft, f.input.after), guard);
  await next.approve(approval(restore), guard, succeeded);
  assert.equal(next.hasUnresolved(f.input.folderId), false); assert.equal((await f.reopen()).get(draft.draftId).resolvedBy, restore.draftId);
});

test('partial write throw persists unknown; invalid current UTF-8 is reviewable only for explicit recovery', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  const result = await f.journal.approve(approval(draft), guard, async () => { throw new Error('partial_write'); });
  assert.equal(result.status, 'unknown'); assert.equal(result.canUndo, true);
  await assert.rejects(f.journal.create({ ...f.input, before: Buffer.from([0xff, 0x80]) }, guard), /invalid_note_encoding/);
  const restore = await f.journal.create(recovery(f, draft, Buffer.from([0xff, 0x80])), guard);
  assert.equal(restore.beforeText, null); assert.equal(restore.beforeBytes, 2); assert.equal(restore.beforeSha256, hash(Buffer.from([0xff, 0x80])));
  const next = await f.reopen(); assert.equal(next.get(restore.draftId).beforeText, null);
  await next.approve(approval(restore), guard, succeeded); assert.equal(next.hasUnresolved(f.input.folderId), false);
  assert.equal(next.get(restore.draftId).canUndo, false);
});

test('unknown recovery retries retain earliest backup and successful recovery resolves sibling attempts after restart', async t => {
  const f = await fixture(t), first = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(first), guard, unknown);
  const broken = Buffer.from([0xff]);
  const second = await f.journal.create(recovery(f, first, broken), guard);
  await f.journal.approve(approval(second), guard, unknown);
  assert.deepEqual(f.journal.original(second.draftId), f.input.before); assert.equal(f.journal.get(second.draftId).canUndo, true);
  const third = await f.journal.create(recovery(f, first, Buffer.from('valid but partial')), guard);
  await f.journal.approve(approval(third), guard, unknown);
  const next = await f.reopen();
  const fourth = await next.create(recovery(f, second, broken, next.original(second.draftId)), guard);
  await next.approve(approval(fourth), guard, succeeded);
  assert.equal(next.hasUnresolved(f.input.folderId), false);
  for (const action of [first, second, third]) assert.equal(next.get(action.draftId).resolvedBy, fourth.draftId);
  assert.equal((await f.reopen()).hasUnresolved(f.input.folderId), false);
});

test('explicit recovery of unchanged original bytes resolves an uncertain claim without implicit replay', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(draft), guard, unknown);
  const restore = await f.journal.create(recovery(f, draft, f.input.before), guard);
  assert.equal(restore.beforeSha256, restore.afterSha256);
  await f.journal.approve(approval(restore), guard, succeeded); assert.equal(f.journal.hasUnresolved(f.input.folderId), false);
});

test('previously previewed normal edits and recovery attempts cannot bypass a new unresolved or resolved state', async t => {
  const f = await fixture(t), a = await f.journal.create(f.input, guard), b = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(a), guard, unknown);
  await assert.rejects(f.journal.approve(approval(b), guard, succeeded), /note_edit_unresolved/);
  const r1 = await f.journal.create(recovery(f, a, f.input.after), guard), r2 = await f.journal.create(recovery(f, a, f.input.after), guard);
  await f.journal.approve(approval(r1), guard, succeeded);
  await assert.rejects(f.journal.approve(approval(r2), guard, succeeded), /invalid_note_recovery/);
});

test('context loss while queued prevents a durable claim and writer call', async t => {
  const f = await fixture(t), a = await f.journal.create(f.input, guard), b = await f.journal.create({ ...f.input, folderId: 'vault-2' }, guard);
  let release, entered; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const active = f.journal.approve(approval(a), guard, async () => { entered(); await held; return succeeded(); });
  await started; let current = true, calls = 0;
  const queued = f.journal.approve(approval(b), () => current, async () => { calls++; return succeeded(); });
  current = false; release(); await active; await assert.rejects(queued, /context_changed/);
  assert.equal(calls, 0); assert.equal(f.saved().ledger.claims.length, 1); assert.equal(f.journal.get(b.draftId).status, 'pending');
});

test('context is rechecked after durable claim immediately before writer and produces a failed receipt', async t => {
  let current = true;
  const f = await fixture(t, { fault: point => { if (point === 'before_write') current = false; } });
  const draft = await f.journal.create(f.input, guard); let calls = 0;
  const result = await f.journal.approve(approval(draft), () => current, async () => { calls++; return succeeded(); });
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'context_changed'); assert.equal(calls, 0);
  assert.equal(f.journal.hasUnresolved(f.input.folderId), false); assert.equal((await f.reopen()).get(draft.draftId).status, 'failed');
});

test('context checked after asynchronous digest prevents stale preview registration', async t => {
  const f = await fixture(t), original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let release, entered, current = true, first = true;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(globalThis.crypto.subtle, 'digest', (...args) => {
    if (!first) return original(...args); first = false;
    return new Promise((resolve, reject) => { release = () => original(...args).then(resolve, reject); entered(); });
  });
  const pending = f.journal.create(f.input, () => current); await started; current = false; release();
  await assert.rejects(pending, /context_changed/); assert.equal(f.journal.list().length, 0); assert.equal(f.saved().records.length, 0);
});

test('captured byte inputs and returned views cannot mutate the durable review or writer payload', async t => {
  const f = await fixture(t), original = Buffer.from(f.input.before), after = Buffer.from(f.input.after);
  const pending = f.journal.create(f.input, guard); f.input.before.fill(0); f.input.after.fill(0); f.input.path = 'changed.md';
  const draft = await pending; draft.afterText = 'changed'; draft.target = 'changed';
  const binding = f.journal.binding(draft.draftId); binding.path = 'changed.md'; f.journal.original(draft.draftId).fill(0);
  const live = f.journal.get(draft.draftId); assert.equal(live.path, 'sub/원본.md'); assert.equal(live.afterText, after.toString());
  assert.deepEqual(f.journal.original(draft.draftId), original);
});

test('optimistic store revision and content digest prevent stale instance approval', async t => {
  const f = await fixture(t), other = await f.reopen(); const draft = await f.journal.create(f.input, guard);
  await assert.rejects(other.create(f.input, guard), /note_edit_store_changed/);
  const state = f.saved(); state.records[0].meta.folderLabel = 'outside change'; writeFileSync(f.store, JSON.stringify(state));
  let calls = 0;
  await assert.rejects(f.journal.approve(approval(draft), guard, async () => { calls++; return succeeded(); }), /note_edit_store_changed/);
  assert.equal(calls, 0);
});

test('store changed after claim prevents file I/O and retains uncertain disk evidence', async t => {
  const f = await fixture(t, { fault: point => {
    if (point === 'before_write') { const state = f.saved(); state.revision++; writeFileSync(f.store, JSON.stringify(state)); }
  } });
  const draft = await f.journal.create(f.input, guard); let calls = 0;
  await assert.rejects(f.journal.approve(approval(draft), guard, async () => { calls++; return succeeded(); }), /note_edit_store_changed/);
  assert.equal(calls, 0); assert.equal((await f.reopen()).get(draft.draftId).status, 'unknown');
});

for (const corrupt of [
  state => { state.records[0].before += '\n'; },
  state => { state.records[0].after = Buffer.from('tampered').toString('base64'); },
  state => { state.records[0].meta.beforeSha256 = 'a'.repeat(64); },
  state => { state.records[0].createdAt++; },
  state => { state.records[0].resolvedBy = state.records[0].draft.draft_id; },
  state => { state.ledger.identity.principal_id = 'other'; },
  state => { state.records.push(state.records[0]); },
  state => { state.records[0].extra = true; },
]) test(`corrupt persisted state fails closed: ${String(corrupt)}`, async t => {
  const f = await fixture(t); await f.journal.create(f.input, guard);
  const state = f.saved(); corrupt(state); writeFileSync(f.store, JSON.stringify(state));
  await assert.rejects(f.reopen());
});

test('unknown states and backups are isolated by personal identity', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(draft), guard, unknown);
  const other = new NoteEditJournal(f.root, { ...identity, principal_id: 'second-owner' }); await other.initialize();
  assert.deepEqual(other.list(), []); assert.equal(other.hasUnresolved(f.input.folderId), false);
  assert.throws(() => other.get(draft.draftId), /unknown_draft/);
  assert.throws(() => new NoteEditJournal(f.root, { ...identity, mode: 'public_demo' }), /local_execution_not_granted/);
  assert.throws(() => new NoteEditJournal('relative', identity), /local_execution_not_granted/);
});

test('journal rejects symlink ancestry, replaced owned directory, and hardlink store', async t => {
  const f = await fixture(t), outside = join(f.outer, 'outside'); mkdirSync(outside);
  const alias = join(f.outer, 'alias'); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new NoteEditJournal(join(alias, 'new'), identity).initialize(), /unsafe_note_edit_directory/);
  assert.equal(existsSync(join(outside, 'new')), false);
  const saved = join(f.outer, 'original-store'); renameSync(f.store, saved); linkSync(saved, f.store);
  await assert.rejects(f.reopen(), /unsafe_note_edit_store/); rmSync(f.store); renameSync(saved, f.store);
  const moved = join(f.outer, 'original-owner'); renameSync(f.directory, moved); mkdirSync(f.directory);
  await assert.rejects(f.journal.create(f.input, guard), /unsafe_note_edit_directory/);
});

test('raw UTF-8 helpers preserve BOM, uniform CRLF, mixed breaks, and reject lossy strings or oversized files', () => {
  const original = Buffer.from('\ufeff# 원본\r\n둘째 🙂\r\n');
  assert.deepEqual(encodeNoteText('# 변경\n둘째 🙂\n', original), Buffer.from('\ufeff# 변경\r\n둘째 🙂\r\n'));
  const mixed = Buffer.from('one\r\ntwo\n'); assert.match(decodeNoteBytes(mixed).encoding, /mixed/);
  assert.deepEqual(encodeNoteText('one\r\nchanged\n', mixed), Buffer.from('one\r\nchanged\n'));
  assert.throws(() => decodeNoteBytes(Buffer.from([0xff])), /invalid_note_encoding/);
  assert.throws(() => encodeNoteText('\ud800', original), /invalid_note_encoding/);
  assert.throws(() => encodeNoteText('a\0b', original), /invalid_note_encoding/);
  assert.throws(() => encodeNoteText('a'.repeat(256 * 1024 + 1), Buffer.from('')), /invalid_note_bytes/);
});

test('normal record limit reserves recovery capacity while read and pending approval remain available', async t => {
  const f = await fixture(t); let first;
  for (let i = 0; i < 48; i++) { const draft = await f.journal.create(f.input, guard); first ??= draft; }
  assert.equal(f.journal.list().length, 48);
  await assert.rejects(f.journal.create(f.input, guard), /note_edit_record_limit/);
  await f.journal.approve(approval(first), guard, unknown);
  const restore = await f.journal.create(recovery(f, first, f.input.after), guard);
  await f.journal.approve(approval(restore), guard, succeeded);
  assert.equal((await f.reopen()).list().length, 49);
});

test('capacity pruning removes only expired or dismissed unclaimed previews and preserves executed backups', async t => {
  let clock = now; const f = await fixture(t, { now: () => clock });
  const kept = await f.journal.create(f.input, guard); await f.journal.approve(approval(kept), guard, succeeded);
  for (let i = 0; i < 47; i++) await f.journal.create(f.input, guard);
  clock += 10 * 60 * 1000;
  await f.journal.create(f.input, guard);
  assert.equal(f.journal.list().length, 2); assert.deepEqual(f.journal.original(kept.draftId), f.input.before);
  assert.equal((await f.reopen()).get(kept.draftId).status, 'succeeded');
});

test('folder labels retain the same Unicode code-point limit as read synchronization', async t => {
  const f = await fixture(t), label = '🙂'.repeat(120);
  const draft = await f.journal.create({ ...f.input, folderLabel: label }, guard); assert.equal(draft.folderLabel, label);
  await assert.rejects(f.journal.create({ ...f.input, folderLabel: label + 'a' }, guard), /invalid_note_edit/);
});

test('explicit forgetting removes only complete linked history and frees capacity without losing unrelated backups', async t => {
  const f = await fixture(t), first = await f.journal.create(f.input, guard), unrelated = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(first), guard, succeeded);
  const undo = await f.journal.create({ ...f.input, kind: 'undo', sourceActionId: first.draftId, before: f.input.after, after: f.input.before }, guard);
  await f.journal.approve(approval(undo), guard, succeeded);
  await assert.rejects(f.journal.forget(first.draftId, () => false), /context_changed/);
  assert.equal(f.journal.list().length, 3);
  await f.journal.forget(undo.draftId, guard);
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.get(unrelated.draftId).status, 'pending');
  assert.deepEqual(f.journal.original(unrelated.draftId), f.input.before);
  const next = await f.reopen(); assert.equal(next.list().length, 1); assert.equal(f.saved().ledger.claims.length, 0);
  await assert.rejects(next.approve(approval(first), guard, succeeded), /unknown_draft/);
  for (let i = 0; i < 47; i++) await next.create(f.input, guard);
  await assert.rejects(next.create(f.input, guard), /note_edit_record_limit/);
  await next.forget(unrelated.draftId, guard); await next.create(f.input, guard);
});

test('forgetting refuses unknown dependency groups until an explicit recovery resolves them', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  await f.journal.approve(approval(draft), guard, unknown);
  const restore = await f.journal.create(recovery(f, draft, f.input.after), guard);
  await assert.rejects(f.journal.forget(draft.draftId, guard), /note_edit_unresolved/);
  await assert.rejects(f.journal.forget(restore.draftId, guard), /note_edit_unresolved/);
  assert.deepEqual(f.journal.original(draft.draftId), f.input.before);
  await f.journal.approve(approval(restore), guard, succeeded); await f.journal.forget(draft.draftId, guard);
  assert.equal(f.journal.list().length, 0); assert.equal((await f.reopen()).list().length, 0);
});

test('invalid writer receipts and errors never become false success evidence', async t => {
  const f = await fixture(t), draft = await f.journal.create(f.input, guard);
  const result = await f.journal.approve(approval(draft), guard, async () => ({ status: 'succeeded', error: 'oops' }));
  assert.equal(result.status, 'unknown'); assert.equal(f.journal.hasUnresolved(f.input.folderId), true);
  assert.equal((await f.reopen()).get(draft.draftId).status, 'unknown');
});
