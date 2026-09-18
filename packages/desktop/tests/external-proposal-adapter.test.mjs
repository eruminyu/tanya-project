import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: `export * from './src/main/external/external-proposal-adapter.ts';
 export * from './src/main/external/external-proposal-gateway.ts'; export * from './src/main/external/external-manager.ts';`,
 resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, write: false,
 platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'contracts', setup(api) {
 api.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true })); } }] });
const { ExternalProposalAdapter, ExternalProposalGateway, ExternalManager } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const identity = { instance_id: 'adapter-fixture', mode: 'personal', principal_id: 'owner' };
const model = { provider_id: 'fixture', model_id: 'fixture-model', endpoint_id: 'fixture-endpoint' };
const select = d => ({ draftId: d.draftId, revision: d.revision, payloadSha256: d.payloadSha256 });
const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'kirian-proposal-adapter-')), secrets = new Map(), calls = [], hooks = {};
 const state = { now: 1_000_000, selections: [], tools: [{ name: 'write', description: 'untrusted metadata', inputSchema: { type: 'object' }, readOnlyHint: true }],
  records: [{ source_id: 'source-1', revision: 1, identity: structuredClone(identity), kind: 'note', boundary: 'local', deleted: false, parents: [] }],
  turn: { scope: { ...identity, session_id: 'session-1', connection_id: 'brain-connection', connection_epoch: 1 }, turnId: 'turn-1', intentId: 'intent-1',
   epoch: 1, sourceEpoch: 1, active: true, toolsEnabled: true, brainDestination: 'loopback', expectedModel: structuredClone(model),
   modelAuthorized: true, modelBoundary: 'local', routingReason: 'request_fixed', sourceRefs: [{ source_id: 'source-1', revision: 1 }], completedCall: null } };
 const vault = { get: key => secrets.get(key), set: (key, value) => secrets.set(key, structuredClone(value)), delete: key => secrets.delete(key) };
 const factory = () => ({ connect: async () => {}, close() {}, listTools: async () => { await hooks.list?.(); return structuredClone(state.tools); },
  callTool: async (name, args, signal) => { calls.push({ name, args: structuredClone(args) });
   if (hooks.call) return hooks.call(signal); return { isError: false, content: [{ type: 'text', text: 'untrusted tool result' }], requestId: 'tool-rpc-1' }; } });
 const manager = new ExternalManager(root, identity, vault, { mcpFactory: factory, now: () => state.now }); await manager.initialize();
 const connection = await manager.addMcp({ kind: 'stdio', command: process.execPath, args: [] }, 'Fixture account');
 const policy = { connectionId: connection.id, toolName: 'write', approvedArgumentBoundary: 'local', metadataBoundary: 'local', resultBoundary: 'local' };
 state.selections = [policy];
 const deps = { currentTurn: () => state.turn, selections: () => state.selections, now: () => state.now,
  resolveSources: async (_refs, guard) => { await hooks.resolve?.(); guard(); return structuredClone(state.records); } };
 const adapter = new ExternalProposalAdapter(manager, deps); let offerId = 0;
 const gateway = new ExternalProposalGateway({ executorId: adapter.executorId, clock: () => ({ wallMs: state.now, monotonicMs: state.now }), newId: () => 'offer-' + ++offerId,
  currentTurn: deps.currentTurn, toolCandidates: () => adapter.toolCandidates(), isCandidateCurrent: c => adapter.isCandidateCurrent(c), resolveSources: deps.resolveSources,
  previewTool: (input, origin, guard) => adapter.previewTool(input, origin, guard), cancelDraft: id => adapter.cancelDraft(id), lookupReceipt: id => adapter.lookupReceipt(id) });
 t.after(() => { manager.dispose(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('kirian-proposal-adapter-')); rmSync(root, { recursive: true, force: true }); });
 const proposal = async () => {
  const offers = await gateway.offers(), turn = state.turn, arguments_json = '{"text":"exact approved payload"}';
  const value = { provider_kind: 'mcp', scope: structuredClone(turn.scope), turn_id: turn.turnId, intent_id: turn.intentId, request_id: 'request-1',
   proposal_id: 'proposal-1', offer_id: offers[0].offer_id, arguments_json, actual_model: structuredClone(model), routing_reason: turn.routingReason, source_refs: structuredClone(turn.sourceRefs) };
  turn.completedCall = { kind: 'single_mcp_tool_call', explicitlySupported: true, requestId: value.request_id, proposalId: value.proposal_id, offerId: value.offer_id,
   canonicalArgumentsSha256: hash(arguments_json), observedModel: structuredClone(model) };
  return value;
 };
 const preview = async () => gateway.preview(await proposal());
 return { root, state, calls, hooks, manager, adapter, gateway, preview, proposal, vault, factory, policy, connection };
}

