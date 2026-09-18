import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export type GoogleGuard = () => void;
export interface GoogleClientConfig { clientId: string; clientSecret?: string }
export interface GoogleDependencies {
  /** main 전용 의존성이다. IPC/환경변수에서 교체할 수 없다. */
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  authorizationTimeoutMs?: number;
  signal?: AbortSignal;
  guard?: GoogleGuard;
}
export interface GoogleAuthorizationDependencies extends GoogleDependencies {
  vault: CredentialStore;
  openBrowser: (url: string) => Promise<void>;
}
export type GoogleEventTime = { date: string } | { dateTime: string; timeZone?: string };
export interface GoogleEventFields {
  summary: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  description: string;
  location: string;
}
export interface GoogleCalendarInfo {
  id: string;
  label: string;
  timeZone: string;
  accessRole: 'owner' | 'writer' | 'writerWithoutPrivateAccess' | 'reader' | 'freeBusyReader';
  canWrite: boolean;
}
export interface GoogleCalendarEvent extends GoogleEventFields {
  id: string;
  etag: string;
  status: 'confirmed' | 'tentative';
  editable: boolean;
}
export interface GoogleCalendarPlan {
  provider: 'google_calendar';
  accountId: string;
  accountLabel: string;
  calendarId: string;
  calendarLabel: string;
  calendarTimeZone: string;
  operation: 'create' | 'update' | 'delete';
  eventId: string;
  before: GoogleCalendarEvent | null;
  event: GoogleEventFields | null;
  marker: string;
}
export interface GoogleExecutionResult {
  status: 'succeeded' | 'failed' | 'unknown';
  operationId: string | null;
  errorCode: string | null;
  resultJson?: string;
}
interface Credential {
  version: 1;
  generation: string;
  clientId: string;
  clientSecret?: string;
  subject: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}
interface ResponseData { status: number; value: unknown; errorCode?: 'google_reconnect_required' }

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';
const MAX_RESPONSE = 1024 * 1024;
const NO_EFFECT_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 412, 413, 415, 422, 429]);

