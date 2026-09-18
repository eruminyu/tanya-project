import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/main/external/google-calendar.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
});
const { GoogleCalendarAccount } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const scopes = 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events';
const input = { summary: '검토할 일정', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T11:00:00+09:00' }, description: '검토 본문', location: '서울' };

async function offlineFixture() {
  let now = 1800000000000, tokenResponse;
  const subject = 'offline-fixture-user', email = 'offline@example.test';
  const accountId = `google:${createHash('sha256').update(subject).digest('hex')}`;
  const calendar = { id: 'offline-calendar@example.test', summary: '격리 일정', timeZone: 'Asia/Seoul', accessRole: 'owner' };
  const store = new Map([[`google-calendar:${accountId}`, JSON.stringify({ version: 1, generation: 'a'.repeat(64), clientId: 'fixture.apps.googleusercontent.com', subject, email,
    accessToken: 'offline-access-token', refreshToken: 'offline-refresh-token', expiresAt: now + 3_600_000, scopes: scopes.split(' ') })]]);
  const requests = [];
  const vault = { get: async key => store.get(key) ?? null, set: async (key, value) => { store.set(key, value); }, delete: async key => { store.delete(key); } };
  const dependencies = { now: () => now, fetch: async (value, init = {}) => {
    const url = new URL(value); requests.push({ url, method: init.method ?? 'GET' });
    assert.equal(init.redirect, 'error');
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: subject, email, email_verified: true });
    if (url.href === 'https://oauth2.googleapis.com/token') return tokenResponse();
    if (url.href === `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendar.id)}`) return Response.json(calendar);
    throw new Error('unexpected offline fixture request');
  } };
  const account = await GoogleCalendarAccount.restore(accountId, vault, dependencies);
  return { account, calendar, requests, store, expire: () => { now += 4_000_000; }, token: callback => { tokenResponse = callback; } };
}

