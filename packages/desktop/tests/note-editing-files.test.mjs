import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: {
  contents: "export * from './src/main/notes/editing/windows-note-file.ts';", loader: 'ts', resolveDir: packageRoot,
}, bundle: true, write: false, platform: 'node', format: 'esm' });
const { readNoteFile, writeNoteFile } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const onWindows = { skip: process.platform !== 'win32' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = path => { const value = lstatSync(path, { bigint: true }); return `${value.dev}:${value.ino}`; };

function fixture(t) {
  const base = resolve(packageRoot, '.test-output'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'note-edit-file-')), root = join(directory, 'vault'); mkdirSync(root);
  t.after(() => {
    assert.equal(dirname(resolve(directory)), base);
    assert.match(basename(directory), /^note-edit-file-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const write = (path, bytes) => { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); return target; };
  return { directory, root, grant: { root, rootIdentity: identity(root) }, write };
}

test('locked native read uses the Node root/file identity and preserves BOM, Unicode and exact newlines', onWindows, async t => {
  const f = fixture(t), bytes = Buffer.from('\ufeff# 원문 🙂\r\n\r\n끝\n'), path = '하위/$(throw `oops`).md';
  const target = f.write(path, bytes), snapshot = await readNoteFile(f.grant, path);
  assert.deepEqual(snapshot, { bytes, sha256: sha(bytes), identity: identity(target) });
  const replacement = Buffer.from('\ufeff# 수정 🚀\r\n새 문장\r\n');
  const result = await writeNoteFile(f.grant, path, { expectedSha256: snapshot.sha256, expectedIdentity: snapshot.identity, bytes: replacement });
  assert.deepEqual(result, { status: 'succeeded', error: null });
  assert.deepEqual(readFileSync(target), replacement);
  assert.equal(identity(target), snapshot.identity);
});

test('write requires both the currently locked content hash and identity; external edits and replacements survive', onWindows, async t => {
  const f = fixture(t), target = f.write('note.md', 'original'), original = await readNoteFile(f.grant, 'note.md');
  const change = { expectedSha256: original.sha256, expectedIdentity: original.identity, bytes: Buffer.from('app change') };
  writeFileSync(target, 'external edit');
  assert.deepEqual(await writeNoteFile(f.grant, 'note.md', change), { status: 'failed', error: 'note_file_conflict' });
  assert.equal(readFileSync(target, 'utf8'), 'external edit');
  renameSync(target, join(f.root, 'old.md')); f.write('note.md', 'original');
  assert.notEqual(identity(target), original.identity);
  assert.deepEqual(await writeNoteFile(f.grant, 'note.md', change), { status: 'failed', error: 'note_file_conflict' });
  assert.equal(readFileSync(target, 'utf8'), 'original');
});

test('an existing external writer prevents both snapshot read and approval write without mutating bytes', onWindows, async t => {
  const f = fixture(t), target = f.write('note.md', 'preserved'), snapshot = await readNoteFile(f.grant, 'note.md');
  const writer = openSync(target, 'r+');
  try {
    await assert.rejects(readNoteFile(f.grant, 'note.md'), /note_file_unavailable/);
    assert.deepEqual(await writeNoteFile(f.grant, 'note.md', { expectedSha256: snapshot.sha256, expectedIdentity: snapshot.identity, bytes: Buffer.from('blocked') }),
      { status: 'failed', error: 'note_file_unavailable' });
    assert.equal(readFileSync(target, 'utf8'), 'preserved');
  } finally { closeSync(writer); }
});

test('root replacement cannot transfer a saved grant to a new directory', onWindows, async t => {
  const f = fixture(t), target = f.write('note.md', 'old'), original = await readNoteFile(f.grant, 'note.md');
  renameSync(f.root, join(f.directory, 'old-vault')); mkdirSync(f.root); f.write('note.md', 'new');
  await assert.rejects(readNoteFile(f.grant, 'note.md'), /note_root_changed/);
  assert.deepEqual(await writeNoteFile(f.grant, 'note.md', { expectedSha256: original.sha256, expectedIdentity: original.identity, bytes: Buffer.from('blocked') }),
    { status: 'failed', error: 'note_root_changed' });
  assert.equal(readFileSync(target, 'utf8'), 'new');
});

test('junction roots/parents and hardlinked files cannot be used to read or change another location', onWindows, async t => {
  const f = fixture(t), outside = join(f.directory, 'outside'); mkdirSync(outside); const outsideFile = join(outside, 'secret.md'); writeFileSync(outsideFile, 'private');
  symlinkSync(outside, join(f.root, 'linked'), 'junction');
  await assert.rejects(readNoteFile(f.grant, 'linked/secret.md'), /note_file_unsafe/);
  const linkRoot = join(f.directory, 'linked-root'); symlinkSync(f.root, linkRoot, 'junction');
  await assert.rejects(readNoteFile({ root: linkRoot, rootIdentity: f.grant.rootIdentity }, 'note.md'), /note_file_unsafe/);
  linkSync(outsideFile, join(f.root, 'hard.md'));
  await assert.rejects(readNoteFile(f.grant, 'hard.md'), /note_file_unsafe/);
  assert.deepEqual(await writeNoteFile(f.grant, 'hard.md', { expectedSha256: sha(Buffer.from('private')), expectedIdentity: identity(outsideFile), bytes: Buffer.from('blocked') }),
    { status: 'failed', error: 'note_file_unsafe' });
  assert.equal(readFileSync(outsideFile, 'utf8'), 'private');
});

test('path escape, NTFS stream/device aliases, hidden files and arbitrary code remain rejected data', onWindows, async t => {
  const f = fixture(t), target = f.write('note.md', 'safe'), original = await readNoteFile(f.grant, 'note.md');
  const change = { expectedSha256: original.sha256, expectedIdentity: original.identity, bytes: Buffer.from('blocked') };
  for (const path of ['../note.md', './note.md', '/note.md', 'nested//note.md', 'nested\\note.md', 'note.md:other', 'C:/note.md',
    'CON.md', 'com1.md', 'LPT².md', 'folder./note.md', 'folder /note.md', '.obsidian/note.md', 'note\0.md', '*.md', 'a'.repeat(1024) + '.md']) {
    await assert.rejects(readNoteFile(f.grant, path), /invalid_note_path/, path);
    assert.deepEqual(await writeNoteFile(f.grant, path, change), { status: 'failed', error: 'invalid_note_path' }, path);
  }
  assert.equal(readFileSync(target, 'utf8'), 'safe');
  assert.equal(existsSync(join(f.root, 'note.md:other')), false);
});

test('size, replacement encoding and missing-file failures do not mutate notes; raw damaged bytes remain recoverable', onWindows, async t => {
  const f = fixture(t); const target = f.write('note.md', 'safe'), original = await readNoteFile(f.grant, 'note.md');
  const change = { expectedSha256: original.sha256, expectedIdentity: original.identity, bytes: Buffer.from('new') };
  assert.equal((await writeNoteFile(f.grant, 'missing.md', change)).status, 'failed');
  assert.equal(existsSync(join(f.root, 'missing.md')), false);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('bad\0text'), Buffer.alloc(256 * 1024 + 1, 65)]) {
    assert.equal((await writeNoteFile(f.grant, 'note.md', { ...change, bytes })).status, 'failed');
    assert.equal(readFileSync(target, 'utf8'), 'safe');
    f.write('invalid.md', bytes);
    if (bytes.length > 256 * 1024) await assert.rejects(readNoteFile(f.grant, 'invalid.md'), /note_file_limit/);
    else {
      const damaged = await readNoteFile(f.grant, 'invalid.md'); assert.deepEqual(damaged.bytes, bytes);
      assert.deepEqual(await writeNoteFile(f.grant, 'invalid.md', { expectedSha256: damaged.sha256, expectedIdentity: damaged.identity, bytes: Buffer.from('recovered') }),
        { status: 'succeeded', error: null });
      assert.equal(readFileSync(join(f.root, 'invalid.md'), 'utf8'), 'recovered');
    }
  }
  const largest = Buffer.alloc(256 * 1024, 65); f.write('large.md', largest);
  assert.deepEqual((await readNoteFile(f.grant, 'large.md')).bytes, largest);
  assert.deepEqual(await writeNoteFile(f.grant, 'note.md', { ...change, bytes: Buffer.alloc(0) }), { status: 'succeeded', error: null });
  assert.equal(readFileSync(target).length, 0);
});

