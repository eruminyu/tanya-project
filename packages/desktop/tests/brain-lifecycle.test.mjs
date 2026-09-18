import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {BrainLifecycle} from '../dist-electron/main/brain-lifecycle.js';
import {DesktopRuntime} from '../dist-electron/main/runtime/desktop-runtime.js';
import {validateConnection} from '../dist-electron/main/brain-connection.js';

const external = {url:'https://brain.example.test/', token:'e'.repeat(48)};
const ok = {ok:true}, busy = {ok:false, code:'busy'};
const test = (name,run) => nodeTest(name,{timeout:5000},run);
const host = {identity:{instance_id:'personal-v1',mode:'personal',principal_id:'owner'},bindings:[{model:{provider_id:'ollama',model_id:'fixture',endpoint_id:'local'},
  label:'검사 설정',kind:'ollama',url:'http://127.0.0.1:11434',boundary:'local'}]};
function deferred() {let resolve;return {promise:new Promise(r=>resolve=r),resolve};}

function fixture(t,available=true) {
  const directory=mkdtempSync(join(tmpdir(),'kirian-lifecycle-'));
  const workers=[],connections=[],hooks={},releases=[];let credentials=null,connected=null,generation=0,reconnects=0;
  const brain={
    async connect(input) {
      let next;try{next=validateConnection(input);}catch{return {ok:false,code:'invalid_request'};}
      const current=++generation;credentials=next;connections.push(next);
      if(hooks.connect)await hooks.connect();
      if(current!==generation)return {ok:false,code:'brain_unavailable'};
      if(next.url!==external.url&&!workers.some(w=>w.running&&w.connection.url+'/'===next.url))return {ok:false,code:'connection_failed'};
      connected=next;return ok;
    },
    reconnect(){reconnects++;return credentials?this.connect(credentials):Promise.resolve({ok:false,code:'brain_unavailable'});},
    disconnect(){generation++;connected=null;return ok;},
  };
  const runtime=new DesktopRuntime({directory,executable:'fixture.exe',available,version:'test',changed:()=>{},
    connect:options=>brain.connect(options),disconnect:()=>{brain.disconnect();},
    createProcess:exited=>{
      const number=workers.length+1;
      const worker={running:false,connection:{url:'http://127.0.0.1:'+(30000+number),token:String(number).repeat(48)},
        async start(){if(hooks.start)await hooks.start();if(hooks.failStart)throw Error('fixture failure');this.running=true;return this.connection;},
        async stop(){this.running=false;if(hooks.stop)await hooks.stop();},
        async validate(){if(hooks.invalid)throw Error('fixture invalid');},
        exit(){this.running=false;exited();},
      };workers.push(worker);return worker;
    }});
  const lifecycle=new BrainLifecycle(brain,runtime);
  t.after(async()=>{for(const release of releases)release();delete hooks.stop;delete hooks.start;delete hooks.connect;await lifecycle.shutdown();rmSync(directory,{recursive:true,force:true});});
  return {lifecycle,runtime,brain,workers,connections,hooks,directory,gate(){const gate=deferred();releases.push(gate.resolve);return gate;},
    get connected(){return connected;},get reconnects(){return reconnects;}};
}

test('내장 연결 해제 뒤에는 새 프로세스의 주소와 토큰으로 연결하고 저장 자료를 보존한다',async t=>{
  const f=fixture(t);await f.lifecycle.runtimeCommand(()=>f.runtime.configure(host));
  mkdirSync(join(f.directory,'brain'));writeFileSync(join(f.directory,'brain','retained'),'보존 자료');
  const settings=readFileSync(join(f.directory,'runtime','settings.json'),'utf8'),old=f.connected;
  assert.deepEqual(await f.lifecycle.disconnect(),ok);assert.equal(f.connected,null);
  assert.equal(f.workers.filter(w=>w.running).length,0);
  assert.deepEqual(await f.lifecycle.reconnect(),ok);
  assert.equal(f.runtime.snapshot().phase,'ready');assert.notEqual(f.connected.url,old.url);assert.notEqual(f.connected.token,old.token);
  assert.equal(f.reconnects,0);assert.equal(f.workers.filter(w=>w.running).length,1);
  assert.equal(readFileSync(join(f.directory,'runtime','settings.json'),'utf8'),settings);
  assert.equal(readFileSync(join(f.directory,'brain','retained'),'utf8'),'보존 자료');
});