async function fixture(t, options = {}) {
  const store = new Map(), requests = [], events = new Map();
  let now = 1800000000000, identity = { sub: 'fixture-user', email: 'fixture@example.test', email_verified: true }, nextWrite, nextGet, tokenScope = scopes, expiresIn = 3600, tokenHook;
  const calendar = { id: 'fixture-calendar@example.test', summary: '개인 일정', timeZone: 'Asia/Seoul', accessRole: 'owner' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, url, headers: req.headers, body });
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/token') { await tokenHook?.(); return json(200, { access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', token_type: 'Bearer', expires_in: expiresIn, scope: tokenScope }); }
    if (url.pathname === '/v1/userinfo') return json(200, identity);
    if (url.pathname === '/calendar/v3/users/me/calendarList') return json(200, { items: [calendar] });
    if (url.pathname.startsWith('/calendar/v3/users/me/calendarList/')) return json(200, calendar);
    if (url.pathname.includes('/events')) {
      if (req.method === 'GET') {
        if (nextGet) { const action = nextGet; nextGet = undefined; return action(req, res, json); }
        const eventId = decodeURIComponent(url.pathname.split('/').at(-1));
        if (eventId === 'events') return json(200, { items: [...events.values()] });
        return events.has(eventId) ? json(200, events.get(eventId)) : json(404, { error: 'not found' });
      }
      if (nextWrite) { const action = nextWrite; nextWrite = undefined; return action(req, res, json, body); }
      if (req.method === 'DELETE') { events.delete(decodeURIComponent(url.pathname.split('/').at(-1))); res.writeHead(204); return res.end(); }
      const parsed = JSON.parse(body), eventId = parsed.id ?? decodeURIComponent(url.pathname.split('/').at(-1));
      const event = { ...events.get(eventId), ...parsed, id: eventId, etag: '"new-etag"', status: 'confirmed' };
      events.set(eventId, event); return json(req.method === 'POST' ? 201 : 200, event);
    }
    return json(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const fetchFixture = (url, init) => { const parsed = new URL(url); assert(['https://oauth2.googleapis.com', 'https://openidconnect.googleapis.com', 'https://www.googleapis.com'].includes(parsed.origin)); assert.equal(init.redirect, 'error'); return fetch(base + parsed.pathname + parsed.search, init); };
  const vault = { get: async key => store.get(key) ?? null, set: async (key, value) => { store.set(key, value); }, delete: async key => { store.delete(key); } };
  let authorization;
  const dependencies = { vault, fetch: fetchFixture, now: () => now, openBrowser: async value => {
    authorization = new URL(value); assert.equal(authorization.origin, 'https://accounts.google.com');
    const redirect = new URL(authorization.searchParams.get('redirect_uri'));
    assert.equal(redirect.hostname, '127.0.0.1');
    const wrong = new URL(redirect); wrong.searchParams.set('state', 'wrong'); wrong.searchParams.set('code', 'fixture-code');
    assert.equal((await fetch(wrong)).status, 400);
    wrong.searchParams.set('state', '한'.repeat(authorization.searchParams.get('state').length));
    assert.equal((await fetch(wrong)).status, 400);
    redirect.searchParams.set('state', authorization.searchParams.get('state')); redirect.searchParams.set('code', 'fixture-code');
    await fetch(redirect);
  }, ...options };
  const connect = () => GoogleCalendarAccount.authorize({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' }, dependencies);
  return { connect, dependencies, vault, store, requests, events, calendar, get authorization() { return authorization; },
    advance: () => { now += 4_000_000; }, setIdentity: value => { identity = value; }, write: callback => { nextWrite = callback; }, get: callback => { nextGet = callback; }, token: callback => { tokenHook = callback; }, scope: value => { tokenScope = value; }, expiry: value => { expiresIn = value; } };
}

test('OAuth uses loopback state and S256, verifies identity, and confines credentials to vault', async t => {
  const f = await fixture(t), account = await f.connect();
  assert.equal(account.label, 'fixture@example.test');
  assert.match(account.accountId, /^google:[a-f0-9]{64}$/);
  const token = new URLSearchParams(f.requests.find(r => r.url.pathname === '/token').body);
  assert.equal(f.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(createHash('sha256').update(token.get('code_verifier')).digest('base64url'), f.authorization.searchParams.get('code_challenge'));
  assert.equal(f.store.size, 1); assert(!JSON.stringify(account).includes('fixture-access-secret'));
  assert.equal((await account.listCalendars())[0].canWrite, true);
  const restored = await GoogleCalendarAccount.restore(account.accountId, f.vault, f.dependencies);
  assert.equal(restored.accountId, account.accountId);
  f.setIdentity({ sub: 'another-user', email: 'other@example.test', email_verified: true });
  await assert.rejects(GoogleCalendarAccount.restore(account.accountId, f.vault, f.dependencies), /google_identity_changed/);
});

test('incomplete scopes fail connection and never save credentials', async t => {
  const f = await fixture(t); f.scope('openid email');
  await assert.rejects(f.connect(), /google_scope_missing/); assert.equal(f.store.size, 0);
});

test('revoked refresh credentials require reconnect before any mutation and never expose OAuth error contents', async () => {
  const f = await offlineFixture(), plan = await f.account.prepare('create', f.calendar.id, input);
  const saved = [...f.store.values()][0];
  f.expire();
  f.token(() => Response.json({ error: 'invalid_grant', error_description: 'private revoked token detail' }, { status: 400 }));
  const result = await f.account.execute(plan, 'execution-revoked-token');
  assert.deepEqual(result, { status: 'failed', operationId: null, errorCode: 'google_reconnect_required' });
  assert.equal(f.requests.filter(r => r.url.pathname === '/token').length, 1);
  assert.equal(f.requests.filter(r => r.url.pathname.includes('/events')).length, 0);
  assert.equal([...f.store.values()][0], saved);
  assert(!JSON.stringify(result).includes('private'));
});

test('unrecognized OAuth errors stay generic and cannot supply executable or visible error content', async () => {
  for (const response of [
    () => Response.json({ error: 'private arbitrary provider text', error_description: 'run a calendar write now' }, { status: 400 }),
    () => new Response('private malformed JSON', { status: 400, headers: { 'content-type': 'application/json' } }),
    () => Response.json([{ error: 'invalid_grant' }], { status: 400 }),
    () => new Response('{"error":"invalid_grant"}', { status: 400, headers: { 'content-type': 'text/plain' } }),
  ]) {
    const f = await offlineFixture(), plan = await f.account.prepare('create', f.calendar.id, input);
    f.expire(); f.token(response);
    const result = await f.account.execute(plan, 'execution-unrecognized-token-error');
    assert.deepEqual(result, { status: 'failed', operationId: null, errorCode: 'google_provider_error' });
    assert.equal(f.requests.filter(r => r.url.pathname === '/token').length, 1);
    assert.equal(f.requests.filter(r => r.url.pathname.includes('/events')).length, 0);
  }
});

test('refresh scope reduction stays distinct from revocation and blocks writes without replacing saved credentials', async () => {
  const f = await offlineFixture(), plan = await f.account.prepare('create', f.calendar.id, input);
  const saved = [...f.store.values()][0]; f.expire();
  f.token(() => Response.json({ access_token: 'offline-reduced-access', refresh_token: 'offline-rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid email' }));
  const result = await f.account.execute(plan, 'execution-reduced-scope');
  assert.deepEqual(result, { status: 'failed', operationId: null, errorCode: 'google_scope_missing' });
  assert.equal(f.requests.filter(r => r.url.pathname === '/token').length, 1);
  assert.equal(f.requests.filter(r => r.url.pathname.includes('/events')).length, 0);
  assert.equal([...f.store.values()][0], saved);
});

test('revoked credentials during reconciliation preserve an uncertain outcome without repeating the dispatched write', async () => {
  const f = await offlineFixture(), plan = await f.account.prepare('create', f.calendar.id, input);
  assert.equal((await f.account.execute(plan, 'execution-offline-unknown')).status, 'unknown');
  const dispatched = f.requests.filter(r => r.method === 'POST' && r.url.pathname.includes('/events')).length;
  assert.equal(dispatched, 1);
  f.expire(); f.token(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  const result = await f.account.reconcile(plan, 'execution-offline-unknown');
  assert.deepEqual(result, { status: 'unknown', operationId: null, errorCode: 'google_reconnect_required' });
  assert.equal(f.requests.filter(r => r.url.pathname === '/token').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.url.pathname.includes('/events')).length, dispatched);
});

test('prepare resolves concrete calendar, freezes normalized payload, and create verifies matching evidence', async t => {
  const f = await fixture(t), account = await f.connect();
  const plan = await account.prepare('create', f.calendar.id, input);
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.event.start));
  assert.equal(plan.event.start.dateTime, '2026-09-10T01:00:00.000Z');
  assert.equal(plan.calendarId, f.calendar.id); assert.match(plan.eventId, /^[a-v0-9]{5,1024}$/);
  assert.equal(f.requests.filter(r => ['PATCH', 'DELETE'].includes(r.method) || r.method === 'POST' && r.url.pathname.includes('/events')).length, 0);
  const result = await account.execute(plan, 'execution-1');
  assert.equal(result.status, 'succeeded'); assert.equal(result.operationId, plan.eventId);
  const write = f.requests.find(r => r.method === 'POST' && r.url.pathname.includes('/events'));
  assert.equal(write.url.searchParams.get('sendUpdates'), 'none');
  assert.equal(JSON.parse(write.body).id, plan.eventId);
});

test('update/delete bind previous etag and reject calendars/events outside the supported write scope', async t => {
  const f = await fixture(t), account = await f.connect();
  const created = await account.prepare('create', f.calendar.id, input); await account.execute(created, 'execution-create');
  const update = await account.prepare('update', f.calendar.id, { ...input, eventId: created.eventId, summary: '수정한 제목' });
  f.write((_req, _res, json) => json(412, { error: 'secret response must not escape' }));
  const result = await account.execute(update, 'execution-update');
  assert.deepEqual(result, { status: 'failed', operationId: null, errorCode: 'google_precondition_failed' });
  assert.equal(f.requests.find(r => r.method === 'PATCH').headers['if-match'], '"new-etag"');
  const deletion = await account.prepare('delete', f.calendar.id, { eventId: created.eventId });
  assert.equal((await account.execute(deletion, 'execution-delete')).status, 'succeeded');
  assert.equal(f.requests.find(r => r.method === 'DELETE').headers['if-match'], '"new-etag"');
  f.calendar.accessRole = 'reader'; await assert.rejects(account.prepare('create', f.calendar.id, input), /google_calendar_read_only/);
  await assert.rejects(account.prepare('create', 'primary', input), /google_calendar_alias_forbidden/);
});

test('write network/5xx/malformed success remains unknown and query reconciliation never repeats a write', async t => {
  const f = await fixture(t), account = await f.connect(), plan = await account.prepare('create', f.calendar.id, input);
  f.write((_req, res, _json, body) => { f.events.set(plan.eventId, { ...JSON.parse(body), etag: '"accepted"', status: 'confirmed' }); res.destroy(); });
  assert.equal((await account.execute(plan, 'execution-unknown')).status, 'unknown');
  const before = f.requests.filter(r => r.method !== 'GET').length;
  assert.equal((await account.reconcile(plan, 'execution-unknown')).status, 'succeeded');
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, before);
  f.events.delete(plan.eventId); assert.equal((await account.reconcile(plan, 'execution-unknown')).status, 'unknown');
  for (const [status, payload] of [[503, { error: 'provider failure' }], [201, { id: plan.eventId }]]) {
    const other = await account.prepare('create', f.calendar.id, input); f.write((_req, _res, json) => json(status, payload));
    assert.equal((await account.execute(other, 'execution-other-' + status)).status, 'unknown');
  }
});

