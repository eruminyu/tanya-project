import { createHash, randomUUID } from 'node:crypto';
import { sameIdentity, type Identity } from '@kirian/contracts';
import { defaultAutoScreenSettings, type AutoScreenState } from '../../shared/auto-screen.js';
import type { ScreenPreview, ScreenTarget } from '../../shared/screens.js';
import type { NativeCapturedFrame } from './native-capture.js';
import type { ScreenClient } from './screen-client.js';
import { AutoScreenStore, validateAutoScreenSettings, type AutoScreenData } from './auto-screen-store.js';

interface Native { listSources(): Promise<ScreenTarget[]>; capture(id:string,name:string,signal:AbortSignal): Promise<NativeCapturedFrame>; }
interface Clock { now():number; setTimer(callback:()=>Promise<void>,delay:number):unknown; clearTimer(timer:unknown):void; }
interface Scope { generation:number; identity:Identity; api:ScreenClient; }
const clock:Clock={now:Date.now,setTimer:(fn,delay)=>setTimeout(()=>void fn(),delay),clearTimer:timer=>clearTimeout(timer as NodeJS.Timeout)};
const empty=():AutoScreenState=>({version:0,available:false,revision:0,settings:defaultAutoScreenSettings(),running:false,phase:'unavailable',reason:null,
  sources:[],preview:null,analysis:null,records:[],lastAttemptAt:0,captures:0,unchanged:0});
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join()===[...keys].sort().join();
const safeCodes=new Set(['invalid_request','context_changed','target_changed','capture_denied','capture_timeout','capture_unavailable',
  'capture_limit','routing_changed','routing_limit','routing_no_candidate','model_not_allowed','unsupported_model','context_blocked','screen_limit','cleanup_required','storage_unavailable',
  'provider_error','provider_unavailable','turn_timeout','model_mismatch','incomplete_response','image_limit','capture_source_changed']);
const code=(error:unknown)=>error instanceof Error && safeCodes.has(error.message)?error.message:'capture_unavailable';