class GoogleError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GoogleCalendarError'; }
}
function fail(code: string): never { throw new GoogleError(code); }
// main은 identity마다 하나의 CredentialStore 어댑터를 공유한다. 같은 키의
// 저장/복원/삭제를 직렬화하여 await 사이에 다른 계정 객체의 값을 지우지 않는다.
const credentialQueues = new WeakMap<CredentialStore, Map<string, Promise<void>>>();
function credentialLock<T>(vault: CredentialStore, key: string, work: () => Promise<T>): Promise<T> {
  let queues = credentialQueues.get(vault);
  if (!queues) { queues = new Map(); credentialQueues.set(vault, queues); }
  const queue = queues;
  const result = (queue.get(key) ?? Promise.resolve()).then(work).catch(error => {
    if (error instanceof GoogleError) throw error;
    return fail('google_credentials_unavailable');
  });
  const settled = result.then(() => {}, () => {});
  queue.set(key, settled);
  void settled.then(() => { if (queue.get(key) === settled) queue.delete(key); });
  return result;
}
async function replaceCredential(vault: CredentialStore, key: string, next: string, guard: GoogleGuard, expected?: string): Promise<void> {
  return credentialLock(vault, key, async () => {
    guard(); const previous = await vault.get(key); guard();
    if (expected !== undefined && previous !== expected) fail('google_credentials_changed');
    await vault.set(key, next);
    try { guard(); }
    catch (error) {
      if (await vault.get(key) === next) {
        if (previous === null) await vault.delete(key); else await vault.set(key, previous);
      }
      throw error;
    }
  });
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const keyFor = (accountId: string): string => `google-calendar:${accountId}`;
const identityId = (subject: string): string => `google:${hash(subject)}`;
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('google_invalid_response');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('google_invalid_input');
  return value;
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('google_invalid_input');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  const order = (item: unknown): unknown => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, order(entry)])) : item;
  return JSON.stringify(order(value));
}
function check(signal?: AbortSignal, guard?: GoogleGuard): void {
  if (signal?.aborted) fail('google_cancelled');
  try { guard?.(); } catch { fail('google_execution_stale'); }
  if (signal?.aborted) fail('google_cancelled');
}
function errorCode(error: unknown): string { return error instanceof GoogleError ? error.code : 'google_request_failed'; }
function boundedTimeout(value: number | undefined, fallback: number, max: number): number {
  return Number.isInteger(value) && value! > 0 && value! <= max ? value! : fallback;
}
async function request(url: string, init: RequestInit, dependencies: GoogleDependencies, signal?: AbortSignal, guard?: GoogleGuard, onDispatch?: () => void): Promise<ResponseData> {
  const target = new URL(url);
  if (![TOKEN_URL, USERINFO_URL].includes(target.href) && !(target.origin === 'https://www.googleapis.com' && target.pathname.startsWith('/calendar/v3/'))) fail('google_endpoint_forbidden');
  const timeout = AbortSignal.timeout(boundedTimeout(dependencies.requestTimeoutMs, 20_000, 60_000));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  check(combined, guard);
  let response: Response;
  try {
    // 이 검사와 fetch 사이에 await가 없으므로 승인 세대가 바뀐 뒤 호출을 시작하지 않는다.
    onDispatch?.();
    response = await (dependencies.fetch ?? fetch)(target.href, { ...init, signal: combined, redirect: 'error' });
  } catch { fail(combined.aborted ? 'google_cancelled' : 'google_request_failed'); }
  try {
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) { await response.body?.cancel(); fail('google_response_limit'); }
    if (response.status === 204) { await response.body?.cancel(); return { status: response.status, value: null }; }
    if (!response.body) fail('google_invalid_response');
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); fail('google_response_limit'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const isJson = /\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/i.test(response.headers.get('content-type') ?? '');
    // 토큰 철회/만료는 다시 OAuth 동의가 필요하다. 알려진 코드만 고정값으로
    // 분류하며 공급자의 오류 본문/설명은 결과나 오류 메시지에 포함하지 않는다.
    if (response.status < 200 || response.status >= 300) {
      if (target.href === TOKEN_URL && response.status === 400 && isJson) {
        try {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (record(value).error === 'invalid_grant') return { status: response.status, value: null, errorCode: 'google_reconnect_required' };
        } catch { /* 알려지지 않은 오류 형식은 일반 공급자 오류로 남긴다. */ }
      }
      return { status: response.status, value: null };
    }
    if (!isJson) fail('google_invalid_response');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail('google_invalid_response'); }
    return { status: response.status, value };
  } catch (error) { if (error instanceof GoogleError) throw error; fail(combined.aborted ? 'google_cancelled' : 'google_request_failed'); }
}
function expectOk(response: ResponseData): unknown {
  if (response.status !== 200) fail(response.errorCode ?? (response.status === 401 ? 'google_reconnect_required' : response.status === 403 ? 'google_permission_denied' : 'google_provider_error'));
  return response.value;
}
function normalizeScopes(value: unknown): string[] {
  const granted = text(value, 4096).split(/\s+/).map(scope => scope === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : scope);
  if (!SCOPES.every(scope => granted.includes(scope))) fail('google_scope_missing');
  return [...new Set(granted)].sort();
}
function parseToken(value: unknown, previous?: Credential): Pick<Credential, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scopes'> & { lifetime: number } {
  const data = record(value);
  if (data.token_type !== 'Bearer' || !Number.isInteger(data.expires_in) || (data.expires_in as number) < 1 || (data.expires_in as number) > 86400) fail('google_invalid_token_response');
  return { accessToken: text(data.access_token, 16384), refreshToken: data.refresh_token === undefined && previous ? previous.refreshToken : text(data.refresh_token, 16384),
    scopes: data.scope === undefined && previous ? previous.scopes : normalizeScopes(data.scope), expiresAt: 0, lifetime: data.expires_in as number };
}
function parseIdentity(value: unknown): { subject: string; email: string } {
  const data = record(value);
  if (data.email_verified !== true) fail('google_identity_unverified');
  return { subject: text(data.sub, 255), email: text(data.email, 254) };
}
function configInput(config: GoogleClientConfig): GoogleClientConfig {
  const clientId = text(config.clientId, 1024);
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) fail('google_invalid_client');
  return { clientId, ...(config.clientSecret !== undefined ? { clientSecret: text(config.clientSecret, 4096) } : {}) };
}
function calendarIdInput(value: unknown): string {
  const id = text(value, 1024);
  if (id === 'primary') fail('google_calendar_alias_forbidden');
  if (/[\r\n]/.test(id)) fail('google_invalid_calendar');
  return id;
}
function eventIdInput(value: unknown, writable = false): string {
  const id = text(value, 1024);
  if (!/^[A-Za-z0-9_-]{5,1024}$/.test(id) || writable && !/^[A-Za-z0-9][A-Za-z0-9_-]{4,127}$/.test(id)) fail('google_invalid_event_id');
  return id;
}
function zoneInput(value: unknown): string {
  const zone = text(value, 128);
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); } catch { fail('google_invalid_time_zone'); }
  return zone;
}
function dateInput(value: unknown): string {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('google_invalid_date');
  return date;
}
function dateTimeInput(value: unknown): string {
  const dateTime = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(dateTime) || !Number.isFinite(Date.parse(dateTime))) fail('google_invalid_datetime');
  dateInput(dateTime.slice(0, 10));
  return new Date(dateTime).toISOString();
}
function eventTime(value: unknown, provider = false): GoogleEventTime {
  // A model may send the ISO text instead of the {date}/{dateTime} object. The coerced object is what the user
  // reviews and approves; the text itself still has to pass the strict date/offset checks below.
  if (!provider && typeof value === 'string') value = /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };
  const data = record(value);
  if (!provider) only(data, ['date', 'dateTime', 'timeZone']);
  if (typeof data.date === 'string' && data.dateTime === undefined) return { date: dateInput(data.date) };
  if (typeof data.dateTime === 'string' && data.date === undefined) return { dateTime: dateTimeInput(data.dateTime), ...(data.timeZone !== undefined ? { timeZone: zoneInput(data.timeZone) } : {}) };
  return fail('google_invalid_time');
}
export function normalizeFields(value: unknown, provider = false): GoogleEventFields {
  const data = record(value);
  if (!provider) only(data, ['summary', 'start', 'end', 'description', 'location', 'eventId']);
  const start = eventTime(data.start, provider), end = eventTime(data.end, provider);
  if (('date' in start) !== ('date' in end)) fail('google_invalid_time_range');
  const startValue = 'date' in start ? start.date : start.dateTime, endValue = 'date' in end ? end.date : end.dateTime;
  if (Date.parse(startValue) >= Date.parse(endValue)) fail('google_invalid_time_range');
  return { summary: text(data.summary ?? (provider ? '' : undefined), 1024, provider), start, end, description: text(data.description ?? '', 8192, true), location: text(data.location ?? '', 1024, true) };
}
function normalizeCalendar(value: unknown): GoogleCalendarInfo {
  const data = record(value), role = data.accessRole;
  if (!['owner', 'writer', 'writerWithoutPrivateAccess', 'reader', 'freeBusyReader'].includes(String(role)) || data.deleted === true) fail('google_invalid_calendar');
  return { id: calendarIdInput(data.id), label: text(data.summaryOverride ?? data.summary, 1024), timeZone: zoneInput(data.timeZone), accessRole: role as GoogleCalendarInfo['accessRole'], canWrite: role === 'owner' || role === 'writer' };
}
function normalizeEvent(value: unknown): GoogleCalendarEvent {
  const data = record(value);
  if (!['confirmed', 'tentative'].includes(String(data.status))) fail('google_invalid_event_status');
  const editable = !data.recurringEventId && !data.recurrence && !data.locked && !data.conferenceData && !data.hangoutLink && (!data.eventType || data.eventType === 'default') && (!data.attendees || Array.isArray(data.attendees) && data.attendees.length === 0);
  const etag = text(data.etag, 256);
  if (!/^"[^"\r\n]+"$/.test(etag)) fail('google_invalid_etag');
  return { ...normalizeFields(data, true), id: eventIdInput(data.id), etag, status: data.status as GoogleCalendarEvent['status'], editable };
}

