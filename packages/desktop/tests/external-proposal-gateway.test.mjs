import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { digestAction } from '@kirian/contracts';

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/main/external/external-proposal-gateway.ts'; export * from './src/main/external/external-executor.ts';`, loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'contracts', setup(api) { api.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true })); } }],
});
const { ExternalProposalGateway, ExternalExecutor, canonicalJson, proposalLimits } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const clone = structuredClone;
const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const identity = { instance_id: 'gateway-fixture', mode: 'personal', principal_id: 'owner' };
const model = { provider_id: 'fixture', model_id: 'model-1', endpoint_id: 'endpoint-1' };
const source = (id, overrides = {}) => ({ source_id: id, revision: 1, identity: clone(identity), kind: 'note', boundary: 'local', deleted: false, parents: [], ...overrides });
const candidate = (id = 'connection-1', overrides = {}) => ({ kind: 'mcp', connectionId: id, generation: 'generation-1', accountId: 'account-' + id,
  toolName: 'write', fingerprint: 'a'.repeat(64), target: 'stdio:fixture-' + id, accountLabel: 'fixture account',
  approvedArgumentBoundary: 'local', metadataBoundary: 'local', resultBoundary: 'local', displayName: 'Fixture tool', description: 'untrusted tool description', inputSchemaJson: '{"type":"object"}', ...overrides });

function fixture() {
  const state = {
    clock: { wallMs: 1_000_000, monotonicMs: 0 }, candidates: [candidate()], records: [],
    turn: { scope: { ...identity, session_id: 'session-1', connection_id: 'brain-connection-1', connection_epoch: 1 },
      turnId: 'turn-1', intentId: 'intent-1', epoch: 1, sourceEpoch: 1, active: true, toolsEnabled: true, brainDestination: 'loopback',
      expectedModel: clone(model), modelAuthorized: true, modelBoundary: 'local', routingReason: 'request_fixed', sourceRefs: [], completedCall: null },
    receipt: { receipt: null, resultJson: null },
  };
  const calls = { preview: 0, cancel: [], lookup: 0, register: [] }, hooks = {};
  let counter = 0, lastAction;
  const deps = {
    executorId: 'kirian-external-v1', clock: () => state.clock, newId: () => 'offer-' + ++counter,
    currentTurn: () => state.turn, toolCandidates: () => state.candidates,
    isCandidateCurrent: item => state.candidates.some(c => canonicalJson(c) === canonicalJson(item)),
    resolveSources: async (refs, guard) => { await hooks.resolve?.(refs, guard); guard(); return state.records; },
    previewTool: async (input, origin, guard) => {
      calls.preview++; guard();
      const c = state.candidates.find(c => c.connectionId === input.connectionId && c.toolName === input.toolName);
      const plan = { providerId: 'mcp', connectionId: c.connectionId, generation: c.generation, fingerprint: c.fingerprint,
        accountId: c.accountId, label: c.accountLabel, target: c.target, operation: 'tool-call', effect: 'untrusted',
        payload: { name: c.toolName, arguments: JSON.parse(input.argumentsJson), inputSchema: JSON.parse(c.inputSchemaJson), description: c.description, readOnlyHint: false } };
      const argumentsJson = canonicalJson(plan);
      const payloadSha256 = await digestAction({ tool_id: 'mcp', operation: 'tool-call', account_id: c.accountId, target: c.target, arguments_json: argumentsJson });
      const action = { draftId: 'draft-' + calls.preview, revision: 1, payloadSha256, providerId: 'mcp', connectionId: c.connectionId,
        accountLabel: c.accountLabel, target: c.target, operation: 'tool-call', effect: 'untrusted', argumentsJson, expiresAt: origin.expiresAtMs,
        status: 'pending', executionId: null, errorCode: null, operationId: null, resultJson: null, recoverable: false };
      lastAction = clone(action);
      return hooks.preview ? hooks.preview(action, input, origin, guard) : action;
    },
    cancelDraft: async id => { calls.cancel.push(id); await hooks.cancel?.(id); },
    lookupReceipt: async id => { calls.lookup++; await hooks.lookup?.(id); return state.receipt; },
    registerResult: async (input, guard) => {
      calls.register.push(clone(input));
      const p = input.provenance;
      const result = { kind: 'tool_result', sourceRef: { source_id: 'result-source', revision: 1 }, identity: clone(p.identity), boundary: p.boundary,
        parents: clone(p.parents), text: input.canonicalResultJson, rawResultSha256: p.rawResultSha256, canonicalResultSha256: p.canonicalResultSha256 };
      return hooks.register ? hooks.register(result, input, guard) : result;
    },
  };
  const gateway = new ExternalProposalGateway(deps);
  function setSources(records) { state.records = records; state.turn.sourceRefs = records.map(({ source_id, revision }) => ({ source_id, revision })); }
  async function proposal(index = 0, args = { text: '검토한 내용' }) {
    const offers = await gateway.offers(), turn = state.turn, argumentsJson = canonicalJson(args);
    const input = { provider_kind: 'mcp', scope: clone(turn.scope), turn_id: turn.turnId, intent_id: turn.intentId, request_id: 'request-' + turn.turnId,
      proposal_id: 'proposal-' + turn.turnId, offer_id: offers[index].offer_id, arguments_json: argumentsJson, actual_model: clone(turn.expectedModel),
      ...(turn.routingReason === undefined ? {} : { routing_reason: turn.routingReason }), source_refs: clone(turn.sourceRefs) };
    turn.completedCall = { kind: 'single_mcp_tool_call', explicitlySupported: true, requestId: input.request_id, proposalId: input.proposal_id,
      offerId: input.offer_id, canonicalArgumentsSha256: hash(argumentsJson), observedModel: clone(turn.expectedModel) };
    return input;
  }
  function receipt(status = 'succeeded', resultJson = '{"ok":true}', overrides = {}) {
    const a = lastAction;
    state.receipt = { receipt: { execution_id: 'execution-1', draft_id: a.draftId, draft_revision: a.revision, identity: clone(identity),
      executor_id: deps.executorId, payload_sha256: a.payloadSha256, provider_id: 'mcp', recorded_at_ms: state.clock.wallMs,
      status, provider_operation_id: status === 'succeeded' ? 'operation-1' : null, error_code: status === 'succeeded' ? null : 'external_result_unknown', ...overrides }, resultJson };
  }
  function nextTurn(id = 'turn-2') { state.turn = { ...clone(state.turn), turnId: id, intentId: 'intent-' + id, completedCall: null }; }
  return { gateway, state, calls, hooks, deps, proposal, receipt, setSources, nextTurn };
}

