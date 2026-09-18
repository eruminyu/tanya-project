import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: "export { NativeScreenCapture } from './src/main/screens/native-capture.ts';", loader: 'ts',
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'electron-runtime-test-double', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const BrowserWindow = null, desktopCapturer = null, nativeImage = null, session = null;' }));
  } }],
});
const { NativeScreenCapture } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const selected = { id: 'window:123:0', name: 'Owned test window', thumbnail: 'must never use this' };
const other = { id: 'screen:0:0', name: 'Other screen', thumbnail: 'must never use this' };
const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]);
const goodFrame = () => ({ dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), width: 640, height: 360 });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options) {
  const state = { sources: [selected, other], calls: [], windows: [], partitions: [], grants: [], result: goodFrame(), decodedSize: { width: 640, height: 360 } };
  const protocols = new Map();
  const captureSession = {
    protocol: { handle: (scheme, handler) => protocols.set(scheme, handler), unhandle: scheme => protocols.delete(scheme) },
    webRequest: { onBeforeRequest: handler => { state.beforeRequest = handler; } },
    setPermissionCheckHandler: handler => { state.permissionCheck = handler; },
    setPermissionRequestHandler: handler => { state.permissionRequest = handler; },
    setDisplayMediaRequestHandler: (handler, settings) => { state.display = handler; if (settings) state.picker = settings; },
  };
  function request(window, changes = {}, handler = state.display) {
    return new Promise(resolve => handler({ frame: window.webContents.mainFrame, securityOrigin: new URL(window.url).origin,
      videoRequested: true, audioRequested: false, userGesture: true, ...changes }, grant => { state.grants.push(grant); resolve(grant); }));
  }
  const host = {
    desktopCapturer: { getSources: async options => { state.calls.push(options); return state.enumerate ? state.enumerate(state.calls.length) : state.sources; } },
    nativeImage: { createFromBuffer: () => ({ getSize: () => state.decodedSize, isEmpty: () => !!state.decodeEmpty }) },
    session: { fromPartition: (partition, settings) => { state.partitions.push({ partition, settings }); return captureSession; } },
    BrowserWindow: class {
      constructor(options) {
        this.options = options; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
        this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
        this.webContents.executeJavaScript = async (script, gesture) => {
          state.script = script; state.gesture = gesture;
          if (state.execute) return state.execute(this, script, request);
          const grant = await request(this);
          return grant.video ? state.result : { error: 'capture_denied' };
        };
        state.windows.push(this);
      }
      async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; if (state.loadError) throw state.loadError; }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; this.webContents.emit('destroyed'); }
    },
  };
  return { state, host, protocols, request, adapter: new NativeScreenCapture(host, options) };
}
const capture = adapter => adapter.capture(selected.id, selected.name, new AbortController().signal);

