import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Missing files are distinct from corrupt, oversized, or non-regular files. */
export function readJsonSync(file: string, maxBytes = 1024 * 1024): unknown | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_json_limit');
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('invalid_json_file');
  const descriptor = openSync(file, 'r');
  try {
    const current = fstatSync(descriptor);
    if (!current.isFile() || current.size > maxBytes || current.ino !== stat.ino || current.dev !== stat.dev)
      throw new Error('invalid_json_file');
    const chunks: Buffer[] = []; let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1 - size));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      size += count;
      if (size > maxBytes) throw new Error('invalid_json_file');
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, size);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid_json_encoding');
    return JSON.parse(text) as unknown;
  } finally { closeSync(descriptor); }
}

/** The caller owns and validates the containing directory. No in-place truncation. */
export function atomicWriteJsonSync(file: string, value: unknown): void {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('invalid_json_value');
  const temporary = join(dirname(file), '.' + basename(file) + '.' + randomUUID() + '.tmp');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, json + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, file);
    // Windows does not expose directory fsync through Node. The replacement is
    // same-directory and the complete temporary file is flushed before rename.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