test('살아 있는 내장 Brain은 프로세스를 바꾸지 않고 연결만 다시 연다',async t=>{
  const f=fixture(t);await f.lifecycle.start();const old=f.connected;
  assert.deepEqual(await f.lifecycle.reconnect(),ok);assert.deepEqual(f.connected,old);
  assert.equal(f.workers.length,1);assert.equal(f.reconnects,1);
});

test('내장 Brain 비정상 종료와 최초 시작 실패 후 명시 재연결은 다시 시작한다',async t=>{
  const f=fixture(t);f.hooks.failStart=true;await f.lifecycle.start();assert.equal(f.runtime.snapshot().phase,'error');
  delete f.hooks.failStart;assert.deepEqual(await f.lifecycle.reconnect(),ok);
  f.workers.at(-1).exit();assert.equal(f.runtime.snapshot().phase,'error');
  assert.deepEqual(await f.lifecycle.reconnect(),ok);assert.equal(f.reconnects,0);
});

test('내장 시작 실패는 성공으로 반환하지 않고 다음 명시 재시도를 허용한다',async t=>{
  const f=fixture(t);await f.lifecycle.start();await f.lifecycle.disconnect();f.hooks.failStart=true;
  assert.deepEqual(await f.lifecycle.reconnect(),{ok:false,code:'connection_failed'});
  assert.equal(f.workers.filter(w=>w.running).length,0);
  delete f.hooks.failStart;assert.deepEqual(await f.lifecycle.reconnect(),ok);
});

test('외부 연결과 내장→외부 전환은 해제 후에도 외부 주소를 사용한다',async t=>{
  for(const embeddedFirst of [false,true]) {
    const f=fixture(t);if(embeddedFirst)await f.lifecycle.start();
    assert.deepEqual(await f.lifecycle.connectExternal(external),ok);const count=f.workers.length;
    for(let i=0;i<2;i++){
      await f.lifecycle.disconnect();assert.deepEqual(await f.lifecycle.reconnect(),ok);
      assert.deepEqual(f.connected,external);assert.equal(f.workers.length,count);
    }
    assert.equal(f.workers.filter(w=>w.running).length,0);
  }
});

test('외부→내장 시작과 설정 적용 후 재연결은 내장 소유권을 따른다',async t=>{
  for(const configure of [false,true]) {
    const f=fixture(t);await f.lifecycle.connectExternal(external);
    if(configure)await f.lifecycle.runtimeCommand(()=>f.runtime.configure(host));else await f.lifecycle.start();
    await f.lifecycle.disconnect();assert.deepEqual(await f.lifecycle.reconnect(),ok);
    assert.notEqual(f.connected.url,external.url);assert.equal(f.reconnects,0);
  }
});

test('외부에서 내장 설정 적용 후 시작이 실패해도 재연결은 내장을 다시 시작한다',async t=>{
  const f=fixture(t);await f.lifecycle.connectExternal(external);f.hooks.failStart=true;
  const state=await f.lifecycle.runtimeCommand(()=>f.runtime.configure(host));assert.equal(state.phase,'error');
  delete f.hooks.failStart;assert.deepEqual(await f.lifecycle.reconnect(),ok);
  assert.equal(f.runtime.snapshot().phase,'ready');assert.notEqual(f.connected.url,external.url);
});

test('잘못된 외부 입력과 실패한 설정 검증은 기존 연결 소유권을 바꾸지 않는다',async t=>{
  const f=fixture(t);await f.lifecycle.start();
  assert.deepEqual(await f.lifecycle.connectExternal({url:external.url,token:'bad'}),{ok:false,code:'invalid_request'});
  await f.lifecycle.disconnect();assert.deepEqual(await f.lifecycle.reconnect(),ok);assert.equal(f.reconnects,0);
  await f.lifecycle.connectExternal(external);f.hooks.invalid=true;
  await f.lifecycle.runtimeCommand(()=>f.runtime.configure(host));await f.lifecycle.disconnect();
  assert.deepEqual(await f.lifecycle.reconnect(),ok);assert.deepEqual(f.connected,external);
});

test('연결 이력이 없으면 재연결로 내장 서비스를 임의 시작하지 않는다',async t=>{
  const f=fixture(t);assert.deepEqual(await f.lifecycle.reconnect(),{ok:false,code:'brain_unavailable'});assert.equal(f.workers.length,0);
});

