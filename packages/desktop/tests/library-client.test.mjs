import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: `export {LibraryClient, modelKey} from './src/main/library-client.ts'; export {BrainConnection} from './src/main/brain-connection.ts'; export {SessionController} from './src/main/session-controller.ts';`, loader: 'ts',
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'package-entries', setup(api) { api.onResolve({ filter: /^(?:@kirian\/contracts|ws)$/ }, args => ({ path: import.meta.resolve(args.path), external: true })); } }] });
const { LibraryClient, modelKey, BrainConnection, SessionController } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const identity = { instance_id: 'library-test', mode: 'personal', principal_id: 'owner' };
const local = { provider_id: 'ollama', model_id: 'local-model', endpoint_id: 'local' };
const cloud = { provider_id: 'api', model_id: 'cloud-model', endpoint_id: 'cloud' };
const catalog = () => ({ identity: structuredClone(identity), models: [{ model: local, label: 'Local' }, { model: cloud, label: 'API' }],
  default_selection: { model: local, source: 'initial_local' } });
const summary = (id = 'conversation-1', model = null) => ({ id, title: id, updated_at: 100, model });
const detail = (id = 'conversation-1', messages = []) => ({ conversation: summary(id), messages });
const row = (overrides = {}) => ({ id: randomUUID(), turn_id: 'past-turn', role: 'assistant', text: '완료한 대화', status: 'completed', actual_model: local, ...overrides });
const source = (overrides = {}) => ({ record: { source_id: 'source-1', identity: structuredClone(identity), revision: 1, kind: 'note',
  boundary: 'local', deleted: false, parents: [], ...overrides }, title: '개인 노트', text: '원문' });
function client(handler, config = catalog()) {
  const calls = [], notifications = [];
  const library = new LibraryClient(config, async (path, method = 'GET', body) => {
    calls.push({ path, method, body: structuredClone(body) }); return handler(path, method, body);
  }, () => notifications.push(library.snapshot()));
  return { library, calls, notifications };
}

test('reopened histories retain each actual model and known routing reason without inventing old reasons', async () => {
  const h = client(() => detail('conversation-1', [row({turn_id:'old'}), row({turn_id:'auto',actual_model:cloud,routing_reason:'automatic_budget'}), row({turn_id:'fixed',routing_reason:'conversation_fixed'})]));
  const result = await h.library.open('conversation-1');
  assert.equal(result.messages[0].routingReason, undefined);
  assert.equal(result.messages[1].routingReason, 'automatic_budget');
  assert.equal(result.messages[1].actualModel.modelId, cloud.model_id);
  assert.equal(result.messages[2].routingReason, 'conversation_fixed');
  assert.equal(result.messages[2].actualModel.modelId, local.model_id);
  const bad = client(() => detail('conversation-1',[row({routing_reason:'forged'})]));
  await assert.rejects(bad.library.open('conversation-1'));
});

test('file-source refresh preserves the current query and selection while opening another conversation clears it', async () => {
  let note = source();
  note.origin = {collection_id: 'notes-test', collection_label: 'Vault', path: '한글/노트.MD', chunk_index: 0, chunk_count: 1};
  const h = client(path => path.startsWith('v1/sources?') ? {sources: [note]} : detail(path.split('/').at(-1)));
  await h.library.open('current'); await h.library.search('노트'); h.library.select(['source-1']);
  await h.library.refreshSources(); await h.library.open('current', true);
  assert.equal(h.calls.filter(call => call.path.startsWith('v1/sources?')).at(-1).path, 'v1/sources?q=' + encodeURIComponent('노트'));
  assert.deepEqual(h.library.snapshot().selectedSourceIds, ['source-1']);
  assert.deepEqual(h.library.snapshot().sources[0].origin, note.origin);
  note = {...note, record: {...note.record, revision: 2}, text: '바뀐 원문'};
  await h.library.refreshSources();
  assert.deepEqual(h.library.contexts(), [{source_id: 'source-1', revision: 2, text: '바뀐 원문'}]);
  await h.library.open('different', true);
  assert.deepEqual(h.library.snapshot().selectedSourceIds, []);
});

