// End to end with the real Brain source in public_demo mode: a fake Ollama answers the tool turn with a
// calendar call and the summary turn with text, the gateway plays the host, a visitor approves the draft.
// Skipped when the repository's Python environment is not present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createGateway } from '../dist/web-gateway/src/server.js';
import { DEFAULT_LIMITS } from '../dist/web-gateway/src/config.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const MODEL = 'fake-gemma';
const TOKEN = 'real-brain-test-token-with-32-characters!';

async function startFakeOllama() {
  const calls = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      calls.push(body);
      const user = [...body.messages].reverse().find(item => item.role === 'user')?.content ?? '';
      if (body.stream === false) {
        // The tool turn: propose a calendar event for a calendar request, otherwise answer as text.
        const wantsCalendar = /일정|예약/.test(user) && Array.isArray(body.tools) && body.tools.length;
        const message = wantsCalendar
          ? { role: 'assistant', content: '', tool_calls: [{ function: { name: body.tools[0].function.name, arguments: {
              summary: '치과 예약', start: { dateTime: '2026-09-18T15:00:00+09:00', timeZone: 'Asia/Seoul' },
              end: { dateTime: '2026-09-18T16:00:00+09:00', timeZone: 'Asia/Seoul' }, description: '', location: '' } } }] }
          : { role: 'assistant', content: '안녕하세요, 키리안이에요.' };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ model: MODEL, done: true, done_reason: 'stop', message }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const text = /외부 도구 실행 결과/.test(body.messages[0]?.content ?? '') ? '일정을 준비했어요. 캘린더에 담아 주세요.' : '안녕하세요, 키리안이에요.';
      response.end(JSON.stringify({ model: MODEL, done: true, message: { role: 'assistant', content: text } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

async function startBrain(ollamaUrl) {
  const directory = await mkdtemp(join(tmpdir(), 'kirian-public-brain-'));
  const config = { identity: { instance_id: 'public-demo-v1', mode: 'public_demo', principal_id: 'visitor' },
    bindings: [{ model: { provider_id: 'ollama', model_id: MODEL, endpoint_id: 'server-ollama' }, label: 'Fake Gemma', kind: 'ollama', url: ollamaUrl,
      boundary: 'local', think: false, num_ctx: 8192, supports_images: false, supports_tools: true, automatic_allowed: false, budget_units: 1 }],
    data_dir: join(directory, 'data') };
  const path = join(directory, 'host.json');
  await writeFile(path, JSON.stringify(config));
  const port = 18000 + Math.floor(Math.random() * 20000);
  const child = spawn(python, ['-X', 'utf8', '-m', 'uvicorn', 'rearchitecture.app:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port), '--no-access-log', '--log-level', 'warning'],
    { cwd: join(root, 'packages/brain'), env: { ...process.env, KIRIAN_V1_TOKEN: TOKEN, KIRIAN_V1_CONFIG_FILE: path, PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.on('data', data => { log = (log + data.toString()).slice(-4000); });
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error('brain exited: ' + log);
    try { const response = await fetch(url + 'v1/config', { headers: { Authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(500) }); if (response.ok) { await response.body?.cancel(); break; } } catch { /* not yet */ }
    if (attempt > 200) throw new Error('brain timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { url, close: async () => { if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; } }, log: () => log };
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
    socket, received, opened: () => opened,
    waitFor: (match, timeoutMs = 15000) => {
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout; last=' + JSON.stringify(received.at(-1)).slice(0, 500))), timeoutMs);
        waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
      });
    },
    command: async value => { const id = nextId++; socket.send(JSON.stringify({ id, ...value })); return (await client.waitFor(item => item.kind === 'result' && item.id === id)).result; },
  };
  return client;
}

test('real public_demo Brain: calendar draft, approval, hand-off registration and summary', { skip: !existsSync(python) && 'python venv not present' }, async () => {
  const ollama = await startFakeOllama();
  const brain = await startBrain(ollama.url);
  const gateway = createGateway({ host: '127.0.0.1', port: 0, brainUrl: brain.url, brainToken: TOKEN, staticDir: null, trustProxy: false,
    calendarLabel: '내 캘린더', calendarTimeZone: 'Asia/Seoul', limits: { ...DEFAULT_LIMITS, concurrentPerClient: 5 } });
  try {
    const address = await gateway.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const session = await (await fetch(base + '/demo/session', { method: 'POST' })).json();
    assert.equal(session.demo.calendar?.kind, 'handoff', JSON.stringify(session));
    const client = connect(base, session.token);
    await client.opened();
    await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.phase === 'ready');
    assert.deepEqual(await client.command({ kind: 'send', text: '안녕?' }), { ok: true });
    const greeted = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId === null && item.snapshot.session.messages.some(row => row.role === 'assistant' && row.status === 'completed'));
    assert.equal(greeted.snapshot.session.messages.at(-1).text, '안녕하세요, 키리안이에요.');
    assert.deepEqual(await client.command({ kind: 'send', text: '내일 3시에 치과 예약 잡아 줘' }), { ok: true });
    const awaiting = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.tools.phase === 'awaiting_approval');
    const draft = awaiting.snapshot.tools.draft;
    assert.equal(draft.event.summary, '치과 예약');
    assert.deepEqual(await client.command({ kind: 'approve', draftId: draft.draftId }), { ok: true });
    const finished = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.tools.phase === 'finished');
    assert.equal(finished.snapshot.tools.receipt.status, 'succeeded');
    assert.match(finished.snapshot.tools.receipt.handoff.googleCalendarUrl, /calendar\.google\.com/);
    const summary = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId === null && item.snapshot.session.messages.at(-1)?.role === 'assistant' && item.snapshot.session.messages.at(-1)?.status === 'completed' && item.snapshot.session.messages.length >= 4);
    assert.equal(summary.snapshot.session.messages.at(-1).text, '일정을 준비했어요. 캘린더에 담아 주세요.');
    // The Brain called the model once with tools and once without (the summary) for the calendar turn.
    const toolCalls = ollama.calls.filter(body => Array.isArray(body.tools) && body.tools.length);
    assert.equal(toolCalls.length, 2);
    assert.match(toolCalls[1].messages[0].content, /승인용 초안/);
    const summaryCall = ollama.calls.at(-1);
    assert.ok(!summaryCall.tools);
    assert.match(summaryCall.messages[0].content, /calendar_handoff/);
    // A second visitor is unaffected when the first one leaves (its conversation is deleted on the Brain).
    const other = connect(base, (await (await fetch(base + '/demo/session', { method: 'POST' })).json()).token);
    await other.opened();
    await other.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.phase === 'ready');
    client.socket.close();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(other.received.some(item => item.kind === 'closed'), false, JSON.stringify(other.received.filter(item => item.kind === 'closed')));
    assert.deepEqual(await other.command({ kind: 'voice', enabled: false }), { ok: false, code: 'invalid_request' });
    other.socket.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    const conversations = await (await fetch(brain.url + 'v1/conversations', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    assert.deepEqual(conversations.conversations, []);
  } finally { await gateway.close(); await brain.close(); await ollama.close(); }
});
