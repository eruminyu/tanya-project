import {spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';

type Options = {
  executable: string; dataDirectory: string; environment?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  request?: typeof fetch; timeoutMs?: number; stopTimeoutMs?: number; exited?: () => void;
};
type Active = {child:ChildProcessWithoutNullStreams; closed:Promise<void>; cancel:()=>void; stopped:boolean};
export class ManagedBrain {
  private active: Active | null = null;
  constructor(private readonly options: Options) {}
  private async launch(configPath?: string, validate = false): Promise<{url:string;token:string}> {
    if (this.active) throw Error('runtime_busy');
    const token = randomBytes(32).toString('hex');
    const environment = {...(this.options.environment ?? process.env)};
    for (const key of Object.keys(environment)) if (/^(KIRIAN_|PYTHON|ELECTRON_RUN_AS_NODE)/i.test(key)) delete environment[key];
    environment.KIRIAN_V1_DATA_DIR = this.options.dataDirectory;
    if (configPath) environment.KIRIAN_V1_CONFIG_FILE = configPath;
    let child: ChildProcessWithoutNullStreams;
    try { child = (this.options.spawn ?? spawn)(this.options.executable, validate ? ['--validate-config'] : [], {
      env:environment,cwd:dirname(this.options.executable),windowsHide:true,stdio:'pipe',shell:false,
    }); } catch { throw Error('runtime_unavailable'); }
    let close!:()=>void;
    const active: Active = {child,closed:new Promise(resolve => {close=resolve;}),cancel:()=>{},stopped:false};
    this.active = active;
    const abort = new AbortController();
    let authenticated = false;
    const ready = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('runtime_start_failed')), this.options.timeoutMs ?? 20000);
      let line = '', settled = false;
      const fail = () => { if (!settled) {settled=true;clearTimeout(timer);reject(Error('runtime_start_failed'));} };
      active.cancel = () => {abort.abort(); fail();};
      child.once('error', () => {close();fail();});
      child.once('exit', code => {
        close();
        if (validate && code === 0 && !active.stopped) {settled=true;clearTimeout(timer);resolve(0);}
        else fail();
        if (authenticated && !active.stopped) this.options.exited?.();
      });
      child.stdin.on('error', fail);
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || validate) return;
        line += chunk.toString('utf8');
        if (Buffer.byteLength(line) > 2048) {fail(); return;}
        if (!line.includes('\n')) return;
        try {
          const value = JSON.parse(line.trim());
          if (Object.keys(value).sort().join(',') !== 'port,type' || value.type !== 'ready' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error();
          settled=true;clearTimeout(timer);resolve(value.port);
        } catch {fail();}
      });
      child.stdin.write(JSON.stringify({token})+'\n');
    });
    try {
      const port = await ready;
      if (validate) return {url:'',token:''};
      if (active.stopped || child.exitCode !== null) throw Error();
      const url = 'http://127.0.0.1:' + port;
      const response = await (this.options.request ?? fetch)(url + '/v1/config', {
        headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)]),
      });
      await response.body?.cancel();
      if (!response.ok || active.stopped || child.exitCode !== null) throw Error();
      authenticated=true; return {url,token};
    } catch { await this.stop(); throw Error('runtime_start_failed'); }
    finally { if (validate) {await this.stop();} }
  }
  start(configPath?: string): Promise<{url:string;token:string}> { return this.launch(configPath); }
  async validate(configPath?: string): Promise<void> { await this.launch(configPath,true); }
  async stop(): Promise<void> {
    const active=this.active; if (!active) return;
    active.stopped=true;active.cancel();active.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([active.closed,new Promise<void>(resolve => {timer=setTimeout(resolve,this.options.stopTimeoutMs ?? 5000);})]);
    clearTimeout(timer);
    if (active.child.exitCode === null) {
      active.child.kill();
      await Promise.race([active.closed,new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);
    }
    if (this.active === active) this.active=null;
  }
}