test('malformed imported origins cannot replace a valid source snapshot', async () => {
  const note = source(); let items = [note];
  const h = client(() => ({sources: items})); await h.library.search('');
  const valid = {collection_id: 'notes-test', collection_label: 'Vault', path: 'note.md', chunk_index: 0, chunk_count: 1};
  for (const patch of [{path: '../escape.md'}, {path: 'C:/notes/a.md'}, {path: '/a.md'}, {path: 'a\\b.md'},
    {path: 'note.md\n'}, {path: 'a.txt'}, {collection_label: ' '}, {chunk_index: 1}, {chunk_count: 0}, {extra: true}]) {
    items = [{...note, origin: {...valid, ...patch}}];
    await assert.rejects(h.library.search(''), /invalid_response/);
    assert.equal(h.library.snapshot().sources[0].origin, undefined);
  }
});

test('initialization restores a preferred completed conversation without creating or replaying it', async () => {
  const histories = [summary('first'), summary('preferred')], data = detail('preferred', [row()]);
  const h = client(path => path === 'v1/conversations' ? { conversations: histories } : path.startsWith('v1/sources?') ? { sources: [source()] } : data);
  const restored = await h.library.initialize('preferred');
  assert.equal(restored.conversation.id, 'preferred'); assert.equal(restored.messages[0].status, 'completed');
  assert.deepEqual(restored.actualModel, { providerId: local.provider_id, modelId: local.model_id, endpointId: local.endpoint_id });
  assert(h.calls.every(call => call.method === 'GET'));
  assert.deepEqual(h.calls.map(call => call.path), ['v1/conversations', 'v1/conversations/preferred', 'v1/sources?q=']);
  restored.messages[0].text = 'changed'; data.messages[0].text = 'server object changed';
  assert.equal(h.library.snapshot().conversationId, 'preferred');
});

test('empty history creates one conversation and an unavailable saved default remains explicitly missing', async () => {
  const config = catalog(), removed = { ...cloud, model_id: 'removed-model' }; config.default_selection = { model: removed, source: 'saved_default' };
  let created = false;
  const h = client((path, method) => {
    if (path === 'v1/conversations' && method === 'POST') { created = true; return detail('new-conversation'); }
    if (path === 'v1/conversations') return { conversations: created ? [summary('new-conversation')] : [] };
    return { sources: [] };
  }, config);
  await h.library.initialize(null);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.library.snapshot().defaultModelId, modelKey(removed)); assert.equal(h.library.snapshot().defaultMissing, true);
  assert.throws(() => h.library.updateDefault({ model: local, source: 'request' }));
  assert.equal(h.library.snapshot().defaultModelId, modelKey(removed));
});

test('open rejects wrong conversation IDs and malformed histories without replacing the current view', async () => {
  let response = detail('current', [row()]); const h = client(() => response);
  await h.library.open('current');
  for (const bad of [detail('foreign'), detail('current', [row({ status: 'streaming' })]),
    detail('current', [row({ id: 'row\n' })]), detail('current', [row({ id: 'same' }), row({ id: 'same' })]),
    detail('current', [row({ text: 'a'.repeat(32768) }), row({ text: 'b'.repeat(32768) }), row({ text: 'c' })])]) {
    response = bad; await assert.rejects(h.library.open('current'));
    assert.equal(h.library.snapshot().conversationId, 'current');
  }
  const before = h.calls.length;
  for (const id of ['current\n', '../escape', '.invalid']) await assert.rejects(h.library.open(id), /invalid_request/);
  assert.equal(h.calls.length, before);
});

test('duplicate or oversized conversation lists cannot replace an already validated list', async () => {
  let response = { conversations: [summary('current')] }; const h = client(() => response);
  await h.library.refreshConversations();
  for (const conversations of [[summary('same'), summary('same')], Array.from({ length: 101 }, (_, i) => summary('c' + i))]) {
    response = { conversations }; await assert.rejects(h.library.refreshConversations(), /invalid_response/);
    assert.deepEqual(h.library.snapshot().conversations.map(item => item.id), ['current']);
  }
});

test('saved defaults and conversation models must acknowledge the exact requested selection', async () => {
  let response = detail('current'); const h = client((path) => path === 'v1/conversations' ? { conversations: [summary('current')] } : response);
  await h.library.open('current');
  response = { default_selection: { model: local, source: 'saved_default' } };
  await assert.rejects(h.library.saveDefault(cloud), /invalid_response/);
  assert.equal(h.library.snapshot().defaultModelId, modelKey(local));
  response = { default_selection: { model: cloud, source: 'saved_default' } }; await h.library.saveDefault(cloud);
  assert.equal(h.library.snapshot().defaultModelId, modelKey(cloud)); assert.equal(h.library.snapshot().defaultMissing, false);
  for (const conversation of [summary('foreign', cloud), summary('current', local)]) {
    response = { conversation }; await assert.rejects(h.library.saveConversationModel(cloud), /invalid_response/);
  }
  response = { conversation: summary('current', cloud) }; await h.library.saveConversationModel(cloud);
  response = { conversation: summary('current', null) }; await h.library.saveConversationModel(null);
});

