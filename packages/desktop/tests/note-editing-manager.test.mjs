import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: { contents: "export { NoteFoldersManager } from './src/main/notes/note-folders-manager.ts';", loader: 'ts', resolveDir: packageRoot },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'contracts-entry', setup(builder) {
    builder.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true }));
  } }] });
const { NoteFoldersManager } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const identity = { instance_id: 'note-edit-manager-test', mode: 'personal', principal_id: 'owner' };
const valid = () => true;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const base = resolve(packageRoot, '.test-output'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'note-edit-manager-')), settings = join(root, 'settings'), approved = join(root, 'approved'), vault = join(root, 'vault');
  for (const directory of [settings, approved, vault]) mkdirSync(directory);
  const file = join(vault, 'note.md'); writeFileSync(file, 'original');
  const records = new Map(), calls = [], hooks = {}, context = { valid: true }, managers = [];
  const api = {
    async list() { calls.push('list'); await hooks.list?.(); return [...records.values()].map(item => structuredClone(item)); },
    async sync(folder, revision, documents) {
      calls.push(['sync', folder.id]); await hooks.sync?.();
      assert.equal(revision, records.get(folder.id)?.revision ?? 0);
      const record = { id: folder.id, label: folder.label, boundary: folder.boundary, revision: revision + 1,
        available: true, source_count: documents.length, documents: structuredClone(documents) };
      records.set(folder.id, record); return structuredClone(record);
    },
    async unavailable(id) { calls.push(['unavailable', id]); await hooks.unavailable?.(); records.get(id).available = false; },
    async remove(id) { calls.push(['remove', id]); records.delete(id); },
  };
  const create = () => { const manager = new NoteFoldersManager(settings, identity, approved, api, () => {}, () => {}, () => context.valid); managers.push(manager); return manager; };
  const manager = create(); await manager.initialize(); await manager.add(vault, 'local');
  const folder = manager.snapshot().folders.find(item => item.kind === 'vault');
  const owner = createHash('sha256').update(JSON.stringify([identity.instance_id, identity.mode, identity.principal_id])).digest('hex');
  t.after(() => { for (const item of managers) item.dispose(); assert.equal(dirname(resolve(root)), base); assert(basename(root).startsWith('note-edit-manager-')); rmSync(root, { recursive: true, force: true }); });
  return { root, settings, approved, vault, file, manager, folder, create, records, calls, hooks, context, store: join(settings, `note-folders-${owner}.json`) };
}

test('new and migrated grants default OFF while existing read synchronization remains available', async t => {
  const f = await fixture(t); assert(f.manager.snapshot().folders.every(item => item.writeEnabled === false));
  let entered = false;
  await assert.rejects(f.manager.editFile(f.folder.id, { context: valid }, async () => { entered = true; }), /write_not_enabled/);
  assert.equal(entered, false);
  writeFileSync(f.file, 'external edit while OFF'); assert.equal(await f.manager.sync(f.folder.id), true);
  assert.equal(f.records.get(f.folder.id).documents[0].text, 'external edit while OFF');
  f.manager.dispose(); const state = JSON.parse(readFileSync(f.store, 'utf8'));
  for (const folder of state.folders) { delete folder.writeEnabled; delete folder.writeRevision; }
  writeFileSync(f.store, JSON.stringify(state)); const restored = f.create(); await restored.initialize();
  assert(restored.snapshot().folders.every(item => item.writeEnabled === false));
  await assert.rejects(restored.editFile(f.folder.id, { context: valid }, async () => {}), /write_not_enabled/);
});

test('folder-scoped write opt-in persists, and OFF/ON invalidates earlier grants across restart', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true);
  const grant = await f.manager.editFile(f.folder.id, { context: valid }, async value => value);
  assert.equal(grant.grantRevision, 1); assert.match(grant.rootIdentity, /^\d+:\d+$/);
  assert.equal(f.manager.snapshot().folders.find(item => item.kind === 'approved_notes').writeEnabled, false);
  f.manager.dispose(); const restored = f.create(); await restored.initialize();
  assert.equal(restored.snapshot().folders.find(item => item.id === f.folder.id).writeEnabled, true);
  assert.deepEqual(await restored.editFile(f.folder.id, { expected: grant, context: valid }, async value => value), grant);
  await restored.setWriteEnabled(f.folder.id, false); await restored.setWriteEnabled(f.folder.id, true);
  await assert.rejects(restored.editFile(f.folder.id, { expected: grant, context: valid }, async () => {}), /source_changed/);
  assert.equal((await restored.editFile(f.folder.id, { context: valid }, async value => value)).grantRevision, 3);
});

