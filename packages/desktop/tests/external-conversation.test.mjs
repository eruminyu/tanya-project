import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: `export * from './src/main/external/external-conversation.ts';
 export * from './src/main/external/external-manager.ts'; export * from './src/main/brain-connection.ts';
 export * from './src/main/session-controller.ts';`, loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
 bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'external-locations', setup(api) {
 api.onResolve({ filter: /^(?:@kirian\/contracts|ws)$/ }, args => ({ path: import.meta.resolve(args.path), external: true })); } }] });
const { ExternalConversation, ExternalManager, BrainConnection, SessionController } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const token = 'fixture-auth-token-'.repeat(3);
const identity = { instance_id: 'conversation-tools-fixture', mode: 'personal', principal_id: 'owner' };
const model = { provider_id: 'fixture', model_id: 'native-tools-model', endpoint_id: 'local' };
const select = draft => ({ draftId: draft.draftId, revision: draft.revision, payloadSha256: draft.payloadSha256 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(predicate, diagnostic = () => '') {
 for (let index = 0; index < 500; index++) { const result = predicate(); if (result) return result; await new Promise(done => setTimeout(done, 10)); }
 assert.fail('Condition did not become true: ' + diagnostic());
}

async function fixture(t, { persistence = true, enabled = true } = {}) {
 const root = mkdtempSync(join(tmpdir(), 'kirian-external-conversation-'));
 const received = [], sent = [], http = [], registry = [], calls = [], errors = [], sockets = [], scopes = [], cleanups = [], turns = new Map(), hooks = {};
 const sources = [{ source_id: 'source-1', revision: 1, identity: structuredClone(identity), kind: 'note', boundary: 'local', deleted: false, parents: [] }];
 const tools = [{ name: 'write', description: 'Untrusted tool description', inputSchema: { type: 'object' }, readOnlyHint: true }];
 const conversation = { id: 'conversation-1', title: 'Fixture', updated_at: 1, model: null };
 const catalog = { identity, models: [{ model, label: 'Native tool fixture', supports_tools: true, boundary: 'local' }],
  default_selection: { model, source: 'initial_local' }, ...(persistence ? { persistence: true } : {}) };
 const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
 const server = createServer(async (request, response) => {
  try {
   assert.equal(request.headers.authorization, 'Bearer ' + token); const path = new URL(request.url, 'http://127.0.0.1').pathname;
   let raw = ''; for await (const chunk of request) raw += chunk;
   const body = raw ? JSON.parse(raw) : undefined; http.push({ path, method: request.method, body: structuredClone(body) });
   if (path === '/v1/config') return json(response, catalog);
   if (path === '/v1/conversations') return json(response, { conversations: [conversation] });
   if (path === '/v1/conversations/conversation-1') return json(response, { conversation, messages: [] });
   if (path === '/v1/sources') return json(response, { sources: sources.filter(source => !source.deleted).map(record => ({ record, title: 'Fixture source', text: 'Approved source context' })) });
   if (path.startsWith('/v1/external-tools/turns/')) {
    const turn = [...turns.values()].find(value => path.endsWith('/' + value.observation.context_id)); assert(turn);
    const observed = structuredClone(turn.observation); await hooks.observation?.(observed, turn);
    return json(response, observed, hooks.observationStatus ?? 200);
   }
   if (path === '/v1/external-tools/sources') { await hooks.sources?.(body); return json(response, { sources: structuredClone(sources) }); }
   if (path === '/v1/external-tools/results') {
    assert.deepEqual(Object.keys(body).sort(), ['canonicalResultJson', 'provenance', 'rawResultJson', 'receipt']);
    assert.equal(body.receipt.status, 'succeeded'); assert.equal(body.receipt.draft_id, body.provenance.draftId);
    assert.equal(body.receipt.payload_sha256, body.provenance.payloadSha256); assert.equal(body.receipt.execution_id, body.provenance.executionId);
    assert.equal(body.receipt.provider_operation_id, body.provenance.providerOperationId);
    const result = { kind: 'tool_result', sourceRef: { source_id: 'tool-result-' + (registry.length + 1), revision: 1 },
     identity: body.provenance.identity, boundary: body.provenance.boundary, parents: body.provenance.parents,
     text: body.canonicalResultJson, rawResultSha256: body.provenance.rawResultSha256, canonicalResultSha256: body.provenance.canonicalResultSha256 };
    registry.push({ body, result }); await hooks.registry?.(result, body); return json(response, result, hooks.registryStatus ?? 200);
   }
   assert.fail('Unexpected fixture request ' + path);
  } catch (error) { if (!request.destroyed) { errors.push(error); if (!response.headersSent) json(response, { error: 'fixture_error' }, 500); else response.end(); } }
 });
 const ws = new WebSocketServer({ noServer: true });
 const send = (socket, message) => { sent.push(structuredClone(message)); socket.send(JSON.stringify(message)); return message; };
 const message = (start, kind, payload, requestId = randomUUID(), sequence = 0) => ({ ...start, kind, payload, message_id: randomUUID(), request_id: requestId, sequence });
 const finish = (turn, state = 'succeeded') => {
  turn.observation.state = 'summarizing';
  send(turn.socket, message(turn.start, 'response.delta', { text: state === 'succeeded' ? 'Registered tool result summarized.' : 'Tool outcome: ' + state,
   actual_model: model, routing_reason: turn.observation.routing_reason }, turn.start.request_id, 1));
  send(turn.socket, message(turn.start, 'response.completed', { actual_model: model, routing_reason: turn.observation.routing_reason }, turn.start.request_id, 2));
  turn.terminal = send(turn.socket, message(turn.start, 'turn.ended', { status: 'completed' })); turn.observation.active = false;
 };
 const propose = turn => {
  const offer = turn.offers[0]; assert(offer);
  const call = { kind: 'single_mcp_tool_call', request_id: randomUUID(), proposal_id: randomUUID(), offer_id: offer.offer_id,
   arguments_json: '{"text":"exact user reviewed arguments"}', observed_model: structuredClone(model) };
  turn.observation.state = 'awaiting_result'; turn.observation.completed_call = call;
  const proposed = message(turn.start, 'tool.proposed', { provider_kind: 'mcp', proposal_id: call.proposal_id, offer_id: call.offer_id,
   arguments_json: call.arguments_json, actual_model: structuredClone(model), routing_reason: turn.observation.routing_reason, source_refs: structuredClone(turn.observation.source_refs) }, call.request_id);
  hooks.proposal?.(proposed, turn); turn.proposed = send(turn.socket, proposed);
 };
 server.on('upgrade', (request, socket, head) => {
  try { assert.equal(request.headers.authorization, 'Bearer ' + token); } catch (error) { errors.push(error); socket.destroy(); return; }
  ws.handleUpgrade(request, socket, head, socket => {
   sockets.push(socket); const old = new URL(request.url, 'http://127.0.0.1').searchParams.get('session_id');
   const scope = { ...identity, session_id: old ?? randomUUID(), connection_id: randomUUID(), connection_epoch: scopes.length }; scopes.push(scope);
   send(socket, { protocol: 'kirian.rearchitecture.v1', message_id: randomUUID(), request_id: randomUUID(), scope, turn_id: null, intent_id: null,
    kind: 'session.ready', sequence: 0, payload: { client_kind: 'electron', resume: old ? 'turns_cancelled' : 'new_session', capabilities: ['text'] } });
   socket.on('message', raw => {
    try {
     const input = JSON.parse(raw.toString()); received.push(input); socket.send(raw.toString());
     if (input.kind === 'turn.start') {
      const turn = { start: input, socket, observation: { context_id: randomUUID(), scope: input.scope, turn_id: input.turn_id, intent_id: input.intent_id,
       request_id: input.request_id, expected_model: structuredClone(model), model_boundary: 'local',
       routing_reason: { initial_local: 'initial_local', conversation: 'conversation_fixed', request: 'request_fixed', saved_default: 'saved_default' }[input.payload.selection.source],
       source_refs: sources.map(({ source_id, revision }) => ({ source_id, revision })), active: true, state: 'awaiting_offers', explicitly_supported: true, completed_call: null } };
      turns.set(input.turn_id, turn);
      if (input.payload.external_tools) turn.context = send(socket, message(input, 'tool.context', { context_id: turn.observation.context_id })); else finish(turn);
     } else if (input.kind === 'tool.offers') {
      const turn = turns.get(input.turn_id); turn.offers = input.payload.offers;
      if (!hooks.holdProposal) propose(turn);
     } else if (input.kind === 'tool.resolved') {
      const turn = turns.get(input.turn_id); turn.resolved = input;
      if (input.payload.state === 'succeeded') assert.deepEqual(input.payload.source_ref, registry.find(item => item.body.provenance.turnId === input.turn_id).result.sourceRef);
      if (!hooks.holdSummary) finish(turn, input.payload.state);
     } else if (input.kind === 'turn.cancel') { const turn = turns.get(input.turn_id); if (turn) turn.observation.active = false; }
    } catch (error) { errors.push(error); }
   });
  });
 });
 await new Promise(done => server.listen(0, '127.0.0.1', done));
 const url = 'http://127.0.0.1:' + server.address().port;
 const session = new SessionController(), brain = new BrainConnection(session), vaultData = new Map(); let conversationTools;
 const manager = new ExternalManager(root, identity, { get: key => vaultData.get(key), set: (key, value) => vaultData.set(key, structuredClone(value)), delete: key => vaultData.delete(key) },
  { changed: () => conversationTools?.refresh(), mcpFactory: () => ({ connect: async () => {}, close() {}, listTools: async () => structuredClone(tools),
   callTool: async (name, args, signal) => { calls.push({ name, args: structuredClone(args) }); if (hooks.call) return hooks.call(signal);
    return { isError: false, content: [{ type: 'text', text: 'Untrusted external result text' }], requestId: randomUUID() }; } }) });
 await manager.initialize();
 conversationTools = new ExternalConversation({ brain, session, manager: async () => manager, changed() {} }); brain.bindConversationTools(conversationTools);
 t.after(async () => {
  for (const cleanup of cleanups) cleanup(); brain.dispose(); await new Promise(done => setImmediate(done)); manager.dispose();
  for (const socket of sockets) socket.terminate(); ws.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('kirian-external-conversation-')); rmSync(root, { recursive: true, force: true });
  assert.deepEqual(errors.map(error => error.stack), []);
 });
 assert.deepEqual(await brain.connect({ url, token }), { ok: true });
 const connection = await manager.addMcp({ kind: 'stdio', command: process.execPath, args: [] }, 'Fixture MCP');
 const settings = { enabled: true, selections: [{ connectionId: connection.id, toolName: 'write', approvedArgumentBoundary: 'local', metadataBoundary: 'local', resultBoundary: 'local' }] };
 if (persistence) assert.deepEqual(brain.selectSources(['source-1']), { ok: true });
 if (enabled) conversationTools.configure(settings);
 const diagnostic = () => JSON.stringify({ tools: conversationTools.snapshot(), brain: brain.snapshot().phase, session: session.snapshot(), received: received.map(value => value.kind), http: http.map(value => value.path), errors: errors.map(value => value.message) });
 const begin = async () => { const previous = turns.size; assert.deepEqual(brain.sendText('Please suggest the selected external tool.'), { ok: true });
  await waitFor(() => turns.size > previous, diagnostic); return [...turns.values()].at(-1); };
 const pending = async () => { const turn = await begin(); await waitFor(() => conversationTools.snapshot().phase === 'awaiting_approval', diagnostic);
  return { turn, draft: manager.state().actions.find(value => value.draftId === conversationTools.snapshot().draftId) }; };
 return { manager, brain, session, conversationTools, settings, connection, received, sent, http, registry, calls, sources, tools, turns, hooks, sockets, scopes, begin, pending, diagnostic,
  propose, send, message, finish, hold: () => { const value = deferred(); cleanups.push(value.resolve); return value; } };
}

test('tools default OFF and an ordinary conversation sends no offers or proposal authority', async t => {
 const f = await fixture(t, { enabled: false }); assert.equal(f.conversationTools.snapshot().enabled, false);
 const turn = await f.begin(); await waitFor(() => f.session.snapshot().activeTurnId === null, f.diagnostic);
 assert.equal(turn.start.payload.external_tools, undefined); assert.equal(f.http.some(value => value.path.startsWith('/v1/external-tools')), false);
 assert.equal(f.received.some(value => value.kind === 'tool.offers'), false); assert.deepEqual(f.manager.state().actions, []); assert.equal(f.calls.length, 0);
});

test('authenticated live conversation previews, explicitly approves, registers and summarizes exactly once', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending();
 assert.equal(turn.start.payload.external_tools, true); assert.equal(f.calls.length, 0); assert.equal(draft.status, 'pending');
 assert.deepEqual(turn.start.payload.context.map(value => value.source_id), ['source-1']);
 assert.deepEqual(Object.keys(turn.offers[0]).sort(), ['description', 'display_name', 'input_schema_json', 'offer_id']);
 const first = f.manager.approve(select(draft)), second = f.manager.approve(select(draft)); await assert.rejects(second, /already_decided/);
 assert.equal((await first).status, 'succeeded'); await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic);
 assert.deepEqual(f.calls, [{ name: 'write', args: { text: 'exact user reviewed arguments' } }]); assert.equal(f.registry.length, 1);
 assert.equal(f.received.filter(value => value.kind === 'tool.resolved').length, 1); assert.equal(turn.resolved.payload.state, 'succeeded');
 assert.equal(f.session.snapshot().messages.at(-1).text, 'Registered tool result summarized.');
 assert(f.http.filter(value => value.path.startsWith('/v1/external-tools/turns/')).length >= 5);
 assert(f.http.filter(value => value.path === '/v1/external-tools/sources').length >= 3);
 for (let index = 0; index < 3; index++) { f.send(turn.socket, turn.proposed); f.send(turn.socket, turn.terminal); f.conversationTools.refresh(); }
 await new Promise(done => setImmediate(done)); assert.equal(f.registry.length, 1); assert.equal(f.calls.length, 1);
 assert.equal(f.received.filter(value => value.kind === 'tool.resolved').length, 1);
});