test('source identity, deletion, duplicate and response bounds are checked before selection changes', async () => {
  let response = { sources: [source()] }; const h = client(() => response);
  await h.library.search(''); h.library.select(['source-1']);
  const before = h.library.snapshot();
  for (const sources of [[source({ identity: { ...identity, principal_id: 'other' } })], [source({ deleted: true })],
    [source(), source()], Array.from({ length: 51 }, (_, index) => source({ source_id: 'source-' + index }))]) {
    response = { sources }; await assert.rejects(h.library.search(''), /invalid_response/);
    assert.deepEqual(h.library.snapshot(), before);
  }
  assert.throws(() => h.library.select(['source-1', 'source-1']), /invalid_request/);
  assert.throws(() => h.library.select(['unknown']), /invalid_request/);
});

test('source refresh replaces revisions, removes invalidated selections and returns isolated context copies', async () => {
  let response = { sources: [source()] }; const h = client(() => response);
  await h.library.search(''); h.library.select(['source-1']);
  const contexts = h.library.contexts(); contexts[0].text = 'changed';
  response.sources[0].text = 'mutated original';
  assert.equal(h.library.contexts()[0].text, '원문');
  response = { sources: [{ ...source({ revision: 2 }), text: '수정한 본문' }] }; await h.library.search('');
  assert.deepEqual(h.library.contexts(), [{ source_id: 'source-1', revision: 2, text: '수정한 본문' }]);
  response = { sources: [] }; await h.library.search('');
  assert.deepEqual(h.library.contexts(), []); assert.deepEqual(h.library.snapshot().selectedSourceIds, []);
});

test('source mutations bind revisions and follow with a fresh source listing', async () => {
  const h = client(() => ({ sources: [] }));
  await h.library.createSource({ title: '새 노트', text: '내용', boundary: 'local' });
  await h.library.updateSource({ id: 'source-1', revision: 2, title: '수정', text: '수정 본문', boundary: 'private_lan' });
  await h.library.deleteSource({ id: 'source-1', revision: 3 });
  assert.deepEqual(h.calls.filter(call => call.method !== 'GET'), [
    { path: 'v1/sources', method: 'POST', body: { title: '새 노트', text: '내용', boundary: 'local', kind: 'note', parents: [] } },
    { path: 'v1/sources/source-1', method: 'PUT', body: { title: '수정', text: '수정 본문', boundary: 'private_lan', expected_revision: 2 } },
    { path: 'v1/sources/source-1?revision=3', method: 'DELETE', body: undefined },
  ]);
  assert.equal(h.calls.filter(call => call.path === 'v1/sources?q=').length, 3);
});

test('source character limits count Unicode code points for both restored and newly submitted notes', async () => {
  const title = '🙂'.repeat(120), text = '🙂'.repeat(8192);
  let response = { sources: [{ ...source(), title, text }] };
  const h = client(() => response);
  await h.library.search(''); h.library.select(['source-1']);
  assert.equal(h.library.snapshot().sources[0].text, text);
  assert.equal(h.library.contexts()[0].text, text);
  await h.library.createSource({ title, text, boundary: 'local' });
  assert.equal(h.calls.find(call => call.method === 'POST').body.text, text);
  const before = h.calls.length;
  await assert.rejects(h.library.createSource({ title, text: text + '🙂', boundary: 'local' }), /invalid_request/);
  assert.equal(h.calls.length, before);
  response = { sources: [{ ...source(), title, text: text + '🙂' }] };
  await assert.rejects(h.library.search(''), /invalid_response/);
  assert.equal(h.library.snapshot().sources[0].text, text);
});

function readyController(limits) {
  const controller = new SessionController(limits);
  const scope = { ...identity, session_id: randomUUID(), connection_id: randomUUID(), connection_epoch: 0 };
  const binding = controller.connect(scope);
  assert.equal(binding.ingest({ protocol: 'kirian.rearchitecture.v1', scope, message_id: randomUUID(), request_id: randomUUID(),
    kind: 'session.ready', turn_id: null, intent_id: null, sequence: 0,
    payload: { client_kind: 'electron', resume: 'new_session', capabilities: ['text'] } }).kind, 'accepted');
  return controller;
}