test('only user-selected connected MCP tools become offers; selections and policy remain host data', async t => {
 const f = await fixture(t); f.state.selections = []; assert.deepEqual(f.adapter.toolCandidates(), []);
 f.state.selections = [f.policy]; const candidate = f.adapter.toolCandidates()[0]; assert(f.adapter.isCandidateCurrent(candidate));
 assert.equal(candidate.accountLabel, 'Fixture account'); assert.equal(candidate.toolName, 'write'); assert.equal(f.calls.length, 0);
 f.state.selections = [{ ...f.policy, metadataBoundary: 'private_lan' }]; assert.equal(f.adapter.isCandidateCurrent(candidate), false);
 f.state.selections = [f.policy]; f.manager.disconnect(f.connection.id); assert.deepEqual(f.adapter.toolCandidates(), []);
});

test('gateway → adapter → explicit exact approval → durable receipt executes once', async t => {
 const f = await fixture(t), proposal = await f.proposal(); f.state.now += 1234;
 const draft = await f.gateway.preview(proposal); assert.equal(draft.expiresAt, 1_600_000); assert.equal(draft.status, 'pending');
 assert.equal(f.calls.length, 0); assert.equal(draft.effect, 'untrusted');
 await assert.rejects(f.manager.approve({ ...select(draft), payloadSha256: 'b'.repeat(64) }), /stale_draft/);
 const results = await Promise.allSettled([f.manager.approve(select(draft)), f.manager.approve(select(draft))]);
 assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
 assert.deepEqual(f.calls, [{ name: 'write', args: { text: 'exact approved payload' } }]);
 const state = await f.adapter.lookupReceipt(draft.draftId); assert.equal(state.receipt.status, 'succeeded');
 assert.equal(state.receipt.payload_sha256, draft.payloadSha256); assert.match(state.resultJson, /untrusted tool result/);
 const collected = await f.gateway.receipt(proposal.proposal_id); assert.equal(collected.state, 'succeeded'); assert.equal(collected.attached, true);
 assert.equal(f.calls.length, 1); const saved = readFileSync(join(f.root, 'ledger', 'executions.json'), 'utf8');
 assert.equal(saved.includes('proposal-1'), false); assert.equal(saved.includes('source-1'), false);
});

const turnChanges = {
 'expired origin': f => { f.state.now = 1_600_000; },
 'inactive turn': f => { f.state.turn.active = false; },
 'tools switched off': f => { f.state.turn.toolsEnabled = false; },
 'model authorization revoked': f => { f.state.turn.modelAuthorized = false; },
 'remote Brain': f => { f.state.turn.brainDestination = 'remote'; },
 'new turn': f => { f.state.turn.turnId = 'turn-2'; },
 'new source epoch': f => { f.state.turn.sourceEpoch++; },
 'different model': f => { f.state.turn.expectedModel.model_id = 'another-model'; },
 'missing call evidence': f => { f.state.turn.completedCall = null; },
 'different call arguments': f => { f.state.turn.completedCall.canonicalArgumentsSha256 = 'b'.repeat(64); },
 'removed selection': f => { f.state.selections = []; },
 'changed boundary consent': f => { f.state.selections = [{ ...f.policy, approvedArgumentBoundary: 'cloud' }]; },
};
for (const [name, change] of Object.entries(turnChanges)) test(`${name} retires an existing preview before approval claim`, async t => {
 const f = await fixture(t), draft = await f.preview(); change(f); await assert.rejects(f.manager.approve(select(draft)));
 assert.equal(f.calls.length, 0); assert.equal(f.manager.state().actions[0].status, 'dismissed');
 assert.equal(f.manager.lookupReceipt(draft.draftId).receipt, null);
});