test('내장 실행이 제공되지 않는 개발 앱에서는 외부 재연결을 유지한다',async t=>{
  const f=fixture(t,false);await f.lifecycle.connectExternal(external);
  assert.equal((await f.lifecycle.start()).reason,'runtime_unavailable');await f.lifecycle.disconnect();
  assert.deepEqual(await f.lifecycle.reconnect(),ok);assert.deepEqual(f.connected,external);assert.equal(f.workers.length,0);
});

test('재연결 중 중복 연결·해제·서비스 명령은 busy로 끝나고 새 작업을 예약하지 않는다',async t=>{
  for(const embedded of [false,true]) {
    const f=fixture(t);if(embedded){await f.lifecycle.start();await f.lifecycle.disconnect();}else await f.lifecycle.connectExternal(external);
    const gate=f.gate();if(embedded)f.hooks.start=()=>gate.promise;else f.hooks.connect=()=>gate.promise;
    const reconnecting=f.lifecycle.reconnect();await tick();
    assert.deepEqual(await f.lifecycle.reconnect(),busy);assert.deepEqual(await f.lifecycle.disconnect(),busy);
    assert.deepEqual(await f.lifecycle.connectExternal(external),busy);assert.equal((await f.lifecycle.start()).reason,'runtime_busy');
    let called=false;assert.equal((await f.lifecycle.runtimeCommand(async()=>{called=true;return f.runtime.snapshot();})).reason,'runtime_busy');assert.equal(called,false);
    gate.resolve();assert.deepEqual(await reconnecting,ok);assert.equal(f.workers.filter(w=>w.running).length,embedded?1:0);
  }
});

test('동시 해제는 한 번만 수행하고 완료 뒤 재연결한다',async t=>{
  const f=fixture(t);await f.lifecycle.start();const gate=f.gate();f.hooks.stop=()=>gate.promise;
  const disconnecting=f.lifecycle.disconnect();assert.deepEqual(await f.lifecycle.disconnect(),busy);assert.deepEqual(await f.lifecycle.reconnect(),busy);
  gate.resolve();await disconnecting;delete f.hooks.stop;assert.deepEqual(await f.lifecycle.reconnect(),ok);
});

test('내장 재시작 중 종료하면 늦은 ready가 연결되지 않고 이후 명령도 차단한다',async t=>{
  const f=fixture(t);await f.lifecycle.start();await f.lifecycle.disconnect();const count=f.connections.length,gate=f.gate();f.hooks.start=()=>gate.promise;
  const reconnecting=f.lifecycle.reconnect();await tick();const quitting=f.lifecycle.shutdown();gate.resolve();
  assert.equal((await reconnecting).ok,false);await quitting;await f.lifecycle.shutdown();
  assert.equal(f.connections.length,count);assert.equal(f.connected,null);assert.equal(f.workers.filter(w=>w.running).length,0);
  assert.equal((await f.lifecycle.reconnect()).ok,false);assert.equal((await f.lifecycle.connectExternal(external)).ok,false);
  assert.equal((await f.lifecycle.start()).phase,'stopped');
});

test('외부 전환 중 종료하면 stop 뒤 외부 연결을 시작하지 않는다',async t=>{
  const f=fixture(t);await f.lifecycle.start();const count=f.connections.length,gate=f.gate();f.hooks.stop=()=>gate.promise;
  const connecting=f.lifecycle.connectExternal(external);const quitting=f.lifecycle.shutdown();gate.resolve();
  assert.equal((await connecting).ok,false);await quitting;assert.equal(f.connections.length,count);assert.equal(f.connected,null);
});

test('외부 재연결 중 종료하면 늦은 완료로 연결 상태가 살아나지 않는다',async t=>{
  const f=fixture(t);await f.lifecycle.connectExternal(external);const gate=f.gate();f.hooks.connect=()=>gate.promise;
  const reconnecting=f.lifecycle.reconnect();await tick();await f.lifecycle.shutdown();gate.resolve();
  assert.equal((await reconnecting).ok,false);assert.equal(f.connected,null);
});

test('내장 재시작 대기 중 창 권한이 바뀌면 새 프로세스를 정리하고 연결하지 않는다',async t=>{
  const f=fixture(t);await f.lifecycle.start();await f.lifecycle.disconnect();const count=f.connections.length,gate=f.gate();let allowed=true;
  f.hooks.start=()=>gate.promise;const reconnecting=f.lifecycle.reconnect(()=>{if(!allowed)throw Error('request_cancelled');});
  await tick();allowed=false;gate.resolve();assert.equal((await reconnecting).ok,false);
  assert.equal(f.connections.length,count);assert.equal(f.workers.filter(w=>w.running).length,0);
});
