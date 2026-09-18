import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

export type NoteFileGrant = { root: string; rootIdentity: string };
export type NoteFileSnapshot = { bytes: Buffer; sha256: string; identity: string };
export type NoteFileWrite = { expectedSha256: string; expectedIdentity: string; bytes: Buffer };
export type NoteFileWriteResult = { status: 'succeeded' | 'failed' | 'unknown'; error: string | null };
const LIMIT = 256 * 1024, OUTPUT_LIMIT = 400 * 1024, TIMEOUT_MS = 20_000;
const identityPattern = /^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})(?![\s\S])/;
const hashPattern = /^[a-f0-9]{64}(?![\s\S])/;
const errors = new Set(['invalid_note_path', 'note_file_unsafe', 'note_root_changed', 'note_file_conflict',
  'note_file_unavailable', 'note_file_limit', 'note_invalid_encoding', 'note_io_failed', 'note_write_unknown']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function validate(grant: NoteFileGrant, path: string): void {
  if (!grant || typeof grant.root !== 'string' || grant.root.length > 4096
    || !/^[A-Za-z]:\\/.test(grant.root) || /[\x00-\x1f\x7f]/.test(grant.root)
    || win32.normalize(grant.root).replace(/\\$/, '').toLowerCase() !== grant.root.replace(/\\$/, '').toLowerCase()
    || grant.root.replace(/\\$/, '').length <= 2 || typeof grant.rootIdentity !== 'string'
    || !identityPattern.test(grant.rootIdentity)) throw new Error('invalid_note_path');
  if (typeof path !== 'string' || path.length > 1024 || !/\.md$/i.test(path) || path.split('/').length > 32)
    throw new Error('invalid_note_path');
  for (const part of path.split('/')) {
    if (!part || part.startsWith('.') || /[<>:"\\|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error('invalid_note_path');
  }
}
function validateBytes(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new Error('note_file_limit');
  try { if (decoder.decode(bytes).includes('\0')) throw new Error(); }
  catch { throw new Error('note_invalid_encoding'); }
}

// Fixed source only: paths, hashes and note contents are data read from stdin.
// Pin directories against rename, then compare and write through ONE file handle.
// FILE_SHARE_READ prevents a writer/delete handle from coexisting with this handle.
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
const helper = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public class KirianNoteResult {
  public string status, error, bytes, sha256, identity;
}
public static class KirianNoteFile {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, IntPtr available, IntPtr left);
  const uint Read = 0x80000000, Write = 0x40000000, Reparse = 0x400, Directory = 0x10;
  const int Limit = 262144;
  static string Native(string path) { return @"\\?\" + path; }
  static Info Stat(SafeFileHandle handle) {
    Info info; if (!GetFileInformationByHandle(handle, out info)) throw new Exception("note_file_unavailable"); return info;
  }
  static string Identity(Info info) { return info.volume.ToString() + ":" + (((ulong)info.indexHigh << 32) | info.indexLow).ToString(); }
  static string Hash(byte[] bytes) { using (SHA256 hash = SHA256.Create()) { return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); } }
  static void Utf8(byte[] bytes) { if (new UTF8Encoding(false, true).GetString(bytes).IndexOf('\0') >= 0) throw new Exception("note_invalid_encoding"); }
  static byte[] ReadAll(FileStream file) {
    if (file.Length > Limit) throw new Exception("note_file_limit");
    byte[] bytes = new byte[(int)file.Length]; file.Position = 0; int offset = 0;
    while (offset < bytes.Length) { int read = file.Read(bytes, offset, bytes.Length - offset); if (read == 0) throw new Exception("note_io_failed"); offset += read; }
    if (file.ReadByte() != -1) throw new Exception("note_file_conflict"); return bytes;
  }
  static void Pin(string directory, List<SafeFileHandle> held) {
    SafeFileHandle handle = CreateFileW(Native(directory), 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Exception("note_file_unavailable"); }
    held.Add(handle); Info info = Stat(handle);
    if ((info.attributes & Reparse) != 0 || (info.attributes & Directory) == 0) throw new Exception("note_file_unsafe");
  }
  public static KirianNoteResult Run(string root, string rootIdentity, string relative, bool write, string expectedHash, string expectedIdentity, string encoded) {
    bool mutated = false; var held = new List<SafeFileHandle>();
    try {
      byte[] replacement = write ? Convert.FromBase64String(encoded) : null;
      if (write) { if (replacement.Length > Limit) throw new Exception("note_file_limit"); Utf8(replacement); }
      root = Path.GetFullPath(root).TrimEnd('\\');
      string current = Path.GetPathRoot(root); Pin(current, held);
      foreach (string component in root.Substring(current.Length).Split('\\')) { current = Path.Combine(current, component); Pin(current, held); }
      if (Identity(Stat(held[held.Count - 1])) != rootIdentity) throw new Exception("note_root_changed");
      string[] parts = relative.Split('/');
      for (int i = 0; i < parts.Length - 1; i++) { current = Path.Combine(current, parts[i]); Pin(current, held); }
      string target = Path.Combine(current, parts[parts.Length - 1]);
      using (SafeFileHandle handle = CreateFileW(Native(target), Read | (write ? Write : 0), 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Exception("note_file_unavailable");
        Info info = Stat(handle);
        if ((info.attributes & (Reparse | Directory)) != 0 || info.links != 1) throw new Exception("note_file_unsafe");
        string identity = Identity(info);
        using (FileStream file = new FileStream(handle, write ? FileAccess.ReadWrite : FileAccess.Read, 4096, false)) {
          byte[] original = ReadAll(file); string hash = Hash(original);
          if (!write) return new KirianNoteResult { status = "succeeded", bytes = Convert.ToBase64String(original), sha256 = hash, identity = identity };
          if (identity != expectedIdentity || hash != expectedHash) throw new Exception("note_file_conflict");
          // The parent keeps the sole stdin writer open. Its death closes that
          // exact handle, so an orphan cannot start writing after restart recovery.
          // This check holds the file's write lock: recovery cannot pass us if the
          // parent dies immediately AFTER this check. Unlike PIDs, pipes aren't reused.
          if (!PeekNamedPipe(GetStdHandle(-10), IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero)) throw new Exception("note_file_unavailable");
          // The caller has already durably recorded the exact original bytes and
          // consumed the approval. Any interruption after here is an unknown write.
          mutated = true; file.Position = 0; file.Write(replacement, 0, replacement.Length); file.SetLength(replacement.Length); file.Flush(true);
          if (Hash(ReadAll(file)) != Hash(replacement) || Identity(Stat(handle)) != identity) throw new Exception("note_write_unknown");
          return new KirianNoteResult { status = "succeeded" };
        }
      }
    } catch (DecoderFallbackException) { return new KirianNoteResult { status = mutated ? "unknown" : "failed", error = "note_invalid_encoding" }; }
    catch (Exception exception) { return new KirianNoteResult { status = mutated ? "unknown" : "failed", error = mutated ? "note_write_unknown" : exception.Message.StartsWith("note_") ? exception.Message : "note_io_failed" }; }
    finally { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); }
  }
}
'@
try {
  $inputText = [Console]::In.ReadLine()
  if ($inputText.Length -gt 380000) { throw 'oversized' }
  $request = ConvertFrom-Json -InputObject $inputText
  $result = [KirianNoteFile]::Run($request.root, $request.rootIdentity, $request.path, $request.write, $request.expectedSha256, $request.expectedIdentity, $request.bytes)
  [Console]::WriteLine((ConvertTo-Json -InputObject $result -Compress))
} catch {
  if ($request -and $request.write) { [Console]::WriteLine('{"status":"unknown","error":"note_write_unknown","bytes":null,"sha256":null,"identity":null}') }
  else { [Console]::WriteLine('{"status":"failed","error":"note_io_failed","bytes":null,"sha256":null,"identity":null}') }
}
`;
const encodedHelper = Buffer.from(helper, 'utf16le').toString('base64');
type Response = { status: 'succeeded' | 'failed' | 'unknown'; error: string | null; bytes: string | null; sha256: string | null; identity: string | null };

async function run(request: object, write: boolean, signal?: AbortSignal): Promise<Response> {
  const failure = (status: 'failed' | 'unknown', error: string): Response => ({ status, error, bytes: null, sha256: null, identity: null });
  if (signal?.aborted) return failure('failed', 'note_cancelled');
  if (process.platform !== 'win32') return failure('failed', 'note_helper_unavailable');
  const windows = process.env.SystemRoot;
  if (!windows || !/^[A-Za-z]:\\[^\x00-\x1f]*$/.test(windows)) return failure('failed', 'note_helper_unavailable');
  return new Promise(resolve => {
    let launched = false, finished = false, invalid = false, output = '', outputSize = 0, errorSize = 0;
    const child = spawn(win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedHelper],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const ambiguous = (): Response => failure(write && launched ? 'unknown' : 'failed', write && launched ? 'note_write_unknown' : 'note_io_failed');
    const stop = (): void => { invalid = true; child.kill(); };
    const timer = setTimeout(stop, TIMEOUT_MS); timer.unref();
    const complete = (result: Response): void => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); child.stdin.destroy(); resolve(result);
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.on('spawn', () => { launched = true; if (signal?.aborted) stop(); });
    child.on('error', () => { if (launched) stop(); else complete(failure('failed', 'note_helper_unavailable')); });
    child.stdin.on('error', stop);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { outputSize += Buffer.byteLength(chunk); if (outputSize > OUTPUT_LIMIT) stop(); else output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { errorSize += chunk.length; if (errorSize > 16 * 1024) stop(); });
    child.on('close', code => {
      if (invalid || code !== 0) return complete(ambiguous());
      try {
        const result = JSON.parse(output) as Response;
        if (!result || Object.keys(result).sort().join(',') !== 'bytes,error,identity,sha256,status'
          || !['succeeded', 'failed', 'unknown'].includes(result.status)
          || (result.error !== null && !errors.has(result.error))) throw new Error();
        if (result.status === 'succeeded') {
          if (result.error !== null) throw new Error();
          if (write) { if (result.bytes !== null || result.sha256 !== null || result.identity !== null) throw new Error(); }
          else if (typeof result.bytes !== 'string' || !hashPattern.test(result.sha256 ?? '') || !identityPattern.test(result.identity ?? '')) throw new Error();
        } else if (!result.error || result.bytes !== null || result.sha256 !== null || result.identity !== null) throw new Error();
        complete(result);
      } catch { complete(ambiguous()); }
    });
    // Keep this private pipe writer alive until the helper exits. The native
    // pre-write check binds execution to this process lifetime without PID races.
    child.stdin.write(JSON.stringify(request) + '\n');
    if (signal?.aborted) stop();
  });
}

/** Raw bytes support recovery of interrupted writes. The editor must decode UTF-8 separately. */
export async function readNoteFile(grant: NoteFileGrant, path: string, signal?: AbortSignal): Promise<NoteFileSnapshot> {
  validate(grant, path);
  const result = await run({ root: grant.root, rootIdentity: grant.rootIdentity, path, write: false }, false, signal);
  if (result.status !== 'succeeded' || result.bytes === null || result.sha256 === null || result.identity === null) throw new Error(result.error ?? 'note_io_failed');
  const bytes = Buffer.from(result.bytes, 'base64');
  if (bytes.length > LIMIT) throw new Error('note_file_limit');
  if (bytes.toString('base64') !== result.bytes || createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw new Error('note_io_failed');
  return { bytes, sha256: result.sha256, identity: result.identity };
}

/** Call only AFTER durably storing original bytes and consuming the approval. Never retry an unknown result. */
export async function writeNoteFile(grant: NoteFileGrant, path: string, change: NoteFileWrite, signal?: AbortSignal): Promise<NoteFileWriteResult> {
  try {
    validate(grant, path); validateBytes(change.bytes);
    if (typeof change.expectedSha256 !== 'string' || !hashPattern.test(change.expectedSha256)
      || typeof change.expectedIdentity !== 'string' || !identityPattern.test(change.expectedIdentity)) throw new Error('invalid_note_path');
  } catch (error) { return { status: 'failed', error: error instanceof Error && errors.has(error.message) ? error.message : 'invalid_note_path' }; }
  const result = await run({ root: grant.root, rootIdentity: grant.rootIdentity, path, write: true, expectedSha256: change.expectedSha256,
    expectedIdentity: change.expectedIdentity, bytes: change.bytes.toString('base64') }, true, signal);
  return { status: result.status, error: result.error };
}
