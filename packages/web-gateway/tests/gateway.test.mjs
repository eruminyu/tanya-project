import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGateway } from '../dist/web-gateway/src/server.js';
import { DEFAULT_LIMITS } from '../dist/web-gateway/src/config.js';
import { startMockBrain, TOKEN } from './mock-brain.mjs';

async function startGateway(brain, overrides = {}, limits = {}) {
  const gateway = createGateway({ host: '127.0.0.1', port: 0, brainUrl: brain.url, brainToken: TOKEN, staticDir: null, trustProxy: false,
    limits: { ...DEFAULT_LIMITS, ...limits }, ...overrides });
  const address = await gateway.listen();
  return { gateway, base: `http://127.0.0.1:${address.port}` };
}

async function issue(base, headers = {}) {
  const response = await fetch(base + '/demo/session', { method: 'POST', headers });
  return { status: response.status, body: await response.json() };
}

/** Opens the visitor socket and collects every gateway message; waitFor resolves on a matching message. */
function connect(base, token) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/demo/ws?token=${token}`);
  const received = [];
  const waiters = [];
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    received.push(value);
    for (const waiter of [...waiters]) if (waiter.match(value)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
  });
  // Registered at creation so a close that already happened still resolves.
  const closedPromise = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const openedPromise = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  openedPromise.catch(() => {});
  let nextId = 1;
  const client = {
    socket, received,
    waitFor: (match, timeoutMs = 5000) => {
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for message; last=' + JSON.stringify(received.at(-1)).slice(0, 300))), timeoutMs);
        waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
      });
    },
    command: async value => {
      const id = nextId++;
      socket.send(JSON.stringify({ id, ...value }));
      return (await client.waitFor(item => item.kind === 'result' && item.id === id)).result;
    },
    opened: () => openedPromise,
    closed: () => closedPromise,
  };
  return client;
}

const ready = client => client.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.phase === 'ready');
const lastSnapshot = client => [...client.received].reverse().find(item => item.kind === 'snapshot').snapshot;

test('visitor tokens are rate limited per client and the socket needs a fresh one', async () => {
  const brain = await startMockBrain();
  const { gateway, base } = await startGateway(brain, {}, { concurrentPerClient: 2, sessionsPerHour: 3 });
  try {
    const first = await issue(base);
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['demo', 'expiresInSeconds', 'token']);
    assert.equal(first.body.demo.modelLabel, 'Mock Gemma');
    assert.equal(first.body.demo.speechAvailable, true);
    const second = await issue(base);
    assert.equal(second.status, 200);
    const third = await issue(base);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'client_concurrency');
    const bad = connect(base, 'not-a-token');
    await assert.rejects(bad.opened(), /401/);
    const client = connect(base, first.body.token);
    await client.opened();
    await ready(client);
    // A token is single use.
    const reuse = connect(base, first.body.token);
    await assert.rejects(reuse.opened(), /401/);
    assert.equal(gateway.stats().sessions, 1);
    client.socket.close();
    await client.closed();
  } finally { await gateway.close(); await brain.close(); }
});

test('a text turn is relayed through the reused session projection and counted', async () => {
  const brain = await startMockBrain({ speech: false });
  const { gateway, base } = await startGateway(brain);
  try {
    const { body } = await issue(base);
    assert.equal(body.demo.speechAvailable, false);
    const client = connect(base, body.token);
    await client.opened();
    const snapshot = (await ready(client)).snapshot;
    assert.equal(snapshot.capabilities.voice, false);
    assert.equal(snapshot.demo.turnsUsed, 0);
    assert.deepEqual(snapshot.brain.models.map(item => item.label), ['Mock Gemma']);
    assert.deepEqual(await client.command({ kind: 'send', text: '  안녕?  ' }), { ok: true });
    const done = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.messages.some(row => row.role === 'assistant' && row.status === 'completed') && item.snapshot.session.activeTurnId === null);
    const rows = done.snapshot.session.messages;
    assert.deepEqual(rows.map(row => [row.role, row.status, row.text]), [['user', 'completed', '안녕?'], ['assistant', 'completed', '안녕하세요.공개 데모예요.']]);
    assert.deepEqual(done.snapshot.session.actualModel, { providerId: 'ollama', modelId: 'mock-gemma', endpointId: 'server-ollama' });
    assert.equal(done.snapshot.demo.turnsUsed, 1);
    assert.equal(gateway.stats().turnsInUse, 0);
    const start = brain.state.turns.find(item => item.kind === 'turn.start');
    assert.deepEqual(start.payload, { selection: { model: { provider_id: 'ollama', model_id: 'mock-gemma', endpoint_id: 'server-ollama' }, source: 'initial_local' }, context: [] });
    assert.deepEqual(await client.command({ kind: 'send', text: '' }), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await client.command({ kind: 'send', text: 'x'.repeat(DEFAULT_LIMITS.messageCharacters + 1) }), { ok: false, code: 'invalid_request' });
    client.socket.close();
  } finally { await gateway.close(); await brain.close(); }
});

test('speech is requested by the gateway, audio reaches the browser and playback reports end the turn', async () => {
  const brain = await startMockBrain({ answer: '첫 문장이에요. 둘째 문장이에요.' });
  const { gateway, base } = await startGateway(brain);
  try {
    const { body } = await issue(base);
    const client = connect(base, body.token);
    await client.opened();
    const snapshot = (await ready(client)).snapshot;
    assert.equal(snapshot.brain.speech.enabled, true);
    assert.deepEqual(await client.command({ kind: 'send', text: '말해 줘' }), { ok: true });
    const audio = await client.waitFor(item => item.kind === 'audio');
    assert.equal(audio.sentence, '첫 문장이에요.');
    assert.ok(Buffer.from(audio.audioBase64, 'base64').subarray(0, 4).equals(Buffer.from('RIFF')));
    assert.deepEqual(await client.command({ kind: 'playback', playbackId: audio.playbackId, state: 'queued' }), { ok: true });
    assert.deepEqual(await client.command({ kind: 'playback', playbackId: audio.playbackId, state: 'playing' }), { ok: true });
    const playing = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.speech.phase === 'playing');
    assert.equal(playing.snapshot.brain.speech.sentence, '첫 문장이에요.');
    assert.deepEqual(await client.command({ kind: 'playback', playbackId: audio.playbackId, state: 'completed' }), { ok: true });
    const second = await client.waitFor(item => item.kind === 'audio' && item.sentence === '둘째 문장이에요.');
    for (const state of ['queued', 'playing', 'completed']) assert.deepEqual(await client.command({ kind: 'playback', playbackId: second.playbackId, state }), { ok: true });
    await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId === null && item.snapshot.session.messages.some(row => row.role === 'assistant' && row.status === 'completed'));
    assert.equal(lastSnapshot(client).brain.speech.phase, 'idle');
    assert.deepEqual(brain.state.turns.filter(item => item.kind === 'speech.request').map(item => item.payload.text), ['첫 문장이에요.', '둘째 문장이에요.']);
    assert.equal(brain.state.turns.filter(item => item.kind === 'speech.finished').length, 1);
    // Voice can be switched off; the next turn then asks for no speech.
    assert.deepEqual(await client.command({ kind: 'voice', enabled: false }), { ok: true });
    assert.deepEqual(await client.command({ kind: 'playback', playbackId: 'stale', state: 'queued' }), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await client.command({ kind: 'send', text: '조용히' }), { ok: true });
    await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.demo.turnsUsed === 2 && item.snapshot.session.activeTurnId === null);
    assert.equal(brain.state.turns.filter(item => item.kind === 'turn.start').at(-1).payload.speech, undefined);
    client.socket.close();
  } finally { await gateway.close(); await brain.close(); }
});

test('unknown browser commands, turn caps and shared generation slots are enforced', async () => {
  const brain = await startMockBrain({ speech: false, delayMs: 150 });
  const { gateway, base } = await startGateway(brain, {}, { concurrentTurns: 1, turnsPerSession: 1, concurrentPerClient: 5 });
  try {
    const rogue = connect(base, (await issue(base)).body.token);
    await rogue.opened();
    await ready(rogue);
    rogue.socket.send(JSON.stringify({ kind: 'tool.offers', payload: {} }));
    const closed = await rogue.waitFor(item => item.kind === 'closed');
    assert.equal(closed.reason, 'protocol_error');
    await rogue.closed();

    const first = connect(base, (await issue(base)).body.token);
    const second = connect(base, (await issue(base)).body.token);
    await Promise.all([first.opened(), second.opened(), ready(first), ready(second)]);
    assert.deepEqual(await first.command({ kind: 'send', text: '느린 답변' }), { ok: true });
    assert.equal(gateway.stats().turnsInUse, 1);
    assert.deepEqual(await second.command({ kind: 'send', text: '나도' }), { ok: false, code: 'busy' });
    assert.equal(lastSnapshot(second).demo.busy, true);
    assert.deepEqual(await first.command({ kind: 'send', text: '겹치기' }), { ok: false, code: 'busy' });
    await first.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId === null && item.snapshot.demo.turnsUsed === 1, 10000);
    assert.equal(gateway.stats().turnsInUse, 0);
    assert.deepEqual(await first.command({ kind: 'send', text: '한 번 더' }), { ok: false, code: 'routing_limit' });
    assert.deepEqual(await second.command({ kind: 'send', text: '이제 내 차례' }), { ok: true });
    await second.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId === null && item.snapshot.demo.turnsUsed === 1 && item.snapshot.demo.busy === false, 10000);
    first.socket.close(); second.socket.close();
  } finally { await gateway.close(); await brain.close(); }
});

test('cancel stops the turn and a Brain-side close or idle timeout ends the visitor session', async () => {
  const brain = await startMockBrain({ speech: false, delayMs: 200 });
  const { gateway, base } = await startGateway(brain, {}, { idleSeconds: 1, concurrentPerClient: 5 });
  try {
    const client = connect(base, (await issue(base)).body.token);
    await client.opened();
    await ready(client);
    assert.deepEqual(await client.command({ kind: 'send', text: '취소할게' }), { ok: true });
    await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId !== null);
    assert.deepEqual(await client.command({ kind: 'cancel' }), { ok: true });
    const cancelled = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.messages.some(row => row.role === 'assistant' && row.status === 'cancelled') && item.snapshot.session.activeTurnId === null);
    assert.equal(cancelled.snapshot.demo.turnsUsed, 1);
    assert.deepEqual(await client.command({ kind: 'cancel' }), { ok: false, code: 'invalid_request' });
    const idle = await client.waitFor(item => item.kind === 'closed', 5000);
    assert.equal(idle.reason, 'idle');
    await client.closed();
    assert.equal(gateway.stats().sessions, 0);

    const other = connect(base, (await issue(base)).body.token);
    await other.opened();
    await ready(other);
    brain.state.closeAll();
    const closed = await other.waitFor(item => item.kind === 'closed');
    assert.equal(closed.reason, 'connection_failed');
    await other.closed();
  } finally { await gateway.close(); await brain.close(); }
});

test('a personal Brain is refused and static files are served with a strict policy', async () => {
  const brain = await startMockBrain();
  brain.state.personal = true;
  const root = await mkdtemp(join(tmpdir(), 'kirian-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Kirian</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(tmpdir(), 'kirian-web-secret.txt'), 'outside');
  const { gateway, base } = await startGateway(brain, { staticDir: root });
  try {
    const refused = await issue(base);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, 'brain_unavailable');
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.equal(await page.text(), '<!doctype html><title>Kirian</title>');
    const asset = await fetch(base + '/assets/app.js');
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(asset.headers.get('cache-control'), /immutable/);
    for (const path of ['/assets/../../kirian-web-secret.txt', '/..%2F..%2Fkirian-web-secret.txt', '/%2e%2e/kirian-web-secret.txt']) {
      const escaped = await fetch(base + path);
      assert.ok([403, 404].includes(escaped.status), path);
      assert.notEqual(await escaped.text(), 'outside', path);
    }
    assert.equal((await fetch(base + '/missing.js')).status, 404);
    assert.equal((await fetch(base + '/demo/ws')).status, 426);
    assert.equal((await fetch(base + '/demo/session')).status, 405);
    const health = await (await fetch(base + '/demo/health')).json();
    assert.deepEqual(health, { ok: true, sessions: 0, turnsInUse: 0, tokens: 0 });
  } finally { await gateway.close(); await brain.close(); }
});