test('offers expose bounded metadata only, and the gateway has no approval or execution API', async () => {
  const f = fixture(), offers = await f.gateway.offers();
  assert.deepEqual(Object.keys(offers[0]).sort(), ['description', 'display_name', 'input_schema_json', 'offer_id']);
  assert.equal(Object.isFrozen(offers[0]), true); assert.equal(f.gateway.approve, undefined); assert.equal(f.gateway.execute, undefined);
  assert.deepEqual(await f.gateway.offers(), offers); assert.equal(f.calls.preview, 0);
});

test('a completed host-observed proposal creates exactly one immutable approval preview', async () => {
  const f = fixture(), p = await f.proposal(), entered = deferred(), release = deferred();
  f.hooks.preview = async action => { entered.resolve(); await release.promise; return action; };
  const first = f.gateway.preview(p); await entered.promise; const second = f.gateway.preview(clone(p));
  release.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(Object.isFrozen(a), true); assert.equal(f.calls.preview, 1);
  assert.deepEqual(await f.gateway.preview(p), a);
  await assert.rejects(f.gateway.preview({ ...p, arguments_json: '{"text":"changed"}' }), /external_proposal_conflict/);
  await assert.rejects(f.gateway.preview({ ...p, proposal_id: 'second-proposal' }), /external_proposal_limit/);
  assert.equal(f.calls.preview, 1);
});

