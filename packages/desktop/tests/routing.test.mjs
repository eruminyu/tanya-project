import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRouting, validateRoutingSettings, automaticCandidates } from '../dist-electron/main/routing-client.js';
const state = { enabled:false, revision:0, daily_call_limit:10, daily_budget_units:20, calls_used:0, budget_units_used:0, resets_at:86400000, persistent:true };
test('routing settings and host state reject unknown fields and coercion', () => {
  assert.deepEqual(validateRouting(state), state);
  for (const changes of [{enabled:1},{daily_budget_units:-1},{calls_used:1.2},{revision:NaN},{extra:true},{persistent:'yes'}]) {
    assert.throws(() => validateRouting({...state,...changes}));
  }
  const input = {enabled:true,expected_revision:0,daily_call_limit:10,daily_budget_units:20};
  assert.deepEqual(validateRoutingSettings(input), input);
  for (const changes of [{enabled:'true'}, {expected_revision:-1}, {daily_call_limit:0}, {daily_budget_units:Infinity}, {url:'https://invalid'}]) {
    assert.throws(() => validateRoutingSettings({...input,...changes}));
  }
});
test('automatic candidates come from priced host-approved input-capable bindings', () => {
  const model = {provider_id:'ollama',model_id:'one',endpoint_id:'local'};
  const base = {model,label:'one',automatic_allowed:true,supports_text:true,supports_images:true,budget_units:1,boundary:'local'};
  const models = [base, {...base,model:{...model,model_id:'unpriced'},budget_units:null}, {...base,model:{...model,model_id:'embedding'},supports_text:false}, {...base,model:{...model,model_id:'denied'},automatic_allowed:false}];
  assert.deepEqual(automaticCandidates(models,'text'), [model]);
  assert.deepEqual(automaticCandidates(models,'images','local'), [model]);
});
