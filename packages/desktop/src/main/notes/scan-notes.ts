import { createHash } from 'node:crypto';
import { constants, lstatSync, promises as fs, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export interface ScannedNote { path: string; title: string; text: string; }
export interface NoteScan { documents: ScannedNote[]; digest: string; skipped: number; }
const MAX_DOCUMENTS = 1000, MAX_FILE_BYTES = 256 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 20000, MAX_DEPTH = 32;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function beneath(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep));
}
function sameStat(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function changed(): never { throw new Error('note_tree_changed'); }

/** The picker may retain this canonical root; selecting a link or a drive root is rejected. */
export function checkNoteRoot(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error('invalid_note_root');
  const selected = resolve(root);
  if (samePath(selected, parse(selected).root)) throw new Error('invalid_note_root');
  const before = lstatSync(selected, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('invalid_note_root');
  const canonical = realpathSync(selected), after = lstatSync(selected, { bigint: true });
  if (!sameStat(before, after) || !after.isDirectory() || after.isSymbolicLink()) changed();
  if (!sameStat(after, lstatSync(canonical, { bigint: true }))) changed();
  return canonical;
}

function titleFor(path: string): string {
  const stem = basename(path).slice(0, -3);
  let title = '', count = 0;
  for (const { segment } of graphemes.segment(stem)) {
    const length = [...segment].length;
    if (count + length > 120) break;
    title += segment; count += length;
  }
  return title.trim() || '노트';
}

/** Read-only snapshot. No partial result is authoritative after any read or validation failure. */
export async function scanNotes(root: string, signal?: AbortSignal): Promise<NoteScan> {
  signal?.throwIfAborted();
  const selected = resolve(root), canonical = checkNoteRoot(root);
  const firstRoot = lstatSync(canonical, { bigint: true });
  const manifest = new Map<string, BigIntStats>([[canonical, firstRoot]]);
  const directories = new Map<string, BigIntStats>([[canonical, firstRoot]]);
  const documents: ScannedNote[] = [];
  let entries = 0, totalBytes = 0, skipped = 0;

  async function verifyRoot(): Promise<void> {
    signal?.throwIfAborted();
    const current = await fs.lstat(selected, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameStat(firstRoot, current)
      || !samePath(await fs.realpath(selected), canonical)) changed();
  }
  async function verifyDirectory(directory: string): Promise<void> {
    signal?.throwIfAborted();
    const expected = directories.get(directory);
    if (!expected || !beneath(canonical, directory)) changed();
    const current = await fs.lstat(directory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameStat(expected, current)
      || !samePath(await fs.realpath(directory), directory)) changed();
  }
  async function verifyParents(directory: string): Promise<void> {
    await verifyRoot();
    let current = directory;
    for (;;) {
      await verifyDirectory(current);
      if (samePath(current, canonical)) break;
      current = dirname(current);
    }
  }
  async function readNote(path: string, expected: BigIntStats): Promise<string> {
    if (expected.size > BigInt(MAX_FILE_BYTES)) throw new Error('note_file_limit');
    if (expected.size > BigInt(MAX_TOTAL_BYTES - totalBytes)) throw new Error('note_total_limit');
    await verifyParents(dirname(path));
    signal?.throwIfAborted();
    // O_NOFOLLOW protects the open on platforms that expose it. The opened
    // descriptor must also match lstat before any bytes are read (including Windows).
    const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || !sameStat(expected, opened)) changed();
      await verifyParents(dirname(path));
      for (;;) {
        signal?.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_FILE_BYTES + 1 - size, MAX_TOTAL_BYTES + 1 - totalBytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        size += bytesRead; totalBytes += bytesRead;
        if (size > MAX_FILE_BYTES) throw new Error('note_file_limit');
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('note_total_limit');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      if (BigInt(size) !== expected.size || !sameStat(expected, await file.stat({ bigint: true }))) changed();
      const current = await fs.lstat(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !sameStat(expected, current)) changed();
      await verifyParents(dirname(path));
    } finally { await file.close(); }
    let text: string;
    try { text = decoder.decode(Buffer.concat(chunks, size)); }
    catch { throw new Error('note_invalid_encoding'); }
    if (text.startsWith('\uFEFF')) text = text.slice(1);
    if (text.includes('\0')) throw new Error('note_invalid_encoding');
    return text;
  }

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error('note_depth_limit');
    await verifyParents(directory);
    const handle = await fs.opendir(directory, { bufferSize: 32 });
    try {
      await verifyParents(directory);
      for (;;) {
        signal?.throwIfAborted();
        const entry = await handle.read();
        if (!entry) break;
        if (++entries > MAX_ENTRIES) throw new Error('note_entry_limit');
        if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'node_modules') { skipped++; continue; }
        const path = join(directory, entry.name);
        if (!beneath(canonical, path) || dirname(path) !== directory || manifest.has(path)) changed();
        await verifyParents(directory);
        const stat = await fs.lstat(path, { bigint: true });
        manifest.set(path, stat);
        if (stat.isSymbolicLink()) { skipped++; continue; }
        if (stat.isDirectory()) {
          directories.set(path, stat);
          await visit(path, depth + 1);
        } else if (stat.isFile() && /\.md(?![\s\S])/i.test(entry.name)) {
          const text = await readNote(path, stat);
          if (!text.trim()) { skipped++; continue; }
          if (documents.length >= MAX_DOCUMENTS) throw new Error('note_document_limit');
          documents.push({ path: relative(canonical, path).split(sep).join('/'), title: titleFor(path), text });
        } else { skipped++; }
      }
    } finally { await handle.close(); }
    await verifyParents(directory);
  }

  await visit(canonical, 0);
  // Revalidate every encountered visible entry, then the parent tree again.
  // Files changing after their individual read must invalidate the whole result.
  for (const [path, expected] of manifest) {
    signal?.throwIfAborted();
    if (!sameStat(expected, await fs.lstat(path, { bigint: true }))) changed();
  }
  for (const directory of [...directories.keys()].reverse()) await verifyDirectory(directory);
  await verifyRoot();
  signal?.throwIfAborted();
  documents.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash('sha256');
  for (const document of documents) hash.update(JSON.stringify([document.path, document.title, document.text]) + '\n');
  return { documents, digest: hash.digest('hex'), skipped };
}