test('Unicode history restores at 32768 total code points and rejects a single extra character without partial replacement', async () => {
  const messages = [row({ id: 'unicode-first', text: '🙂'.repeat(16385) }), row({ id: 'unicode-second', text: '한'.repeat(16383) })];
  let response = detail('current', messages); const h = client(() => response);
  const restored = await h.library.open('current'), controller = readyController();
  controller.restoreConversation(restored.messages, restored.actualModel);
  assert.deepEqual(controller.snapshot().messages.map(item => item.text), messages.map(item => item.text));
  const before = controller.snapshot();
  response = detail('current', [...messages, row({ id: 'over-limit', text: '🙂' })]);
  await assert.rejects(h.library.open('current'), /invalid_response/);
  assert.throws(() => controller.restoreConversation([...restored.messages, {
    id: 'over-limit', turnId: 'extra-turn', role: 'assistant', text: '🙂', status: 'completed',
  }], restored.actualModel), /invalid_history/);
  assert.deepEqual(controller.snapshot(), before);
  controller.dispose();
});

test('restored per-message limits count Unicode code points even when a controller uses a smaller limit', () => {
  const controller = readyController({ maxResponseCharacters: 2 });
  const message = { id: 'unicode-row', turnId: 'unicode-turn', role: 'assistant', text: '🙂🙂', status: 'completed' };
  controller.restoreConversation([message], null);
  assert.equal(controller.snapshot().messages[0].text, message.text);
  assert.throws(() => controller.restoreConversation([{ ...message, text: '🙂🙂🙂' }], null), /invalid_history/);
  assert.equal(controller.snapshot().messages[0].text, message.text);
  controller.dispose();
});

async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await pause(10); }
  assert.fail('Expected asynchronous state was not reached');
}
async function transport(t, configuration = { ...catalog(), persistence: true }, conversationModel = null) {
  const token = 'a'.repeat(48), sockets = [], received = [], headers = [], requests = [];
  const state = { sources: [source()], messages: [row({ id: 'old-history', text: '삭제 대상에서 파생된 대화' })], held: null, holdNext: true };
  const http = createServer((request, response) => {
    headers.push(request.headers.authorization); requests.push(request.url);
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/config') response.end(JSON.stringify(configuration));
    else if (request.url === '/v1/conversations') response.end(JSON.stringify({ conversations: [summary('conversation-1', conversationModel)] }));
    else if (request.url === '/v1/conversations/conversation-1') response.end(JSON.stringify({ ...detail('conversation-1', state.messages), conversation: summary('conversation-1', conversationModel) }));
    else if (request.url === '/v1/sources?q=hold' && state.holdNext) { state.holdNext = false; state.held = response; }
    else if (request.url?.startsWith('/v1/sources?')) response.end(JSON.stringify({ sources: state.sources }));
    else response.writeHead(404).end('{}');
  });
  const ws = new WebSocketServer({ noServer: true });
  let scope;
  http.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== 'Bearer ' + token) { socket.destroy(); return; }
    ws.handleUpgrade(request, socket, head, connection => {
      sockets.push(connection); scope = { ...identity, session_id: randomUUID(), connection_id: randomUUID(), connection_epoch: 0 };
      connection.send(JSON.stringify(wire('session.ready', { client_kind: 'electron', resume: 'new_session', capabilities: ['text'] })));
      connection.on('message', raw => received.push(JSON.parse(raw.toString())));
    });
  });
  function wire(kind, payload, start = null, sequence = 0) {
    return { protocol: 'kirian.rearchitecture.v1', scope, kind, turn_id: start?.turn_id ?? null, intent_id: start?.intent_id ?? null,
      message_id: randomUUID(), request_id: start?.request_id ?? randomUUID(), sequence, payload };
  }
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const controller = new SessionController(), brain = new BrainConnection(controller);
  t.after(async () => { brain.dispose(); state.held?.end('{}'); for (const socket of sockets) socket.terminate(); ws.close(); await new Promise(resolve => http.close(resolve)); });
  const connected = await brain.connect({ url: 'http://127.0.0.1:' + http.address().port, token }); assert.deepEqual(connected, { ok: true });
  return { brain, controller, state, received, requests, headers, send: (kind, payload, start = null, sequence = 0) => sockets[0].send(JSON.stringify(wire(kind, payload, start, sequence))) };
}

test('a missing persisted default blocks text dispatch instead of silently selecting a local model', async t => {
  const config = { ...catalog(), persistence: true, default_selection: { model: { ...cloud, model_id: 'missing' }, source: 'saved_default' } };
  const h = await transport(t, config);
  assert.equal(h.brain.librarySnapshot().defaultMissing, true);
  assert.deepEqual(h.brain.sendText('질문'), { ok: false, code: 'default_unavailable' });
  await pause(20); assert.deepEqual(h.received, []);
  assert(h.headers.every(value => value === 'Bearer ' + 'a'.repeat(48)));
  assert.equal(JSON.stringify(h.brain.snapshot()).includes('a'.repeat(48)), false);
});

