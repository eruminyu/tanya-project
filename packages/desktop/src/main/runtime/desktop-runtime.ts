import {mkdtemp, writeFile, unlink, rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {CommandResult} from '../../shared/bridge.js';
import type {RuntimeState} from '../../shared/runtime.js';
import {ManagedBrain} from './managed-brain.js';
import {RuntimeStore, type HostSettings, parseHostFile} from './runtime-store.js';

type Worker = Pick<ManagedBrain,'start'|'stop'|'validate'>;
type Options = {directory:string;executable:string;available:boolean;version:string;changed:()=>void;
  connect:(options:{url:string;token:string})=>Promise<CommandResult>;disconnect:()=>void;
  createProcess?:(exited:()=>void)=>Worker;};
const defaultIdentity = {instance_id:'personal-v1',mode:'personal',principal_id:'owner'};
const identity = (host: HostSettings | null) => {
  const value = (host?.identity ?? defaultIdentity) as Record<string,unknown>;
  return JSON.stringify([value.instance_id,value.mode,value.principal_id]);
};
export class DesktopRuntime {
  private readonly store: RuntimeStore;
  private worker: Worker | null = null;
  private validator: Worker | null = null;
  private busy = false;
  private generation = 0;
  private sequence = 0;
  private phase: RuntimeState['phase'] = 'stopped';
  private reason: string | null = null;
  private pending: Promise<unknown> | null = null;
  private stopping: Promise<void> | null = null;
  constructor(private readonly options: Options) {this.store = new RuntimeStore(join(options.directory,'runtime'));}
  snapshot(): RuntimeState {return {sequence:this.sequence,available:this.options.available,busy:this.busy,phase:this.phase,reason:this.reason,
    canRestore:this.store.canRestore(),version:this.options.version,dataDirectory:this.options.directory};}
  private changed():void {this.sequence++;this.options.changed();}
  private create(exited:()=>void):Worker {
    return this.options.createProcess?.(exited) ?? new ManagedBrain({executable:this.options.executable,dataDirectory:join(this.options.directory,'brain'),exited});
  }
  private async configFile<T>(host: HostSettings | null, use:(path?:string)=>Promise<T>):Promise<T> {
    if (host === null) return use();
    const directory=await mkdtemp(join(tmpdir(),'kirian-managed-')),path=join(directory,'host.json');
    try {await writeFile(path,JSON.stringify(host),{mode:0o600,flag:'wx'});return await use(path);}
    finally {await unlink(path).catch(()=>{});await rmdir(directory).catch(()=>{});}
  }
  private async run(operation:(generation:number)=>Promise<void>):Promise<RuntimeState> {
    if (!this.options.available) {this.reason='runtime_unavailable';this.changed();return this.snapshot();}
    if (this.busy || this.stopping) return {...this.snapshot(),reason:'runtime_busy'};
    this.busy=true;this.reason=null;const generation=++this.generation;this.changed();
    const pending=operation(generation);this.pending=pending;
    try {await pending;} catch(error) {
      if (generation===this.generation) this.reason=error instanceof Error && ['identity_changed','settings_unavailable','restore_unavailable','invalid_config','request_cancelled'].includes(error.message) ? error.message : 'runtime_start_failed';
    } finally {if(this.pending===pending)this.pending=null;if(generation===this.generation){this.busy=false;this.changed();}}
    return this.snapshot();
  }
  private check(generation:number,guard:()=>void):void {
    if(generation!==this.generation)throw Error('request_cancelled');
    try{guard();}catch{throw Error('request_cancelled');}
  }
  private async begin(host:HostSettings|null,generation:number,guard:()=>void):Promise<void> {
    this.check(generation,guard);this.options.disconnect();
    const old=this.worker;this.worker=null;await old?.stop();this.check(generation,guard);
    this.phase='starting';this.changed();
    let exited=false;
    const worker=this.create(()=>{
      exited=true;
      if(this.worker!==worker)return;this.options.disconnect();this.phase='error';this.reason='runtime_exited';this.changed();
    });this.worker=worker;
    try {
      await this.configFile(host,async path=>{
        this.check(generation,guard);
        const connection=await worker.start(path);this.check(generation,guard);
        const result=await this.options.connect(connection);this.check(generation,guard);
        if(!result.ok)throw Error('runtime_start_failed');
      });
      this.check(generation,guard);if(exited||this.worker!==worker)throw Error('runtime_start_failed');
      this.phase='ready';
    } catch(error) {
      await worker.stop();if(this.worker===worker){this.worker=null;this.options.disconnect();this.phase='error';}throw error;
    }
  }
  start(guard:()=>void=()=>{}):Promise<RuntimeState> {
    return this.run(async generation=>{let host:HostSettings|null;try{host=this.store.read();}catch{this.phase='error';throw Error('settings_unavailable');}
      await this.begin(host,generation,guard);});
  }
  configure(host:HostSettings,guard:()=>void=()=>{}):Promise<RuntimeState> {
    return this.run(async generation=>{
      let checked:HostSettings;try{checked=parseHostFile(JSON.stringify(host));}catch{throw Error('invalid_config');}
      let current:HostSettings|null;try{current=this.store.read();}catch{throw Error('settings_unavailable');}
      if(identity(current)!==identity(checked))throw Error('identity_changed');
      await this.validate(checked,generation,guard);this.check(generation,guard);
      try{this.store.save(checked);}catch{throw Error('settings_unavailable');}
      await this.begin(checked,generation,guard);
    });
  }
  restore(guard:()=>void=()=>{}):Promise<RuntimeState> {
    return this.run(async generation=>{
      let previous:HostSettings|null;try{previous=this.store.previous();}catch{throw Error('restore_unavailable');}
      await this.validate(previous,generation,guard);this.check(generation,guard);
      try{this.store.restore();}catch{throw Error('settings_unavailable');}
      await this.begin(previous,generation,guard);
    });
  }
  private async validate(host:HostSettings|null,generation:number,guard:()=>void):Promise<void> {
    const worker=this.create(()=>{});this.validator=worker;
    try{await this.configFile(host,path=>{this.check(generation,guard);return worker.validate(path);});}catch{throw Error('invalid_config');}
    finally{await worker.stop();if(this.validator===worker)this.validator=null;}
    this.check(generation,guard);
  }
  async stop():Promise<RuntimeState> {
    if(this.stopping){await this.stopping;return this.snapshot();}
    ++this.generation;this.busy=true;this.changed();this.options.disconnect();
    const worker=this.worker,validator=this.validator;this.worker=null;this.validator=null;
    const pending=this.pending;
    this.stopping=(async()=>{await Promise.all([worker?.stop(),validator?.stop()]);await pending?.catch(()=>{});
      this.phase='stopped';this.reason=null;this.busy=false;this.stopping=null;this.changed();})();
    await this.stopping;return this.snapshot();
  }
}
