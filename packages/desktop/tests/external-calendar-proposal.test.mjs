import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const {outputFiles}=await build({stdin:{contents:`export * from './src/main/external/external-proposal-adapter.ts';
 export * from './src/main/external/external-proposal-gateway.ts';export * from './src/main/external/external-manager.ts';
 export * from './src/main/external/google-calendar.ts';export {canonicalJson} from './src/main/external/external-executor.ts';
 export {calendarProposal,exampleOffset} from './src/main/external/calendar-proposals.ts';`,
 resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',packages:'external',
 plugins:[{name:'contracts',setup(api){api.onResolve({filter:/^@kirian\/contracts$/},()=>({path:import.meta.resolve('@kirian/contracts'),external:true}));}}]});
const {ExternalManager,ExternalProposalAdapter,ExternalProposalGateway,GoogleCalendarAccount,canonicalJson,calendarProposal,exampleOffset}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const identity={instance_id:'calendar-proposals',mode:'personal',principal_id:'owner'};
const model={provider_id:'fixture',model_id:'model',endpoint_id:'local'};
const event={summary:'승인할 일정',start:{date:'2026-09-20'},end:{date:'2026-09-21'}};
const select=d=>({draftId:d.draftId,revision:d.revision,payloadSha256:d.payloadSha256});
async function fixture(t,operation='create'){
 const root=mkdtempSync(join(tmpdir(),'kirian-calendar-proposals-')),secret=new Map(),writes=[],hooks={};
 const subject='calendar-proposal-user',accountId='google:'+hash(subject),calendar={id:'selected@example.test',summary:'선택한 일정',timeZone:'Asia/Seoul',accessRole:'owner'};
 secret.set('google-calendar:'+accountId,JSON.stringify({version:1,generation:'a'.repeat(64),clientId:'fixture.apps.googleusercontent.com',subject,email:'fixture@example.test',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000,scopes:['openid','email','https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.events']}));
 const vault={get:k=>secret.get(k),set:(k,v)=>secret.set(k,v),delete:k=>secret.delete(k)};
 const account=await GoogleCalendarAccount.restore(accountId,{get:async k=>secret.get(k)??null,set:async(k,v)=>secret.set(k,v),delete:async k=>secret.delete(k)}, {fetch:async(value,init)=>{
  const url=new URL(value),method=init.method??'GET';
  if(url.href==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:subject,email:'fixture@example.test',email_verified:true});
  assert.equal(url.origin,'https://www.googleapis.com');
  if(url.pathname.includes('/calendarList')){await hooks.calendar?.();return Response.json(url.pathname.endsWith('/calendarList')?{items:[calendar]}:calendar);}
  assert(url.pathname.includes('/calendars/'+encodeURIComponent(calendar.id)+'/events'));
  if(method==='GET')return Response.json({id:'existingevent',...event,etag:'"before"',status:'confirmed'});
  writes.push({url,method,body:init.body,headers:init.headers});
  if(hooks.write)return hooks.write();
  if(method==='DELETE')return new Response(null,{status:204});
  return Response.json({...JSON.parse(init.body),id:operation==='create'?JSON.parse(init.body).id:'existingevent',etag:'"after"',status:'confirmed'},{status:operation==='create'?201:200});
 }});
 t.mock.method(GoogleCalendarAccount,'authorize',async()=>account);
 const manager=new ExternalManager(root,identity,vault);await manager.initialize();
 const connection=await manager.connectGoogle({clientId:'fixture'},async()=>{});
 const policy={connectionId:connection.id,calendarId:calendar.id,toolName:'calendar.'+operation,approvedArgumentBoundary:'cloud',metadataBoundary:'cloud',resultBoundary:'local'};
 const state={selections:[policy],records:[],turn:{scope:{...identity,session_id:'session',connection_id:'brain',connection_epoch:1},turnId:'turn',intentId:'intent',epoch:1,sourceEpoch:1,active:true,toolsEnabled:true,brainDestination:'loopback',expectedModel:model,modelAuthorized:true,modelBoundary:'local',sourceRefs:[],completedCall:null}};
 const deps={currentTurn:()=>state.turn,selections:()=>state.selections,resolveSources:async()=>{await hooks.resolve?.();return state.records;}};
 const adapter=new ExternalProposalAdapter(manager,deps);let n=0;
 const gateway=new ExternalProposalGateway({executorId:adapter.executorId,clock:()=>({wallMs:Date.now(),monotonicMs:performance.now()}),newId:()=>`offer-${++n}`,currentTurn:deps.currentTurn,toolCandidates:()=>adapter.toolCandidates(),isCandidateCurrent:c=>adapter.isCandidateCurrent(c),resolveSources:deps.resolveSources,previewTool:(...args)=>adapter.previewTool(...args),cancelDraft:id=>adapter.cancelDraft(id),lookupReceipt:id=>adapter.lookupReceipt(id)});
 t.after(()=>{manager.dispose();assert.equal(dirname(resolve(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
 const proposal=async(args=operation==='delete'?{eventId:'existingevent'}:operation==='update'?{...event,eventId:'existingevent'}:event)=>{
  await manager.calendars(connection.id);const offers=await gateway.offers();assert.equal(offers[0].provider_kind,'google_calendar');
  const arguments_json=canonicalJson(args),input={provider_kind:'google_calendar',scope:state.turn.scope,turn_id:'turn',intent_id:'intent',request_id:'request',proposal_id:'proposal',offer_id:offers[0].offer_id,arguments_json,actual_model:model,source_refs:state.turn.sourceRefs};
  state.turn.completedCall={kind:'single_google_calendar_call',explicitlySupported:true,requestId:'request',proposalId:'proposal',offerId:input.offer_id,canonicalArgumentsSha256:hash(arguments_json),observedModel:model};return input;
 };
 return {manager,adapter,gateway,proposal,writes,hooks,state,calendar,policy,connection};
}
for(const operation of ['create','update','delete'])test(`Calendar ${operation}: host-bound target, exact approval, single receipt and result provenance`,async t=>{
 const f=await fixture(t,operation);assert.deepEqual(f.adapter.toolCandidates(),[]);
 const input=await f.proposal(),draft=await f.gateway.preview(input);assert.equal(f.writes.length,0);assert.equal(draft.target,f.calendar.id);assert.equal(draft.operation,operation);
 await assert.rejects(f.manager.approve({...select(draft),payloadSha256:'b'.repeat(64)}));
 const result=await f.manager.approve(select(draft));assert.equal(result.status,'succeeded');assert.equal(f.writes.length,1);
 if(operation!=='create')assert.equal(f.writes[0].headers['if-match'],'"before"');
 const receipt=await f.gateway.receipt('proposal');assert.equal(receipt.state,'succeeded');assert.equal(receipt.attached,true);assert.equal(receipt.provenance.providerKind,'google_calendar');assert.equal(receipt.provenance.offeredMetadata[0].providerKind,'google_calendar');
 await assert.rejects(f.manager.approve(select(draft)));await f.gateway.receipt('proposal');assert.equal(f.writes.length,1);
});
for(const extra of [{calendarId:'foreign@example.test'},{accountId:'foreign'},{operation:'delete'},{attendees:[]}])test('model cannot widen Calendar target or supported fields '+JSON.stringify(extra),async t=>{
 const f=await fixture(t);await assert.rejects(f.gateway.preview(await f.proposal({...event,...extra})));assert.equal(f.writes.length,0);
});
for(const change of ['off','selection','disconnect','calendar','source'])test('Calendar pending approval is revoked by '+change,async t=>{
 const f=await fixture(t),draft=await f.gateway.preview(await f.proposal());
 if(change==='off')f.state.turn.toolsEnabled=false;
 if(change==='selection')f.state.selections=[];
 if(change==='disconnect')f.manager.disconnect(f.connection.id);
 if(change==='calendar')f.calendar.accessRole='reader';
 if(change==='source'){f.state.turn.sourceRefs=[{source_id:'new-source',revision:1}];}
 await f.manager.approve(select(draft)).catch(()=>{});assert.equal(f.writes.length,0);
});
test('Calendar source revocation during last provider read blocks actual mutation',async t=>{
 const f=await fixture(t);const source={source_id:'source',revision:1,identity,kind:'note',boundary:'cloud',deleted:false,parents:[]};
 f.state.records=[source];f.state.turn.sourceRefs=[{source_id:'source',revision:1}];
 const draft=await f.gateway.preview(await f.proposal());f.hooks.calendar=async()=>{source.deleted=true;};
 assert.equal((await f.manager.approve(select(draft))).status,'failed');assert.equal(f.writes.length,0);
});
test('local-only conversation history cannot be sent to Calendar',async t=>{
 const f=await fixture(t);f.state.records=[{source_id:'private',revision:1,identity,kind:'tool_result',boundary:'local',deleted:false,parents:[]}];
 f.state.turn.sourceRefs=[{source_id:'private',revision:1}];
 await assert.rejects(f.gateway.preview(await f.proposal()),/context_blocked/);assert.equal(f.writes.length,0);
});
test('Calendar provider mismatch and local-only argument policy never create a draft',async t=>{
 const f=await fixture(t),input=await f.proposal();await assert.rejects(f.gateway.preview({...input,provider_kind:'mcp'}));
 f.state.selections=[{...f.policy,approvedArgumentBoundary:'local'}];assert.throws(()=>f.adapter.toolCandidates());assert.equal(f.writes.length,0);
});
test('Calendar response loss remains unknown and receipt lookup never retries a write',async t=>{
 const f=await fixture(t),draft=await f.gateway.preview(await f.proposal());f.hooks.write=()=>{throw Error('lost after write');};
 assert.equal((await f.manager.approve(select(draft))).status,'unknown');
 assert.equal((await f.gateway.receipt('proposal')).state,'unknown');await f.gateway.receipt('proposal');assert.equal(f.writes.length,1);
});
test('Calendar offer description states draft semantics, the exact time shape and a fixed example offset',()=>{
 for(const [zone,offset] of [['Asia/Seoul','+09:00'],['UTC','+00:00'],['America/New_York','-05:00'],['Australia/Adelaide','+10:30']])assert.equal(exampleOffset(zone),offset);
 assert.equal(exampleOffset('Not/AZone'),'+00:00');
 const calendar={id:'selected@example.test',label:'선택한 일정',timeZone:'Australia/Adelaide',accessRole:'owner',canWrite:true};
 for(const operation of ['create','update','delete']){
  const offer=calendarProposal('calendar.'+operation,calendar),second=calendarProposal('calendar.'+operation,calendar);
  assert.deepEqual(offer,second);assert.ok(Buffer.byteLength(offer.description,'utf8')<=2048);
  assert.equal(offer.displayName,{create:'일정 만들기',update:'일정 수정',delete:'일정 삭제'}[operation]+' · 선택한 일정');
  assert.match(offer.description,/Selected calendar: 선택한 일정; time zone: Australia\/Adelaide/);
  assert.match(offer.description,/the call itself writes nothing/);assert.match(offer.description,/never ask for confirmation/);
  assert.doesNotMatch(offer.description,/User approval is required/);
  if(operation==='delete'){assert.doesNotMatch(offer.description,/dateTime/);assert.match(offer.description,/never invent or guess one/);continue;}
  assert.match(offer.description,/\{"dateTime":"2026-01-15T09:00:00\+10:30","timeZone":"Australia\/Adelaide"\}/);
  assert.match(offer.description,/\{"date":"2026-01-15"\}/);assert.match(offer.description,/end must be later than start/);
  assert.equal(/never invent or guess one/.test(offer.description),operation==='update');
  assert.deepEqual(JSON.parse(offer.inputSchemaJson).required,operation==='update'?['eventId','summary','start','end']:['summary','start','end']);
 }
});
test('Calendar model draft accepts ISO text for start/end only as the exact object the user reviews',async t=>{
 const text={summary:'문자열 시각',start:'2026-09-18T15:00:00+09:00',end:'2026-09-18T16:00:00+09:00'};
 let f=await fixture(t),draft=await f.gateway.preview(await f.proposal(text)),plan=JSON.parse(draft.argumentsJson).payload;
 assert.deepEqual(plan.calendarPlan.event.start,{dateTime:'2026-09-18T06:00:00.000Z'});assert.deepEqual(plan.calendarPlan.event.end,{dateTime:'2026-09-18T07:00:00.000Z'});
 assert.deepEqual(plan.proposalArguments,text);
 f=await fixture(t);draft=await f.gateway.preview(await f.proposal({summary:'종일',start:'2026-09-20',end:'2026-09-21'}));
 assert.deepEqual(JSON.parse(draft.argumentsJson).payload.calendarPlan.event.start,{date:'2026-09-20'});
 for(const bad of [{...text,start:'2026-09-18T15:00:00'},{...text,start:'2026-09-18 15:00'},{...text,start:'2026-09-18'}]){
  f=await fixture(t);await assert.rejects(f.gateway.preview(await f.proposal(bad)));assert.equal(f.writes.length,0);
 }
});
