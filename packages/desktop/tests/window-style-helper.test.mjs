import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWindowTransparent, windowStyleCommand } from './fixtures/window-style.mjs';

test('native style helper accepts only a numeric test HWND and does not change execution policy', () => {
  for (const handle of ['0', '-1', '1;Remove-Item', "1'", '18446744073709551615', 12])
    assert.throws(() => windowStyleCommand(handle), /invalid_test_window_handle/);
  let calls = 0;
  assert.equal(nativeWindowTransparent('1234', (command, args, options) => {
    calls++;
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const source = Buffer.from(args[3], 'base64').toString('utf16le');
    assert.match(source, /GetWindowLongPtr/);
    assert.match(source, /\} -Handle 1234$/);
    assert.doesNotMatch(source, /ExecutionPolicy|SetWindowLong/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 10000);
    return 'True\r\n';
  }), true);
  assert.equal(calls, 1);
  assert.equal(nativeWindowTransparent('1234', () => 'False\r\n'), false);
  assert.throws(() => nativeWindowTransparent('1234', () => ''), /invalid_test_window_style/);
});