test('concurrent offers during old-draft cancellation share the same new lease', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p);
  const entered = deferred(), release = deferred(); f.hooks.cancel = async () => { entered.resolve(); await release.promise; };
  f.nextTurn(); const first = f.gateway.offers(); await entered.promise; const second = f.gateway.offers(); release.resolve();
  assert.deepEqual(await first, await second); assert.deepEqual(f.calls.cancel, ['draft-1']);
  const fresh = await f.proposal(); await f.gateway.preview(fresh); assert.equal(f.calls.preview, 2);
});

for (const change of [f => { f.state.clock.monotonicMs += proposalLimits.ttlMs; }, f => { f.state.clock.wallMs += proposalLimits.ttlMs; }]) {
  test('an expired offer cannot be renewed or used for a preview', async () => {
    const f = fixture(), p = await f.proposal(); change(f);
    await assert.rejects(f.gateway.preview(p), /external_proposal_expired/); await assert.rejects(f.gateway.offers(), /external_proposal_expired/);
    assert.equal(f.calls.preview, 0);
  });
}

test('retired turns and exhausted offer-only records cannot be reissued', async () => {
  const f = fixture(); const original = clone(f.state.turn); await f.gateway.offers();
  for (let index = 1; index < proposalLimits.records; index++) { f.nextTurn('turn-' + index + '-new'); await f.gateway.offers(); }
  f.nextTurn('overflow'); await assert.rejects(f.gateway.offers(), /external_proposal_limit/);
  f.state.turn = original; await assert.rejects(f.gateway.offers(), /external_retired_turn/);
});

for (const [name, mutate] of [
  ['Google automatic read', f => { f.state.candidates[0].kind = 'google'; }],
  ['remote Brain', f => { f.state.turn.brainDestination = 'remote'; }],
  ['disabled tools', f => { f.state.turn.toolsEnabled = false; }],
  ['unapproved model', f => { f.state.turn.modelAuthorized = false; }],
  ['private metadata sent to cloud model', f => { f.state.turn.modelBoundary = 'cloud'; }],
  ['too many offers', f => { f.state.candidates = Array.from({ length: 17 }, (_, i) => candidate('connection-' + i)); }],
  ['oversized schema', f => { f.state.candidates[0].inputSchemaJson = JSON.stringify({ description: 'x'.repeat(8192) }); }],
]) {
  test(name + ' is rejected before any preview', async () => {
    const f = fixture(); mutate(f); await assert.rejects(f.gateway.offers(), /external_/); assert.equal(f.calls.preview, 0);
  });
}

for (const [name, mutate] of [
  ['foreign scope', (f, p) => { p.scope.principal_id = 'other'; }],
  ['reconnected Brain', f => { f.state.turn.scope.connection_epoch++; }],
  ['observed model mismatch', f => { f.state.turn.completedCall.observedModel.model_id = 'other'; }],
  ['claimed model mismatch', (f, p) => { p.actual_model.model_id = 'other'; }],
  ['claimed routing mismatch', (f, p) => { p.routing_reason = 'automatic_budget'; }],
  ['unsupported provider tools', f => { f.state.turn.completedCall.explicitlySupported = false; }],
  ['unfinished provider evidence', f => { f.state.turn.completedCall = null; }],
  ['different completed arguments', f => { f.state.turn.completedCall.canonicalArgumentsSha256 = 'b'.repeat(64); }],
  ['unknown argument boundary even without sources', f => { f.state.candidates[0].approvedArgumentBoundary = null; }],
]) {
  test(name + ' cannot create a draft', async () => {
    const f = fixture(); if (name.startsWith('unknown argument')) f.state.candidates[0].approvedArgumentBoundary = null;
    const p = await f.proposal(); mutate(f, p); await assert.rejects(f.gateway.preview(p), /external_/); assert.equal(f.calls.preview, 0);
  });
}

