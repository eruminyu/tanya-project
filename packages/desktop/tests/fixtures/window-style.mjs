import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('./window-style.ps1', import.meta.url), 'utf8');
export function windowStyleCommand(handle) {
  if (typeof handle !== 'string' || !/^[1-9][0-9]{0,19}$/.test(handle) || BigInt(handle) > 0x7fffffffffffffffn)
    throw Error('invalid_test_window_handle');
  // Execute our fixed read-only helper as a command. Do not change any execution
  // policy or load a caller-provided script; the only data is a validated HWND.
  return Buffer.from("$ProgressPreference = 'SilentlyContinue'; & {\n" + source + '\n} -Handle ' + handle, 'utf16le').toString('base64');
}
export function nativeWindowTransparent(handle, run = execFileSync) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', windowStyleCommand(handle)],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (!['True', 'False'].includes(result.trim())) throw Error('invalid_test_window_style');
  return result.trim() === 'True';
}