test('dismissing a pending proposal returns unavailable and completes without execution or result registration', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending(); f.manager.cancel(draft.draftId);
 await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic);
 assert.equal(turn.resolved.payload.state, 'unavailable'); assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
 await assert.rejects(f.manager.approve(select(draft)), /already_decided/);
});

for (const mutation of ['inactive', 'model', 'authorization']) test(`an invalid authenticated ${mutation} observation cannot create a preview`, async t => {
 const f = await fixture(t);
 f.hooks.observation = value => { if (mutation === 'inactive') value.active = false; else if (mutation === 'model') value.expected_model.model_id = 'foreign'; else f.hooks.observationStatus = 401; };
 await f.begin(); await waitFor(() => f.conversationTools.snapshot().phase === 'unavailable', f.diagnostic);
 assert.equal(f.manager.state().actions.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
 await waitFor(() => f.received.some(value => value.kind === 'turn.cancel'), f.diagnostic);
});

for (const mutation of ['actual_model', 'arguments']) test(`forged wire ${mutation} does not acquire observed proposal authority`, async t => {
 const f = await fixture(t); f.hooks.proposal = value => { if (mutation === 'actual_model') value.payload.actual_model.model_id = 'foreign'; else value.payload.arguments_json = '{"text":"forged"}'; };
 await f.begin(); await waitFor(() => f.conversationTools.snapshot().phase === 'unavailable' || f.brain.snapshot().phase === 'error', f.diagnostic);
 assert.equal(f.manager.state().actions.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
});

for (const persistence of [true, false]) test(`source invalidation retires pending approval and cancels the waiting Brain (persistence=${persistence})`, async t => {
 const f = await fixture(t, { persistence }), { turn, draft } = await f.pending();
 f.send(turn.socket, { ...f.message(turn.start, 'context.invalidated', { source_id: 'unrelated-source', revision: 2, reason: 'updated' }), turn_id: null, intent_id: null });
 await waitFor(() => f.received.some(value => value.kind === 'turn.cancel' && value.turn_id === turn.start.turn_id), f.diagnostic);
 await waitFor(() => f.manager.state().actions[0].status === 'dismissed', f.diagnostic); await assert.rejects(f.manager.approve(select(draft)));
 assert.equal(f.session.snapshot().activeTurnId, null); assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
});

test('changed offered metadata immediately withdraws the pending approval', async t => {
 const f = await fixture(t), { draft } = await f.pending(); f.tools[0].description = 'changed metadata'; await f.manager.discover(f.connection.id);
 await waitFor(() => f.manager.state().actions[0].status === 'dismissed', f.diagnostic); await assert.rejects(f.manager.approve(select(draft)));
 assert.notEqual(f.conversationTools.snapshot().phase, 'awaiting_approval'); assert.equal(f.calls.length, 0);
});

test('settings changes cancel pending work and late old events cannot replace a fresh proposal', async t => {
 const f = await fixture(t), first = await f.pending(); f.conversationTools.configure({ enabled: false, selections: [] });
 await waitFor(() => f.session.snapshot().activeTurnId === null, f.diagnostic); f.conversationTools.configure(f.settings);
 const second = await f.pending(); f.send(first.turn.socket, first.turn.context); f.send(first.turn.socket, first.turn.proposed);
 await new Promise(done => setImmediate(done)); assert.equal(f.conversationTools.snapshot().draftId, second.draft.draftId);
 assert.equal(f.manager.state().actions.find(value => value.draftId === first.draft.draftId).status, 'dismissed');
 assert.equal((await f.manager.approve(select(second.draft))).status, 'succeeded');
 await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic); assert.equal(f.calls.length, 1); assert.equal(f.registry.length, 1);
});

test('connection reset returns settings to OFF and cannot reuse pending origin authority', async t => {
 const f = await fixture(t), { draft } = await f.pending(); f.brain.disconnect();
 await waitFor(() => f.manager.state().actions[0].status === 'dismissed', f.diagnostic);
 assert.equal(f.conversationTools.snapshot().enabled, false); assert.deepEqual(f.conversationTools.snapshot().selections, []);
 await assert.rejects(f.manager.approve(select(draft))); assert.equal(f.calls.length, 0);
});

test('unknown external execution is reported once and never registered or retried', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending(); f.hooks.call = async () => { throw Error('fixture response lost after dispatch'); };
 assert.equal((await f.manager.approve(select(draft))).status, 'unknown'); await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic);
 assert.equal(turn.resolved.payload.state, 'unknown'); assert.equal(f.calls.length, 1); assert.equal(f.registry.length, 0);
 f.conversationTools.refresh(); f.conversationTools.refresh(); await assert.rejects(f.manager.approve(select(draft)), /already_decided/); assert.equal(f.calls.length, 1);
});