test('raw JSON text, provider fragments, noncanonical or oversized arguments never become tool calls', async () => {
  for (const args of ['[]', '{"b":1,"a":2}', '{"secret":', JSON.stringify({ text: 'x'.repeat(16384) })]) {
    const f = fixture(), p = await f.proposal(); p.arguments_json = args;
    await assert.rejects(f.gateway.preview(p), /external_/); assert.equal(f.calls.preview, 0);
  }
  const f = fixture(), p = await f.proposal();
  await assert.rejects(f.gateway.preview(JSON.stringify(p)), /external_/);
  await assert.rejects(f.gateway.preview({ ...p, fragment: true }), /external_/); assert.equal(f.calls.preview, 0);
});

for (const [name, alter] of [
  ['omitted actual source', (f, p) => { p.source_refs = []; }],
  ['foreign source', f => { f.state.records[0].identity.principal_id = 'foreign'; }],
  ['stale source', f => { f.state.records[0].revision++; }],
  ['deleted source', f => { f.state.records[0].deleted = true; }],
  ['missing ancestor', f => { f.state.records[0].parents = [{ source_id: 'missing', revision: 1 }]; }],
  ['cyclic ancestry', f => { f.state.records[0].parents = [{ source_id: 'note-1', revision: 1 }]; }],
]) {
  test(name + ' is rejected by the authenticated source check', async () => {
    const f = fixture(); f.setSources([source('note-1')]); const p = await f.proposal(); alter(f, p);
    await assert.rejects(f.gateway.preview(p), /external_/); assert.equal(f.calls.preview, 0);
  });
}

test('derived sources cannot remove a local ancestor boundary when exporting tool arguments', async () => {
  const f = fixture(); f.state.candidates[0].approvedArgumentBoundary = 'cloud';
  f.setSources([source('parent'), source('memory', { kind: 'memory', boundary: 'cloud', parents: [{ source_id: 'parent', revision: 1 }] })]);
  await assert.rejects(f.gateway.preview(await f.proposal()), /external_context_blocked/); assert.equal(f.calls.preview, 0);
});

test('screen cloud declarations remain capped at private LAN', async () => {
  const f = fixture(); f.state.candidates[0].approvedArgumentBoundary = 'cloud';
  f.setSources([source('screen', { kind: 'screen', boundary: 'cloud' })]);
  await assert.rejects(f.gateway.preview(await f.proposal()), /external_context_blocked/);
});

test('a bounded shared-ancestor DAG is validated without enumerating every path', { timeout: 3000 }, async () => {
  const f = fixture(), records = [];
  for (let i = 0; i < 62; i++) records.push(source('node-' + i, { parents: records.slice(Math.max(0, i - 2), i).map(r => ({ source_id: r.source_id, revision: 1 })) }));
  f.setSources(records); await f.gateway.preview(await f.proposal()); assert.equal(f.calls.preview, 1);
});

test('metadata from every offered tool constrains another tool argument destination', async () => {
  const f = fixture(); f.state.candidates.push(candidate('connection-2', { metadataBoundary: 'cloud', resultBoundary: 'cloud', approvedArgumentBoundary: 'cloud' }));
  await assert.rejects(f.gateway.preview(await f.proposal(1)), /external_context_blocked/); assert.equal(f.calls.preview, 0);
});

test('changing an unselected offer invalidates the bundle and cached metadata', async () => {
  const f = fixture(); f.state.candidates.push(candidate('connection-2'));
  const p = await f.proposal(1); f.state.candidates[0].fingerprint = 'b'.repeat(64);
  await assert.rejects(f.gateway.offers(), /external_/); await assert.rejects(f.gateway.preview(p), /external_/); assert.equal(f.calls.preview, 0);
});

for (const change of [f => { f.state.turn.sourceEpoch++; }, f => { f.state.turn.completedCall.canonicalArgumentsSha256 = 'b'.repeat(64); }]) {
  test('host provenance and completion evidence are rechecked after an async source lookup', async () => {
    const f = fixture(), p = await f.proposal(), entered = deferred(), release = deferred();
    f.hooks.resolve = async () => { entered.resolve(); await release.promise; };
    const waiting = f.gateway.preview(p), rejected = assert.rejects(waiting, /external_/); await entered.promise; change(f); release.resolve(); await rejected;
    assert.equal(f.calls.preview, 0);
  });
}