test('a missing saved conversation model is retained and blocks fallback to an available default', async t => {
  const missing = { ...cloud, model_id: 'removed-conversation-model' };
  const h = await transport(t, { ...catalog(), persistence: true }, missing);
  assert.equal(h.brain.librarySnapshot().defaultMissing, false);
  assert.equal(h.brain.snapshot().selectedModelId, modelKey(missing));
  assert.deepEqual(h.brain.sendText('선택을 바꾸지 말아 주세요'), { ok: false, code: 'default_unavailable' });
  await pause(20); assert.deepEqual(h.received, []);
});

test('disconnect aborts a pending library request and a late response cannot restore prior connection data', async t => {
  const h = await transport(t);
  const pending = h.brain.refreshLibrary('hold'); await until(() => h.state.held !== null);
  h.brain.disconnect();
  h.state.held.end(JSON.stringify({ sources: [source()] })); h.state.held = null;
  assert.equal((await pending).ok, false);
  assert.equal(h.brain.snapshot().phase, 'disconnected');
  assert.equal(h.brain.authenticatedIdentity(), null);
  assert.equal(h.brain.librarySnapshot().available, false);
  assert.deepEqual(h.brain.librarySnapshot().sources, []);
});

test('reconnect restores fresh sources and history while rejecting an older outstanding REST result', async t => {
  const h = await transport(t);
  const pending = h.brain.refreshLibrary('hold'); await until(() => h.state.held !== null);
  const oldResponse = h.state.held; h.state.held = null;
  h.state.sources = [{ ...source({ source_id: 'new-source', revision: 2 }), text: '새 연결의 본문' }];
  h.state.messages = [row({ id: 'new-history', text: '새 연결의 기록' })];
  assert.deepEqual(await h.brain.reconnect(), { ok: true });
  oldResponse.end(JSON.stringify({ sources: [source()] }));
  assert.equal((await pending).ok, false);
  assert.equal(h.brain.snapshot().phase, 'ready');
  assert.deepEqual(h.brain.librarySnapshot().sources.map(item => item.id), ['new-source']);
  assert.deepEqual(h.controller.snapshot().messages.map(item => item.text), ['새 연결의 기록']);
});

test('source invalidation during an active turn is applied to sources and history after the turn ends', async t => {
  const h = await transport(t); assert.deepEqual(h.brain.selectSources(['source-1']), { ok: true });
  assert.deepEqual(h.brain.sendText('진행 중 질문'), { ok: true });
  await until(() => h.received.some(message => message.kind === 'turn.start'));
  const start = h.received.find(message => message.kind === 'turn.start');
  h.state.sources = []; h.state.messages = [];
  h.send('context.invalidated', { source_id: 'source-1', revision: 2, reason: 'deleted' });
  await pause(30);
  h.send('response.delta', { text: '현재 응답', actual_model: local }, start, 1);
  h.send('response.completed', { actual_model: local }, start, 2);
  h.send('turn.ended', { status: 'completed' }, { ...start, request_id: randomUUID() });
  await until(() => h.controller.snapshot().activeTurnId === null && h.brain.librarySnapshot().sources.length === 0
    && h.controller.snapshot().messages.length === 0);
  assert.equal(h.brain.snapshot().phase, 'ready');
  assert.deepEqual(h.brain.librarySnapshot().selectedSourceIds, []);
});

test('source invalidation received while a library query is busy is not lost when that query completes', async t => {
  const h = await transport(t); h.brain.selectSources(['source-1']);
  const pending = h.brain.refreshLibrary('hold'); await until(() => h.state.held !== null);
  h.state.sources = []; h.state.messages = [];
  h.send('context.invalidated', { source_id: 'source-1', revision: 2, reason: 'deleted' });
  await pause(30);
  h.state.held.end(JSON.stringify({ sources: [source()] })); h.state.held = null;
  assert.deepEqual(await pending, { ok: true });
  await until(() => h.brain.librarySnapshot().sources.length === 0 && h.controller.snapshot().messages.length === 0);
  assert.deepEqual(h.brain.librarySnapshot().selectedSourceIds, []);
  assert.equal(h.requests.filter(path => path === '/v1/sources?q=hold').length, 2);
});
