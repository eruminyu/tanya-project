import { createHash, randomUUID } from 'node:crypto';
import { sameIdentity, type Identity } from '@kirian/contracts';
import { emptyProactive, proactiveLabels, type ProactiveCandidates, type ProactiveResult, type ProactiveSettings, type ProactiveState, type ProactiveSource } from '../../shared/proactive.js';
import { exact, validateProactiveSettings, ProactiveStore, type ProactiveData } from './proactive-store.js';
export interface ProactiveApi {candidates(signal?:AbortSignal,include?:string[]):Promise<ProactiveCandidates>;generate(sources:ProactiveSource[],modelId:string|null,attempt:string,signal:AbortSignal):Promise<ProactiveResult>;}
export interface ProactiveCalendar {read(selection:NonNullable<ProactiveSettings['calendar']>,signal:AbortSignal):Promise<unknown[]>;}
interface Time {now():number;setTimer(callback:()=>Promise<void>,ms:number):unknown;clearTimer(timer:unknown):void;}
const clock:Time={now:Date.now,setTimer:(f,ms)=>setTimeout(()=>void f(),ms),clearTimer:t=>clearTimeout(t as ReturnType<typeof setTimeout>)};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export class ProactiveController {
 private state=emptyProactive();private scope:{generation:number;identity:Identity;api:ProactiveApi;calendar:ProactiveCalendar}|null=null;
 private epoch=0;private timer:unknown;private job:Promise<void>|null=null;private abort:AbortController|null=null;private sourceGeneration:number|null=null;private readingCalendar=false;
 constructor(private readonly store:ProactiveStore,private readonly changed:(s:ProactiveState)=>void,private readonly permitted:()=>boolean,private readonly time:Time=clock){}
 snapshot():ProactiveState{return structuredClone(this.state);}
 private emit():void{this.state.version++;this.changed(this.snapshot());}
 private require(){if(!this.scope||!this.state.available)throw Error('context_changed');return this.scope;}
 private data():ProactiveData{return this.store.read(this.require().identity);}
 private save(data:ProactiveData):void{this.store.write(this.require().identity,data);this.state.settings=structuredClone(data.settings);this.state.revision=data.revision;this.state.attemptsToday=data.count;}
 setConnection(generation:number,identity:Identity|null,api:ProactiveApi|null,calendar:ProactiveCalendar):void {
  if(this.scope?.generation===generation&&identity&&sameIdentity(this.scope.identity,identity)&&api)return;
  this.pause('context_changed');this.scope=null;const version=this.state.version;this.state={...emptyProactive(),version};
  if(identity?.mode==='personal'&&api){this.scope={generation,identity:structuredClone(identity),api,calendar};
   try{const data=this.store.read(identity);Object.assign(this.state,{available:true,settings:data.settings,revision:data.revision,attemptsToday:data.count,reason:'resume_required'});}
   catch{this.scope=null;this.state.reason='storage_unavailable';}}
  this.emit();
 }
 configure(input:unknown):ProactiveState {
  const data=this.data();if(!exact(input,['revision','settings']))throw Error('invalid_request');validateProactiveSettings(input.settings);
  if(input.revision!==data.revision)throw Error('context_changed');this.pause('settings_changed');data.settings=structuredClone(input.settings);data.revision++;
  try{this.save(data);}catch(error){this.state.available=false;this.state.reason='storage_unavailable';this.emit();throw error;}this.emit();return this.snapshot();
 }
 start():ProactiveState {const data=this.data();if(!data.settings.enabled)throw Error('invalid_request');if(this.job)throw Error('proactive_busy');
  if(!this.permitted())throw Error('context_changed');this.state.running=true;this.state.reason='ready';this.schedule(0);this.emit();return this.snapshot();}
 pause(reason='paused'):ProactiveState {this.epoch++;this.abort?.abort();this.state.running=false;this.state.cards=[];this.state.sources=[];this.sourceGeneration=null;this.state.reason=reason;
  if(this.timer!==undefined)this.time.clearTimer(this.timer);this.timer=undefined;this.emit();return this.snapshot();}
 invalidateSources():void {this.epoch++;this.abort?.abort();this.state.cards=this.state.cards.filter(c=>c.kind==='calendar');this.state.sources=[];this.sourceGeneration=null;
  if(this.state.running){this.state.reason='source_changed';this.schedule(60_000);}this.emit();}
 invalidateCalendar(connectionId?:string):void {if(!this.state.settings.calendar||connectionId&&connectionId!==this.state.settings.calendar.connectionId)return;
  if(this.readingCalendar){this.epoch++;this.abort?.abort();}this.state.cards=this.state.cards.filter(c=>c.kind!=='calendar');this.emit();}
 dismiss(id:unknown):ProactiveState {if(typeof id!=='string'||!this.state.cards.some(c=>c.id===id))throw Error('invalid_request');
  this.state.cards=this.state.cards.filter(c=>c.id!==id);this.emit();return this.snapshot();}
 async refreshSources():Promise<ProactiveState>{const scope=this.require(),epoch=this.epoch;const result=await scope.api.candidates(undefined,this.state.settings.memorySourceIds);
  if(this.scope!==scope||this.epoch!==epoch)throw Error('context_changed');this.state.sources=result.sources;this.emit();return this.snapshot();}
 dispose():void{this.pause('closed');this.scope=null;}
 private schedule(ms:number):void{if(this.timer!==undefined)this.time.clearTimer(this.timer);this.timer=this.state.running?this.time.setTimer(()=>this.cycle(),ms):undefined;}
 private limits():ProactiveData {const data=this.data(),now=this.time.now(),day=Math.max(data.day,Math.floor(now/86400000));
  if(day>data.day){data.day=day;data.count=0;data.reads=0;}
  // 시도·거절/실패 억제는 30일 유지한다. 날짜 역행으로 먼저 지우지 않는다.
  data.seen=data.seen.filter(v=>now-v.at<30*86400000);return data;
 }
 private reserve(data:ProactiveData,fingerprint:string):boolean {const now=this.time.now();
  if(data.seen.some(v=>v.hash===fingerprint))return false;
  if(data.seen.length>=512)throw Error('ledger_full');
  if(data.count>=data.settings.dailyLimit){this.state.reason='daily_limit';return false;}
  if(data.lastAt&&now-data.lastAt<data.settings.intervalMinutes*60000){this.state.reason='interval_limit';return false;}
  data.count++;data.lastAt=now;data.seen.push({hash:fingerprint,at:now});this.save(data);return true;
 }
 private async cycle():Promise<void>{
  if(this.job){this.schedule(60_000);return;}const scope=this.scope;if(!scope||!this.state.running)return;
  const epoch=this.epoch,abort=new AbortController();this.abort=abort;this.state.busy=true;this.emit();
  const check=()=>{if(this.scope!==scope||this.epoch!==epoch||abort.signal.aborted||!this.permitted())throw Error('context_changed');};
  this.job=(async()=>{try{
   check();this.state.cards=this.state.cards.filter(c=>c.expiresAt>this.time.now());let data=this.limits();this.save(data);
   const candidates=await scope.api.candidates(abort.signal,data.settings.memorySourceIds);check();
   if(this.sourceGeneration!==null&&this.sourceGeneration!==candidates.generation)this.state.cards=this.state.cards.filter(c=>c.kind==='calendar');
   this.sourceGeneration=candidates.generation;this.state.sources=candidates.sources;this.state.reason='no_context';
   if(data.count>=data.settings.dailyLimit){this.state.reason='daily_limit';return;}
   const calendar=data.settings.calendar;
   if(calendar&&(!data.readAt||this.time.now()-data.readAt>=300000)){
    if(data.reads>=96)throw Error('calendar_read_limit');data.readAt=this.time.now();data.reads++;this.save(data);
    this.readingCalendar=true;let events:unknown[];try{events=await scope.calendar.read(calendar,abort.signal);}finally{this.readingCalendar=false;}check();const now=this.time.now();
    const upcoming=events.flatMap(event=>{
     if(!event||typeof event!=='object'||Array.isArray(event))return [];const e=event as Record<string,any>;
     if(typeof e.id!=='string'||e.id.length>1024||typeof e.summary!=='string'||!e.summary.trim()||e.summary.length>1024||e.status==='cancelled'||typeof e.start?.dateTime!=='string')return [];
     const at=Date.parse(e.start.dateTime);return Number.isFinite(at)&&at>now&&at<=now+15*60000?[{id:e.id,title:e.summary,at}]:[];
    }).sort((a,b)=>a.at-b.at);
    // 새 조회 결과에서 삭제·변경된 일정의 기존 카드도 철회한다.
    this.state.cards=this.state.cards.filter(c=>c.kind!=='calendar'||upcoming.some(e=>c.sourceId===hash(JSON.stringify([calendar,e.id,e.at,e.title]))));
    for(const event of upcoming){const key=hash(JSON.stringify([calendar,event.id,event.at,event.title]));
     if(!this.reserve(data,key))continue;check();this.state.cards.unshift({id:randomUUID(),kind:'calendar',text:'곧 시작하는 일정에 필요한 준비를 확인해 볼까요?',
      quote:event.title,title:'Google Calendar · '+new Date(event.at).toLocaleString(),sourceId:key,revision:1,createdAt:now,expiresAt:event.at,actualModel:null,routingReason:'calendar_time'});
     this.state.reason='ready';return;}
   }
   const allowed=candidates.sources.filter(s=>s.kind==='screen'?data.settings.screenAnalyses:data.settings.memorySourceIds.includes(s.source_id));
   const source=allowed.find(s=>!data.seen.some(v=>v.hash===s.fingerprint));
   if(!source||!this.reserve(data,source.fingerprint))return;
   check();const result=await scope.api.generate([source],data.settings.modelId,randomUUID(),abort.signal);check();
   const current=await scope.api.candidates(abort.signal,data.settings.memorySourceIds);check();
   if(result.generation!==current.generation||!current.sources.some(s=>s.source_id===source.source_id&&s.revision===source.revision&&s.fingerprint===source.fingerprint))throw Error('source_changed');
   if(result.suggestion){const suggestion=result.suggestion;if(suggestion.source_id!==source.source_id||suggestion.revision!==source.revision)throw Error('invalid_response');
    this.state.cards.unshift({id:randomUUID(),kind:source.kind,text:suggestion.text,quote:suggestion.quote,title:source.title,sourceId:source.source_id,revision:source.revision,
     createdAt:this.time.now(),expiresAt:this.time.now()+15*60000,actualModel:result.actual_model,routingReason:result.routing_reason});this.state.cards=this.state.cards.slice(0,5);}
   this.state.reason='ready';
  }catch(error){if(this.scope===scope&&this.epoch===epoch){const code=error instanceof Error?error.message:'';this.pause(Object.hasOwn(proactiveLabels,code)?code:'invalid_response');}}
  })();
  try{await this.job;}finally{this.job=null;this.state.busy=false;if(this.abort===abort)this.abort=null;this.emit();this.schedule(60_000);}
 }
}