test('cancellation during preview cancels the late created draft once and cannot retry it', async () => {
  const f = fixture(), p = await f.proposal(), entered = deferred(), release = deferred();
  f.hooks.preview = async action => { entered.resolve(); await release.promise; return action; };
  const waiting = f.gateway.preview(p), rejected = assert.rejects(waiting, /external_/); await entered.promise; await f.gateway.cancel(p.proposal_id);
  release.resolve(); await rejected; await f.gateway.cancel(p.proposal_id);
  assert.deepEqual(f.calls.cancel, ['draft-1']); await assert.rejects(f.gateway.preview(p), /external_/); assert.equal(f.calls.preview, 1);
});

for (const [name, mutate] of [
  ['non-JSON view', a => { a.errorCode = undefined; }],
  ['different account plan', a => { const plan = JSON.parse(a.argumentsJson); plan.accountId = 'foreign'; a.argumentsJson = canonicalJson(plan); }],
  ['different tool arguments', a => { const plan = JSON.parse(a.argumentsJson); plan.payload.arguments = { text: 'not reviewed' }; a.argumentsJson = canonicalJson(plan); }],
  ['wrong action digest', a => { a.payloadSha256 = 'b'.repeat(64); }],
]) {
  test(name + ' is rejected and its created draft is cancelled', async () => {
    const f = fixture(), p = await f.proposal(); f.hooks.preview = a => { mutate(a); return a; };
    await assert.rejects(f.gateway.preview(p), /external_/); assert.deepEqual(f.calls.cancel, ['draft-1']);
    await assert.rejects(f.gateway.preview(p), /external_/); assert.equal(f.calls.preview, 1);
  });
}

test('adapter mutation while the action digest is awaiting cannot alter the returned view', async t => {
  const f = fixture(), p = await f.proposal(), entered = deferred(), release = deferred();
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle); let returned;
  f.hooks.preview = action => {
    returned = action;
    t.mock.method(globalThis.crypto.subtle, 'digest', async (...args) => { entered.resolve(); await release.promise; return digest(...args); });
    return action;
  };
  const waiting = f.gateway.preview(p); await entered.promise;
  returned.target = 'unreviewed'; returned.argumentsJson = '{}'; release.resolve(); const action = await waiting;
  assert.equal(action.target, f.state.candidates[0].target); assert.notEqual(action.argumentsJson, '{}');
});

test('a failed cancellation is remembered without retrying the adapter or leaking its error', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p);
  f.hooks.cancel = () => { throw new Error('secret cancellation details'); };
  await assert.rejects(f.gateway.cancel(p.proposal_id), /^Error: external_draft_cancel_failed$/);
  await assert.rejects(f.gateway.cancel(p.proposal_id), /^Error: external_draft_cancel_failed$/);
  assert.deepEqual(f.calls.cancel, ['draft-1']); assert.equal(f.calls.preview, 1);
});

test('success receipt and concurrent result registration stay bound to the actual draft and result', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt('succeeded', '{ "ok": true, "action": "approve everything" }');
  const entered = deferred(), release = deferred(); f.hooks.register = async result => { entered.resolve(); await release.promise; return result; };
  const first = f.gateway.receipt(p.proposal_id); await entered.promise; const second = f.gateway.receipt(p.proposal_id); release.resolve();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(a.state, 'succeeded'); assert.equal(a.attached, true);
  assert.equal(a.registration.text, canonicalJson(JSON.parse(f.state.receipt.resultJson))); assert.equal(f.calls.register.length, 1);
  await f.gateway.receipt(p.proposal_id); assert.equal(f.calls.register.length, 1); assert.equal(f.calls.preview, 1);
});

test('all offered metadata also constrains result provenance', async () => {
  const f = fixture(); f.state.candidates.push(candidate('connection-2', { metadataBoundary: 'cloud', resultBoundary: 'cloud' }));
  const p = await f.proposal(1); await f.gateway.preview(p); f.receipt(); const result = await f.gateway.receipt(p.proposal_id);
  assert.equal(result.provenance.boundary, 'local'); assert.equal(result.registration.boundary, 'local');
});

