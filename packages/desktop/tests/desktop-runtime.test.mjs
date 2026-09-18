import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopRuntime} from '../dist-electron/main/runtime/desktop-runtime.js';
const host=label=>({identity:{instance_id:'personal-v1',mode:'personal',principal_id:'owner'},bindings:[{model:{provider_id:'ollama',model_id:'fixture',endpoint_id:'local'},label,kind:'ollama',url:'http://127.0.0.1:11434',boundary:'local'}]});
function fixture(){const directory=mkdtempSync(join(tmpdir(),'kirian-runtime-')),calls=[],workers=[],hooks={};
 const runtime=new DesktopRuntime({directory,executable:'bundled.exe',available:true,version:'0.1.0',changed:()=>hooks.changed?.(runtime),
  connect:async o=>{calls.push(['connect',o]);hooks.connected?.();return {ok:true};},disconnect:()=>{calls.push(['disconnect']);},
  createProcess:exited=>{const worker={start:async path=>{calls.push(['start',path]);if(hooks.start)return hooks.start();return {url:'http://127.0.0.1:1234',token:'secret'};},
   stop:async()=>{calls.push(['stop']);},validate:async()=>{if(hooks.invalid)throw Error('secret failure');},exited};workers.push(worker);return worker;}});
 return {runtime,directory,calls,workers,hooks};}
test('기본 서비스 시작·실패·명시 복구는 자동 재시도 없이 데이터 보존',async()=>{
 const f=fixture();mkdirSync(join(f.directory,'brain'));writeFileSync(join(f.directory,'brain','retained'),'memory');
 await f.runtime.start();assert.equal(f.runtime.snapshot().phase,'ready');f.workers[0].exited();assert.equal(f.runtime.snapshot().phase,'error');
 assert.equal(f.calls.filter(c=>c[0]==='start').length,1);await f.runtime.start();assert.equal(f.runtime.snapshot().phase,'ready');
 assert.equal(readFileSync(join(f.directory,'brain','retained'),'utf8'),'memory');await f.runtime.stop();
});
test('설정 검증 실패 시 현재 서비스·현재 설정을 바꾸지 않음',async()=>{
 const f=fixture();await f.runtime.start();f.hooks.invalid=true;await f.runtime.configure(host('bad'));
 assert.equal(f.runtime.snapshot().phase,'ready');assert.equal(f.runtime.snapshot().reason,'invalid_config');
 assert.equal(f.calls.filter(c=>c[0]==='disconnect').length,1);await f.runtime.stop();
});
test('설정 적용/이전 복원은 같은 identity와 앱 소유 데이터 경로를 유지',async()=>{
 const f=fixture();await f.runtime.configure(host('first'));await f.runtime.configure(host('second'));await f.runtime.restore();
 const stored=JSON.parse(readFileSync(join(f.directory,'runtime','settings.json'),'utf8'));assert.equal(stored.host.bindings[0].label,'first');
 await f.runtime.configure({...host('changed'),identity:{instance_id:'other',mode:'personal',principal_id:'owner'}});
 assert.equal(f.runtime.snapshot().reason,'identity_changed');assert.equal(f.runtime.snapshot().phase,'ready');await f.runtime.stop();
});
test('시작 중 중단 및 외부 연결 전환에서 늦은 로컬 ready는 연결하지 않는다',async()=>{
 const f=fixture();let ready;f.hooks.start=()=>new Promise(resolve=>ready=resolve);const starting=f.runtime.start();await new Promise(resolve=>setImmediate(resolve));
 const stopping=f.runtime.stop();ready({url:'http://127.0.0.1:1234',token:'late'});await starting;await stopping;
 assert.equal(f.calls.filter(c=>c[0]==='connect').length,0);assert.equal(f.runtime.snapshot().phase,'stopped');
});
test('설정 검증 동안 권한이 바뀌면 저장·서비스 전환을 하지 않는다',async()=>{
 const f=fixture();let valid=true;await f.runtime.start();
 await f.runtime.configure(host('new'),()=>{valid=false;throw Error('renderer_changed');});
 assert.equal(valid,false);assert.equal(f.runtime.snapshot().phase,'ready');await f.runtime.stop();
});
test('임시 설정 정리 동안 서비스가 종료되면 ready로 덮지 않는다',async()=>{
 const f=fixture();f.hooks.connected=()=>setImmediate(()=>f.workers.at(-1).exited());
 await f.runtime.configure(host('race'));assert.equal(f.runtime.snapshot().phase,'error');await f.runtime.stop();
});
test('임시 설정 준비 중 중단하면 이후 spawn을 하지 않는다',async()=>{
 const f=fixture();await f.runtime.configure(host('stored'));await f.runtime.stop();f.calls.length=0;
 let stopping;f.hooks.changed=runtime=>{if(runtime.snapshot().phase==='starting'){f.hooks.changed=null;queueMicrotask(()=>{stopping=runtime.stop();});}};
 await f.runtime.start();await stopping;
 assert.equal(f.calls.filter(c=>c[0]==='start').length,0);assert.equal(f.runtime.snapshot().phase,'stopped');
});
