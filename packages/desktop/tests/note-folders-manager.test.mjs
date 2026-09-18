import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: `export { NoteFoldersManager } from './src/main/notes/note-folders-manager.ts'; export { CollectionClient } from './src/main/notes/collection-client.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'es2022',
  plugins: [{ name: 'contracts-entry', setup(api) {
    api.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true }));
  } }],
});
const { NoteFoldersManager, CollectionClient } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const identity = { instance_id: 'note-folder-tests', mode: 'personal', principal_id: 'owner' };
const ownerHash = owner => createHash('sha256').update(JSON.stringify([owner.instance_id, owner.mode, owner.principal_id])).digest('hex');
const publicCollection = record => {
  const { id, label, boundary, revision, available, source_count } = record;
  return { id, label, boundary, revision, available, source_count };
};

/** Uses the real CollectionClient. Fault hooks can fail before or after a simulated HTTP commit. */
function memoryApi() {
  const records = new Map(), calls = [], deleted = new Set();
  const backend = { records, calls, hook: undefined };
  backend.request = async (path, method = 'GET', body) => {
    const call = { path, method, body: structuredClone(body) }; calls.push(call);
    const proceed = () => {
      if (path === 'v1/collections' && method === 'GET') {
        return { collections: [...records.values()].map(publicCollection) };
      }
      const match = /^v1\/collections\/([^/?]+)(\/availability)?(?:\?revision=(\d+))?$/.exec(path);
      assert(match, `Unexpected collection request: ${method} ${path}`);
      const [, id, availability, queryRevision] = match;
      const current = records.get(id);
      if (availability && method === 'PUT') {
        if (!current) throw new Error('not_found');
        assert.deepEqual(body, { available: false });
        current.available = false;
        return { collection: publicCollection(current) };
      }
      if (method === 'PUT') {
        if (deleted.has(id)) throw new Error('collection_deleted');
        if (body.expected_revision !== (current?.revision ?? 0)) throw new Error('revision_conflict');
        const saved = { id, label: body.label, boundary: body.boundary,
          revision: body.expected_revision + 1, available: true,
          source_count: body.documents.length, documents: structuredClone(body.documents) };
        records.set(id, saved);
        return { collection: publicCollection(saved) };
      }
      if (method === 'DELETE') {
        if (!current) throw new Error('not_found');
        if (Number(queryRevision) !== current.revision) throw new Error('revision_conflict');
        records.delete(id); deleted.add(id); return { ok: true };
      }
      assert.fail(`Unexpected collection method: ${method}`);
    };
    return structuredClone(await (backend.hook ? backend.hook(call, proceed) : proceed()));
  };
  backend.client = new CollectionClient(backend.request);
  return backend;
}

async function fixture(t, { initialize = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kirian-note-folders-manager-'));
  const settings = join(root, 'settings'), approved = join(root, 'approved'), vault = join(root, 'vault');
  for (const path of [settings, approved, vault]) mkdirSync(path);
  const backend = memoryApi(), managers = [], context = { valid: true }, events = { changed: 0, imported: 0 };
  const create = (owner = identity) => {
    const manager = new NoteFoldersManager(settings, owner, approved, backend.client,
      () => { events.changed += 1; }, () => { events.imported += 1; }, () => context.valid);
    managers.push(manager); return manager;
  };
  t.after(() => {
    for (const manager of managers) manager.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('kirian-note-folders-manager-'));
    rmSync(root, { recursive: true, force: true });
  });
  const manager = create();
  const f = { root, settings, approved, vault, backend, context, events, manager, create,
    store: join(settings, 'note-folders-' + ownerHash(identity) + '.json') };
  if (initialize) await manager.initialize();
  return f;
}

const folderOf = (f, kind = 'vault') => f.manager.snapshot().folders.find(folder => folder.kind === kind);
const syncCalls = (backend, id) => backend.calls.filter(call => call.method === 'PUT' && call.path === 'v1/collections/' + id);

function holdRequest(backend, match) {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  backend.hook = async (call, proceed) => {
    if (match(call)) { entered(); await released; }
    return proceed();
  };
  return { waiting, release };
}

test('folder grants survive restart with stable IDs and policies; snapshots cannot mutate saved grants', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, '첫 노트.md'), '# 실제 노트\n처음 내용');
  assert.equal(folderOf(f, 'approved_notes').boundary, 'local');
  await f.manager.add(f.vault, 'private_lan');
  const before = f.manager.snapshot(), vault = folderOf(f);
  const exposed = f.manager.snapshot();
  exposed.folders[1].boundary = 'local'; exposed.folders[1].path = join(f.root, 'elsewhere');
  exposed.folders.splice(0, 1);
  assert.equal(folderOf(f).path, f.vault);
  assert.equal(folderOf(f).boundary, 'private_lan');
  f.manager.dispose();
  const restored = f.create(); await restored.initialize();
  assert.deepEqual(restored.snapshot().folders.map(({ id, path, boundary, kind }) => ({ id, path, boundary, kind })),
    before.folders.map(({ id, path, boundary, kind }) => ({ id, path, boundary, kind })));
  assert.equal(restored.snapshot().folders.find(folder => folder.id === vault.id).documentCount, 1);
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.find(folder => folder.id === vault.id).boundary, 'private_lan');
});

test('an unchanged scan avoids import and PUT, while skipped attachment counts remain visible', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '원본 노트');
  writeFileSync(join(f.vault, 'image.png'), 'attachment');
  await f.manager.add(f.vault, 'local');
  const folder = folderOf(f), beforeCalls = syncCalls(f.backend, folder.id).length, imported = f.events.imported;
  assert.equal(folder.skipped, 1);
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(syncCalls(f.backend, folder.id).length, beforeCalls);
  assert.equal(f.events.imported, imported);
  assert.equal(folderOf(f).phase, 'ready');
  assert.equal(folderOf(f).documentCount, 1);
  assert.equal(folderOf(f).sourceCount, 1);
});

test('an external revision change restores the authoritative local snapshot even when local files are unchanged', async t => {
  const f = await fixture(t);
  const note = join(f.vault, 'note.md'), original = '선택한 폴더의 원문';
  writeFileSync(note, original); await f.manager.add(f.vault, 'local');
  const folder = folderOf(f), initial = f.backend.records.get(folder.id);
  // A different client changes content while retaining the label, policy and availability.
  const otherClient = new CollectionClient(f.backend.request);
  const external = await otherClient.sync(folder, initial.revision,
    [{ path: 'note.md', title: 'note', text: '다른 클라이언트가 변경한 내용' }]);
  const writes = syncCalls(f.backend, folder.id).length, imported = f.events.imported;
  assert.equal(f.backend.records.get(folder.id).documents[0].text, '다른 클라이언트가 변경한 내용');
  assert.equal(await f.manager.sync(folder.id), true);
  const restored = f.backend.records.get(folder.id);
  assert.equal(restored.revision, external.revision + 1);
  assert.deepEqual(restored.documents, [{ path: 'note.md', title: 'note', text: original }]);
  assert.equal(syncCalls(f.backend, folder.id).length, writes + 1);
  assert.equal(f.events.imported, imported + 1);
  assert.equal(readFileSync(note, 'utf8'), original);
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(syncCalls(f.backend, folder.id).length, writes + 1,
    'the acknowledged restored revision should become an unchanged scan again');
});

test('modified and deleted Markdown is replaced as a complete snapshot without changing original files', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.vault, 'nested'));
  const first = join(f.vault, 'a.md'), second = join(f.vault, 'nested', 'b.md');
  writeFileSync(first, '첫 번째'); writeFileSync(second, '두 번째');
  await f.manager.add(f.vault, 'private_lan');
  const folder = folderOf(f);
  assert.deepEqual(f.backend.records.get(folder.id).documents.map(doc => doc.path), ['a.md', 'nested/b.md']);
  writeFileSync(first, '수정한 원본 🙂'); unlinkSync(second);
  assert.equal(await f.manager.sync(folder.id), true);
  assert.deepEqual(f.backend.records.get(folder.id).documents, [{ path: 'a.md', title: 'a', text: '수정한 원본 🙂' }]);
  assert.equal(folderOf(f).documentCount, 1);
  assert.equal(readFileSync(first, 'utf8'), '수정한 원본 🙂');
  assert.equal(existsSync(second), false);
  for (const call of syncCalls(f.backend, folder.id)) {
    assert.equal(JSON.stringify(call.body).includes(f.vault), false);
    assert.deepEqual(Object.keys(call.body).sort(), ['boundary', 'documents', 'expected_revision', 'label']);
  }
});

test('a temporarily unreadable folder blocks the indexed copy and recovers after the original folder returns', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '복원 후에도 보존할 원문');
  await f.manager.add(f.vault, 'private_lan');
  const folder = folderOf(f), offline = join(f.root, 'vault-offline');
  renameSync(f.vault, offline);
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(folderOf(f).phase, 'error'); assert(folderOf(f).error);
  assert.equal(f.backend.records.get(folder.id).available, false);
  assert.equal(f.backend.calls.filter(call => call.method === 'DELETE').length, 0);
  renameSync(offline, f.vault);
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(folderOf(f).phase, 'ready'); assert.equal(folderOf(f).error, null);
  assert.equal(f.backend.records.get(folder.id).available, true);
  assert.equal(readFileSync(join(f.vault, 'note.md'), 'utf8'), '복원 후에도 보존할 원문');
});

for (const kind of ['vault', 'approved_notes']) {
  test(`a different directory at the same ${kind} path remains blocked across restart`, async t => {
    const f = await fixture(t);
    const path = kind === 'vault' ? f.vault : f.approved;
    writeFileSync(join(path, 'note.md'), '승인한 원래 디렉터리');
    if (kind === 'vault') await f.manager.add(path, 'local'); else await f.manager.sync();
    const folder = folderOf(f, kind), writes = syncCalls(f.backend, folder.id).length;
    const original = join(f.root, kind + '-original');
    renameSync(path, original); mkdirSync(path);
    writeFileSync(join(path, 'note.md'), '선택하지 않은 대체 디렉터리');
    assert.equal(await f.manager.sync(folder.id), true);
    assert.equal(f.manager.snapshot().folders.find(saved => saved.id === folder.id).error, 'root_unavailable');
    assert.equal(f.backend.records.get(folder.id).available, false);
    assert.equal(syncCalls(f.backend, folder.id).length, writes);
    f.manager.dispose(); const restored = f.create(); await restored.initialize();
    assert.equal(restored.snapshot().folders.find(saved => saved.id === folder.id).error, 'root_unavailable');
    assert.equal(f.backend.records.get(folder.id).available, false);
    assert.equal(syncCalls(f.backend, folder.id).length, writes);
    if (kind === 'vault') {
      await restored.remove(folder.id); await restored.add(path, 'local');
      const newlySelected = restored.snapshot().folders.find(saved => saved.kind === 'vault');
      assert.notEqual(newlySelected.id, folder.id);
      assert.equal(f.backend.records.get(newlySelected.id).documents[0].text, '선택하지 않은 대체 디렉터리');
      assert.equal(newlySelected.phase, 'ready');
    } else {
      await assert.rejects(restored.remove(folder.id), /invalid_request/);
      unlinkSync(join(path, 'note.md')); rmdirSync(path); renameSync(original, path);
      assert.equal(await restored.sync(folder.id), true);
      assert.equal(f.backend.records.get(folder.id).available, true);
      assert.equal(f.backend.records.get(folder.id).documents[0].text, '승인한 원래 디렉터리');
    }
    assert.equal(readFileSync(join(kind === 'vault' ? original : path, 'note.md'), 'utf8'), '승인한 원래 디렉터리');
  });
}

for (const [name, bytes] of [['invalid UTF-8', Buffer.from([0xff, 0xfe])], ['NUL text', Buffer.from('valid\0invalid')]]) {
  test(`${name} disables the old collection and yields the localized encoding reason`, async t => {
    const f = await fixture(t);
    const path = join(f.vault, 'note.md'); writeFileSync(path, '마지막 정상 내용');
    await f.manager.add(f.vault, 'local'); const folder = folderOf(f);
    const writes = syncCalls(f.backend, folder.id).length;
    writeFileSync(path, bytes);
    assert.equal(await f.manager.sync(folder.id), true);
    assert.equal(folderOf(f).error, 'invalid_encoding');
    assert.equal(f.backend.records.get(folder.id).available, false);
    assert.equal(syncCalls(f.backend, folder.id).length, writes);
    assert.deepEqual(readFileSync(path), bytes);
  });
}

test('sync reports unsafe if the unreadable folder cannot be disabled remotely, then retries the block', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '이전 색인'); await f.manager.add(f.vault, 'local');
  const folder = folderOf(f);
  renameSync(f.vault, join(f.root, 'unavailable-vault'));
  f.backend.hook = (call, proceed) => {
    if (call.path.endsWith('/availability')) throw new Error('network_down');
    return proceed();
  };
  assert.equal(await f.manager.sync(folder.id), false);
  assert.equal(f.backend.records.get(folder.id).available, true);
  assert.equal(folderOf(f).phase, 'error');
  f.backend.hook = undefined;
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(f.backend.records.get(folder.id).available, false);
});

for (const invalidation of ['identity change', 'dispose']) {
  test(`a late list response after ${invalidation} cannot start another scan or import`, async t => {
    const f = await fixture(t);
    writeFileSync(join(f.vault, 'note.md'), 'before'); await f.manager.add(f.vault, 'local');
    const folder = folderOf(f), count = syncCalls(f.backend, folder.id).length, imported = f.events.imported;
    writeFileSync(join(f.vault, 'note.md'), 'after');
    const hold = holdRequest(f.backend, call => call.path === 'v1/collections');
    const pending = f.manager.sync(folder.id); await hold.waiting;
    if (invalidation === 'dispose') f.manager.dispose(); else f.context.valid = false;
    hold.release();
    await assert.rejects(pending, /connection_changed/);
    assert.equal(syncCalls(f.backend, folder.id).length, count);
    assert.equal(f.events.imported, imported);
    assert.equal(f.backend.records.get(folder.id).documents[0].text, 'before');
  });
}

test('a queued mutation rechecks identity before creating a folder grant or sending its contents', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '새 신원에는 전송하지 않을 원문');
  const hold = holdRequest(f.backend, call => call.path === 'v1/collections');
  const pending = f.manager.sync(); await hold.waiting;
  const adding = f.manager.add(f.vault, 'local');
  f.context.valid = false; hold.release();
  await assert.rejects(pending, /connection_changed/);
  await assert.rejects(adding, /connection_changed/);
  assert.equal(f.manager.snapshot().folders.length, 1);
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.length, 1);
  assert.equal([...f.backend.records.values()].some(record => record.documents.some(doc => doc.text.includes('새 신원'))), false);
});

test('a PUT response from the old identity cannot publish a ready state or imported callback', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), 'before'); await f.manager.add(f.vault, 'local');
  const folder = folderOf(f), imported = f.events.imported;
  writeFileSync(join(f.vault, 'note.md'), 'after');
  const hold = holdRequest(f.backend, call => call.method === 'PUT' && call.path === 'v1/collections/' + folder.id);
  const pending = f.manager.sync(folder.id); await hold.waiting;
  assert.equal(folderOf(f).phase, 'syncing');
  f.context.valid = false; hold.release();
  await assert.rejects(pending, /connection_changed/);
  assert.equal(f.events.imported, imported);
  assert.notEqual(folderOf(f).phase, 'ready');
  assert.equal(f.backend.calls.some(call => call.path.endsWith('/availability')), false,
    'the retired manager must not issue recovery mutations on its old connection');
});

test('both vault and approved notes can change their boundary, which is preserved across restart', async t => {
  const f = await fixture(t);
  const original = '# 원본\n정책 변경 중에도 같은 내용';
  writeFileSync(join(f.vault, 'note.md'), original); await f.manager.add(f.vault, 'private_lan');
  const vault = folderOf(f), approved = folderOf(f, 'approved_notes');
  await f.manager.setBoundary(vault.id, 'local');
  await f.manager.setBoundary(approved.id, 'private_lan');
  assert.equal(f.backend.records.get(vault.id).boundary, 'local');
  assert.equal(f.backend.records.get(approved.id).boundary, 'private_lan');
  await assert.rejects(f.manager.setBoundary(vault.id, 'cloud'), /invalid_request/);
  f.manager.dispose(); const restored = f.create(); await restored.initialize();
  assert.equal(restored.snapshot().folders.find(folder => folder.id === vault.id).boundary, 'local');
  assert.equal(restored.snapshot().folders.find(folder => folder.id === approved.id).boundary, 'private_lan');
  assert.equal(readFileSync(join(f.vault, 'note.md'), 'utf8'), original);
});

test('an unconfirmed LAN-to-local policy change persists intent but shows an error until recovery sync applies it', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '로컬 전용으로 바꿀 원문');
  await f.manager.add(f.vault, 'private_lan'); const folder = folderOf(f);
  assert.equal(folder.phase, 'ready');
  f.backend.hook = (call, proceed) => {
    if (call.path === 'v1/collections') throw new Error('network_down');
    return proceed();
  };
  await assert.rejects(f.manager.setBoundary(folder.id, 'local'));
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.find(saved => saved.id === folder.id).boundary, 'local');
  assert.equal(folderOf(f).boundary, 'local');
  assert.equal(folderOf(f).phase, 'error');
  assert.equal(folderOf(f).error, 'storage_unavailable');
  assert.equal(f.backend.records.get(folder.id).boundary, 'private_lan');
  await assert.rejects(f.manager.sync(folder.id), /network_down/,
    'a failed pre-send check must not report the unconfirmed remote policy as safe');
  f.backend.hook = undefined;
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(f.backend.records.get(folder.id).boundary, 'local');
  assert.equal(folderOf(f).phase, 'ready');
  assert.equal(folderOf(f).error, null);
});

test('failed removal before a remote commit is retryable; confirmed removal preserves original files', async t => {
  const f = await fixture(t);
  const note = join(f.vault, 'note.md'); writeFileSync(note, '연결 해제 뒤에도 원본 유지');
  await f.manager.add(f.vault, 'local'); const folder = folderOf(f);
  f.backend.hook = (call, proceed) => {
    if (call.method === 'DELETE') throw new Error('network_down');
    return proceed();
  };
  await assert.rejects(f.manager.remove(folder.id), /network_down/);
  assert.equal(folderOf(f).id, folder.id); assert.equal(f.backend.records.has(folder.id), true);
  assert.equal(folderOf(f).phase, 'error');
  assert.equal(folderOf(f).error, 'storage_unavailable');
  f.backend.hook = undefined; await f.manager.remove(folder.id);
  assert.equal(folderOf(f), undefined); assert.equal(f.backend.records.has(folder.id), false);
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.some(saved => saved.id === folder.id), false);
  assert.equal(readFileSync(note, 'utf8'), '연결 해제 뒤에도 원본 유지');
  await assert.rejects(f.manager.remove(folderOf(f, 'approved_notes').id), /invalid_request/);
  assert.equal(existsSync(f.approved), true);
});

test('a disconnect list failure shows an error with durable removal intent and recovers without reimporting', async t => {
  const f = await fixture(t);
  const note = join(f.vault, 'note.md'); writeFileSync(note, '연결 해제 후에도 보존할 원문');
  await f.manager.add(f.vault, 'private_lan'); const folder = folderOf(f);
  const writes = syncCalls(f.backend, folder.id).length;
  f.backend.hook = (call, proceed) => {
    if (call.path === 'v1/collections') throw new Error('network_down');
    return proceed();
  };
  await assert.rejects(f.manager.remove(folder.id));
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.find(saved => saved.id === folder.id).removing, true);
  assert.equal(folderOf(f).phase, 'error');
  assert.equal(folderOf(f).error, 'storage_unavailable');
  assert.equal(f.backend.records.has(folder.id), true);
  assert.equal(f.backend.calls.some(call => call.method === 'DELETE'), false);
  await assert.rejects(f.manager.sync(folder.id), /network_down/,
    'an unverified disconnect cannot pass the pre-send synchronization gate');
  f.backend.hook = undefined;
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(f.backend.records.has(folder.id), false);
  assert.equal(folderOf(f), undefined);
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.some(saved => saved.id === folder.id), false);
  assert.equal(syncCalls(f.backend, folder.id).length, writes);
  assert.equal(readFileSync(note, 'utf8'), '연결 해제 후에도 보존할 원문');
});

test('malformed durable folder settings fail closed and are preserved for recovery', async t => {
  const f = await fixture(t, { initialize: false });
  const content = JSON.stringify({ version: 1, folders: [], unexpected: 'do not erase' });
  writeFileSync(f.store, content);
  await assert.rejects(f.manager.initialize(), /storage_unavailable/);
  assert.equal(f.manager.snapshot().available, false);
  assert.equal(f.backend.calls.length, 0);
  assert.equal(readFileSync(f.store, 'utf8'), content);
});

test('a first sync whose response is lost disables the possibly committed collection until recovery', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '아직 수신 확인되지 않은 색인');
  let failOnce = true;
  f.backend.hook = (call, proceed) => {
    const result = proceed();
    if (failOnce && call.method === 'PUT' && !call.path.endsWith('/availability')) {
      failOnce = false; throw new Error('response_lost');
    }
    return result;
  };
  await f.manager.add(f.vault, 'local');
  const folder = folderOf(f);
  assert.equal(folder.phase, 'error');
  assert.equal(f.backend.records.get(folder.id).available, false,
    'an uncertain first PUT must not leave an available collection behind an error view');
  f.backend.hook = undefined;
  assert.equal(await f.manager.sync(folder.id), true);
  assert.equal(f.backend.records.get(folder.id).available, true);
  assert.equal(folderOf(f).phase, 'ready');
});

test('an uncertain initial PUT is unsafe when its committed state cannot be rechecked', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.vault, 'note.md'), '원문'); await f.manager.add(f.vault, 'local');
  const folder = folderOf(f);
  // A fresh server has no collection for an existing durable grant.
  f.backend.records.delete(folder.id);
  let responseLost = false;
  f.backend.hook = (call, proceed) => {
    if (responseLost && call.path === 'v1/collections') throw new Error('network_down');
    const result = proceed();
    if (call.method === 'PUT' && call.path === 'v1/collections/' + folder.id) {
      responseLost = true; throw new Error('response_lost');
    }
    return result;
  };
  assert.equal(await f.manager.sync(folder.id), false,
    'an unverified remote commit must block the pre-send synchronization gate');
  assert.equal(folderOf(f).phase, 'error');
});

for (const recovery of ['sync', 'restart']) {
  test(`a lost DELETE response cannot reimport the disconnected folder on ${recovery}`, async t => {
    const f = await fixture(t);
    const note = join(f.vault, 'note.md'); writeFileSync(note, '삭제하지 않을 원본');
    await f.manager.add(f.vault, 'local'); const folder = folderOf(f);
    const writes = syncCalls(f.backend, folder.id).length;
    f.backend.hook = (call, proceed) => {
      const result = proceed();
      if (call.method === 'DELETE') throw new Error('response_lost');
      return result;
    };
    await assert.rejects(f.manager.remove(folder.id), /response_lost/);
    assert.equal(f.backend.records.has(folder.id), false);
    f.backend.hook = undefined;
    let manager = f.manager;
    if (recovery === 'restart') {
      manager.dispose(); manager = f.create(); await manager.initialize();
    } else await manager.sync();
    assert.equal(f.backend.records.has(folder.id), false);
    assert.equal(syncCalls(f.backend, folder.id).length, writes,
      'the backend tombstone must not be the only protection against a reimport attempt');
    assert.equal(manager.snapshot().folders.some(saved => saved.id === folder.id), false);
    assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.some(saved => saved.id === folder.id), false);
    assert.equal(readFileSync(note, 'utf8'), '삭제하지 않을 원본');
  });
}

test('restart retries a pending disconnect without scanning the original folder', async t => {
  const f = await fixture(t);
  const note = join(f.vault, 'note.md'); writeFileSync(note, '분리한 원본 유지');
  await f.manager.add(f.vault, 'local'); const folder = folderOf(f);
  f.backend.hook = (call, proceed) => {
    if (call.method === 'DELETE') throw new Error('network_down');
    return proceed();
  };
  await assert.rejects(f.manager.remove(folder.id), /network_down/);
  f.manager.dispose();
  // A disconnect does not need continued access to the user's original root.
  const detached = join(f.root, 'detached-vault'); renameSync(f.vault, detached);
  f.backend.hook = undefined;
  const restored = f.create(); await restored.initialize();
  assert.equal(f.backend.records.has(folder.id), false);
  assert.equal(restored.snapshot().folders.some(saved => saved.id === folder.id), false);
  assert.equal(readFileSync(join(detached, 'note.md'), 'utf8'), '분리한 원본 유지');
});
