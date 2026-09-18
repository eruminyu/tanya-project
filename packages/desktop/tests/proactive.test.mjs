import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProactiveController } from '../dist-electron/main/proactive/proactive-controller.js';
import { ProactiveStore } from '../dist-electron/main/proactive/proactive-store.js';
const identity={instance_id:'test',mode:'personal',principal_id:'owner'};
const memory={source_id:'memory-one',revision:1,title:'발표 기억',kind:'memory',fingerprint:'a'.repeat(64)};
const model={provider_id:'ollama',model_id:'fixture',endpoint_id:'local'};
function fixture(){
 let now=1_800_000_000_000, timer;
 const root=mkdtempSync(join(tmpdir(),'kirian-proactive-')),store=new ProactiveStore(root),calls=[];
 const api={candidates:async()=>({generation:0,sources:[memory]}),generate:async(s,id,attempt,signal)=>{
  calls.push({s,id,attempt,signal});return {suggestion:{text:'발표를 준비해 볼까요?',quote:'발표 준비',source_id:memory.source_id,revision:1,title:memory.title},actual_model:model,routing_reason:'request_fixed',generation:0};}};
 const calendar={read:async()=>[]};
 const controller=new ProactiveController(store,()=>{},()=>true,{now:()=>now,setTimer:f=>{timer=f;return 1;},clearTimer:()=>{timer=null;}});
 controller.setConnection(1,identity,api,calendar);
 const configure=(changes={})=>controller.configure({revision:controller.snapshot().revision,settings:{...controller.snapshot().settings,enabled:true,memorySourceIds:['memory-one'],...changes}});
 const step=async(ms=60000)=>{now+=ms;const work=timer;timer=null;if(work)await work();};
 return {controller,api,calendar,calls,store,root,configure,step,now:()=>now};
}
test('기본 OFF, 명시 시작, 정지는 내용 제거, 연결/재시작 자동 재개 없음',async()=>{
 const f=fixture();await f.step();assert.equal(f.calls.length,0);assert.equal(f.controller.snapshot().settings.enabled,false);
 f.configure();f.controller.start();await f.step();assert.equal(f.calls.length,1);assert.equal(f.controller.snapshot().cards.length,1);
 f.controller.pause();assert.equal(f.controller.snapshot().cards.length,0);await f.step();assert.equal(f.calls.length,1);
 f.controller.setConnection(2,identity,f.api,f.calendar);await f.step();assert.equal(f.controller.snapshot().running,false);
 assert.ok(!readFileSync(join(f.root,readdirSync(f.root)[0]),'utf8').includes('발표 준비'));
});
test('동일 내용의 새 화면 ID, 실패, 재시작도 중복 호출을 만들지 않음',async()=>{
 const f=fixture();f.configure({screenAnalyses:true,memorySourceIds:[]});
 f.api.candidates=async()=>({generation:0,sources:[{...memory,source_id:'screen-first',kind:'screen'}]});
 f.api.generate=async()=>{f.calls.push(1);throw Error('provider_unavailable');};
 f.controller.start();await f.step();f.controller.start();
 f.api.candidates=async()=>({generation:0,sources:[{...memory,source_id:'screen-next',kind:'screen'}]});
 await f.step(3600000);assert.equal(f.calls.length,1);
 f.controller.setConnection(2,identity,f.api,f.calendar);f.controller.start();await f.step(3600000);assert.equal(f.calls.length,1);
});
test('화면 파생 기억은 선택 ID에 있어도 화면 허용 OFF면 사용하지 않음',async()=>{
 const f=fixture();f.api.candidates=async()=>({generation:0,sources:[{...memory,kind:'screen'}]});
 f.configure();f.controller.start();await f.step();assert.equal(f.calls.length,0);
});
test('생성 중 정지는 signal 취소하고 늦은 응답 폐기, 생성 시도는 유지',async()=>{
 const f=fixture();let release,signal;
 f.api.generate=async(s,id,attempt,sig)=>{signal=sig;await new Promise(r=>release=r);return {suggestion:null,actual_model:model,routing_reason:'request_fixed',generation:0};};
 f.configure();f.controller.start();const pending=f.step();await new Promise(setImmediate);f.controller.pause();
 assert.equal(signal.aborted,true);release();await pending;assert.equal(f.controller.snapshot().cards.length,0);
 assert.equal(f.controller.snapshot().attemptsToday,1);
});
test('일별/간격 제한과 시계 역행은 설정 변경으로 초기화되지 않음',async()=>{
 const f=fixture();f.configure({dailyLimit:1});f.controller.start();await f.step();
 f.api.candidates=async()=>({generation:0,sources:[{...memory,fingerprint:'b'.repeat(64)}]});
 f.configure({dailyLimit:1});f.controller.start();await f.step(-1000);await f.step(3600000);assert.equal(f.calls.length,1);
});
test('거절 뒤 재개와 근거 철회에서 표시 내용이 돌아오지 않음',async()=>{
 const f=fixture();f.configure();f.controller.start();await f.step();
 f.controller.dismiss(f.controller.snapshot().cards[0].id);assert.equal(f.controller.snapshot().cards.length,0);
 await f.step(3600000);assert.equal(f.calls.length,1);
 f.controller.invalidateSources();assert.equal(f.controller.snapshot().cards.length,0);
});
test('선택 일정만 실제 조회, 종일/진행 중 제외, 임박 제안은 모델 호출 없음',async()=>{
 const f=fixture(),reads=[];
 f.calendar.read=async(settings,signal)=>{reads.push(settings);return [
  {id:'soon',summary:'발표',start:{dateTime:new Date(f.now()+600000).toISOString()}},
  {id:'all-day',summary:'종일',start:{date:'2027-01-15'}},
  {id:'past',summary:'진행 중',start:{dateTime:new Date(f.now()-1000).toISOString()}}];};
 f.configure({memorySourceIds:[],calendar:{connectionId:'google-one',calendarId:'primary'}});f.controller.start();await f.step();
 assert.equal(reads[0].calendarId,'primary');assert.equal(f.controller.snapshot().cards.length,1);assert.equal(f.calls.length,0);
 assert.equal(f.controller.snapshot().cards[0].kind,'calendar');
});
test('일정 조회 도중 정지는 해당 요청만 취소하고 수동 연결을 건드리지 않음',async()=>{
 const f=fixture();let signal,release;
 f.calendar.read=async(s,sig)=>{signal=sig;await new Promise(r=>release=r);return [];};
 f.configure({memorySourceIds:[],calendar:{connectionId:'google-one',calendarId:'primary'}});f.controller.start();
 const pending=f.step();await new Promise(setImmediate);f.controller.pause();assert.equal(signal.aborted,true);release();await pending;
 assert.equal(f.controller.snapshot().cards.length,0);
});
test('오늘 기록이 가득 차도 기존 억제·횟수를 지워 재호출하지 않음',async()=>{
 const f=fixture();f.configure();const data=f.store.read(identity);data.seen=Array.from({length:512},(_,i)=>({hash:i.toString(16).padStart(64,'0'),at:f.now()}));f.store.write(identity,data);
 f.controller.start();await f.step();assert.equal(f.calls.length,0);assert.equal(f.controller.snapshot().reason,'ledger_full');
 assert.equal(f.store.read(identity).seen.length,512);
});
test('생성 완료 직전 근거 세대 변경은 표시를 차단',async()=>{
 const f=fixture();let count=0;f.api.candidates=async()=>({generation:count++,sources:[memory]});
 f.configure();f.controller.start();await f.step();assert.equal(f.calls.length,1);assert.equal(f.controller.snapshot().cards.length,0);assert.equal(f.controller.snapshot().reason,'source_changed');
});
test('다른 identity와 공개 모드는 이전 설정이나 제안을 상속하지 않음',async()=>{
 const f=fixture();f.configure();f.controller.start();await f.step();
 f.controller.setConnection(2,{...identity,principal_id:'other'},f.api,f.calendar);assert.equal(f.controller.snapshot().settings.enabled,false);assert.equal(f.controller.snapshot().cards.length,0);
 f.controller.setConnection(3,{...identity,mode:'public_demo'},f.api,f.calendar);assert.equal(f.controller.snapshot().available,false);
});
test('무관한 외부 상태 변경은 기억 제안 요청을 취소하지 않음',async()=>{
 const f=fixture();let release,signal;const generate=f.api.generate;
 f.api.generate=async(...args)=>{signal=args[3];await new Promise(r=>release=r);return generate(...args);};
 f.configure();f.controller.start();const pending=f.step();await new Promise(setImmediate);f.controller.invalidateCalendar();
 assert.equal(signal.aborted,false);release();await pending;assert.equal(f.controller.snapshot().cards.length,1);
});
test('빈칸 배열에 추가 속성을 붙여도 설정 저장과 기존 원장을 손상시키지 않음',()=>{
 const f=fixture();f.configure();const before=f.store.read(identity);
 assert.throws(()=>f.configure({memorySourceIds:Object.assign(Array(1),{extra:'x'})}),/invalid_request/);
 assert.deepEqual(f.store.read(identity),before);
});