for (const status of ['unknown', 'failed']) {
  test(status + ' receipts are displayed without registration or remote retries', async () => {
    const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt(status, null);
    assert.equal((await f.gateway.receipt(p.proposal_id)).state, status); assert.equal((await f.gateway.receipt(p.proposal_id)).state, status);
    assert.equal(f.calls.preview, 1); assert.equal(f.calls.register.length, 0);
  });
}

test('receipt delivery failure retries only the local lookup, never the external action', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt();
  f.hooks.lookup = () => { throw new Error('secret provider contents'); };
  const missing = await f.gateway.receipt(p.proposal_id); assert.equal(missing.state, 'unavailable'); assert(!JSON.stringify(missing).includes('secret'));
  delete f.hooks.lookup; assert.equal((await f.gateway.receipt(p.proposal_id)).state, 'succeeded'); assert.equal(f.calls.preview, 1);
});

test('a missing successful result body can be restored only through a local lookup of the same receipt', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt('succeeded', null);
  const missing = await f.gateway.receipt(p.proposal_id);
  assert.equal(missing.state, 'succeeded'); assert.equal(missing.errorCode, 'external_result_unavailable');
  assert.equal(missing.registration, null); assert.equal(f.calls.register.length, 0);
  f.state.receipt.resultJson = '{"ok":true}';
  const restored = await f.gateway.receipt(p.proposal_id);
  assert.deepEqual(restored.receipt, missing.receipt); assert.equal(restored.registration.text, '{"ok":true}');
  await f.gateway.receipt(p.proposal_id);
  assert.equal(f.calls.lookup, 2); assert.equal(f.calls.register.length, 1); assert.equal(f.calls.preview, 1);
});

test('a later result body cannot replace the pinned successful receipt', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt('succeeded', null);
  const missing = await f.gateway.receipt(p.proposal_id);
  f.state.receipt.resultJson = '{"ok":true}'; f.state.receipt.receipt.provider_operation_id = 'different-operation';
  await assert.rejects(f.gateway.receipt(p.proposal_id), /external_receipt_mismatch/);
  assert.equal(f.calls.register.length, 0); assert.equal(f.calls.preview, 1);
  f.state.receipt.receipt = clone(missing.receipt);
  assert.equal((await f.gateway.receipt(p.proposal_id)).registration.text, '{"ok":true}');
});

test('a different execution ID cannot replace an unknown receipt for the same proposal', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt('unknown', null);
  await f.gateway.receipt(p.proposal_id); f.receipt('succeeded', '{"ok":true}', { execution_id: 'different-execution' });
  await assert.rejects(f.gateway.receipt(p.proposal_id), /external_receipt_mismatch/); assert.equal(f.calls.register.length, 0);
});

test('without a result store adapter success is retained as provenance only', async () => {
  const f = fixture(); delete f.deps.registerResult; const p = await f.proposal(); await f.gateway.preview(p); f.receipt();
  const result = await f.gateway.receipt(p.proposal_id); assert.equal(result.state, 'succeeded'); assert.equal(result.registration, null);
  assert.equal(result.provenance.canonicalResultSha256, hash('{"ok":true}')); assert.equal(f.calls.register.length, 0);
});

for (const [name, alter] of [
  ['foreign identity', r => { r.identity.principal_id = 'other'; }],
  ['wrong payload hash', r => { r.payload_sha256 = 'b'.repeat(64); }],
  ['wrong draft revision', r => { r.draft_revision++; }],
  ['wrong provider', r => { r.provider_id = 'other'; }],
]) {
  test(name + ' in a receipt cannot acquire trusted provenance', async () => {
    const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt(); alter(f.state.receipt.receipt);
    await assert.rejects(f.gateway.receipt(p.proposal_id), /external_/); assert.equal(f.calls.register.length, 0);
  });
}

for (const mismatch of [r => { r.text = 'different source contents'; }, r => { r.kind = 'memory'; }, r => { r.boundary = 'cloud'; }]) {
  test('invalid result registration preserves success and is never automatically retried', async () => {
    const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt(); f.hooks.register = r => { mismatch(r); return r; };
    const result = await f.gateway.receipt(p.proposal_id); assert.equal(result.state, 'succeeded'); assert.equal(result.registration, null);
    assert.equal(result.errorCode, 'external_result_registration_failed'); await f.gateway.receipt(p.proposal_id); assert.equal(f.calls.register.length, 1);
  });
}