const sourceChanges = {
 deleted: records => { records[0].deleted = true; },
 revision: records => { records[0].revision++; },
 identity: records => { records[0].identity.principal_id = 'foreign'; },
 permission: records => { records[0].boundary = 'cloud'; },
 missing: records => { records.length = 0; },
 lineage: records => { records[0].parents = [{ source_id: 'missing-parent', revision: 1 }]; },
 cycle: records => { records[0].parents = [{ source_id: 'source-1', revision: 1 }]; },
};
for (const [name, change] of Object.entries(sourceChanges)) test(`effective source ${name} is rechecked before approval`, async t => {
 const f = await fixture(t), draft = await f.preview(); change(f.state.records); await assert.rejects(f.manager.approve(select(draft)));
 assert.equal(f.calls.length, 0); assert.equal(f.manager.state().actions[0].status, 'dismissed');
});

test('source verification racing cancellation cannot create a late claim', async t => {
 const f = await fixture(t), draft = await f.preview(), entered = deferred(), release = deferred();
 f.hooks.resolve = async () => { entered.resolve(); await release.promise; };
 const approval = f.manager.approve(select(draft)), rejected = assert.rejects(approval); await entered.promise;
 f.manager.cancel(draft.draftId); release.resolve(); await rejected; assert.equal(f.calls.length, 0);
 assert.equal(f.manager.lookupReceipt(draft.draftId).receipt, null);
});

test('sources revoked during dispatch validation fail the consumed approval without tools/call', async t => {
 const f = await fixture(t), draft = await f.preview(), entered = deferred(), release = deferred(); let checks = 0;
 f.hooks.resolve = async () => { if (++checks === 2) { entered.resolve(); await release.promise; } };
 const approval = f.manager.approve(select(draft)); await entered.promise;
 assert.equal(f.manager.state().actions[0].status, 'running'); f.state.records[0].deleted = true; release.resolve();
 const result = await approval; assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'external_proposal_revoked');
 assert.equal(f.calls.length, 0); await assert.rejects(f.manager.approve(select(draft)), /already_decided/);
});

test('origin expiry while tools/list is pending is checked immediately before dispatch', async t => {
 const f = await fixture(t), draft = await f.preview(), entered = deferred(), release = deferred();
 f.hooks.list = async () => { entered.resolve(); await release.promise; };
 const approval = f.manager.approve(select(draft)); await entered.promise; f.state.now = draft.expiresAt; release.resolve();
 const result = await approval; assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 0);
 await assert.rejects(f.manager.approve(select(draft)), /already_decided/);
});

test('changing another offered tool metadata prevents the selected tools/call', async t => {
 const f = await fixture(t); f.state.tools.push({ name: 'other', description: 'original', inputSchema: { type: 'object' } });
 await f.manager.discover(f.connection.id); f.state.selections.push({ ...f.policy, toolName: 'other' });
 const draft = await f.preview(); f.state.tools[1].description = 'changed after model saw it';
 const result = await f.manager.approve(select(draft)); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 0);
});

test('a dispatched response loss remains unknown and receipt reads never retry execution', async t => {
 const f = await fixture(t), draft = await f.preview(); f.hooks.call = async () => { throw new Error('fixture lost response'); };
 const result = await f.manager.approve(select(draft)); assert.equal(result.status, 'unknown'); assert.equal(result.recoverable, false);
 assert.equal((await f.adapter.lookupReceipt(draft.draftId)).receipt.status, 'unknown');
 assert.equal((await f.adapter.lookupReceipt(draft.draftId)).receipt.status, 'unknown');
 await assert.rejects(f.manager.approve(select(draft)), /already_decided/); assert.equal(f.calls.length, 1);
});

test('restarting removes all live origin authority and dismisses unclaimed proposal drafts', async t => {
 const f = await fixture(t), draft = await f.preview();
 const restored = new ExternalManager(f.root, identity, f.vault, { mcpFactory: f.factory, now: () => f.state.now }); await restored.initialize();
 assert.equal(restored.state().actions[0].status, 'dismissed'); assert.equal(restored.state().connections[0].phase, 'disconnected');
 await assert.rejects(restored.approve(select(draft))); assert.equal(f.calls.length, 0);
 // The original manager is intentionally stale after the simulated second process wrote the ledger.
 restored.dispose();
});