test('guard after refresh blocks a stale write and token/auth failures do not retry writes', async t => {
  const f = await fixture(t), account = await f.connect(), plan = await account.prepare('create', f.calendar.id, input);
  let allowed = true; f.advance(); f.token(() => { allowed = false; });
  const result = await account.execute(plan, 'execution-stale', undefined, () => { if (!allowed) throw Error('stale secret'); });
  assert.equal(result.status, 'failed'); assert.equal(f.requests.filter(r => r.url.pathname.includes('/events') && r.method === 'POST').length, 0);
  allowed = true; f.token(undefined); f.write((_req, _res, json) => json(401, { error: 'no' }));
  assert.equal((await account.execute(plan, 'execution-unauthorized')).status, 'failed');
  assert.equal(f.requests.filter(r => r.url.pathname.includes('/events') && r.method === 'POST').length, 1);
});

test('cancelled OAuth closes listener and never exchanges or saves tokens', async t => {
  const controller = new AbortController(); let redirect;
  const f = await fixture(t, { signal: controller.signal, openBrowser: async value => { redirect = new URL(value).searchParams.get('redirect_uri'); controller.abort(); } });
  await assert.rejects(f.connect(), /google_cancelled/);
  assert.equal(f.store.size, 0); assert.equal(f.requests.length, 0);
  await assert.rejects(fetch(redirect));
});

