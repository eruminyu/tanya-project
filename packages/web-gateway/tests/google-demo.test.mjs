// The google_demo executor against a fake Google API (token, userinfo, calendar list, events), driven through
// the gateway with the mock Brain: approval writes the event, the receipt carries the read-back, the public
// calendar route lists it and the sweeper deletes it after the retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGateway } from '../dist/web-gateway/src/server.js';
import { DEFAULT_LIMITS } from '../dist/web-gateway/src/config.js';
import { GoogleDemoExecutor, eventLink, DEMO_PREFIX } from '../dist/web-gateway/src/google-demo-executor.js';
import { startMockBrain, TOKEN } from './mock-brain.mjs';

const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events';

async function fakeGoogle() {
  const events = new Map(), requests = [];
  const identity = { sub: 'demo-account-user', email: 'demo@example.test', email_verified: true };
  const calendar = { id: 'demo-calendar@group.calendar.google.com', summary: '키리안 데모 캘린더', timeZone: 'Asia/Seoul', accessRole: 'owner' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://fake');
    requests.push({ method: req.method, path: url.pathname, body });
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/token') return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
    if (url.pathname === '/v1/userinfo') return json(200, identity);
    if (url.pathname === '/calendar/v3/users/me/calendarList') return json(200, { items: [calendar] });
    if (url.pathname.startsWith('/calendar/v3/users/me/calendarList/')) return json(200, calendar);
    if (url.pathname.includes('/events')) {
      const last = decodeURIComponent(url.pathname.split('/').at(-1));
      if (req.method === 'GET') {
        if (last === 'events') return json(200, { items: [...events.values()] });
        return events.has(last) ? json(200, events.get(last)) : json(404, { error: 'not found' });
      }
      if (req.method === 'DELETE') { events.delete(last); res.writeHead(204); return res.end(); }
      const parsed = JSON.parse(body), id = parsed.id ?? last;
      const event = { ...events.get(id), ...parsed, id, etag: '"etag-' + events.size + '"', status: 'confirmed' };
      events.set(id, event);
      return json(req.method === 'POST' ? 201 : 200, event);
    }
    return json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchFake = (url, init) => { const parsed = new URL(url); return fetch(base + parsed.pathname + parsed.search, init); };
  const directory = await mkdtemp(join(tmpdir(), 'kirian-google-demo-'));
  const credentialFile = join(directory, 'credential.json');
  await writeFile(credentialFile, JSON.stringify({ version: 1, generation: 'a'.repeat(64), clientId: 'fixture.apps.googleusercontent.com', subject: identity.sub, email: identity.email,
    accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000, scopes: SCOPES.split(' ') }));
  return { fetch: fetchFake, credentialFile, calendar, events, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

function connect(base, token) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/demo/ws?token=${token}`);
  const received = [], waiters = [];
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    received.push(value);
    for (const waiter of [...waiters]) if (waiter.match(value)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
  });
  const opened = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 1;
  const client = {
    socket, opened: () => opened,
    waitFor: (match, timeoutMs = 5000) => {
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout; last=' + JSON.stringify(received.at(-1)).slice(0, 400))), timeoutMs);
        waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
      });
    },
    command: async value => { const id = nextId++; socket.send(JSON.stringify({ id, ...value })); return (await client.waitFor(item => item.kind === 'result' && item.id === id)).result; },
  };
  return client;
}

test('the demo account executor writes, reads back, lists publicly and sweeps demo events', async () => {
  const google = await fakeGoogle();
  let now = Date.now();
  const executor = await GoogleDemoExecutor.create({ credentialFile: google.credentialFile, calendarId: google.calendar.id, cleanupMinutes: 30, fetch: google.fetch, now: () => now });
  assert.equal(executor.kind, 'google_demo');
  assert.equal(executor.calendar.label, '키리안 데모 캘린더');
  // The credential file was rotated by restore (new generation), still owned by the operator.
  assert.notEqual(JSON.parse(await readFile(google.credentialFile, 'utf8')).generation, 'a'.repeat(64));
  // Leftovers from an earlier run with the demo prefix are swept at start; other events stay.
  google.events.set('olddemo1', { id: 'olddemo1', etag: '"e"', status: 'confirmed', summary: DEMO_PREFIX + '지난 데모', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T11:00:00+09:00' } });
  google.events.set('keepme1', { id: 'keepme1', etag: '"e"', status: 'confirmed', summary: '운영자 일정', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T11:00:00+09:00' } });

  const brain = await startMockBrain({ speech: false, tools: true });
  const gateway = createGateway({ host: '127.0.0.1', port: 0, brainUrl: brain.url, brainToken: TOKEN, staticDir: null, trustProxy: false,
    calendarLabel: 'unused', calendarTimeZone: 'Asia/Seoul', executorKind: 'google_demo', googleDemo: null, limits: { ...DEFAULT_LIMITS, concurrentPerClient: 5 }, executor, now: () => now });
  try {
    const address = await gateway.listen();
    const base = `http://127.0.0.1:${address.port}`;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(google.events.has('olddemo1'), false);
    assert.equal(google.events.has('keepme1'), true);
    const session = await (await fetch(base + '/demo/session', { method: 'POST' })).json();
    assert.deepEqual(session.demo.calendar, { kind: 'google_demo', label: '키리안 데모 캘린더', timeZone: 'Asia/Seoul' });
    const client = connect(base, session.token);
    await client.opened();
    await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.phase === 'ready');
    assert.deepEqual(await client.command({ kind: 'send', text: '내일 3시에 치과 예약 잡아 줘' }), { ok: true });
    const awaiting = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.tools.phase === 'awaiting_approval');
    const draft = awaiting.snapshot.tools.draft;
    assert.equal(draft.event.summary, DEMO_PREFIX + '치과 예약');
    assert.equal(draft.calendarLabel, '키리안 데모 캘린더');
    assert.equal(google.events.size, 1);
    assert.deepEqual(await client.command({ kind: 'approve', draftId: draft.draftId }), { ok: true });
    const finished = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.tools.phase === 'finished');
    const receipt = finished.snapshot.tools.receipt;
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.executorKind, 'google_demo');
    assert.equal(receipt.handoff, null);
    assert.equal(receipt.created.readBack, true);
    assert.equal(receipt.created.calendarLabel, '키리안 데모 캘린더');
    assert.equal(receipt.created.htmlLink, eventLink(receipt.created.eventId, google.calendar.id));
    assert.match(receipt.created.htmlLink, /^https:\/\/calendar\.google\.com\/calendar\/event\?eid=/);
    const written = google.events.get(receipt.created.eventId);
    assert.equal(written.summary, DEMO_PREFIX + '치과 예약');
    assert.equal(written.extendedProperties.private.kirianExecution, createHash('sha256').update('demo-' + draft.draftId).digest('hex'));
    const registration = brain.state.registrations[0];
    assert.equal(registration.provenance.boundary, 'cloud');
    assert.match(registration.canonicalResultJson, /"kind":"calendar_created"/);
    assert.match(registration.canonicalResultJson, /재조회로 확인됨/);
    // Public view: the created event is listed with the calendar identity.
    const listing = await (await fetch(base + '/demo/calendar')).json();
    assert.equal(listing.calendar.kind, 'google_demo');
    assert.deepEqual(listing.events.map(item => item.id).sort(), ['keepme1', receipt.created.eventId].sort());
    // Ending the demo deletes this session's events right away (not the operator's), closes with the count, and a
    // second visitor's finish deletes nothing.
    assert.deepEqual(await client.command({ kind: 'finish' }), { ok: true });
    const closed = await client.waitFor(item => item.kind === 'closed');
    assert.deepEqual(closed, { kind: 'closed', reason: 'finished', deletedEvents: 1 });
    assert.equal(google.events.has(receipt.created.eventId), false);
    assert.equal(google.events.has('keepme1'), true);
    const other = connect(base, (await (await fetch(base + '/demo/session', { method: 'POST' })).json()).token);
    await other.opened();
    await other.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.phase === 'ready');
    assert.deepEqual(await other.command({ kind: 'finish' }), { ok: true });
    assert.deepEqual(await other.waitFor(item => item.kind === 'closed'), { kind: 'closed', reason: 'finished', deletedEvents: 0 });
    // Retention still applies to whatever a visitor left behind.
    now += 31 * 60_000;
    assert.equal(await executor.sweep(), 0);
    assert.equal(google.events.has('keepme1'), true);
    client.socket.close();
  } finally { await gateway.close(); await brain.close(); await google.close(); }
});