async function authorizationCode(config: GoogleClientConfig, dependencies: GoogleAuthorizationDependencies): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('base64url');
  const signal = dependencies.signal, guard = dependencies.guard;
  check(signal, guard);
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // 브라우저 열기 실패/취소와 콜백이 겹쳐도 처리되지 않은 rejection을 남기지 않는다.
  void codePromise.catch(() => {});
  let redirectUri = '', settled = false;
  const reject = (code: string): void => { if (!settled) { settled = true; rejectCode(new GoogleError(code)); } };
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store'); res.setHeader('content-security-policy', "default-src 'none'");
    if (settled || req.method !== 'GET' || !req.url || req.url.length > 8192) { res.writeHead(400); res.end('잘못된 연결 요청입니다.'); return; }
    let url: URL;
    try { url = new URL(req.url, redirectUri); } catch { res.writeHead(400); res.end('잘못된 연결 요청입니다.'); return; }
    const expected = new URL(redirectUri);
    const received = url.searchParams.get('state') ?? '';
    const receivedBytes = Buffer.from(received), stateBytes = Buffer.from(state);
    if (req.headers.host !== expected.host || url.origin !== expected.origin || url.pathname !== '/' || url.searchParams.getAll('state').length !== 1 || receivedBytes.length !== stateBytes.length || !timingSafeEqual(receivedBytes, stateBytes)) {
      res.writeHead(400); res.end('연결 요청을 확인할 수 없습니다.'); return;
    }
    try { check(signal, guard); } catch { reject('google_cancelled'); res.writeHead(400); res.end('연결이 취소되었습니다.'); return; }
    if (url.searchParams.has('error')) { reject('google_authorization_denied'); res.writeHead(400); res.end('Google 연결이 승인되지 않았습니다.'); return; }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) { res.writeHead(400); res.end('잘못된 연결 응답입니다.'); return; }
    settled = true; resolveCode(code); res.writeHead(200); res.end('Google 연결 응답을 받았습니다. 키리안으로 돌아가 주세요.');
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 4;
  const abort = (): void => { reject('google_cancelled'); server.closeAllConnections(); server.close(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, rejectListen) => {
      server.once('error', () => rejectListen(new GoogleError('google_loopback_unavailable')));
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') fail('google_loopback_unavailable');
    redirectUri = `http://127.0.0.1:${address.port}/`;
    signal?.addEventListener('abort', abort, { once: true });
    check(signal, guard);
    timer = setTimeout(() => { reject('google_authorization_timeout'); server.closeAllConnections(); server.close(); }, boundedTimeout(dependencies.authorizationTimeoutMs, 180_000, 300_000));
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent select_account' }).toString();
    const code = await Promise.race([dependencies.openBrowser(url.href).then(() => codePromise), codePromise]);
    check(signal, guard);
    return { code, verifier, redirectUri };
  } catch (error) { throw new GoogleError(errorCode(error)); }
  finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); server.closeAllConnections(); server.close(); }
}

