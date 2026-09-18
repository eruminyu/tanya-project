import { randomUUID } from 'node:crypto';
import { BrowserWindow, desktopCapturer, nativeImage, session, type DesktopCapturerSource, type Session } from 'electron';

export interface NativeCaptureSource { id: string; name: string; kind: 'screen' | 'window'; }
export interface NativeCapturedFrame { jpeg: Buffer; width: number; height: number; }
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ORIGIN = 'https://capture.kirian.invalid';
const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Kirian one-shot capture</title></head><body></body></html>';
const CSP = "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; img-src 'none'; media-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const runtime = { BrowserWindow, desktopCapturer, nativeImage, session };
function fail(code: string): never { throw new Error(code); }
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) {
    if (signal.reason?.name === 'TimeoutError') fail('capture_timeout');
    throw new DOMException('Capture cancelled', 'AbortError');
  }
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => { try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}

// Serialized fixed code only: no source IDs, names, caller JavaScript, or URLs are
// interpolated into this isolated document. The main-only display grant picks it.
async function captureOneFrame(): Promise<{ dataUrl: string; width: number; height: number } | { error: string }> {
  let stream: MediaStream | undefined;
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  document.body.append(video);
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { max: 1 } } });
    if (stream.getAudioTracks().length || stream.getVideoTracks().length !== 1) throw new Error('capture_unavailable');
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      const track = stream!.getVideoTracks()[0]!;
      let done = false, frame = 0;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        clearTimeout(timer); video.cancelVideoFrameCallback(frame);
        video.removeEventListener('error', unavailable); track.removeEventListener('ended', unavailable);
        if (error) reject(error); else resolve();
      };
      const unavailable = () => finish(new Error('capture_unavailable'));
      const timer = setTimeout(() => finish(new Error('capture_timeout')), 8000);
      video.addEventListener('error', unavailable, { once: true });
      track.addEventListener('ended', unavailable, { once: true });
      frame = video.requestVideoFrameCallback(() => finish());
      void video.play().catch(unavailable);
    });
    const track = stream.getVideoTracks()[0]!;
    if (track.readyState !== 'live' || track.muted || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1)
      throw new Error('capture_unavailable');
    const scale = Math.min(1, 1600 / video.videoWidth, 1600 / video.videoHeight);
    const width = Math.max(1, Math.floor(video.videoWidth * scale)), height = Math.max(1, Math.floor(video.videoHeight * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('capture_unavailable');
    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    canvas.width = 0; canvas.height = 0;
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 23 + 4 * Math.ceil((4 * 1024 * 1024) / 3)) throw new Error('capture_limit');
    return { dataUrl, width, height };
  } catch (error) {
    const value = error as Error;
    return { error: value.name === 'NotAllowedError' ? 'capture_denied'
      : ['capture_timeout', 'capture_limit', 'capture_unavailable'].includes(value.message) ? value.message : 'capture_unavailable' };
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    video.srcObject = null; video.remove();
  }
}