export class AutoScreenController {
  private state=empty(); private scope:Scope|null=null; private timer:unknown;
  private epoch=0; private version=0; private abort:AbortController|null=null; private job:Promise<void>|null=null; private starting=false;
  private index=0; private hashes=new Map<string,string>(); private analyzed=new Map<string,string>();
  constructor(private readonly native:Native,private readonly store:AutoScreenStore,private readonly changed:(state:AutoScreenState)=>void,
    private readonly imported:()=>unknown,private readonly time:Clock=clock,private readonly permitted:()=>boolean=()=>true) {}
  snapshot():AutoScreenState{return structuredClone(this.state);}
  private emit():void{this.state.version=++this.version;this.changed(this.snapshot());}
  private data(scope:Scope):AutoScreenData{return this.store.read(scope.identity);}
  private save(scope:Scope,edit:(data:AutoScreenData)=>void):void{
    const data=this.data(scope);edit(data);this.store.write(scope.identity,data);
    if(this.scope===scope){this.state.revision=data.revision;this.state.settings=data.settings;this.state.records=data.records;this.state.lastAttemptAt=data.lastAttemptAt;}
  }
  setConnection(generation:number,identity:Identity|null,api:ScreenClient|null):void{
    if(this.scope && this.scope.generation===generation && identity && api && sameIdentity(this.scope.identity,identity)) {this.scope.api=api;return;}
    if(!this.scope && !identity && !api)return;
    this.pause('connection_changed');this.scope=null;this.state=empty();
    if(identity?.mode==='personal' && api){
      const scope={generation,identity:structuredClone(identity),api};
      try{const data=this.data(scope);this.scope=scope;this.state={...empty(),...data,available:true,phase:'paused',reason:'resume_required'};this.schedule(0);}
      catch{this.state.reason='storage_unavailable';}
    }
    this.emit();
  }
  async listSources():Promise<AutoScreenState>{
    const scope=this.require(),epoch=this.epoch;const sources=await this.native.listSources();
    if(this.scope!==scope || this.epoch!==epoch)throw Error('context_changed');
    this.state.sources=sources.filter(s=>s.kind==='window');this.emit();return this.snapshot();
  }
  private require():Scope{if(!this.scope || !this.state.available)throw Error('context_changed');return this.scope;}
  async configure(input:unknown):Promise<AutoScreenState>{
    const scope=this.require();
    if(!exact(input,['revision','settings']))throw Error('invalid_request');validateAutoScreenSettings(input.settings);
    if(input.revision!==this.data(scope).revision)throw Error('context_changed');
    this.pause('settings_changed');
    try{this.save(scope,data=>{data.settings=structuredClone(input.settings);data.revision++;});}
    catch{this.state.available=false;this.state.reason='storage_unavailable';this.emit();throw Error('storage_unavailable');}
    this.emit();return this.snapshot();
  }
  async start(input:unknown):Promise<AutoScreenState>{
    const scope=this.require();
    if(!exact(input,['revision']) || input.revision!==this.data(scope).revision)throw Error('context_changed');
    if(this.job || this.starting)throw Error('busy');
    if(!this.state.settings.enabled)throw Error('invalid_request');
    if(!this.permitted())throw Error('capture_denied');
    this.starting=true;const epoch=this.epoch;
    try{
      const sources=await this.native.listSources();if(this.scope!==scope || this.epoch!==epoch)throw Error('context_changed');
      this.checkTargets(sources);if(!this.permitted())throw Error('capture_denied');this.state.sources=sources.filter(s=>s.kind==='window');
      if(this.state.settings.analysisEnabled)scope.api.model(this.state.settings.modelId,this.state.settings.boundary);
      this.state.running=true;this.state.phase='waiting';this.state.reason=null;this.schedule(0);this.emit();return this.snapshot();
    }finally{this.starting=false;}
  }
  pause(reason='paused'):AutoScreenState{
    this.epoch++;this.abort?.abort();this.state.running=false;this.state.preview=null;this.state.analysis=null;
    this.hashes.clear();this.analyzed.clear();this.index=0;this.state.phase=this.scope?'paused':'unavailable';this.state.reason=reason;
    this.schedule(30_000);this.emit();return this.snapshot();
  }
  async disable():Promise<AutoScreenState>{
    this.pause('disabled');const scope=this.require();
    try{this.save(scope,data=>{data.settings.enabled=false;data.revision++;});}
    catch{this.state.available=false;this.state.reason='storage_unavailable';this.emit();throw Error('storage_unavailable');}
    this.emit();return this.snapshot();
  }
  async clearRecords():Promise<AutoScreenState>{
    this.pause('paused');const scope=this.require();
    if(this.job)await this.job;if(this.scope!==scope)throw Error('context_changed');
    this.save(scope,data=>{for(const record of data.records)record.status='pending';});
    await this.cleanup(scope);this.emit();return this.snapshot();
  }
  dispose():void{this.pause('closed');this.scope=null;if(this.timer!==undefined)this.time.clearTimer(this.timer);this.timer=undefined;}
  private schedule(delay:number):void{
    if(this.timer!==undefined)this.time.clearTimer(this.timer);
    this.timer=this.scope?this.time.setTimer(()=>this.cycle(),delay):undefined;
  }
  private checkTargets(sources:ScreenTarget[]):void{
    for(const target of this.state.settings.targets){
      if(target.kind!=='window' || this.state.settings.excludedIds.includes(target.id)
        || !sources.some(s=>s.id===target.id && s.name===target.name && s.kind==='window'))throw Error('target_changed');
    }
  }
  private async cleanup(scope:Scope,room=false):Promise<void>{
    const data=this.data(scope),now=this.time.now();
    const expired=new Set(data.records.filter(r=>r.status==='pending' || r.capturedAt+data.settings.retentionMinutes*60_000<=now).map(r=>r.id));
    const keep=data.records.filter(r=>!expired.has(r.id)).sort((a,b)=>a.capturedAt-b.capturedAt);
    while(keep.length>data.settings.maxRecords-(room?1:0))expired.add(keep.shift()!.id);
    if(!expired.size)return;
    this.save(scope,next=>{for(const r of next.records)if(expired.has(r.id))r.status='pending';});
    for(const id of expired){
      try{await scope.api.delete(id,1);}catch{throw Error('cleanup_required');}
      this.save(scope,next=>{next.records=next.records.filter(r=>r.id!==id);});
      if(this.scope===scope && this.state.analysis && !this.state.records.length)this.state.analysis=null;
    }
    if(this.scope===scope)await this.imported();
  }
  private async cycle():Promise<void>{
    if(this.job){this.schedule(30_000);return;}
    const scope=this.scope;if(!scope || !this.state.available)return;
    const epoch=this.epoch;this.abort=new AbortController();const abort=this.abort;
    const live=()=>this.scope===scope && this.epoch===epoch && !abort.signal.aborted;
    const check=()=>{if(!live())throw Error('context_changed');};
    this.job=(async()=>{
      try{
        await this.cleanup(scope);check();
        if(!this.state.running)return;
        if(!this.permitted())throw Error('capture_denied');
        const settings=structuredClone(this.state.settings);
        const sources=await this.native.listSources();check();this.checkTargets(sources);if(!this.permitted())throw Error('capture_denied');
        const target=settings.targets[this.index++ % settings.targets.length]!;
        this.state.phase='capturing';this.emit();
        let frame:NativeCapturedFrame;
        try{frame=await this.native.capture(target.id,target.name,abort.signal);}catch(error){if(error instanceof Error && error.message==='capture_busy')return;throw error;}
        check();
        if(!Buffer.isBuffer(frame.jpeg) || !frame.jpeg.length || frame.jpeg.length>4*1024*1024
          || !Number.isInteger(frame.width) || frame.width<1 || frame.width>1600 || !Number.isInteger(frame.height) || frame.height<1 || frame.height>1600)throw Error('capture_limit');
        const hash=createHash('sha256').update(frame.jpeg).digest('hex');
        if(this.hashes.get(target.id)===hash)this.state.unchanged++;this.hashes.set(target.id,hash);this.state.captures++;
        const preview:ScreenPreview={id:'auto-'+randomUUID(),revision:1,title:[...target.name].slice(0,120).join(''),capturedAt:this.time.now(),
          width:frame.width,height:frame.height,boundary:settings.boundary,dataUrl:'data:image/jpeg;base64,'+frame.jpeg.toString('base64')};
        this.state.preview=preview;this.emit();
        const last=this.data(scope).lastAttemptAt;
        if(!settings.analysisEnabled || this.analyzed.get(target.id)===hash || last && this.time.now()-last<settings.analysisSeconds*1000)return;
        const model=scope.api.model(settings.modelId,settings.boundary);await this.cleanup(scope,true);check();
        const saved=await scope.api.list(abort.signal);check();if(saved.length>=32)throw Error('screen_limit');
        this.save(scope,data=>{data.lastAttemptAt=this.time.now();data.records.push({id:preview.id,capturedAt:preview.capturedAt,status:'pending'});});
        check();this.state.phase='analyzing';this.emit();
        try{
          const source=await scope.api.upload(preview,frame.jpeg,abort.signal);check();
          const analysis=await scope.api.analyze(preview,source,model,settings.prompt,abort.signal,true);check();
          this.save(scope,data=>{const record=data.records.find(r=>r.id===preview.id);if(!record)throw Error('storage_unavailable');record.status='saved';});
          this.analyzed.set(target.id,hash);this.state.analysis=analysis;await this.imported();check();
        }catch(error){
          try{await scope.api.delete(preview.id,1);this.save(scope,data=>{data.records=data.records.filter(r=>r.id!==preview.id);});}
          catch{if(live())throw Error('cleanup_required');}
          throw error;
        }
      }catch(error){if(live()){this.pause(code(error));}}
      finally{
        if(this.scope===scope){this.state.phase=this.state.running?'waiting':'paused';this.emit();}
      }
    })();
    try{await this.job;}finally{this.job=null;if(this.abort===abort)this.abort=null;this.schedule(this.state.running?this.state.settings.collectionSeconds*1000:30_000);}
  }
}
