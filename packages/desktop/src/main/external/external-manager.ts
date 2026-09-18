import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Identity } from '@kirian/contracts';
import type { ExternalApproval, ExternalConnection, ExternalPreviewInput, ExternalState, CalendarView } from '../../shared/external.js';
import { ExternalExecutor, canonicalJson, externalExecutorId, type ExternalBinding, type ExternalDraftAuthority, type ExternalGuard, type ExternalPlan } from './external-executor.js';
import type { HostToolCandidate } from './external-proposal-gateway.js';
import { McpClient, McpTransportError, type McpClientOptions, type McpConnectionConfig, type McpTool } from './mcp-transport.js';
import { calendarProposal } from './calendar-proposals.js';
import { GoogleCalendarAccount, type GoogleCalendarPlan } from './google-calendar.js';

export interface ExternalVault {get(id:string):unknown|undefined;set(id:string,value:unknown):void;delete(id:string):void;}
/** A main-owned explicit selection and boundary policy. No transport-derived defaults. */
export interface ToolProposalSelection {
 connectionId:string;toolName:string;calendarId?:string;approvedArgumentBoundary:'local'|'private_lan'|'cloud'|null;
 metadataBoundary:'local'|'private_lan'|'cloud';resultBoundary:'local'|'private_lan'|'cloud';
}
interface Entry {view:ExternalConnection;generation:string;abort:AbortController;client?:McpClient;google?:GoogleCalendarAccount;tools:McpTool[];accountId:string;calendars?:CalendarView[];}
interface SavedConnection {id:string;kind:'mcp'|'google';label:string;destination:string;accountId:string;}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const validBoundary=(v:unknown):v is 'local'|'private_lan'|'cloud'=>typeof v==='string'&&['local','private_lan','cloud'].includes(v);
function keys(value:Record<string,unknown>,expected:string[]):boolean{return Object.keys(value).sort().join()===expected.sort().join();}
export function safeExternalError(error:unknown):string {
 if(error instanceof McpTransportError)return 'mcp_'+error.code;
 const code=error instanceof Error?error.message:'';
 return /^(external|google|mcp|credential|invalid_credential)_[a-z_]{1,64}$/.test(code)?code:'external_request_failed';
}
/** Holds live authority. IDs from the renderer select these objects, never supply one. */
export class ExternalManager {
 readonly executorId=externalExecutorId;
 private readonly entries=new Map<string,Entry>();
 private readonly executor:ExternalExecutor;
 private disposed=false;
 private readonly pending=new Set<AbortController>();
 private readonly credentialStore;
 constructor(root:string,identity:Identity,private readonly vault:ExternalVault,
  private readonly options:{mcpFactory?:(config:McpConnectionConfig,options?:McpClientOptions)=>McpClient;changed?:()=>void;now?:()=>number}={}) {
  this.executor=new ExternalExecutor(join(root,'ledger'),identity,(plan,recovery)=>this.binding(plan,recovery),{now:options.now});
  this.credentialStore={get:async(key:string)=>{const value=vault.get(key);if(value===undefined)return null;if(typeof value!=='string')throw new Error('external_invalid_credentials');return value;},set:async(key:string,value:string)=>{vault.set(key,value);},delete:async(key:string)=>{vault.delete(key);}};
 }
 async initialize():Promise<void>{
  await this.executor.initialize();const saved=this.vault.get('connection-catalog');
  if(saved!==undefined){
   if(!Array.isArray(saved)||saved.length>32)throw new Error('external_invalid_catalog');
   for(const item of saved){
    if(!object(item)||!keys(item,['id','kind','label','destination','accountId'])||!validId(item.id)||!validId(item.accountId)
      ||!['mcp','google'].includes(String(item.kind))||typeof item.label!=='string'||item.label.length>300||typeof item.destination!=='string'||item.destination.length>2048||this.entries.has(item.id))throw new Error('external_invalid_catalog');
    this.entries.set(item.id,this.entry(item as unknown as SavedConnection));
   }
  }
 }
 state():ExternalState{return {available:!this.disposed,connections:[...this.entries.values()].map(e=>structuredClone(e.view)),actions:this.executor.list()};}
 proposalCandidates(selections:readonly ToolProposalSelection[]):HostToolCandidate[]{
  this.check(()=>true);
  if(!Array.isArray(selections)||selections.length>16)throw new Error('external_invalid_selection');
  const candidates:HostToolCandidate[]=[],seen=new Set<string>();
  for(const selection of selections){
   if(!object(selection)||!keys(selection,['connectionId','toolName','approvedArgumentBoundary','metadataBoundary','resultBoundary',...(selection.calendarId===undefined?[]:['calendarId'])])
     ||!validId(selection.connectionId)||typeof selection.toolName!=='string'
     ||(selection.approvedArgumentBoundary!==null&&!validBoundary(selection.approvedArgumentBoundary))
     ||!validBoundary(selection.metadataBoundary)||!validBoundary(selection.resultBoundary))throw new Error('external_invalid_selection');
   const key=selection.connectionId+'\0'+selection.toolName;
   if(seen.has(key))throw new Error('external_invalid_selection');seen.add(key);
   const entry=this.entries.get(selection.connectionId),tool=entry?.tools.find(t=>t.name===selection.toolName);
   if(selection.calendarId!==undefined){
    if(typeof selection.calendarId!=='string'||!selection.calendarId||selection.calendarId.length>1024||selection.approvedArgumentBoundary!=='cloud')throw new Error('external_invalid_selection');
    const calendar=entry?.calendars?.find(c=>c.id===selection.calendarId);
    if(entry?.view.kind==='google'&&entry.view.phase==='ready'&&entry.google&&!entry.abort.signal.aborted&&calendar?.canWrite){
     const proposal=calendarProposal(selection.toolName,calendar);
     candidates.push({kind:'google_calendar',connectionId:entry.view.id,generation:entry.generation,accountId:entry.accountId,
      toolName:selection.toolName,fingerprint:hash({account:entry.accountId,calendar,tool:selection.toolName}),target:calendar.id,accountLabel:entry.view.label,
      approvedArgumentBoundary:'cloud',metadataBoundary:selection.metadataBoundary,resultBoundary:selection.resultBoundary,
      calendar, ...proposal});
    }
    continue;
   }
   if(!entry||entry.view.kind!=='mcp'||entry.view.phase!=='ready'||!entry.client||entry.abort.signal.aborted||!tool)continue;
   candidates.push({kind:'mcp',connectionId:entry.view.id,generation:entry.generation,accountId:entry.accountId,
    toolName:tool.name,fingerprint:hash(tool),target:entry.view.destination,accountLabel:entry.view.label,
    approvedArgumentBoundary:selection.approvedArgumentBoundary,metadataBoundary:selection.metadataBoundary,resultBoundary:selection.resultBoundary,
    displayName:tool.name,description:tool.description??'',inputSchemaJson:canonicalJson(tool.inputSchema)});
  }
  return structuredClone(candidates);
 }
 isProposalCandidateCurrent(candidate:HostToolCandidate):boolean{
  try{return this.proposalCandidates([{connectionId:candidate.connectionId,toolName:candidate.toolName,
   approvedArgumentBoundary:candidate.approvedArgumentBoundary,metadataBoundary:candidate.metadataBoundary,resultBoundary:candidate.resultBoundary,...(candidate.kind==='google_calendar'?{calendarId:candidate.target}:{})}])
   .some(current=>canonicalJson(current)===canonicalJson(candidate));}catch{return false;}
 }
 lookupReceipt(id:string){return this.executor.lookupReceipt(id);}
 private entry(saved:SavedConnection):Entry{return {view:{id:saved.id,kind:saved.kind,label:saved.label,destination:saved.destination,phase:'disconnected',errorCode:null,tools:[]},generation:randomUUID(),abort:new AbortController(),tools:[],accountId:saved.accountId};}
 private save():void{this.vault.set('connection-catalog',[...this.entries.values()].map(e=>({id:e.view.id,kind:e.view.kind,label:e.view.label,destination:e.view.destination,accountId:e.accountId})));}
 private check(context:ExternalGuard):void{if(this.disposed||context()!==true)throw new Error('external_context_changed');}
 private get(id:string):Entry{const entry=this.entries.get(id);if(!entry)throw new Error('external_unknown_connection');return entry;}
 private guard(entry:Entry,context:ExternalGuard):()=>void{const generation=entry.generation;return()=>{this.check(context);if(generation!==entry.generation||entry.abort.signal.aborted)throw new Error('external_connection_changed');};}
 async addMcp(config:McpConnectionConfig,label:string,context:ExternalGuard=()=>true):Promise<ExternalConnection>{
  this.check(context);const copied=structuredClone(config);
  // Constructor validates before either persistence or launching a process.
  new McpClient(copied).close();
  if(typeof label!=='string'||!label.trim()||label.length>120||this.entries.size+this.pending.size>=32)throw new Error('external_invalid_connection');
  const id=randomUUID(),destination=copied.kind==='stdio'?copied.command:new URL(copied.url).origin+new URL(copied.url).pathname;
  const entry=this.entry({id,kind:'mcp',label:label.trim(),destination,accountId:'mcp-'+id});
  this.vault.set('mcp-'+id,copied);this.entries.set(id,entry);this.save();return this.connect(id,context);
 }
 async connect(id:string,context:ExternalGuard=()=>true):Promise<ExternalConnection>{
  this.check(context);const entry=this.get(id);
  if(entry.view.phase==='connecting')throw new Error('external_connection_busy');
  this.disconnect(id);entry.abort=new AbortController();entry.generation=randomUUID();entry.view.phase='connecting';entry.view.errorCode=null;
  const abort=entry.abort,generation=entry.generation,guard=this.guard(entry,context);
  let ownedClient:McpClient|undefined;this.changed();
  try{
   guard();
   if(entry.view.kind==='mcp'){
    const config=this.vault.get('mcp-'+id) as McpConnectionConfig;
    const onDisconnected=(error:McpTransportError)=>{
     if(entry.generation!==generation||entry.client!==ownedClient||abort.signal.aborted)return;
     this.disconnectEntries([entry],safeExternalError(error));
    };
    ownedClient=(this.options.mcpFactory??((c,options)=>new McpClient(c,options)))(config,{onDisconnected});guard();entry.client=ownedClient;
    await ownedClient.connect(abort.signal);guard();
    const tools=await ownedClient.listTools(abort.signal);guard();entry.tools=tools;this.setTools(entry);
   }else{
    const google=await GoogleCalendarAccount.restore(entry.accountId,this.credentialStore,{guard,signal:abort.signal});guard();entry.google=google;
   }
   entry.view.phase='ready';return structuredClone(entry.view);
  }catch(error){
   // 이전 시도의 늦은 실패는 교체된 연결의 상태·클라이언트를 변경하지 않는다.
   ownedClient?.close();
   if(entry.generation===generation){
    if(!abort.signal.aborted){entry.view.phase='error';entry.view.errorCode=safeExternalError(error);}
    entry.client=undefined;entry.google=undefined;entry.tools=[];entry.view.tools=[];
   }
   throw new Error(safeExternalError(error));
  }finally{if(entry.generation===generation)this.changed();}
 }
 async connectGoogle(config:{clientId:string;clientSecret?:string},openBrowser:(url:string)=>Promise<void>,context:ExternalGuard=()=>true):Promise<ExternalConnection>{
  // An OAuth dialog reserves a catalog slot until completion or cancellation.
  this.check(context);if(this.entries.size+this.pending.size>=32)throw new Error('external_connection_limit');
  const abort=new AbortController();this.pending.add(abort);const guard=()=>{this.check(context);if(abort.signal.aborted)throw new Error('external_context_changed');};
  try{
   const account=await GoogleCalendarAccount.authorize(config,{vault:this.credentialStore,openBrowser,signal:abort.signal,guard});guard();
   let entry=[...this.entries.values()].find(e=>e.view.kind==='google'&&e.accountId===account.accountId);
   if(entry)this.disconnect(entry.view.id);
   else{entry=this.entry({id:randomUUID(),kind:'google',label:account.label,destination:'https://www.googleapis.com/calendar/v3',accountId:account.accountId});this.entries.set(entry.view.id,entry);}
   entry.abort=new AbortController();entry.generation=randomUUID();entry.google=account;entry.view.phase='ready';entry.view.errorCode=null;entry.view.label=account.label;this.save();return structuredClone(entry.view);
  }finally{this.pending.delete(abort);this.changed();}
 }
 disconnect(id:string):void{
  this.disconnectEntries([this.get(id)]);
 }
 private disconnectEntries(entries:Entry[],errorCode?:string):void{
  // 디스크 접근 전에 모든 연결 권한을 무효화한다. 원장 오류가 다음 연결의 해제를 막아서는 안 된다.
  const revoked=entries.map(entry=>{
   const handles={entry,abort:entry.abort,client:entry.client};
   entry.generation=randomUUID();entry.client=undefined;entry.google=undefined;entry.tools=[];entry.calendars=undefined;
   entry.view.phase='disconnected';entry.view.tools=[];entry.view.errorCode=null;return handles;
  });
  for(const {entry,abort,client} of revoked){
   abort.abort();
   try{client?.close();}catch(error){entry.view.errorCode=safeExternalError(error);}
  }
  const byId=new Map(entries.map(entry=>[entry.view.id,entry]));
  try{
   for(const action of this.executor.list()){
    const entry=byId.get(action.connectionId);
    if(entry&&['pending','running'].includes(action.status)){
     try{this.executor.cancel(action.draftId);}catch(error){entry.view.errorCode=safeExternalError(error);}
    }
   }
  }catch(error){for(const entry of entries)entry.view.errorCode=safeExternalError(error);}
  if(errorCode!==undefined)for(const entry of entries){entry.view.phase='error';entry.view.errorCode??=errorCode;}
  this.changed();
 }
 cancelConnections():void{for(const abort of this.pending)abort.abort();this.disconnectEntries([...this.entries.values()]);}
 private invalidate():void{
  try{this.executor.invalidate();}catch(error){for(const entry of this.entries.values())entry.view.errorCode=safeExternalError(error);this.changed();}
 }
 suspend():void{try{this.cancelConnections();}finally{this.invalidate();}}
 dispose():void{this.disposed=true;try{this.cancelConnections();}finally{this.invalidate();}}
 async discover(id:string,context:ExternalGuard=()=>true):Promise<ExternalConnection>{
  const entry=this.get(id),guard=this.guard(entry,context);guard();if(!entry.client||entry.view.phase!=='ready')throw new Error('external_connection_changed');
  const tools=await entry.client.listTools(entry.abort.signal);guard();entry.tools=tools;this.setTools(entry);this.changed();return structuredClone(entry.view);
 }
 private setTools(entry:Entry):void{entry.view.tools=entry.tools.map(t=>({name:t.name,description:t.description??'',inputSchemaJson:canonicalJson(t.inputSchema),readOnlyHint:t.readOnlyHint===true}));}
 async calendars(id:string,context:ExternalGuard=()=>true):Promise<CalendarView[]>{const entry=this.get(id),guard=this.guard(entry,context);guard();if(!entry.google||entry.view.phase!=='ready')throw new Error('external_connection_changed');const calendars=await entry.google.listCalendars(entry.abort.signal,guard);guard();entry.calendars=structuredClone(calendars);return calendars;}
 async events(input:{connectionId:string;calendarId:string;timeMin:string;timeMax:string},context:ExternalGuard=()=>true,signal?:AbortSignal):Promise<unknown[]>{
  if(!object(input)||!keys(input,['connectionId','calendarId','timeMin','timeMax']))throw new Error('external_invalid_request');
  const entry=this.get(input.connectionId),guard=this.guard(entry,context);guard();if(!entry.google||entry.view.phase!=='ready')throw new Error('external_connection_changed');
  const combined=signal?AbortSignal.any([entry.abort.signal,signal]):entry.abort.signal;
  combined.throwIfAborted();const result=await entry.google.listEvents(input.calendarId,{timeMin:input.timeMin,timeMax:input.timeMax},combined,guard);combined.throwIfAborted();guard();return result;
 }
 async preview(value:ExternalPreviewInput,context:ExternalGuard=()=>true,authority?:ExternalDraftAuthority){
  if(!object(value)||!['mcp','google'].includes(String(value.kind)))throw new Error('external_invalid_request');
  const input=structuredClone(value),entry=this.get(input.connectionId),guard=this.guard(entry,context);guard();
  if(entry.view.phase!=='ready')throw new Error('external_connection_changed');
  let plan:ExternalPlan;
  if(input.kind==='mcp'){
   if(!keys(input,['kind','connectionId','toolName','argumentsJson'])||entry.view.kind!=='mcp'||!entry.client||typeof input.argumentsJson!=='string'||input.argumentsJson.length>24576)throw new Error('external_invalid_request');
   const args:unknown=JSON.parse(input.argumentsJson);if(!object(args))throw new Error('external_invalid_arguments');canonicalJson(args);
   await this.discover(input.connectionId,context);guard();const tool=entry.tools.find(t=>t.name===input.toolName);if(!tool)throw new Error('external_unknown_tool');
   plan={providerId:'mcp',connectionId:entry.view.id,generation:entry.generation,fingerprint:hash(tool),accountId:entry.accountId,label:entry.view.label,
    target:entry.view.destination,operation:'tool-call',effect:'untrusted',payload:{name:tool.name,arguments:args,inputSchema:tool.inputSchema,description:tool.description??'',readOnlyHint:tool.readOnlyHint===true}};
  }else{
   if(!keys(input,['kind','connectionId','calendarId','operation','event'])||entry.view.kind!=='google'||!entry.google)throw new Error('external_invalid_request');
   if(authority)await this.calendars(input.connectionId,context);guard();
   const calendarPlan=await entry.google.prepare(input.operation,input.calendarId,input.event,entry.abort.signal,guard);guard();
   plan={providerId:'google_calendar',connectionId:entry.view.id,generation:entry.generation,fingerprint:authority?hash({account:entry.accountId,calendar:entry.calendars?.find(c=>c.id===input.calendarId),tool:'calendar.'+input.operation}):hash({account:entry.accountId}),accountId:entry.accountId,
    label:entry.view.label,target:input.calendarId,operation:input.operation,effect:'write',payload:{calendarPlan,...(authority?{proposalArguments:input.event}:{})}};
  }
  if(authority){await authority.revalidate();guard();}
  const result=await this.executor.preview(plan,()=>{guard();return true;},authority);this.changed();return result;
 }
 approve(input:ExternalApproval,context:ExternalGuard=()=>true){const result=this.executor.approve(input,context);this.changed();return result.finally(()=>this.changed());}
 cancel(id:string){const result=this.executor.cancel(id);this.changed();return result;}
 reconcile(id:string,context:ExternalGuard=()=>true){return this.executor.reconcile(id,context).finally(()=>this.changed());}
 private binding(plan:ExternalPlan,recovery=false):ExternalBinding|undefined {
  const entry=this.entries.get(plan.connectionId);if(!entry||entry.accountId!==plan.accountId||entry.view.phase!=='ready'
    ||(recovery?plan.providerId!=='google_calendar':entry.generation!==plan.generation))return;
  const generation=entry.generation;
  const current=()=>!this.disposed&&entry.generation===generation&&entry.view.phase==='ready'&&!entry.abort.signal.aborted;
  if(plan.providerId==='mcp'&&entry.client){const client=entry.client;return {current,execute:async(p,_id,signal,guard,authorizeDispatch)=>{
   try{
    guard();let tools:McpTool[];
    try{tools=await client.listTools(signal);}catch{return {status:'failed',operationId:null,errorCode:'external_tool_verification_failed'};}
    guard();entry.tools=tools;this.setTools(entry);const tool=tools.find(t=>t.name===p.payload.name);
    if(!tool||hash(tool)!==p.fingerprint)return {status:'failed',operationId:null,errorCode:'external_tool_changed'};
    // readOnlyHint is server data, never authorization to bypass the consent ledger.
    await authorizeDispatch();guard();
   }catch{return {status:'failed',operationId:null,errorCode:'external_proposal_revoked'};}
   const result=await client.callTool(String(p.payload.name),p.payload.arguments as Record<string,unknown>,signal);
   if(result.isError)return {status:'unknown',operationId:result.requestId,errorCode:'external_tool_reported_error'};
   return {status:'succeeded',operationId:result.requestId,errorCode:null,resultJson:canonicalJson({content:result.content,...(result.structuredContent===undefined?{}:{structuredContent:result.structuredContent})})};
  }};}
  if(plan.providerId==='google_calendar'&&entry.google){const google=entry.google;return {current,
   execute:(p,id,signal,guard,authorizeDispatch)=>google.execute(p.payload.calendarPlan as unknown as GoogleCalendarPlan,id,signal,guard,authorizeDispatch),
   reconcile:(p,id,signal,guard)=>google.reconcile(p.payload.calendarPlan as unknown as GoogleCalendarPlan,id,signal,guard)};}
  return;
 }
 private changed():void{this.options.changed?.();}
}
