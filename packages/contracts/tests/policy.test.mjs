import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ModelPreferences, resolveModel, assertActualModel, assertContextAllowed} from '../dist/index.js';
const identity = {instance_id:'private-1', mode:'personal', principal_id:'user-1'};
const local = {provider_id:'ollama', model_id:'local-model', endpoint_id:'local'};
const api = {provider_id:'api-provider', model_id:'api-model', endpoint_id:'api'};
const lan = {provider_id:'ollama', model_id:'lan-model', endpoint_id:'lan'};
const endpoints = [
 {endpoint_id:'local',provider_id:'ollama',boundary:'local',approved:true},
 {endpoint_id:'api',provider_id:'api-provider',boundary:'cloud',approved:true},
 {endpoint_id:'lan',provider_id:'ollama',boundary:'private_lan',approved:true},
];
const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
test('request > conversation > saved default > initial local, without content routing', () => {
 assert.deepEqual(resolveModel(identity,endpoints,local), {model:local,source:'initial_local'});
 assert.deepEqual(resolveModel(identity,endpoints,local,{savedDefault:api}), {model:api,source:'saved_default'});
 assert.deepEqual(resolveModel(identity,endpoints,local,{savedDefault:api,conversation:lan}), {model:lan,source:'conversation'});
 assert.deepEqual(resolveModel(identity,endpoints,local,{savedDefault:api,conversation:lan,request:local}), {model:local,source:'request'});
});
test('API default survives serialized restart and new conversation; temporary choices do not change it', () => {
 const prefs = new ModelPreferences(identity,endpoints,local);
 prefs.setDefault(api);
 assert.equal(prefs.resolve(local).source, 'request');
 const restarted = new ModelPreferences(identity,endpoints,local,JSON.parse(JSON.stringify(prefs.snapshot())));
 assert.deepEqual(restarted.resolve(), {model:api,source:'saved_default'});
 assert.deepEqual(restarted.resolve(), {model:api,source:'saved_default'});
 rejects(()=> new ModelPreferences({...identity,principal_id:'other'},endpoints,local,prefs.snapshot()), 'invalid_preferences_snapshot');
});
test('public instance rejects personal API defaults and foreign endpoint claims', () => {
 rejects(()=>resolveModel({...identity,mode:'public_demo'},endpoints,local,{savedDefault:api}), 'public_model_blocked');
 rejects(()=>resolveModel(identity,endpoints,local,{request:{...api,provider_id:'ollama'}}), 'unapproved_endpoint');
 rejects(()=>resolveModel(identity,endpoints,local,{request:{...api,endpoint_id:'unregistered'}}), 'unapproved_endpoint');
 rejects(()=>resolveModel(identity,endpoints.map(e=>e.endpoint_id==='api'?{...e,approved:false}:e),local,{request:api}), 'unapproved_endpoint');
});
test('actual provider, endpoint or model may not silently differ from selected model', () => {
 const selection={model:api,source:'request'};
 assert.doesNotThrow(()=>assertActualModel(selection,api));
 for(const actual of [local,{...api,model_id:'other'},{...api,endpoint_id:'elsewhere'}])
   rejects(()=>assertActualModel(selection,actual),'unapproved_model_change');
});
function source(source_id, kind='note', boundary='cloud', parents=[]) {
 return {source_id,revision:1,identity,kind,boundary,deleted:false,parents};
}
const item={source_id:'memory',revision:1,text:'화면에서 추출된 기억'};
const lineage=[
 source('screen','screen','private_lan'),
 source('summary','conversation','cloud',[{source_id:'screen',revision:1}]),
 source('memory','memory','cloud',[{source_id:'summary',revision:1}]),
];
test('screen -> summary -> memory retains local/LAN restriction even if children say cloud', () => {
 assert.doesNotThrow(()=>assertContextAllowed(identity,[item],lineage,local,endpoints));
 assert.doesNotThrow(()=>assertContextAllowed(identity,[item],lineage,lan,endpoints));
 rejects(()=>assertContextAllowed(identity,[item],lineage,api,endpoints),'context_boundary_blocked');
 rejects(()=>assertContextAllowed(identity,[{source_id:'screen',revision:1,text:'x'}],[source('screen','screen','cloud')],api,endpoints),'context_boundary_blocked');
});
test('deleted, edited, foreign, missing and cyclic ancestors block stale search results', () => {
 for(const [change,code] of [
   [s=>{s[0].deleted=true},'deleted_source'],
   [s=>{s[0].revision=2},'stale_source'],
   [s=>{s[0].identity={...identity,principal_id:'other'}},'foreign_source'],
   [s=>{s.shift()},'unknown_source'],
   [s=>{s[0].parents=[{source_id:'memory',revision:1}]},'invalid_source_lineage'],
 ]) { const catalog=structuredClone(lineage);change(catalog);rejects(()=>assertContextAllowed(identity,[item],catalog,local,endpoints),code); }
});
test('local-only data cannot move to LAN; approved nonsensitive note may reach API', () => {
 const note={source_id:'note',revision:1,text:'공개 가능한 메모'};
 rejects(()=>assertContextAllowed(identity,[note],[source('note','note','local')],lan,endpoints),'context_boundary_blocked');
 assert.doesNotThrow(()=>assertContextAllowed(identity,[note],[source('note')],api,endpoints));
 rejects(()=>assertContextAllowed(identity,[note],[source('note'),source('note')],local,endpoints),'duplicate_source');
});

test('approved personal LAN inference is a valid initial local model', () => {
 assert.deepEqual(resolveModel(identity,endpoints,lan), {model:lan,source:'initial_local'});
 rejects(()=>resolveModel(identity,endpoints,api),'initial_model_not_local');
});
