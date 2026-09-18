// The browser client against a scripted gateway: token request, socket, snapshots, commands, audio decoding
// and closes. Runs under node:test with a fake fetch and a fake WebSocket; no bundler needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

// Strip types so the TS module can be imported by Node directly (Vite does this in the browser build).
const source = await readFile(new URL('../src/demo-client.ts', import.meta.url), 'utf8');
const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
const { DemoClient } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({ reason: '' }); }
  open() { this.readyState = 1; }
  push(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
globalThis.WebSocket = { OPEN: 1 };

const snapshot = (overrides = {}) => ({ session: { revision: 1, connection: { phase: 'ready', reason: null }, actualModel: null, messages: [], activeTurnId: null },
  brain: { phase: 'ready', reason: null, url: 'public-demo', models: [], selectedModelId: null, speech: { available: true, enabled: true, label: 'v', phase: 'idle', sentence: null, error: null }, transcription: { available: false, label: null } },
  capabilities: { chat: true, voice: true, live2d: true }, demo: { turnsUsed: 0, turnsLimit: 30, messageCharacters: 500, busy: false }, ...overrides });

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return { ok: status === 200, status, json: async () => body }; };
  return { impl, calls };
}

test('connect requests a token, opens the socket and reports the ready snapshot', async () => {
  FakeSocket.instances = [];
  const http = fakeFetch(200, { token: 'abc', expiresInSeconds: 60, demo: { modelLabel: 'Gemma', speechAvailable: true, speechLabel: 'voice', turnsPerSession: 30, messageCharacters: 500, idleSeconds: 600 } });
  const client = new DemoClient({ origin: 'https://demo.example', fetch: http.impl, createSocket: url => new FakeSocket(url) });
  const states = [];
  client.subscribe(state => states.push(state.phase));
  const connecting = client.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(http.calls[0].url, 'https://demo.example/demo/session');
  assert.equal(http.calls[0].init.method, 'POST');
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://demo.example/demo/ws?token=abc');
  socket.open();
  socket.push({ kind: 'snapshot', snapshot: snapshot({ brain: { ...snapshot().brain, phase: 'connecting' } }) });
  assert.equal(client.getState().phase, 'connecting');
  socket.push({ kind: 'snapshot', snapshot: snapshot() });
  await connecting;
  assert.deepEqual([...new Set(states)], ['idle', 'requesting', 'connecting', 'ready']);
  assert.equal(client.getState().info.modelLabel, 'Gemma');

  const pending = client.sendText('안녕');
  assert.deepEqual(socket.sent.at(-1), { id: 1, kind: 'send', text: '안녕' });
  socket.push({ kind: 'result', id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  const playback = client.reportPlayback({ playbackId: 'p1', state: 'queued' });
  assert.deepEqual(socket.sent.at(-1), { id: 2, kind: 'playback', playbackId: 'p1', state: 'queued' });
  socket.push({ kind: 'result', id: 2, result: { ok: false, code: 'invalid_request' } });
  assert.deepEqual(await playback, { ok: false, code: 'invalid_request' });

  const audio = [];
  client.onAudio(event => audio.push(event));
  socket.push({ kind: 'audio', playbackId: 'p2', sentence: '문장', audioBase64: Buffer.from('RIFFxxxx').toString('base64') });
  socket.push({ kind: 'audio-reset' });
  assert.equal(audio[0].kind, 'audio');
  assert.equal(audio[0].sentence, '문장');
  assert.equal(Buffer.from(audio[0].data).toString(), 'RIFFxxxx');
  assert.deepEqual(audio[1], { kind: 'reset' });

  socket.push({ kind: 'closed', reason: 'idle' });
  assert.deepEqual([client.getState().phase, client.getState().reason], ['closed', 'idle']);
  assert.equal(audio.at(-1).kind, 'reset');
  assert.deepEqual(await client.sendText('again'), { ok: false, code: 'brain_unavailable' });
});

test('a refused token and a dropped socket end in a closed state with the reason', async () => {
  FakeSocket.instances = [];
  const refused = fakeFetch(429, { error: 'client_rate', retryAfterSeconds: 120 });
  const client = new DemoClient({ origin: 'https://demo.example', fetch: refused.impl, createSocket: url => new FakeSocket(url) });
  await client.connect();
  assert.deepEqual([client.getState().phase, client.getState().reason, client.getState().retryAfterSeconds], ['closed', 'client_rate', 120]);
  assert.equal(FakeSocket.instances.length, 0);

  const ok = fakeFetch(200, { token: 't', expiresInSeconds: 60, demo: { modelLabel: 'Gemma', speechAvailable: false, speechLabel: null, turnsPerSession: 30, messageCharacters: 500, idleSeconds: 600 } });
  const second = new DemoClient({ origin: 'https://demo.example', fetch: ok.impl, createSocket: url => new FakeSocket(url), commandTimeoutMs: 20 });
  const connecting = second.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.push({ kind: 'snapshot', snapshot: snapshot() });
  await connecting;
  const unanswered = second.cancelTurn();
  assert.deepEqual(await unanswered, { ok: false, code: 'brain_unavailable' });
  socket.onclose({ reason: 'connection_failed' });
  assert.deepEqual([second.getState().phase, second.getState().reason], ['closed', 'connection_failed']);
});