test('a newer OFF revocation cannot be cleared by an older queued enable before a queued edit', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let hold = true, wrote = false;
  f.hooks.list = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } };
  const sync = f.manager.sync(); await entered.promise;
  const enable = f.manager.setWriteEnabled(f.folder.id, true);
  const edit = f.manager.editFile(f.folder.id, { mutation: true, context: valid }, async () => { wrote = true; });
  const rejected = assert.rejects(edit, /write_not_enabled/);
  const disable = f.manager.setWriteEnabled(f.folder.id, false);
  release.resolve(); await Promise.all([sync, enable, rejected, disable]);
  assert.equal(wrote, false); assert.equal(f.manager.snapshot().folders.find(item => item.id === f.folder.id).writeEnabled, false);
  assert.equal(readFileSync(f.file, 'utf8'), 'original');
});

test('OFF immediately aborts an active edit before the queued setting update completes', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true);
  const entered = deferred(); let aborted = false;
  const edit = f.manager.editFile(f.folder.id, { mutation: true, context: valid }, async (_grant, guard, signal) => {
    assert.equal(f.records.get(f.folder.id).available, false); entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted = signal.aborted; assert.throws(guard, /connection_changed|write_not_enabled/);
  });
  await entered.promise; const disable = f.manager.setWriteEnabled(f.folder.id, false);
  await Promise.all([edit, disable]); assert.equal(aborted, true); assert.equal(readFileSync(f.file, 'utf8'), 'original');
});

test('connection invalidation aborts an active helper even while its operation is awaiting completion', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true);
  const entered = deferred(); let aborted = false;
  const edit = f.manager.editFile(f.folder.id, { context: () => f.context.valid }, async (_grant, guard, signal) => {
    entered.resolve();
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('abort_timeout')), 1500);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    aborted = true; assert.throws(guard, /connection_changed/);
  });
  await entered.promise; f.context.valid = false; await edit; assert.equal(aborted, true);
});

test('unknown writes block scans and regular edits; explicit recovery restores indexing without a repeat loop', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true); let unresolved = true;
  f.manager.setEditingBlocked(id => id === f.folder.id && unresolved);
  writeFileSync(f.file, 'uncertain partial content');
  assert.equal(await f.manager.sync(f.folder.id), true); assert.equal(f.records.get(f.folder.id).available, false);
  assert.equal(f.records.get(f.folder.id).documents[0].text, 'original');
  await assert.rejects(f.manager.editFile(f.folder.id, { context: valid }, async () => {}), /note_write_unknown/);
  await f.manager.editFile(f.folder.id, { mutation: true, recovery: true, context: valid }, async (_grant, guard) => {
    guard(); assert.equal(f.records.get(f.folder.id).available, false); writeFileSync(f.file, 'recovered original'); unresolved = false;
  });
  assert.equal(f.records.get(f.folder.id).available, true); assert.equal(f.records.get(f.folder.id).documents[0].text, 'recovered original');
  const imports = f.calls.filter(call => Array.isArray(call) && call[0] === 'sync' && call[1] === f.folder.id).length;
  await f.manager.sync(f.folder.id); await f.manager.sync(f.folder.id);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'sync' && call[1] === f.folder.id).length, imports);
});