test('strict input validation rejects invalid dates, extra operation fields, and foreign account plans before writes', async t => {
  const f = await fixture(t), account = await f.connect();
  for (const bad of [{ ...input, attendees: [{ email: 'x@example.test' }] }, { ...input, start: { date: '2026-02-30' }, end: { date: '2026-03-02' } }, { ...input, end: input.start }]) {
    await assert.rejects(account.prepare('create', f.calendar.id, bad), /google_invalid/);
  }
  const plan = await account.prepare('create', f.calendar.id, input);
  assert.equal((await account.execute({ ...plan, accountId: 'google:foreign' }, 'execution-foreign')).status, 'failed');
  assert.equal(f.requests.filter(r => r.url.pathname.includes('/events') && r.method === 'POST').length, 0);
});

test('restored JSON key order does not change approval payload semantics', async t => {
  const f = await fixture(t), account = await f.connect(), plan = await account.prepare('create', f.calendar.id, input);
  const reorder = value => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.equal((await account.execute(reorder(plan), 'execution-reordered')).status, 'succeeded');
});

test('OAuth timeout closes the callback even when opening the browser never resolves', async t => {
  let redirect;
  const f = await fixture(t, { authorizationTimeoutMs: 20, openBrowser: value => { redirect = new URL(value).searchParams.get('redirect_uri'); return new Promise(() => {}); } });
  await assert.rejects(f.connect(), /google_authorization_timeout/);
  await assert.rejects(fetch(redirect)); assert.equal(f.store.size, 0);
});