test('late result registration after cancellation cannot attach to a new turn or resend a resolution', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending(), entered = f.hold(), release = f.hold();
 f.hooks.registry = async () => { entered.resolve(); await release.promise; };
 assert.equal((await f.manager.approve(select(draft))).status, 'succeeded'); await entered.promise;
 f.brain.cancelTurn(); release.resolve(); await waitFor(() => f.session.snapshot().activeTurnId === null, f.diagnostic);
 await new Promise(done => setImmediate(done)); assert.equal(f.received.some(value => value.kind === 'tool.resolved' && value.turn_id === turn.start.turn_id), false);
 assert.equal(f.calls.length, 1); assert.equal(f.manager.state().actions[0].status, 'succeeded');
});

test('a newer completed execution is drained after an older cancelled result registration finishes', async t => {
 const f = await fixture(t), first = await f.pending(), entered = f.hold(), release = f.hold();
 f.hooks.registry = async (_result, body) => { if (body.provenance.turnId === first.turn.start.turn_id) { entered.resolve(); await release.promise; } };
 assert.equal((await f.manager.approve(select(first.draft))).status, 'succeeded'); await entered.promise;
 f.brain.cancelTurn(); await waitFor(() => f.session.snapshot().activeTurnId === null, f.diagnostic);
 const second = await f.pending(); assert.equal((await f.manager.approve(select(second.draft))).status, 'succeeded');
 assert.equal(f.registry.length, 1); assert.equal(second.turn.resolved, undefined);
 release.resolve(); await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic);
 assert.equal(f.registry.length, 2); assert.equal(f.calls.length, 2);
 assert.deepEqual(f.received.filter(value => value.kind === 'tool.resolved').map(value => value.turn_id), [second.turn.start.turn_id]);
 assert.equal(second.turn.resolved.payload.state, 'succeeded');
});

