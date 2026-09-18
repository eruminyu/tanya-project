import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: "export { scanNotes, checkNoteRoot } from './src/main/notes/scan-notes.ts';", loader: 'ts',
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { scanNotes, checkNoteRoot } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
function fixture(t) {
  const container = mkdtempSync(join(tmpdir(), 'kirian-note-scan-')), root = join(container, 'notes'); mkdirSync(root);
  t.after(() => {
    assert.equal(dirname(resolve(container)), resolve(tmpdir())); assert(basename(container).startsWith('kirian-note-scan-'));
    rmSync(container, { recursive: true, force: true });
  });
  const write = (path, value) => { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value); return target; };
  return { container, root, write };
}

test('mixed Markdown paths, UTF-8 BOM and Unicode text are read exactly and sorted with a stable digest', async t => {
  const f = fixture(t);
  f.write('z-last.MD', '\uFEFF# 그대로\r\n\r\n본문 🙂\r\n');
  f.write('nested/한글🙂.md', '---\ncommand: not executed\n---\n[link](https://example.invalid/)\n');
  f.write('a-first.md', '# 제목은 파일 내용일 뿐\n');
  const result = await scanNotes(f.root);
  assert.deepEqual(result.documents, [
    { path: 'a-first.md', title: 'a-first', text: '# 제목은 파일 내용일 뿐\n' },
    { path: 'nested/한글🙂.md', title: '한글🙂', text: '---\ncommand: not executed\n---\n[link](https://example.invalid/)\n' },
    { path: 'z-last.MD', title: 'z-last', text: '# 그대로\r\n\r\n본문 🙂\r\n' },
  ]);
  assert.equal(result.skipped, 0);
  const expected = createHash('sha256');
  for (const document of result.documents) expected.update(JSON.stringify([document.path, document.title, document.text]) + '\n');
  assert.equal(result.digest, expected.digest('hex'));
  assert.deepEqual(await scanNotes(f.root), result);
  f.write('a-first.md', '# 수정\n'); assert.notEqual((await scanNotes(f.root)).digest, result.digest);
});

test('hidden trees, dotfiles, node_modules, attachments and whitespace files are skipped without reading them', async t => {
  const f = fixture(t);
  for (const path of ['.obsidian/config.md', '.git/secret.md', '.trash/deleted.md', '.hidden.md', 'node_modules/module.md', 'image.png']) f.write(path, Buffer.from([0xff]));
  f.write('empty.md', ' \r\n\t'); f.write('visible.md', '내용');
  const result = await scanNotes(f.root);
  assert.deepEqual(result.documents.map(document => document.path), ['visible.md']);
  assert.equal(result.skipped, 7);
});

test('empty directories form a valid authoritative empty snapshot and long Unicode titles remain bounded', async t => {
  const f = fixture(t), empty = await scanNotes(f.root);
  assert.deepEqual(empty.documents, []); assert.equal(empty.skipped, 0);
  assert.equal(empty.digest, createHash('sha256').digest('hex'));
  f.write('a'.repeat(115) + '가'.repeat(10) + '.md', '🙂 원문');
  const result = await scanNotes(f.root);
  assert.equal([...result.documents[0].title].length, 120);
  assert.equal(result.documents[0].text, '🙂 원문');
});

test('invalid UTF-8 and NUL invalidate the entire scan rather than returning partial documents', async t => {
  const f = fixture(t); f.write('a-good.md', '정상 문서');
  for (const invalid of [Buffer.from([0xf0, 0x28, 0x8c, 0x28]), Buffer.from('before\0after')]) {
    f.write('z-invalid.md', invalid);
    await assert.rejects(scanNotes(f.root), /note_invalid_encoding/);
    assert.equal(readFileSync(join(f.root, 'a-good.md'), 'utf8'), '정상 문서');
  }
});

test('root checks reject relative paths, files, drive roots and selected directory junctions', t => {
  const f = fixture(t), file = f.write('file.md', '내용');
  assert.equal(checkNoteRoot(f.root), resolve(f.root));
  for (const root of ['relative', file, parse(f.root).root]) assert.throws(() => checkNoteRoot(root));
  const link = join(f.container, 'selected-link');
  symlinkSync(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkNoteRoot(link), /invalid_note_root/);
});

test('linked directories are not traversed and a Markdown path replaced by a link disappears from the snapshot', async t => {
  const f = fixture(t), outside = join(f.container, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'private.md'), '외부 문서');
  const prior = f.write('prior.md', '이전 본문');
  assert.equal((await scanNotes(f.root)).documents.length, 1);
  // A directory junction with an .md name exercises the replacement without
  // requiring Windows developer mode or symbolic-link privileges for files.
  renameSync(prior, join(f.container, 'prior-backup.md'));
  symlinkSync(outside, prior, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scanNotes(f.root);
  assert.deepEqual(result.documents, []); assert.equal(result.skipped, 1);
  assert.equal(readFileSync(join(outside, 'private.md'), 'utf8'), '외부 문서');
});