export class GoogleCalendarAccount {
  readonly accountId: string;
  readonly label: string;
  #credential: Credential;
  #stored: string;
  #vault: CredentialStore;
  #dependencies: GoogleDependencies;
  #closed = false;
  #lifetime = new AbortController();
  #refreshing: Promise<void> | undefined;

  private constructor(credential: Credential, vault: CredentialStore, dependencies: GoogleDependencies, stored = JSON.stringify(credential)) {
    this.#credential = credential; this.#vault = vault; this.#dependencies = dependencies;
    this.#stored = stored;
    this.accountId = identityId(credential.subject); this.label = credential.email;
  }

  static async authorize(config: GoogleClientConfig, dependencies: GoogleAuthorizationDependencies): Promise<GoogleCalendarAccount> {
    const client = configInput(config), { code, verifier, redirectUri } = await authorizationCode(client, dependencies);
    const form = new URLSearchParams({ client_id: client.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
    if (client.clientSecret) form.set('client_secret', client.clientSecret);
    const token = parseToken(expectOk(await request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, dependencies, dependencies.signal, dependencies.guard)));
    const identity = parseIdentity(expectOk(await request(USERINFO_URL, { headers: { authorization: `Bearer ${token.accessToken}` } }, dependencies, dependencies.signal, dependencies.guard)));
    const credential: Credential = { version: 1, generation: randomBytes(32).toString('hex'), ...client, ...identity, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: (dependencies.now ?? Date.now)() + token.lifetime * 1000, scopes: token.scopes };
    const account = new GoogleCalendarAccount(credential, dependencies.vault, dependencies);
    check(dependencies.signal, dependencies.guard);
    await replaceCredential(dependencies.vault, keyFor(account.accountId), account.#stored, () => check(dependencies.signal, dependencies.guard));
    return account;
  }

  static async restore(accountId: string, vault: CredentialStore, dependencies: GoogleDependencies = {}): Promise<GoogleCalendarAccount> {
    if (!/^google:[a-f0-9]{64}$/.test(accountId)) fail('google_invalid_account');
    let raw: string | null;
    try { raw = await vault.get(keyFor(accountId)); } catch { fail('google_credentials_unavailable'); }
    if (!raw || raw.length > 65536) fail('google_reconnect_required');
    let data: Record<string, unknown>;
    try { data = record(JSON.parse(raw)); } catch { fail('google_credentials_invalid'); }
    if (data.version !== 1 || typeof data.generation !== 'string' || !/^[a-f0-9]{64}$/.test(data.generation) || !Number.isFinite(data.expiresAt) || !Array.isArray(data.scopes)) fail('google_credentials_invalid');
    const client = configInput({ clientId: text(data.clientId), ...(data.clientSecret !== undefined ? { clientSecret: text(data.clientSecret, 4096) } : {}) });
    const credential: Credential = { version: 1, generation: data.generation, ...client, subject: text(data.subject, 255), email: text(data.email, 254), accessToken: text(data.accessToken, 16384), refreshToken: text(data.refreshToken, 16384), expiresAt: data.expiresAt as number, scopes: normalizeScopes(data.scopes.join(' ')) };
    if (identityId(credential.subject) !== accountId) fail('google_identity_changed');
    const account = new GoogleCalendarAccount(credential, vault, dependencies, raw);
    await account.#verifyIdentity(dependencies.signal, dependencies.guard);
    const next = { ...account.#credential, generation: randomBytes(32).toString('hex') }, stored = JSON.stringify(next);
    await replaceCredential(vault, keyFor(accountId), stored, () => check(dependencies.signal, dependencies.guard), account.#stored);
    account.#credential = next; account.#stored = stored;
    return account;
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    this.#lifetime.abort();
    // 연결 해제는 단말 저장소만 지운다. Google 원격 revoke는 별도 사용자 동작이다.
    try {
      await credentialLock(this.#vault, keyFor(this.accountId), async () => {
        const current = await this.#vault.get(keyFor(this.accountId));
        if (current !== null && record(JSON.parse(current)).generation === this.#credential.generation) await this.#vault.delete(keyFor(this.accountId));
      });
    } catch { fail('google_credentials_unavailable'); }
    finally { this.#credential.accessToken = ''; this.#credential.refreshToken = ''; this.#credential.clientSecret = undefined; this.#stored = ''; }
  }

  #guard(signal?: AbortSignal, guard?: GoogleGuard): GoogleGuard {
    return () => { if (this.#closed) fail('google_disconnected'); check(signal, guard); };
  }

  async #access(signal?: AbortSignal, guard?: GoogleGuard): Promise<string> {
    const verify = this.#guard(signal, guard); verify();
    if ((this.#dependencies.now ?? Date.now)() + 30_000 >= this.#credential.expiresAt) {
      if (!this.#refreshing) {
        const refresh = async (): Promise<void> => {
          const credential = this.#credential;
          const form = new URLSearchParams({ client_id: credential.clientId, refresh_token: credential.refreshToken, grant_type: 'refresh_token' });
          if (credential.clientSecret) form.set('client_secret', credential.clientSecret);
          const token = parseToken(expectOk(await request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, this.#dependencies, signal, verify)), credential);
          verify();
          const next: Credential = { ...credential, accessToken: token.accessToken, refreshToken: token.refreshToken, scopes: token.scopes, expiresAt: (this.#dependencies.now ?? Date.now)() + token.lifetime * 1000 };
          await credentialLock(this.#vault, keyFor(this.accountId), async () => {
            verify(); const current = await this.#vault.get(keyFor(this.accountId)); verify();
            if (current !== this.#stored) fail('google_credentials_changed');
            const stored = JSON.stringify(next);
            await this.#vault.set(keyFor(this.accountId), stored);
            // 갱신 토큰이 회전했을 수 있으므로 저장 성공 뒤의 단일 요청 취소는
            // 새 자격 증명을 이전 값으로 되돌리지 않는다. 계정 해제만 이를 삭제한다.
            this.#credential = next; this.#stored = stored;
            if (this.#closed) {
              if (await this.#vault.get(keyFor(this.accountId)) === stored) await this.#vault.delete(keyFor(this.accountId));
              fail('google_disconnected');
            }
            verify();
          });
        };
        this.#refreshing = refresh().finally(() => { this.#refreshing = undefined; });
      }
      await this.#refreshing;
    }
    verify(); return this.#credential.accessToken;
  }

  async #api(url: string, signal?: AbortSignal, guard?: GoogleGuard, init: RequestInit = {}, onDispatch?: () => void, authorizeDispatch?: () => Promise<void>): Promise<ResponseData> {
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const token = await this.#access(combined, guard);
    if (authorizeDispatch) await authorizeDispatch();
    check(combined, this.#guard(combined, guard));
    return request(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }, this.#dependencies, combined, this.#guard(combined, guard), onDispatch);
  }

  async #verifyIdentity(signal?: AbortSignal, guard?: GoogleGuard): Promise<void> {
    const identity = parseIdentity(expectOk(await this.#api(USERINFO_URL, signal, guard)));
    if (identity.subject !== this.#credential.subject || identity.email !== this.label) fail('google_identity_changed');
  }

  async #calendar(calendarId: string, signal?: AbortSignal, guard?: GoogleGuard): Promise<GoogleCalendarInfo> {
    const id = calendarIdInput(calendarId);
    const calendar = normalizeCalendar(expectOk(await this.#api(`${CALENDAR_URL}/users/me/calendarList/${encodeURIComponent(id)}`, signal, guard)));
    if (calendar.id !== id) fail('google_calendar_changed');
    return calendar;
  }

  async listCalendars(signal?: AbortSignal, guard?: GoogleGuard): Promise<GoogleCalendarInfo[]> {
    const rows = await this.#pages(`${CALENDAR_URL}/users/me/calendarList?maxResults=250&showDeleted=false`, 500, signal, guard);
    return freeze(rows.map(normalizeCalendar));
  }

  async listEvents(calendarId: string, input: { timeMin: string; timeMax: string }, signal?: AbortSignal, guard?: GoogleGuard): Promise<GoogleCalendarEvent[]> {
    const id = calendarIdInput(calendarId), timeMin = dateTimeInput(input.timeMin), timeMax = dateTimeInput(input.timeMax);
    if (Date.parse(timeMax) <= Date.parse(timeMin) || Date.parse(timeMax) - Date.parse(timeMin) > 366 * 86400_000) fail('google_invalid_time_range');
    const calendar = await this.#calendar(id, signal, guard);
    if (calendar.accessRole === 'freeBusyReader') fail('google_calendar_read_only');
    const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '250' });
    const rows = await this.#pages(`${CALENDAR_URL}/calendars/${encodeURIComponent(id)}/events?${params}`, 500, signal, guard);
    return freeze(rows.map(normalizeEvent));
  }

  async #pages(url: string, limit: number, signal?: AbortSignal, guard?: GoogleGuard): Promise<unknown[]> {
    const rows: unknown[] = [], seen = new Set<string>();
    let current = url;
    for (let page = 0; page < 4; page++) {
      const body = record(expectOk(await this.#api(current, signal, guard)));
      if (!Array.isArray(body.items) || body.items.length > 250) fail('google_invalid_response');
      rows.push(...body.items);
      if (rows.length > limit) fail('google_result_limit');
      if (body.nextPageToken === undefined) return rows;
      const next = text(body.nextPageToken, 4096);
      if (seen.has(next)) fail('google_invalid_pagination');
      seen.add(next); const target = new URL(url); target.searchParams.set('pageToken', next); current = target.href;
    }
    return fail('google_result_limit');
  }

  async prepare(operation: 'create' | 'update' | 'delete', calendarId: string, input: unknown, signal?: AbortSignal, guard?: GoogleGuard): Promise<GoogleCalendarPlan> {
    if (!['create', 'update', 'delete'].includes(operation)) fail('google_invalid_operation');
    const data = record(input);
    only(data, operation === 'delete' ? ['eventId'] : operation === 'create' ? ['summary', 'start', 'end', 'description', 'location'] : ['eventId', 'summary', 'start', 'end', 'description', 'location']);
    const event = operation === 'delete' ? null : normalizeFields(input);
    await this.#verifyIdentity(signal, guard);
    const calendar = await this.#calendar(calendarId, signal, guard);
    if (!calendar.canWrite) fail('google_calendar_read_only');
    const marker = randomBytes(32).toString('hex');
    const eventId = operation === 'create' ? `tana${hash(marker)}` : eventIdInput(data.eventId, true);
    let before: GoogleCalendarEvent | null = null;
    if (operation !== 'create') {
      before = normalizeEvent(expectOk(await this.#api(this.#eventUrl(calendar.id, eventId), signal, guard)));
      if (before.id !== eventId) fail('google_event_changed');
      if (!before.editable) fail('google_event_not_supported');
    }
    check(signal, this.#guard(signal, guard));
    return freeze({ provider: 'google_calendar', accountId: this.accountId, accountLabel: this.label, calendarId: calendar.id, calendarLabel: calendar.label, calendarTimeZone: calendar.timeZone, operation, eventId, before, event, marker });
  }

  #eventUrl(calendarId: string, eventId: string): string { return `${CALENDAR_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`; }

  #validatePlan(plan: GoogleCalendarPlan, executionId: string): GoogleCalendarPlan {
    text(executionId, 128);
    const data = record(plan);
    only(data, ['provider', 'accountId', 'accountLabel', 'calendarId', 'calendarLabel', 'calendarTimeZone', 'operation', 'eventId', 'before', 'event', 'marker']);
    if (plan.provider !== 'google_calendar' || plan.accountId !== this.accountId || plan.accountLabel !== this.label || !['create', 'update', 'delete'].includes(plan.operation) || !/^[a-f0-9]{64}$/.test(plan.marker)) fail('google_invalid_plan');
    calendarIdInput(plan.calendarId); text(plan.calendarLabel); zoneInput(plan.calendarTimeZone); eventIdInput(plan.eventId, true);
    if (plan.operation === 'create') { if (plan.before !== null || plan.eventId !== `tana${hash(plan.marker)}`) fail('google_invalid_plan'); }
    else {
      if (!plan.before || plan.before.id !== plan.eventId || plan.before.editable !== true) fail('google_invalid_plan');
      const before = record(plan.before); only(before, ['id', 'etag', 'status', 'editable', 'summary', 'start', 'end', 'description', 'location']);
      if (canonical(normalizeEvent(plan.before)) !== canonical(plan.before)) fail('google_invalid_plan');
    }
    if (plan.operation === 'delete') { if (plan.event !== null) fail('google_invalid_plan'); }
    else if (!plan.event || canonical(normalizeFields(plan.event)) !== canonical(plan.event)) fail('google_invalid_plan');
    // 이후의 await 도중 호출자가 내용을 바꿀 수 없도록 검증한 사본을 사용한다.
    return freeze(structuredClone(plan));
  }

  #proof(value: unknown, plan: GoogleCalendarPlan, executionId: string): GoogleCalendarEvent | null {
    try {
      const data = record(value), properties = record(record(data.extendedProperties).private);
      if (properties.kirianAction !== plan.marker || properties.kirianExecution !== hash(executionId)) return null;
      const event = normalizeEvent(data);
      if (event.id !== plan.eventId || !event.editable || plan.before && event.etag === plan.before.etag || !plan.event) return null;
      const fields = normalizeFields(data, true);
      // Google는 같은 순간을 다른 offset으로 응답하거나 기본 timeZone을 추가할 수 있다.
      const sameTime = (actual: GoogleEventTime, expected: GoogleEventTime): boolean => 'date' in expected ? 'date' in actual && actual.date === expected.date : 'dateTime' in actual && actual.dateTime === expected.dateTime && (!expected.timeZone || actual.timeZone === expected.timeZone);
      if (fields.summary !== plan.event.summary || fields.description !== plan.event.description || fields.location !== plan.event.location || !sameTime(fields.start, plan.event.start) || !sameTime(fields.end, plan.event.end)) return null;
      return event;
    } catch { return null; }
  }

  async execute(planInput: GoogleCalendarPlan, executionId: string, signal?: AbortSignal, guard?: GoogleGuard, authorizeDispatch?: () => Promise<void>): Promise<GoogleExecutionResult> {
    let started = false;
    try {
      const plan = this.#validatePlan(planInput, executionId);
      await this.#verifyIdentity(signal, guard);
      const calendar = await this.#calendar(plan.calendarId, signal, guard);
      if (!calendar.canWrite || calendar.label !== plan.calendarLabel || calendar.timeZone !== plan.calendarTimeZone) fail('google_calendar_changed');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (plan.before) headers['if-match'] = plan.before.etag;
      const url = plan.operation === 'create' ? `${CALENDAR_URL}/calendars/${encodeURIComponent(plan.calendarId)}/events?sendUpdates=none` : `${this.#eventUrl(plan.calendarId, plan.eventId)}?sendUpdates=none`;
      const body = plan.event ? JSON.stringify({ ...(plan.operation === 'create' ? { id: plan.eventId } : {}), ...plan.event, extendedProperties: { private: { kirianAction: plan.marker, kirianExecution: hash(executionId) } } }) : undefined;
      const response = await this.#api(url, signal, guard, { method: plan.operation === 'create' ? 'POST' : plan.operation === 'update' ? 'PATCH' : 'DELETE', headers, body }, () => { started = true; }, authorizeDispatch);
      if (NO_EFFECT_STATUS.has(response.status)) return { status: 'failed', operationId: null, errorCode: response.status === 412 ? 'google_precondition_failed' : response.status === 401 ? 'google_reconnect_required' : 'google_write_rejected' };
      if (plan.operation === 'delete' && response.status === 204) return { status: 'succeeded', operationId: plan.eventId, errorCode: null, resultJson: JSON.stringify({ eventId: plan.eventId, deleted: true, evidence: 'google_http_204' }) };
      const evidence = (response.status === 200 || response.status === 201) && plan.operation !== 'delete' ? this.#proof(response.value, plan, executionId) : null;
      if (evidence) return { status: 'succeeded', operationId: evidence.id, errorCode: null, resultJson: JSON.stringify(evidence) };
      return { status: 'unknown', operationId: null, errorCode: 'google_write_unconfirmed' };
    } catch (error) { return { status: started ? 'unknown' : 'failed', operationId: null, errorCode: errorCode(error) }; }
  }

  async reconcile(planInput: GoogleCalendarPlan, executionId: string, signal?: AbortSignal, guard?: GoogleGuard): Promise<GoogleExecutionResult> {
    try {
      const plan = this.#validatePlan(planInput, executionId);
      await this.#verifyIdentity(signal, guard);
      const response = await this.#api(this.#eventUrl(plan.calendarId, plan.eventId), signal, guard);
      // 404/삭제 tombstone은 키리안 실행이 삭제했다는 증거가 아니다. 절대 재실행하지 않는다.
      const evidence = response.status === 200 && plan.operation !== 'delete' ? this.#proof(response.value, plan, executionId) : null;
      if (evidence) return { status: 'succeeded', operationId: evidence.id, errorCode: null, resultJson: JSON.stringify(evidence) };
      return { status: 'unknown', operationId: null, errorCode: 'google_write_unconfirmed' };
    } catch (error) { return { status: 'unknown', operationId: null, errorCode: errorCode(error) }; }
  }
}