test('effective source deletion returned by HTTP prevents approval even without a prior invalidation event', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending(); f.sources[0].deleted = true;
 await assert.rejects(f.manager.approve(select(draft))); await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic);
 assert.equal(f.manager.state().actions[0].status, 'dismissed'); assert.equal(turn.resolved.payload.state, 'unavailable');
 assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
});

test('settings revoked during final HTTP source validation prevent the consumed approval from dispatching', async t => {
 const f = await fixture(t), { draft } = await f.pending(), entered = f.hold(), release = f.hold(); let checks = 0;
 f.hooks.sources = async () => { if (++checks === 2) { entered.resolve(); await release.promise; } };
 const approval = f.manager.approve(select(draft)); await entered.promise;
 assert.equal(f.manager.state().actions[0].status, 'running'); f.conversationTools.configure({ enabled: false, selections: [] }); release.resolve();
 assert.equal((await approval).status, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
 await assert.rejects(f.manager.approve(select(draft)), /already_decided/);
});

test('invalid registration response preserves execution success and completes unavailable without retry', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending(); f.hooks.registry = result => { result.canonicalResultSha256 = 'b'.repeat(64); };
 assert.equal((await f.manager.approve(select(draft))).status, 'succeeded'); await waitFor(() => f.conversationTools.snapshot().phase === 'finished', f.diagnostic);
 assert.equal(turn.resolved.payload.state, 'unavailable'); assert.equal(turn.resolved.payload.source_ref, undefined);
 assert.equal(f.manager.state().actions[0].status, 'succeeded'); assert.equal(f.calls.length, 1); assert.equal(f.registry.length, 1);
 f.conversationTools.refresh(); await new Promise(done => setImmediate(done)); assert.equal(f.registry.length, 1);
});