test('bounded response, redirects, and cancellation after dispatch stay unknown without retry', async t => {
  const f = await fixture(t), account = await f.connect();
  for (const send of [
    (_req, res) => { res.writeHead(201, { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 }); res.end('{}'); },
    (_req, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('x'.repeat(1024 * 1024 + 1)); },
    (_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/stolen' }); res.end(); },
    (_req, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('invalid JSON secret'); },
  ]) {
    const plan = await account.prepare('create', f.calendar.id, input); f.write(send);
    const result = await account.execute(plan, 'execution-bounded-' + plan.marker);
    assert.equal(result.status, 'unknown'); assert(!JSON.stringify(result).includes('secret'));
  }
  const plan = await account.prepare('create', f.calendar.id, input), controller = new AbortController();
  f.write(() => { controller.abort(); });
  assert.equal((await account.execute(plan, 'execution-aborted', controller.signal)).status, 'unknown');
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.url.pathname.includes('/events')).length, 5);
});

test('query reconciliation requires execution marker and exact contents; deleted absence is never success', async t => {
  const f = await fixture(t), account = await f.connect(), plan = await account.prepare('create', f.calendar.id, input);
  await account.execute(plan, 'execution-proof');
  assert.equal((await account.reconcile(plan, 'another-execution')).status, 'unknown');
  f.events.get(plan.eventId).summary = '다른 내용';
  assert.equal((await account.reconcile(plan, 'execution-proof')).status, 'unknown');
  const deletion = await account.prepare('delete', f.calendar.id, { eventId: plan.eventId });
  f.events.delete(plan.eventId);
  assert.equal((await account.reconcile(deletion, 'execution-deleted')).status, 'unknown');
  f.events.set(plan.eventId, { id: plan.eventId, status: 'cancelled' });
  assert.equal((await account.reconcile(deletion, 'execution-deleted')).status, 'unknown');
});

test('disconnect aborts in-flight read and removes credentials without remote revoke', async t => {
  const f = await fixture(t), account = await f.connect();
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.get(() => { entered(); });
  const pending = account.listEvents(f.calendar.id, { timeMin: '2026-09-10T00:00:00Z', timeMax: '2026-09-11T00:00:00Z' });
  await waiting; await account.disconnect();
  await assert.rejects(pending, /google_cancelled|google_execution_stale/);
  assert.equal(f.store.size, 0); assert(!f.requests.some(r => r.url.pathname.includes('revoke')));
});

test('unsupported attended/recurring/conference events reject edit without side effects', async t => {
  const f = await fixture(t), account = await f.connect(), plan = await account.prepare('create', f.calendar.id, input);
  await account.execute(plan, 'execution-complex'); const original = f.events.get(plan.eventId);
  for (const extra of [{ attendees: [{ email: 'guest@example.test' }] }, { recurrence: ['RRULE:FREQ=DAILY'] }, { conferenceData: {} }, { locked: true }, { eventType: 'outOfOffice' }]) {
    f.events.set(plan.eventId, { ...original, ...extra });
    await assert.rejects(account.prepare('update', f.calendar.id, { ...input, eventId: plan.eventId }), /google_event_not_supported/);
    await assert.rejects(account.prepare('delete', f.calendar.id, { eventId: plan.eventId }), /google_event_not_supported/);
  }
  assert(!f.requests.some(r => r.method === 'PATCH' || r.method === 'DELETE'));
});

test('all-day creation, event listing, and update success use exact normalized event evidence', async t => {
  const f = await fixture(t), account = await f.connect();
  const allDay = { summary: '종일 일정', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } };
  const created = await account.prepare('create', f.calendar.id, allDay);
  assert.equal((await account.execute(created, 'execution-allday')).status, 'succeeded');
  const listed = await account.listEvents(f.calendar.id, { timeMin: '2026-09-10T00:00:00Z', timeMax: '2026-09-12T00:00:00Z' });
  assert.equal(listed[0].id, created.eventId); assert.deepEqual(listed[0].end, { date: '2026-09-11' });
  assert(Object.isFrozen(listed[0]));
  const update = await account.prepare('update', f.calendar.id, { ...allDay, eventId: created.eventId, summary: '변경된 종일 일정' });
  f.write((_req, _res, json, body) => {
    const changed = { ...f.events.get(created.eventId), ...JSON.parse(body), etag: '"updated-etag"' };
    f.events.set(created.eventId, changed); return json(200, changed);
  });
  const result = await account.execute(update, 'execution-allday-update');
  assert.equal(result.status, 'succeeded'); assert.equal(JSON.parse(result.resultJson).summary, '변경된 종일 일정');
  assert.equal((await account.reconcile(update, 'execution-allday-update')).status, 'succeeded');
});