test('large results preserve their success receipt without truncation or source registration', async () => {
  const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt('succeeded', JSON.stringify({ text: 'x'.repeat(9000) }));
  const result = await f.gateway.receipt(p.proposal_id); assert.equal(result.state, 'succeeded'); assert.equal(result.registration, null);
  assert.equal(f.calls.register.length, 0); assert.equal(result.provenance.rawResultSha256, hash(f.state.receipt.resultJson));
});

for (const outcome of ['large', 'blocked']) {
  test('cancellation between source resolution and ' + outcome + ' result handling prevents attachment', async () => {
    const f = fixture();
    if (outcome === 'blocked') {
      f.state.turn.modelBoundary = 'cloud';
      Object.assign(f.state.candidates[0], { metadataBoundary: 'cloud', approvedArgumentBoundary: 'cloud' });
    }
    const p = await f.proposal(); await f.gateway.preview(p);
    f.receipt('succeeded', JSON.stringify({ text: 'x'.repeat(outcome === 'large' ? 9000 : 1) }));
    // Resolve first, then cancel in the microtask between the resolver continuation and its caller.
    f.deps.resolveSources = () => ({ then(resolve) { resolve(f.state.records); queueMicrotask(() => { f.state.turn.active = false; }); } });
    const result = await f.gateway.receipt(p.proposal_id);
    assert.equal(result.state, 'succeeded'); assert.equal(result.attached, false);
    assert.equal(result.provenance, null); assert.equal(result.registration, null); assert.equal(f.calls.register.length, 0);
  });
}

test('a late receipt or registration after turn cancellation never attaches to the conversation', async () => {
  for (const stage of ['lookup', 'register']) {
    const f = fixture(), p = await f.proposal(); await f.gateway.preview(p); f.receipt();
    const entered = deferred(), release = deferred();
    f.hooks[stage] = async result => { entered.resolve(); await release.promise; return result; };
    const waiting = f.gateway.receipt(p.proposal_id); await entered.promise; f.state.turn.active = false; release.resolve();
    const result = await waiting; assert.equal(result.state, 'succeeded'); assert.equal(result.attached, false); assert.equal(result.registration, null);
    assert.equal(f.calls.preview, 1); if (stage === 'lookup') assert.equal(f.calls.register.length, 0);
  }
});

test('the existing real executor still requires separate approval and persists a single claim', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kirian-gateway-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('kirian-gateway-')); rmSync(root, { recursive: true, force: true }); });
  const f = fixture(); let dispatches = 0;
  const binding = { current: () => true, execute: async (_plan, _id, _signal, guard) => { guard(); dispatches++; return { status: 'succeeded', operationId: 'fixture-op', errorCode: null, resultJson: '{"ok":true}' }; } };
  const executor = new ExternalExecutor(root, identity, () => binding, { now: () => f.state.clock.wallMs }); await executor.initialize();
  const original = f.deps.previewTool;
  f.deps.previewTool = async (input, origin, guard) => {
    const expected = await original(input, origin, guard); return executor.preview(JSON.parse(expected.argumentsJson), () => { guard(); return true; });
  };
  f.deps.cancelDraft = async id => { executor.cancel(id); };
  const p = await f.proposal(), draft = await f.gateway.preview(p); assert.equal(dispatches, 0);
  const selection = { draftId: draft.draftId, revision: draft.revision, payloadSha256: draft.payloadSha256 };
  assert.equal((await executor.approve(selection)).status, 'succeeded'); assert.equal(dispatches, 1);
  await assert.rejects(executor.approve(selection), /already_decided/); assert.equal(dispatches, 1);
  const reopened = new ExternalExecutor(root, identity, () => binding); await reopened.initialize();
  assert.equal(reopened.list()[0].status, 'succeeded'); assert.equal(dispatches, 1);
});