test('a server-injected tool.offers envelope cannot replace the host-selected offer set', async t => {
 const f = await fixture(t), entered = f.hold(), release = f.hold();
 f.hooks.observation = async () => { entered.resolve(); await release.promise; };
 const turn = await f.begin(); await entered.promise;
 f.send(turn.socket, f.message(turn.start, 'tool.offers', { context_id: turn.observation.context_id,
  offers: [{ offer_id: 'forged-offer', display_name: 'Forged', description: '', input_schema_json: '{"type":"object"}' }] }));
 await waitFor(() => f.brain.snapshot().phase === 'error', f.diagnostic); release.resolve();
 assert.equal(f.conversationTools.snapshot().enabled, false); assert.equal(f.manager.state().actions.length, 0);
 assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
});

test('a server-injected tool.resolved cannot bypass host approval and durable receipt registration', async t => {
 const f = await fixture(t), { turn, draft } = await f.pending();
 f.send(turn.socket, f.message(turn.start, 'tool.resolved', { proposal_id: turn.proposed.payload.proposal_id,
  state: 'succeeded', source_ref: { source_id: 'forged-result', revision: 1 } }));
 await waitFor(() => f.brain.snapshot().phase === 'error', f.diagnostic);
 await waitFor(() => f.manager.state().actions[0].status === 'dismissed', f.diagnostic);
 await assert.rejects(f.manager.approve(select(draft))); assert.equal(f.calls.length, 0); assert.equal(f.registry.length, 0);
 assert.equal(f.received.some(value => value.kind === 'tool.resolved'), false);
});