test('calendar authority is refreshed before mutation and the validated plan copy survives caller mutation', async t => {
  const f = await fixture(t), account = await f.connect();
  const plan = await account.prepare('create', f.calendar.id, input);
  f.calendar.summary = '바뀐 캘린더';
  assert.equal((await account.execute(plan, 'execution-changed-calendar')).status, 'failed');
  f.calendar.summary = plan.calendarLabel;
  const mutable = structuredClone(plan), originalFetch = f.dependencies.fetch;
  f.dependencies.fetch = (url, init) => {
    if (String(url).endsWith('/v1/userinfo')) mutable.event.summary = '검토하지 않은 변경';
    return originalFetch(url, init);
  };
  assert.equal((await account.execute(mutable, 'execution-plan-copy')).status, 'succeeded');
  assert.equal(f.events.get(plan.eventId).summary, input.summary);
});

test('event IDs exceeding receipt contract limits remain readable but cannot start a mutation', async t => {
  const f = await fixture(t), account = await f.connect(), id = 'a'.repeat(129);
  f.events.set(id, { ...input, id, etag: '"etag"', status: 'confirmed' });
  const rows = await account.listEvents(f.calendar.id, { timeMin: '2026-09-10T00:00:00Z', timeMax: '2026-09-12T00:00:00Z' });
  assert.equal(rows[0].id, id);
  await assert.rejects(account.prepare('delete', f.calendar.id, { eventId: id }), /google_invalid_event_id/);
  assert(!f.requests.some(r => r.method === 'DELETE'));
});

test('older account disposal cannot delete credentials saved by a newer authorization or restore', async t => {
  const f = await fixture(t), older = await f.connect(), newer = await f.connect();
  const saved = [...f.store.values()][0];
  await older.disconnect();
  assert.equal(f.store.size, 1); assert.equal([...f.store.values()][0], saved);
  const restored = await GoogleCalendarAccount.restore(newer.accountId, f.vault, f.dependencies);
  const restoredValue = [...f.store.values()][0];
  await newer.disconnect();
  assert.equal(f.store.size, 1); assert.equal([...f.store.values()][0], restoredValue);
  assert.equal((await restored.listCalendars())[0].id, f.calendar.id);
});

test('cancellation after reauthorization saves restores the existing credential instead of deleting it', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  await f.connect(); const saved = [...f.store.values()][0], originalSet = f.vault.set;
  let cancelNext = true;
  f.vault.set = async (key, value) => { await originalSet(key, value); if (cancelNext) { cancelNext = false; controller.abort(); } };
  await assert.rejects(f.connect(), /google_cancelled/);
  assert.equal(f.store.size, 1); assert.equal([...f.store.values()][0], saved);
  assert(!f.requests.some(r => r.url.pathname.includes('/events')));
});

test('an older token refresh cannot overwrite a newer account credential while OAuth reconnects', async t => {
  const f = await fixture(t), older = await f.connect();
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  let tokens = 0;
  f.advance(); f.token(async () => { if (++tokens === 1) { enter(); await waiting; } });
  const pending = older.listCalendars(); await entered;
  const newer = await GoogleCalendarAccount.authorize({ clientId: 'new-fixture.apps.googleusercontent.com' }, f.dependencies);
  const saved = [...f.store.values()][0];
  release(); await assert.rejects(pending, /google_credentials_changed/);
  assert.equal([...f.store.values()][0], saved);
  assert.equal(JSON.parse(saved).clientId, 'new-fixture.apps.googleusercontent.com');
  await older.disconnect(); assert.equal([...f.store.values()][0], saved);
  assert.equal((await newer.listCalendars())[0].id, f.calendar.id);
});