test('source enumeration obtains no thumbnails or icons and returned metadata cannot alter the grant', async () => {
  const f = fixture(), listing = await f.adapter.listSources();
  assert.deepEqual(listing, [{ id: selected.id, name: selected.name, kind: 'window' }, { id: other.id, name: other.name, kind: 'screen' }]);
  listing[0].name = 'mutated';
  assert.deepEqual(await capture(f.adapter), { jpeg, width: 640, height: 360 });
  for (const call of f.state.calls) assert.deepEqual(call, { types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  assert.deepEqual(f.state.grants, [{ video: { id: selected.id, name: selected.name } }]);
  assert.equal(f.state.windows[0].destroyed, true);
});

test('unlisted or renamed/disappeared sources fail without opening a capture window', async () => {
  const f = fixture(); await assert.rejects(capture(f.adapter), /capture_source_changed/);
  await f.adapter.listSources();
  f.state.sources = [{ ...selected, name: 'Different document' }];
  await assert.rejects(capture(f.adapter), /capture_source_changed/);
  f.state.sources = [other]; await assert.rejects(capture(f.adapter), /capture_source_changed/);
  assert.equal(f.state.windows.length, 0); assert.deepEqual(f.state.grants, []);
});

test('the grant revalidates the OS source, refusing a changed name before requesting pixels', async () => {
  const f = fixture(); await f.adapter.listSources();
  f.state.enumerate = call => call === 3 ? [{ ...selected, name: 'Now another window' }] : [selected, other];
  await assert.rejects(capture(f.adapter), /capture_source_changed/);
  assert.deepEqual(f.state.grants, [{}]); assert.equal(f.state.windows[0].destroyed, true);
});

test('only the internal main frame receives one video-only grant and other permissions/network/navigation are denied', async () => {
  const f = fixture(); await f.adapter.listSources();
  f.state.execute = async (window, script, request) => {
    assert.equal(f.state.permissionCheck(window.webContents, 'display-capture', new URL(window.url).origin), true);
    for (const permission of ['media', 'notifications', 'clipboard-read']) assert.equal(f.state.permissionCheck(window.webContents, permission, new URL(window.url).origin), false);
    assert.equal(f.state.permissionCheck({}, 'display-capture', new URL(window.url).origin), false);
    assert.equal(f.state.permissionCheck(window.webContents, 'display-capture', 'https://other.invalid'), false);
    for (const [mediaTypes, allowed] of [[[], true], [['audio'], false], [['video'], false], [['audio', 'video'], false]])
      f.state.permissionRequest(window.webContents, 'media', value => assert.equal(value, allowed), { isMainFrame: true, requestingUrl: window.url, mediaTypes });
    f.state.permissionRequest({}, 'media', value => assert.equal(value, false), { isMainFrame: true, requestingUrl: window.url, mediaTypes: [] });
    assert.equal((await f.protocols.get('https')({ url: window.url })).headers.get('content-security-policy').includes("connect-src 'none'"), true);
    assert.equal((await f.protocols.get('https')({ url: 'https://other.invalid' })).status, 403);
    f.state.beforeRequest({ url: 'https://other.invalid' }, result => assert.equal(result.cancel, true));
    f.state.beforeRequest({ url: window.url }, result => assert.equal(result.cancel, false));
    assert.deepEqual(window.popup(), { action: 'deny' });
    let prevented = 0;
    window.webContents.emit('will-navigate', { preventDefault: () => prevented++ });
    window.webContents.emit('will-attach-webview', { preventDefault: () => prevented++ });
    assert.equal(prevented, 2);
    for (const invalid of [{ frame: { url: window.url } }, { audioRequested: true }, { videoRequested: false }, { userGesture: false }, { securityOrigin: 'https://other.invalid' }])
      assert.deepEqual(await request(window, invalid), {});
    assert.deepEqual(await request(window, { securityOrigin: new URL(window.url).origin + '/' }), { video: { id: selected.id, name: selected.name } });
    assert.deepEqual(await request(window), {});
    return goodFrame();
  };
  await capture(f.adapter);
  const window = f.state.windows[0];
  assert.equal(window.options.show, false); assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(f.state.partitions[0].partition.startsWith('persist:'), false);
  assert.deepEqual(f.state.picker, { useSystemPicker: false }); assert.equal(f.state.gesture, true);
  assert.equal(f.protocols.size, 0); assert.equal(f.state.permissionCheck(window.webContents, 'display-capture', new URL(window.url).origin), false);
});

test('abort destroys the worker, denies late callbacks, and releases the busy guard without retaining an active grant', async () => {
  const f = fixture(), entered = defer(), stalled = defer(); await f.adapter.listSources();
  const controller = new AbortController(); let oldHandler, oldWindow;
  f.state.execute = async window => { oldHandler = f.state.display; oldWindow = window; entered.resolve(); return stalled.promise; };
  const pending = f.adapter.capture(selected.id, selected.name, controller.signal);
  await entered.promise; await assert.rejects(capture(f.adapter), /capture_busy/); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(oldWindow.destroyed, true);
  assert.deepEqual(await f.request(oldWindow, {}, oldHandler), {});
  stalled.resolve(goodFrame()); f.state.execute = null;
  await capture(f.adapter); assert.equal(f.state.partitions.length, 1, 'one in-memory session is reused without accumulating session partitions');
});

test('OS enumeration deadlines and loading failures fail closed and allow a later retry', async t => {
  const f = fixture({ timeoutMs: 25 }); await f.adapter.listSources();
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  f.state.enumerate = () => new Promise(() => {});
  await assert.rejects(capture(f.adapter), /capture_timeout/); assert.equal(f.state.windows.length, 0);
  f.state.enumerate = null; f.state.loadError = new Error('test load failure');
  await assert.rejects(capture(f.adapter), /test load failure/);
  assert.equal(f.state.windows[0].destroyed, true); assert.equal(f.protocols.size, 0);
  f.state.loadError = null; await capture(f.adapter);
});

test('malformed, oversized or mismatched JPEG results are never returned', async () => {
  for (const mutate of [
    f => { f.state.result.width = 1601; },
    f => { f.state.result.dataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(4 * Math.ceil(4 * 1024 * 1024 / 3) + 4); },
    f => { f.state.result.dataUrl += '\n'; },
    f => { f.state.result.dataUrl = 'data:image/png;base64,' + jpeg.toString('base64'); },
    f => { f.state.result.dataUrl = 'data:image/jpeg;base64,' + Buffer.from('not jpeg').toString('base64'); },
    f => { f.state.decodeEmpty = true; },
    f => { f.state.decodedSize = { width: 10, height: 10 }; },
  ]) {
    const f = fixture(); await f.adapter.listSources(); mutate(f);
    await assert.rejects(capture(f.adapter), /capture_unavailable/); assert.equal(f.state.windows[0].destroyed, true);
  }
});

test('a source disappearing after acquisition discards the frame and cleans up', async () => {
  const f = fixture(); await f.adapter.listSources();
  f.state.enumerate = call => call === 4 ? [other] : [selected, other];
  await assert.rejects(capture(f.adapter), /capture_source_changed/);
  assert.equal(f.state.windows[0].destroyed, true);
});

test('the actual serialized frame script scales one video frame, never requests audio, and stops all tracks', async () => {
  const f = fixture(); await f.adapter.listSources();
  const track = new EventEmitter(); track.readyState = 'live'; track.muted = false;
  track.addEventListener = track.on.bind(track); track.removeEventListener = track.off.bind(track);
  let stopped = 0, removed = 0, drawn, constraints;
  track.stop = () => stopped++;
  const video = new EventEmitter(); video.videoWidth = 3840; video.videoHeight = 2160; video.readyState = 2;
  video.addEventListener = video.on.bind(video); video.removeEventListener = video.off.bind(video);
  video.requestVideoFrameCallback = callback => { video.frame = callback; return 1; };
  video.cancelVideoFrameCallback = () => {};
  video.play = async () => { queueMicrotask(() => video.frame()); }; video.remove = () => removed++;
  const canvas = { getContext: () => ({ drawImage: (...args) => { drawn = args; } }), toDataURL: (type, quality) => {
    assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.85); return goodFrame().dataUrl;
  } };
  f.state.decodedSize = { width: 1600, height: 900 };
  f.state.execute = async (window, script, request) => {
    await request(window);
    return runInNewContext(script, { document: { body: { append: () => {} }, createElement: tag => tag === 'video' ? video : canvas },
      navigator: { mediaDevices: { getDisplayMedia: async value => {
        constraints = value; return { getAudioTracks: () => [], getVideoTracks: () => [track], getTracks: () => [track] };
      } } }, setTimeout, clearTimeout });
  };
  const result = await capture(f.adapter);
  assert.equal(constraints.audio, false); assert.equal(result.width, 1600); assert.equal(result.height, 900);
  assert.deepEqual(drawn.slice(1), [0, 0, 1600, 900]); assert.equal(stopped, 1); assert.equal(removed, 1);
  assert.equal(video.srcObject, null); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
});

test('real Electron captures only an owned synthetic window through the isolated one-shot adapter', {
  skip: process.env.KIRIAN_NATIVE_CAPTURE_TEST !== '1', timeout: 45000,
}, async () => {
  const desktop = fileURLToPath(new URL('../', import.meta.url)), output = join(desktop, '.test-output');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'native-capture-')), entry = join(directory, 'probe.cjs');
  const source = `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { app, BrowserWindow, desktopCapturer, nativeImage, session } from 'electron';
    import { NativeScreenCapture } from './src/main/screens/native-capture.ts';
    const output = ${JSON.stringify(directory)};
    app.setPath('userData', join(output, 'profile'));
    app.on('window-all-closed', () => {});
    app.whenReady().then(async () => {
      let fixture; const diagnostic = [];
      try {
        fixture = new BrowserWindow({ width: 420, height: 280, show: false, focusable: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Kirian owned capture fixture</title><body style="margin:0;background:rgb(31,89,147);color:white;font:24px sans-serif">KIRIAN CAPTURE FIXTURE</body>'));
        fixture.showInactive();
        await new Promise(resolve => setTimeout(resolve, 350));
        const debugSession = { fromPartition(partition, options) {
          const value = session.fromPartition(partition, options);
          const check = value.setPermissionCheckHandler.bind(value), request = value.setPermissionRequestHandler.bind(value), display = value.setDisplayMediaRequestHandler.bind(value);
          value.setPermissionCheckHandler = handler => check((contents, permission, origin, details) => {
            const allowed = handler(contents, permission, origin, details); diagnostic.push({ kind: 'check', permission, origin, allowed }); return allowed;
          });
          value.setPermissionRequestHandler = handler => request((contents, permission, callback, details) => {
            diagnostic.push({ kind: 'request', permission, details }); handler(contents, permission, callback, details);
          });
          value.setDisplayMediaRequestHandler = (handler, options) => display((request, callback) => {
            diagnostic.push({ kind: 'display', origin: request.securityOrigin, frame: request.frame?.url, audio: request.audioRequested, video: request.videoRequested, gesture: request.userGesture });
            handler(request, streams => { diagnostic.push({ kind: 'grant', granted: !!streams.video }); callback(streams); });
          }, options);
          return value;
        } };
        const adapter = new NativeScreenCapture({ BrowserWindow, desktopCapturer, nativeImage, session: debugSession });
        const selected = (await adapter.listSources()).find(source => source.id === fixture.getMediaSourceId());
        assert(selected, 'owned test window is not available to capture');
        const result = await adapter.capture(selected.id, selected.name, new AbortController().signal);
        const pixels = nativeImage.createFromBuffer(result.jpeg).toBitmap();
        let expectedPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4)
          if (Math.abs(pixels[offset] - 147) < 8 && Math.abs(pixels[offset + 1] - 89) < 8 && Math.abs(pixels[offset + 2] - 31) < 8) expectedPixels++;
        assert(expectedPixels > 1000, 'captured image does not contain the owned fixture color');
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'capture worker must be destroyed');
        await writeFile(join(output, 'owned-fixture.jpg'), result.jpeg);
        fixture.minimize();
        await new Promise(resolve => setTimeout(resolve, 250));
        await assert.rejects(adapter.capture(selected.id, selected.name, new AbortController().signal), /capture_(source_changed|unavailable|timeout|denied)/);
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'failed capture worker must also be destroyed');
        await writeFile(join(output, 'result.json'), JSON.stringify({ width: result.width, height: result.height, bytes: result.jpeg.length, expectedPixels }));
        fixture.destroy(); app.exit(0);
      } catch (error) {
        await writeFile(join(output, 'error.txt'), String(error?.stack ?? error) + '\\n' + JSON.stringify(diagnostic));
        fixture?.destroy(); app.exit(1);
      }
    });
  `;
  await build({ stdin: { contents: source, loader: 'ts', resolveDir: desktop }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: entry });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0) {
    try { diagnostic += '\n' + await readFile(join(directory, 'error.txt'), 'utf8'); } catch {}
  }
  assert.equal(code, 0, diagnostic);
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert(result.width > 0 && result.width <= 1600 && result.height > 0 && result.height <= 1600);
  assert(result.bytes > 0 && result.bytes <= 4 * 1024 * 1024);
});