test('permission or read errors invalidate all collected content', async t => {
  const f = fixture(t), inaccessible = f.write('unreadable.md', '읽지 못할 문서'); f.write('good.md', '정상');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (String(path) === inaccessible) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return open(path, ...args);
  });
  await assert.rejects(scanNotes(f.root), /denied/);
});

test('a file changed during its read invalidates the snapshot even if its size is unchanged', async t => {
  const f = fixture(t), target = f.write('racing.md', 'old!'), open = fs.open.bind(fs);
  let changed = false;
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (String(path) === target) {
      const read = handle.read.bind(handle);
      handle.read = async (...arguments_) => {
        const result = await read(...arguments_);
        if (!changed && result.bytesRead) {
          changed = true; writeFileSync(target, 'new!');
          await fs.utimes(target, new Date(), new Date(Date.now() + 1000));
        }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(scanNotes(f.root), /note_tree_changed/);
});

test('a file replaced between lstat and open is rejected before reading replacement bytes', async t => {
  const f = fixture(t), target = f.write('replaced.md', 'old!'), open = fs.open.bind(fs);
  let replacementReads = 0;
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (String(path) !== target) return open(path, ...args);
    renameSync(target, join(f.container, 'original.md'));
    writeFileSync(target, 'new!');
    const handle = await open(path, ...args), read = handle.read.bind(handle);
    handle.read = (...arguments_) => { replacementReads++; return read(...arguments_); };
    return handle;
  });
  await assert.rejects(scanNotes(f.root), /note_tree_changed/);
  assert.equal(replacementReads, 0);
});

test('replacing the selected root during enumeration fails instead of adopting a different tree', async t => {
  const f = fixture(t); f.write('old.md', '원래 폴더');
  const opendir = fs.opendir.bind(fs); let replaced = false;
  t.mock.method(fs, 'opendir', async (path, ...args) => {
    const handle = await opendir(path, ...args);
    if (!replaced && String(path) === f.root) {
      replaced = true; renameSync(f.root, f.root + '-previous'); mkdirSync(f.root); writeFileSync(join(f.root, 'new.md'), '다른 폴더');
    }
    return handle;
  });
  await assert.rejects(scanNotes(f.root), /note_tree_changed/);
});

test('aborted scans never return an authoritative partial snapshot', async t => {
  const f = fixture(t), target = f.write('abort.md', 'x'.repeat(100000));
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(scanNotes(f.root, preAborted.signal), error => error.name === 'AbortError');
  const controller = new AbortController(), open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (String(path) === target) {
      const read = handle.read.bind(handle);
      handle.read = async (...arguments_) => { const result = await read(...arguments_); controller.abort(); return result; };
    }
    return handle;
  });
  await assert.rejects(scanNotes(f.root, controller.signal), error => error.name === 'AbortError');
});

test('per-file and total byte limits fail instead of dropping oversized documents', async t => {
  const f = fixture(t);
  f.write('oversized.md', Buffer.alloc(256 * 1024 + 1, 0x61));
  await assert.rejects(scanNotes(f.root), /note_file_limit/);
  rmSync(join(f.root, 'oversized.md'));
  for (let index = 0; index < 64; index++) f.write(index + '.md', Buffer.alloc(256 * 1024, 0x61));
  assert.equal((await scanNotes(f.root)).documents.length, 64, 'exactly 16 MiB is permitted');
  f.write('over-total.md', 'x');
  await assert.rejects(scanNotes(f.root), /note_total_limit/);
});

test('document count and recursion depth limits reject the full tree', async t => {
  const f = fixture(t);
  for (let index = 0; index < 1000; index++) f.write(index + '.md', 'x');
  assert.equal((await scanNotes(f.root)).documents.length, 1000);
  f.write('overflow.md', 'x'); await assert.rejects(scanNotes(f.root), /note_document_limit/);
  const deep = fixture(t);
  const allowed = Array.from({ length: 32 }, () => 'd').join('/'); deep.write(allowed + '/allowed.md', '내용');
  assert.equal((await scanNotes(deep.root)).documents.length, 1);
  deep.write(allowed + '/d/too-deep.md', '내용'); await assert.rejects(scanNotes(deep.root), /note_depth_limit/);
});

test('the entry limit counts ignored entries too and cannot be bypassed by hidden names', async t => {
  const f = fixture(t), opendir = fs.opendir.bind(fs);
  t.mock.method(fs, 'opendir', async (path, ...args) => {
    if (String(path) !== f.root) return opendir(path, ...args);
    let index = 0;
    return { read: async () => index < 20001 ? { name: '.hidden-' + index++ } : null, close: async () => {} };
  });
  await assert.rejects(scanNotes(f.root), /note_entry_limit/);
});