/** A main-process, one-shot adapter. Listing obtains metadata, never thumbnails. */
export class NativeScreenCapture {
  private allowed = new Map<string, string>();
  private busy = false;
  private readonly partition = 'kirian-one-shot-capture-' + randomUUID();
  private captureSession?: Session;
  private readonly timeoutMs: number;
  constructor(private readonly host = runtime, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 12000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) fail('invalid_request');
  }

  private async metadata(): Promise<DesktopCapturerSource[]> {
    const sources = await this.host.desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    if (sources.length > 2000) fail('capture_unavailable');
    const seen = new Set<string>();
    for (const source of sources) {
      if (!text(source.id, 256) || !/^(screen|window):[0-9]+:[0-9]+(?![\s\S])/.test(source.id)
        || !text(source.name, 4096) || seen.has(source.id)) fail('capture_unavailable');
      seen.add(source.id);
    }
    return sources;
  }

  async listSources(): Promise<NativeCaptureSource[]> {
    const sources = await bounded(this.metadata(), AbortSignal.timeout(this.timeoutMs));
    this.allowed = new Map(sources.map(source => [source.id, source.name]));
    return sources.map(source => ({ id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window' }));
  }

  async capture(sourceId: string, expectedName: string, signal: AbortSignal): Promise<NativeCapturedFrame> {
    aborted(signal);
    if (this.busy) fail('capture_busy');
    if (!text(sourceId, 256) || !text(expectedName, 4096) || this.allowed.get(sourceId) !== expectedName) fail('capture_source_changed');
    this.busy = true;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let window: BrowserWindow | undefined, captureSession: Session | undefined;
    let active = true, requested = false, granted = false, grantError: string | null = null;
    const url = ORIGIN + '/' + randomUUID();
    try {
      const before = (await bounded(this.metadata(), deadline)).find(source => source.id === sourceId);
      aborted(deadline);
      if (!before || before.name !== expectedName) fail('capture_source_changed');
      captureSession = this.captureSession ??= this.host.session.fromPartition(this.partition, { cache: false });
      // A private, non-persistent secure origin needs no packaged HTML asset and
      // never reaches DNS/network. App renderer sessions do not share this grant.
      captureSession.protocol.handle('https', request => request.url === url
        ? new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store' } })
        : new Response('', { status: 403 }));
      captureSession.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !active || request.url !== url }));
      captureSession.setPermissionCheckHandler((contents, permission, origin) => active && !deadline.aborted && contents === window?.webContents
        && permission === 'display-capture' && (origin === ORIGIN || origin === ORIGIN + '/'));
      captureSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        // Electron 44 requests display capture as media with no microphone/camera
        // types. Ordinary audio/video media permissions remain denied.
        const display = permission === 'display-capture' || (permission === 'media' && 'mediaTypes' in details
          && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0);
        callback(active && !deadline.aborted && contents === window?.webContents && display && details.isMainFrame && details.requestingUrl === url);
      });
      captureSession.setDisplayMediaRequestHandler((request, callback) => {
        let replied = false;
        const respond = (streams: Electron.Streams) => {
          if (replied) return; replied = true;
          // The frame may have been destroyed while an OS enumeration was pending.
          try { callback(streams); } catch {}
        };
        if (!active || deadline.aborted || requested || !window || window.isDestroyed()
          || request.frame !== window.webContents.mainFrame || request.frame.url !== url || ![ORIGIN, ORIGIN + '/'].includes(request.securityOrigin)
          || !request.videoRequested || request.audioRequested || !request.userGesture) { respond({}); return; }
        requested = true;
        void bounded(this.metadata(), deadline).then(sources => {
          const selected = sources.find(source => source.id === sourceId);
          if (!active || deadline.aborted || window?.isDestroyed() || request.frame !== window?.webContents.mainFrame || request.frame?.url !== url) { respond({}); return; }
          if (!selected || selected.name !== expectedName) { grantError = 'capture_source_changed'; respond({}); return; }
          granted = true;
          respond({ video: { id: selected.id, name: selected.name } });
        }).catch(() => { grantError = 'capture_unavailable'; respond({}); });
      }, { useSystemPicker: false });
      window = new this.host.BrowserWindow({ width: 64, height: 64, show: false, frame: false, skipTaskbar: true, focusable: false,
        webPreferences: { session: captureSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
          webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, devTools: false, spellcheck: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      await bounded(window.loadURL(url), deadline);
      aborted(deadline);
      const result: unknown = await bounded(window.webContents.executeJavaScript('(' + captureOneFrame.toString() + ')()', true), deadline);
      aborted(deadline);
      if (grantError) fail(grantError);
      if (!result || typeof result !== 'object' || Array.isArray(result)) fail('capture_unavailable');
      const value = result as Record<string, unknown>;
      if (typeof value.error === 'string') fail(['capture_denied', 'capture_timeout', 'capture_limit'].includes(value.error) ? value.error : 'capture_unavailable');
      if (!granted || !Number.isInteger(value.width) || !Number.isInteger(value.height)
        || (value.width as number) < 1 || (value.height as number) < 1 || (value.width as number) > 1600 || (value.height as number) > 1600
        || typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith('data:image/jpeg;base64,')
        || value.dataUrl.length > 23 + 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) fail('capture_unavailable');
      const encoded = value.dataUrl.slice(23), jpeg = Buffer.from(encoded, 'base64');
      if (!jpeg.length || jpeg.length > MAX_IMAGE_BYTES || jpeg.toString('base64') !== encoded
        || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) fail('capture_unavailable');
      const decoded = this.host.nativeImage.createFromBuffer(jpeg), size = decoded.getSize();
      if (decoded.isEmpty() || size.width !== value.width || size.height !== value.height) fail('capture_unavailable');
      // Do not return a frame for a source that vanished/changed title while it was
      // being acquired. Pixel content itself is a point-in-time observation.
      const after = (await bounded(this.metadata(), deadline)).find(source => source.id === sourceId);
      aborted(deadline);
      if (!after || after.name !== expectedName) fail('capture_source_changed');
      return { jpeg, width: size.width, height: size.height };
    } finally {
      active = false;
      if (captureSession) {
        captureSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
        captureSession.setPermissionCheckHandler(() => false);
        captureSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      }
      if (window && !window.isDestroyed()) window.destroy();
      if (captureSession) captureSession.protocol.unhandle('https');
      this.busy = false;
    }
  }
}