test('unknown write prevents removal and same-path re-registration, while OFF and reviewed recovery remain available', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true); let unresolved = true;
  const blocked = id => id === f.folder.id && unresolved;
  f.manager.setEditingBlocked(blocked); writeFileSync(f.file, 'uncertain partial content');
  await f.manager.sync(f.folder.id);
  await assert.rejects(f.manager.remove(f.folder.id), /note_write_unknown/);
  assert(f.manager.snapshot().folders.some(item => item.id === f.folder.id));
  const blockedView = f.manager.snapshot().folders.find(item => item.id === f.folder.id);
  assert.equal(blockedView.phase, 'error'); assert.equal(blockedView.error, 'note_write_unknown');
  assert.equal(blockedView.writeEnabled, false);
  await assert.rejects(f.manager.editFile(f.folder.id, {recovery: true, context: valid}, async () => {}), /write_not_enabled/);
  assert.equal(f.records.get(f.folder.id).available, false);
  assert.equal(f.records.get(f.folder.id).documents[0].text, 'original');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'remove' && call[1] === f.folder.id), false);
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.find(item => item.id === f.folder.id).removing, undefined);
  await f.manager.setWriteEnabled(f.folder.id, false);
  assert.equal(f.manager.snapshot().folders.find(item => item.id === f.folder.id).writeEnabled, false);
  await assert.rejects(f.manager.add(f.vault, 'local'), /invalid_request/);

  f.manager.dispose(); const restored = f.create(); restored.setEditingBlocked(blocked); await restored.initialize();
  assert.equal(restored.snapshot().folders.find(item => item.id === f.folder.id).writeEnabled, false);
  await assert.rejects(restored.remove(f.folder.id), /note_write_unknown/);
  await assert.rejects(restored.add(f.vault, 'local'), /invalid_request/);
  assert.equal(readFileSync(f.file, 'utf8'), 'uncertain partial content');
  await restored.setWriteEnabled(f.folder.id, true);
  await restored.editFile(f.folder.id, { mutation: true, recovery: true, context: valid }, async (_grant, guard) => {
    guard(); writeFileSync(f.file, 'original'); unresolved = false;
  });
  assert.equal(f.records.get(f.folder.id).available, true);
  await restored.remove(f.folder.id);
  assert.equal(restored.snapshot().folders.some(item => item.id === f.folder.id), false);
  assert.equal(f.records.has(f.folder.id), false);
  assert.equal(readFileSync(f.file, 'utf8'), 'original');
  await restored.add(f.vault, 'local');
  const replacement = restored.snapshot().folders.find(item => item.kind === 'vault');
  assert.notEqual(replacement.id, f.folder.id);
  assert.equal(f.records.get(replacement.id).documents[0].text, 'original');
});

test('queued removal checks the unknown result caused by aborting an active write', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true);
  const entered = deferred(); let unresolved = false;
  f.manager.setEditingBlocked(id => id === f.folder.id && unresolved);
  const edit = f.manager.editFile(f.folder.id, { mutation: true, context: valid }, async (_grant, _guard, signal) => {
    writeFileSync(f.file, 'partial'); entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
    unresolved = true;
  });
  await entered.promise;
  const rejected = assert.rejects(f.manager.remove(f.folder.id), /note_write_unknown/);
  await Promise.all([edit, rejected]);
  assert(f.manager.snapshot().folders.some(item => item.id === f.folder.id));
  assert.equal(f.manager.snapshot().folders.find(item => item.id === f.folder.id).error, 'note_write_unknown');
  assert.equal(f.records.get(f.folder.id).available, false);
  assert.equal(readFileSync(f.file, 'utf8'), 'partial');
  assert.equal(JSON.parse(readFileSync(f.store, 'utf8')).folders.find(item => item.id === f.folder.id).removing, undefined);
});

test('a mutation cannot begin unless existing indexed content has been acknowledged unavailable', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true); let wrote = false;
  f.hooks.unavailable = async () => { throw new Error('network_down'); };
  await assert.rejects(f.manager.editFile(f.folder.id, { mutation: true, context: valid }, async () => { wrote = true; }), /network_down/);
  assert.equal(wrote, false); assert.equal(readFileSync(f.file, 'utf8'), 'original');
});

test('read synchronization waits for an edit, then sees only its completed content', async t => {
  const f = await fixture(t); await f.manager.setWriteEnabled(f.folder.id, true);
  const entered = deferred(), release = deferred();
  const edit = f.manager.editFile(f.folder.id, { mutation: true, context: valid }, async () => {
    entered.resolve(); writeFileSync(f.file, 'intermediate bytes'); await release.promise; writeFileSync(f.file, 'completed');
  });
  await entered.promise; const sync = f.manager.sync(f.folder.id);
  assert.equal(f.records.get(f.folder.id).available, false); assert.equal(f.records.get(f.folder.id).documents[0].text, 'original');
  release.resolve(); await Promise.all([edit, sync]); assert.equal(f.records.get(f.folder.id).documents[0].text, 'completed');
});
