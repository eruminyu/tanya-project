import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';

// Synthetic authenticated HTTP/WS responses, exercising current main-process code.
const { outputFiles } = await build({
  stdin: { contents: `export {BrainConnection} from './src/main/brain-connection.ts'; export {SessionController} from './src/main/session-controller.ts';`,
    loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'package-entries', setup(api) {
    api.onResolve({ filter: /^(?:@kirian\/contracts|ws)$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }],
});
const { BrainConnection, SessionController } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('an older post-turn conversation list cannot restore a conversation deleted by a newer library request', { timeout: 5000 }, async t => {
  const token = 'a'.repeat(48);
  const identity = { instance_id: 'library-race', mode: 'personal', principal_id: 'owner' };
  const model = { provider_id: 'ollama', model_id: 'local-model', endpoint_id: 'local' };
  const summary = id => ({ id, title: id, updated_at: id === 'current' ? 200 : 100, model: null });
  const config = { identity, models: [{ model, label: 'Local' }], default_selection: { model, source: 'initial_local' }, persistence: true };
  let conversations = [summary('current'), summary('other')], listCalls = 0, held = null, peer, scope;
  const send = (kind, payload, start = null, sequence = 0) => peer.send(JSON.stringify({
    protocol: 'kirian.rearchitecture.v1', scope, kind, payload, sequence,
    message_id: randomUUID(), request_id: start?.request_id ?? randomUUID(),
    turn_id: start?.turn_id ?? null, intent_id: start?.intent_id ?? null,
  }));
  const http = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    const finish = body => response.end(JSON.stringify(body));
    if (request.url === '/v1/config') finish(config);
    else if (request.url === '/v1/conversations') {
      listCalls += 1;
      if (listCalls === 2) held = { response, body: JSON.stringify({ conversations }) };
      else finish({ conversations });
    } else if (request.url === '/v1/conversations/current') finish({ conversation: summary('current'), messages: [] });
    else if (request.url === '/v1/conversations/other' && request.method === 'DELETE') {
      conversations = [summary('current')];
      send('context.invalidated', { source_id: 'conversation-other', revision: 2, reason: 'deleted' });
      finish({ ok: true });
    } else if (request.url?.startsWith('/v1/sources?')) finish({ sources: [] });
    else response.writeHead(404).end('{}');
  });
  const ws = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== 'Bearer ' + token) { socket.destroy(); return; }
    ws.handleUpgrade(request, socket, head, connection => {
      peer = connection;
      scope = { ...identity, session_id: randomUUID(), connection_id: randomUUID(), connection_epoch: 0 };
      send('session.ready', { client_kind: 'electron', resume: 'new_session', capabilities: ['text'] });
      connection.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.kind !== 'turn.start') return;
        send('response.delta', { text: 'synthetic answer', actual_model: model }, message, 1);
        send('response.completed', { actual_model: model }, message, 2);
        send('turn.ended', { status: 'completed' }, { ...message, request_id: randomUUID() });
      });
    });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const controller = new SessionController(), brain = new BrainConnection(controller);
  t.after(async () => {
    brain.dispose(); held?.response.end('{}'); peer?.terminate(); ws.close();
    await new Promise(resolve => http.close(resolve));
    controller.dispose();
  });
  assert.deepEqual(await brain.connect({ url: 'http://127.0.0.1:' + http.address().port, token }), { ok: true });
  assert.deepEqual(brain.sendText('start the synthetic turn'), { ok: true });
  for (let attempt = 0; attempt < 100 && !held; attempt += 1) await pause(10);
  assert(held, 'The automatic list refresh after turn.ended must be pending.');
  assert.deepEqual(await brain.deleteConversation('other'), { ok: true });
  assert.deepEqual(brain.librarySnapshot().conversations.map(item => item.id), ['current']);
  const old = held; held = null;
  await new Promise(resolve => old.response.end(old.body, resolve));
  // Let the released HTTP body reach its already waiting fetch continuation.
  await pause(60);
  assert.equal(brain.snapshot().phase, 'ready');
  assert.deepEqual(brain.librarySnapshot().conversations.map(item => item.id), ['current']);
});
