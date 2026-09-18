// The public gateway process: static web files, visitor session tokens and one WebSocket per visitor that
// speaks a small snapshot/command protocol. The Brain stays on loopback behind it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { GatewayConfig } from './config.js';
import { SessionLimiter, TurnSlots, clientKey } from './limits.js';
import { VisitorSession, validatePublicCatalog, type PublicCatalog } from './visitor-session.js';
import { handoffExecutor, type CalendarExecutor } from './demo-calendar.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.wasm': 'application/wasm', '.moc3': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; "
  + "media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const MAX_BROWSER_MESSAGE = 8192;
const CATALOG_TTL_MS = 300_000;

interface VisitorToken { key: string; expiresAt: number; }

export interface GatewayOptions extends GatewayConfig {
  now?: () => number;
  /** Calendar executor for approved drafts; defaults to the hand-off executor for the configured calendar view. */
  executor?: CalendarExecutor | null;
}

export interface Gateway {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Live counters for the health endpoint and tests. */
  stats(): { sessions: number; turnsInUse: number; tokens: number };
}

export function createGateway(options: GatewayOptions): Gateway {
  const now = options.now ?? Date.now;
  const limiter = new SessionLimiter(options.limits.sessionsPerHour, options.limits.concurrentPerClient, options.limits.concurrentTotal, now);
  const slots = new TurnSlots(options.limits.concurrentTurns);
  const tokens = new Map<string, VisitorToken>();
  const sessions = new Set<VisitorSession>();
  const staticRoot = options.staticDir ? resolve(options.staticDir) : null;
  const executor = options.executor === undefined
    ? handoffExecutor({ id: 'visitor', label: options.calendarLabel, timeZone: options.calendarTimeZone, accessRole: 'owner', canWrite: true }, now)
    : options.executor;
  let catalog: { value: PublicCatalog; fetchedAt: number } | null = null;

  async function loadCatalog(): Promise<PublicCatalog> {
    if (catalog && now() - catalog.fetchedAt < CATALOG_TTL_MS) return catalog.value;
    const response = await fetch(new URL('v1/config', options.brainUrl), { headers: { Authorization: 'Bearer ' + options.brainToken },
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('brain_unavailable'); }
    const text = await response.text();
    if (text.length > 65536) throw new Error('invalid_catalog');
    const value = validatePublicCatalog(JSON.parse(text));
    catalog = { value, fetchedAt: now() };
    return value;
  }

  function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    response.end(payload);
  }

  function pruneTokens(): void {
    const moment = now();
    for (const [token, record] of tokens) if (record.expiresAt <= moment) { tokens.delete(token); limiter.release(record.key); }
  }

  async function issueSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    pruneTokens();
    let value: PublicCatalog;
    try { value = await loadCatalog(); } catch { json(response, 503, { error: 'brain_unavailable' }); return; }
    const key = clientKey(request.headers, request.socket.remoteAddress, options.trustProxy);
    const decision = limiter.acquire(key);
    if (!decision.allowed) { json(response, 429, { error: decision.reason, retryAfterSeconds: decision.retryAfterSeconds }, { 'Retry-After': String(decision.retryAfterSeconds) }); return; }
    const token = randomBytes(24).toString('base64url');
    tokens.set(token, { key, expiresAt: now() + options.limits.tokenSeconds * 1000 });
    const model = value.models.find(item => item.model.model_id === value.default_selection.model.model_id) ?? value.models[0]!;
    json(response, 200, { token, expiresInSeconds: options.limits.tokenSeconds,
      demo: { modelLabel: model.label, speechAvailable: Boolean(value.speech), speechLabel: value.speech?.label ?? null,
        turnsPerSession: options.limits.turnsPerSession, messageCharacters: options.limits.messageCharacters, idleSeconds: options.limits.idleSeconds,
        calendar: executor && model.supports_tools === true ? { kind: executor.kind, label: executor.calendar.label, timeZone: executor.calendar.timeZone } : null } });
  }

  async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    if (!staticRoot) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    let relative = decodeURIComponent(pathname);
    if (relative.endsWith('/')) relative += 'index.html';
    const target = normalize(join(staticRoot, relative));
    if (target !== staticRoot && !target.startsWith(staticRoot + sep)) { response.writeHead(403); response.end(); return; }
    let info;
    try { info = await stat(target); } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    if (!info.isFile()) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('not found'); return; }
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const html = type.startsWith('text/html');
    const headers: Record<string, string> = { 'Content-Type': type, 'Content-Length': String(info.size), 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': html ? 'no-cache' : relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' };
    if (html) Object.assign(headers, { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(target).pipe(response);
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gateway.invalid');
    if (url.pathname === '/demo/session') {
      if (request.method !== 'POST') { json(response, 405, { error: 'method_not_allowed' }); return; }
      void issueSession(request, response);
      return;
    }
    if (url.pathname === '/demo/health') { json(response, 200, { ok: true, ...stats() }); return; }
    if (url.pathname === '/demo/calendar') {
      if (request.method !== 'GET') { json(response, 405, { error: 'method_not_allowed' }); return; }
      if (!executor?.listUpcoming) { json(response, 404, { error: 'no_public_calendar' }); return; }
      executor.listUpcoming().then(events => json(response, 200, { calendar: { kind: executor.kind, label: executor.calendar.label, timeZone: executor.calendar.timeZone }, events }),
        () => json(response, 503, { error: 'calendar_unavailable' }));
      return;
    }
    if (url.pathname === '/demo/ws') { json(response, 426, { error: 'upgrade_required' }); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: 'method_not_allowed' }); return; }
    void serveStatic(request, response, url.pathname);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_BROWSER_MESSAGE });

  function attach(browser: WebSocket, key: string): void {
    let visitor: VisitorSession | null = null;
    let released = false;
    const release = () => { if (!released) { released = true; limiter.release(key); } };
    // Reverse proxies (nginx/Cloudflare) drop a WebSocket that carries no frames for ~60-100 s; a visitor reading
    // a long answer or waiting for a proactive card would lose the session. Server pings keep it alive.
    const keepalive = setInterval(() => { if (browser.readyState === WebSocket.OPEN) browser.ping(); }, 25_000);
    keepalive.unref?.();
    const send = (value: unknown) => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(value)); };
    const finish = (reason: string, detail?: { deletedEvents: number }) => {
      send({ kind: 'closed', reason, ...(detail ?? {}) });
      if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) browser.close(1000, reason.slice(0, 120));
      release();
    };
    void (async () => {
      let value: PublicCatalog;
      try { value = await loadCatalog(); } catch { finish('brain_unavailable'); return; }
      if (browser.readyState !== WebSocket.OPEN) { release(); return; }
      const session = new VisitorSession({ brainUrl: options.brainUrl, brainToken: options.brainToken, catalog: value, slots, ...(executor ? { executor } : {}),
        limits: { turnsPerSession: options.limits.turnsPerSession, messageCharacters: options.limits.messageCharacters,
          idleMs: options.limits.idleSeconds * 1000, sessionMs: options.limits.sessionSeconds * 1000 },
        proactiveLeadMs: options.limits.proactiveLeadMinutes * 60_000, proactiveCalendarLabel: options.calendarLabel,
        events: {
          snapshot: snapshot => send({ kind: 'snapshot', snapshot }),
          audio: event => send(event.kind === 'reset' ? { kind: 'audio-reset' }
            : { kind: 'audio', playbackId: event.playbackId, sentence: event.sentence, audioBase64: Buffer.from(event.data).toString('base64') }),
          closed: (reason, detail) => { sessions.delete(session); finish(reason, detail); },
        } });
      visitor = session;
      sessions.add(session);
      try { await session.open(); } catch { return; }
      send({ kind: 'snapshot', snapshot: session.snapshot() });
    })();
    browser.on('message', (data, binary) => {
      if (binary || !visitor) { finish('protocol_error'); return; }
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { finish('protocol_error'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { finish('protocol_error'); return; }
      const command = value as { id?: unknown; kind?: unknown; text?: unknown; enabled?: unknown; playbackId?: unknown; state?: unknown; draftId?: unknown; cardId?: unknown };
      const id = typeof command.id === 'number' && Number.isSafeInteger(command.id) ? command.id : null;
      let result;
      switch (command.kind) {
        case 'send': result = visitor.sendText(command.text); break;
        case 'cancel': result = visitor.cancelTurn(); break;
        case 'voice': result = visitor.setVoiceEnabled(command.enabled); break;
        case 'playback': result = visitor.reportPlayback({ playbackId: command.playbackId, state: command.state }); break;
        case 'approve': void visitor.approveDraft(command.draftId).then(value => { if (id !== null) send({ kind: 'result', id, result: value }); }); return;
        case 'reject': result = visitor.rejectDraft(command.draftId); break;
        case 'dismiss': result = visitor.dismissSuggestion(command.cardId); break;
        case 'finish': {
          const session = visitor;
          void session.finish().then(detail => {
            if (id !== null) send({ kind: 'result', id, result: detail ? { ok: true } : { ok: false, code: 'invalid_request' } });
            if (detail) session.close('finished', detail);
          });
          return;
        }
        default: finish('protocol_error'); return;
      }
      if (id !== null) send({ kind: 'result', id, result });
    });
    browser.on('close', () => { clearInterval(keepalive); visitor?.close('browser_closed'); release(); });
    browser.on('error', () => { clearInterval(keepalive); visitor?.close('browser_closed'); release(); });
  }

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://gateway.invalid');
    const token = url.searchParams.get('token') ?? '';
    pruneTokens();
    const record = tokens.get(token);
    if (url.pathname !== '/demo/ws' || !record || [...url.searchParams.keys()].some(name => name !== 'token')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    tokens.delete(token);
    // The token already counted as one session for its client key; the socket inherits that count.
    sockets.handleUpgrade(request, socket, head, browser => attach(browser, record.key));
  });

  function stats() { return { sessions: sessions.size, turnsInUse: slots.inUse(), tokens: tokens.size }; }
  let sweeper: NodeJS.Timeout | null = null;

  return {
    listen: () => new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('listen_failed')); return; }
        if (executor?.sweep) {
          void executor.sweep(true).catch(() => {});
          sweeper = setInterval(() => { void executor.sweep!().catch(() => {}); }, 60_000);
        }
        resolvePromise({ host: address.address, port: address.port });
      });
    }),
    close: async () => {
      if (sweeper) clearInterval(sweeper);
      for (const session of [...sessions]) session.close('gateway_stopping');
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>(resolvePromise => sockets.close(() => resolvePromise()));
      server.closeAllConnections();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    },
    stats,
  };
}