test('cancelled before launch is a known failure, and interruption after launch is conservatively unknown', onWindows, async t => {
  const f = fixture(t), target = f.write('note.md', 'safe'), original = await readNoteFile(f.grant, 'note.md');
  const change = { expectedSha256: original.sha256, expectedIdentity: original.identity, bytes: Buffer.from('new') };
  const before = new AbortController(); before.abort();
  await assert.rejects(readNoteFile(f.grant, 'note.md', before.signal), /note_cancelled/);
  assert.deepEqual(await writeNoteFile(f.grant, 'note.md', change, before.signal), { status: 'failed', error: 'note_cancelled' });
  const during = new AbortController(), pending = writeNoteFile(f.grant, 'note.md', change, during.signal);
  setTimeout(() => during.abort(), 25);
  assert.deepEqual(await pending, { status: 'unknown', error: 'note_write_unknown' });
  assert.equal(readFileSync(target, 'utf8'), 'safe');
});

test('truncated, forged or oversized helper replies cannot acknowledge a write or deliver unverified snapshot bytes', onWindows, async () => {
  // Fault injection replaces the child-process module only in this test bundle.
  // The shipping helper and its API contain no test switch or timing hook.
  const key = '__kirianNoteChildFaults';
  let scenario;
  globalThis[key] = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdout.setEncoding = () => {}; child.stdin.write = () => {}; child.stdin.destroy = () => {};
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.emit('data', scenario);
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const built = await build({ stdin: { contents: "export * from './src/main/notes/editing/windows-note-file.ts';", loader: 'ts', resolveDir: packageRoot },
      bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'child-failure-fixture', setup(builder) {
        builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const spawn = (...args) => globalThis.${key}(...args);`, loader: 'js' }));
      } }] });
    const mocked = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
    const grant = { root: 'C:\\fixtures', rootIdentity: '1:2' }, change = { expectedSha256: sha(Buffer.from('old')), expectedIdentity: '1:3', bytes: Buffer.from('new') };
    for (scenario of ['{"status":"succeeded"', JSON.stringify({ status: 'succeeded', error: null, bytes: null, sha256: null, identity: null, extra: true }),
      JSON.stringify({ status: 'succeeded', error: 'note_io_failed', bytes: null, sha256: null, identity: null }), 'x'.repeat(400 * 1024 + 1)]) {
      assert.deepEqual(await mocked.writeNoteFile(grant, 'note.md', change), { status: 'unknown', error: 'note_write_unknown' });
    }
    scenario = JSON.stringify({ status: 'succeeded', error: null, bytes: Buffer.from('other').toString('base64'), sha256: change.expectedSha256, identity: '1:3' });
    await assert.rejects(mocked.readNoteFile(grant, 'note.md'), /note_io_failed/);
    scenario = JSON.stringify({ status: 'succeeded', error: null, bytes: 'b2xk!!!!', sha256: change.expectedSha256, identity: '1:3' });
    await assert.rejects(mocked.readNoteFile(grant, 'note.md'), /note_io_failed/);
  } finally { delete globalThis[key]; }
});

test('abrupt parent exit cannot leave an orphan that writes after restart recovery', onWindows, async t => {
  const f = fixture(t), target = f.write('note.md', 'original'), original = await readNoteFile(f.grant, 'note.md');
  const modulePath = join(f.directory, 'file-adapter.mjs'); writeFileSync(modulePath, outputFiles[0].text);
  const script = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const originalSpawn = cp.spawn;
    cp.spawn = (...args) => {
      const helper = originalSpawn(...args), write = helper.stdin.write.bind(helper.stdin);
      helper.stdin.write = (chunk, ...other) => write(chunk, ...other, () => process.send({flushed: true, helperPid: helper.pid}));
      return helper;
    };
    syncBuiltinESMExports();
    const api = await import(process.argv[1]), request = JSON.parse(process.argv[2]);
    await api.writeNoteFile(request.grant, 'note.md', {...request.change, bytes: Buffer.from('orphan must not write')});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(modulePath).href,
    JSON.stringify({ grant: f.grant, change: { expectedSha256: original.sha256, expectedIdentity: original.identity } })],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let helperPid;
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  try {
    const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('fixture_parent_exited_early'); })]);
    assert.equal(message[0].flushed, true); helperPid = message[0].helperPid;
    assert.equal(typeof helperPid, 'number'); process.kill(helperPid, 0);
    child.kill(); await exited;
    // A new execution may immediately inspect and explicitly restore the same
    // original bytes. The previous orphan's original hash would also match them.
    const current = await readNoteFile(f.grant, 'note.md'); assert.deepEqual(current.bytes, original.bytes);
    assert.deepEqual(await writeNoteFile(f.grant, 'note.md', { expectedSha256: current.sha256, expectedIdentity: current.identity, bytes: original.bytes }),
      { status: 'succeeded', error: null });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { process.kill(helperPid, 0); } catch { break; }
      assert(Date.now() < deadline, 'orphan helper should exit after parent death');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(readFileSync(target), original.bytes);
  } finally {
    if (child.exitCode === null) child.kill();
    if (helperPid) { try { process.kill(helperPid); } catch {} }
  }
});
