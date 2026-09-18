import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle, parseMessage, assertDefinition } from '../dist/index.js';
const identity={instance_id:'instance',principal_id:'owner',mode:'personal'};
const scope={...identity,session_id:'session',connection_id:'connection',connection_epoch:0};
const model={provider_id:'ollama',model_id:'model',endpoint_id:'local'};
let n=0;
function event(kind,payload,extra={}){return {protocol:'kirian.rearchitecture.v1',message_id:'msg-'+(++n),request_id:'req-'+n,scope,turn_id:'turn',intent_id:'intent',sequence:0,kind,payload,...extra};}
const offer={offer_id:'offer',display_name:'Lookup',description:'Untrusted metadata',input_schema_json:'{"type":"object"}'};
function setup(tools=true){const lifecycle=new SessionLifecycle(scope);lifecycle.receive(event('session.ready',{client_kind:'electron',resume:'new_session',capabilities:['text']},{turn_id:null,intent_id:null}));
 lifecycle.receive(event('turn.start',{selection:{model,source:'initial_local'},context:[],...(tools?{external_tools:true}:{})},{request_id:'response'}));return lifecycle;}
function prepared(){const lifecycle=setup();lifecycle.receive(event('tool.context',{context_id:'context'}));lifecycle.receive(event('tool.offers',{context_id:'context',offers:[offer]}));return lifecycle;}
function proposed(lifecycle){const message=event('tool.proposed',{provider_kind:'mcp',proposal_id:'proposal',offer_id:'offer',arguments_json:'{}',actual_model:model,routing_reason:'initial_local',source_refs:[]});lifecycle.receive(message);return message;}

test('Calendar offer binds its provider and MCP offers cannot be relabelled as Calendar',()=>{
 for(const provider of ['mcp','google_calendar']){
  const lifecycle=setup();lifecycle.receive(event('tool.context',{context_id:'context'}));
  lifecycle.receive(event('tool.offers',{context_id:'context',offers:[{...offer,provider_kind:provider}]}));
  const payload={provider_kind:provider==='mcp'?'google_calendar':'mcp',proposal_id:'proposal',offer_id:'offer',arguments_json:'{}',actual_model:model,routing_reason:'initial_local',source_refs:[]};
  assert.throws(()=>lifecycle.receive(event('tool.proposed',payload)),/invalid_tool_proposal/);
  assert.equal(lifecycle.receive(event('tool.proposed',{...payload,provider_kind:provider})).kind,'accepted');
 }
});
test('tool handshakes require host opt-in, context, known offers and a single proposal',()=>{
 assert.throws(()=>setup(false).receive(event('tool.context',{context_id:'context'})));
 const lifecycle=setup();assert.throws(()=>lifecycle.receive(event('tool.offers',{context_id:'context',offers:[offer]})));
 lifecycle.receive(event('tool.context',{context_id:'context'}));
 assert.throws(()=>lifecycle.receive(event('tool.context',{context_id:'context'})));
 assert.throws(()=>lifecycle.receive(event('tool.offers',{context_id:'other',offers:[offer]})));
 assert.throws(()=>lifecycle.receive(event('tool.offers',{context_id:'context',offers:[offer,offer]})));
 lifecycle.receive(event('tool.offers',{context_id:'context',offers:[offer]}));
 const message=proposed(lifecycle);assert.equal(lifecycle.receive(message).kind,'duplicate');
 assert.throws(()=>proposed(lifecycle));assert.equal(lifecycle.getTurn('turn').generation,'running');
});
for(const state of ['succeeded','failed','unknown','unavailable'])test('resolution '+state+' allows one tool-free response after the approval wait',()=>{
 const lifecycle=prepared();proposed(lifecycle);
 assert.throws(()=>lifecycle.receive(event('response.completed',{actual_model:model},{request_id:'response',sequence:1})));
 const payload={proposal_id:'proposal',state,...(state==='succeeded'?{source_ref:{source_id:'tool-result-1',revision:1}}:{})};
 const resolution=event('tool.resolved',payload);assert.equal(lifecycle.receive(resolution).kind,'accepted');assert.equal(lifecycle.receive(resolution).kind,'duplicate');
 assert.throws(()=>lifecycle.receive(event('tool.resolved',payload)));
 lifecycle.receive(event('response.completed',{actual_model:model},{request_id:'response',sequence:1}));
 lifecycle.receive(event('turn.ended',{status:'completed'}));assert.equal(lifecycle.getTurn('turn').status,'completed');
});
for(const payload of [{proposal_id:'other',state:'failed'},{proposal_id:'proposal',state:'succeeded'},{proposal_id:'proposal',state:'failed',source_ref:{source_id:'result',revision:1}}])test('resolution requires exact proposal and success-only source reference '+JSON.stringify(payload),()=>{
 const lifecycle=prepared();proposed(lifecycle);assert.throws(()=>lifecycle.receive(event('tool.resolved',payload)));
});
test('ordinary no-offer response and unsupported-model normal flow remain valid',()=>{
 for(const tools of [false,true]){const lifecycle=setup(tools);if(tools){lifecycle.receive(event('tool.context',{context_id:'context'}));lifecycle.receive(event('tool.offers',{context_id:'context',offers:[]}));}
 lifecycle.receive(event('response.completed',{actual_model:model},{request_id:'response',sequence:1}));}
});
test('tool payloads never accept authority, receipts, unknown fields or excessive offers',()=>{
 for(const extra of [{approval:{status:'approved'}},{receipt:{status:'succeeded'}},{execute:true}])assert.throws(()=>parseMessage(event('tool.proposed',{provider_kind:'mcp',proposal_id:'proposal',offer_id:'offer',arguments_json:'{}',actual_model:model,source_refs:[],...extra})));
 assert.throws(()=>parseMessage(event('tool.offers',{context_id:'context',offers:Array(17).fill(offer)})));
 assertDefinition('SourceRecord',{source_id:'result',revision:1,identity,kind:'tool_result',boundary:'local',deleted:false,parents:[]});
});
test('wrong model, late proposal after cancel and source authority remain independent',()=>{
 const lifecycle=prepared();const message=event('tool.proposed',{provider_kind:'mcp',proposal_id:'proposal',offer_id:'offer',arguments_json:'{}',actual_model:{...model,model_id:'different'},source_refs:[]});
 assert.throws(()=>lifecycle.receive(message));lifecycle.receive(event('turn.cancel',{reason:'user'}));
 assert.equal(lifecycle.receive({...message,message_id:'late',payload:{...message.payload,actual_model:model}}).kind,'discarded');
});
