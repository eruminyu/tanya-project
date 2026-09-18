import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoScreenController } from '../dist-electron/main/screens/auto-screen-controller.js';
import { AutoScreenStore } from '../dist-electron/main/screens/auto-screen-store.js';

const identity = {instance_id:'personal-one', mode:'personal', principal_id:'owner'};
const target = {id:'window:42:0', name:'테스트 창', kind:'window'};
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
function fixture() {
  let now=1_800_000_000_000, timer;
  const root=mkdtempSync(join(tmpdir(),'kirian-auto-screen-')), store=new AutoScreenStore(root);
  const calls={capture:0,upload:[],analyze:[],delete:[]};
  const native={listSources:async()=>[target], capture:async()=>{
    calls.capture++; return {jpeg:Buffer.from([255,216,255,217,calls.capture]),width:1,height:1};
  }};
  const api={model:()=>({provider_id:'ollama',model_id:'vision',endpoint_id:'local'}),
    list:async()=>[], upload:async(p)=>{calls.upload.push(p.id);return 'source-'+p.id;},
    analyze:async(p,s,m,q,signal,background)=>{calls.analyze.push({id:p.id,background});return {sourceId:'analysis-'+p.id,text:'테스트 설명',actualModel:m};},
    delete:async(id)=>{calls.delete.push(id);}};
  const controller=new AutoScreenController(native,store,()=>{},()=>{}, {
    now:()=>now,setTimer:(callback)=>{timer=callback;return 1;},clearTimer:()=>{timer=undefined;}
  });
  controller.setConnection(1,identity,api);
  const step=async(ms=30_000)=>{now+=ms;const callback=timer;timer=undefined;if(callback)await callback();};
  const configure=(updates={})=>controller.configure({revision:controller.snapshot().revision,settings:{...controller.snapshot().settings,enabled:true,targets:[target],...updates}});
  const start=()=>controller.start({revision:controller.snapshot().revision});
  return {root,store,native,api,calls,controller,step,configure,start};
}
test('기본 OFF, 수집과 분석 별도 동의, 재시작은 명시 재개 필요',async()=>{
  const f=fixture();assert.equal(f.controller.snapshot().settings.enabled,false);
  await f.step();assert.equal(f.calls.capture,0);
  await f.configure();await f.start();await f.step();
  assert.equal(f.calls.capture,1);assert.equal(f.calls.upload.length,0);
  assert.ok(f.controller.snapshot().preview.dataUrl);
  f.controller.setConnection(2,identity,f.api);await f.step();
  assert.equal(f.calls.capture,1);assert.equal(f.controller.snapshot().preview,null);
  assert.equal(f.controller.snapshot().running,false);
  assert.ok(!readFileSync(join(f.root,readdirSync(f.root)[0]),'utf8').includes('base64'));
});
test('변경 감지와 별도 분석 간격은 고정 모델에서도 background 경로를 사용',async()=>{
  const f=fixture();await f.configure({analysisEnabled:true,modelId:'fixed',analysisSeconds:60});await f.start();
  await f.step();await f.step();assert.equal(f.calls.analyze.length,1);
  await f.step();assert.equal(f.calls.analyze.length,2);assert.ok(f.calls.analyze.every(a=>a.background===true));
  f.native.capture=async()=>({jpeg:Buffer.from([255,216,255,217,3]),width:1,height:1});
  await f.step(60_000);assert.equal(f.calls.analyze.length,2);
});
test('업로드 도중 정지는 픽셀을 즉시 해제하고 늦은 결과를 같은 ID로 삭제',async()=>{
  const f=fixture(),wait=deferred();let uploaded;
  f.api.upload=async(p)=>{uploaded=p.id;await wait.promise;return 'source';};
  await f.configure({analysisEnabled:true,modelId:'fixed'});await f.start();
  const work=f.step();await new Promise(setImmediate);
  f.controller.pause('locked');assert.equal(f.controller.snapshot().preview,null);
  wait.resolve();await work;
  assert.deepEqual(f.calls.delete,[uploaded]);assert.equal(f.calls.analyze.length,0);
  assert.equal(f.store.read(identity).records.length,0);
});
test('삭제 실패는 journal에 남고 새 연결에서 동일 ID만 정리하며 자동 재개 안 함',async()=>{
  const f=fixture(),wait=deferred();let id;
  f.api.upload=async(p)=>{id=p.id;await wait.promise;return 'source';};
  f.api.delete=async()=>{throw Error('offline');};
  await f.configure({analysisEnabled:true,modelId:'fixed'});await f.start();
  const work=f.step();await new Promise(setImmediate);f.controller.pause('suspended');wait.resolve();await work;
  assert.equal(f.store.read(identity).records[0].status,'pending');
  f.api.delete=async(id)=>f.calls.delete.push(id);
  f.controller.setConnection(2,identity,f.api);await f.step();
  assert.deepEqual(f.calls.delete,[id]);assert.equal(f.controller.snapshot().running,false);
});
test('identity 전환의 늦은 작업은 새 계정의 API나 원장을 건드리지 않음',async()=>{
  const f=fixture(),wait=deferred();f.api.upload=async()=>{await wait.promise;return 'source';};
  await f.configure({analysisEnabled:true,modelId:'fixed'});await f.start();
  const work=f.step();await new Promise(setImmediate);
  let otherDelete=0;const other={...identity,principal_id:'other'};
  f.controller.setConnection(2,other,{...f.api,delete:async()=>otherDelete++});
  wait.resolve();await work;
  assert.equal(otherDelete,0);assert.equal(f.store.read(other).records.length,0);
  assert.equal(f.controller.snapshot().settings.enabled,false);
});
test('허용 창 변경과 제외된 대상은 수집 전에 차단하고 임의로 재선택 안 함',async()=>{
  const f=fixture();await f.configure();await f.start();
  f.native.listSources=async()=>[{...target,name:'다른 창'}];await f.step();
  assert.equal(f.calls.capture,0);assert.equal(f.controller.snapshot().running,false);
  await assert.rejects(f.configure({excludedIds:[target.id]}));
  await assert.rejects(f.configure({targets:[{id:'screen:0:0',name:'전체',kind:'screen'}]}));
});
test('보존은 자동 원장 기록만 삭제하며 수동 기록은 보존',async()=>{
  const f=fixture();f.api.list=async()=>[{captureId:'manual-record'}];
  await f.configure({analysisEnabled:true,modelId:'fixed',maxRecords:1});await f.start();
  await f.step();const first=f.calls.upload[0];await f.step(60_000);
  assert.deepEqual(f.calls.delete,[first]);assert.equal(f.store.read(identity).records.length,1);
  assert.ok(!f.calls.delete.includes('manual-record'));
  f.controller.pause();await f.controller.clearRecords();assert.equal(f.store.read(identity).records.length,0);
});
test('저장 실패와 수동 화면 용량 포화에서는 새 업로드하지 않음',async()=>{
  const f=fixture();await f.configure({analysisEnabled:true,modelId:'fixed'});await f.start();
  f.api.list=async()=>Array.from({length:32},(_,i)=>({captureId:'manual-'+i}));
  await f.step();assert.equal(f.calls.upload.length,0);assert.equal(f.controller.snapshot().running,false);
  const g=fixture();await g.configure({analysisEnabled:true,modelId:'fixed'});await g.start();
  g.store.write=()=>{throw Error('disk_full');};await g.step();assert.equal(g.calls.upload.length,0);
});
test('손상된 저장 내용은 덮어쓰지 않고 기능 차단',()=>{
  const f=fixture();f.store.write(identity,f.store.read(identity));const file=join(f.root,readdirSync(f.root)[0]);
  writeFileSync(file,'{broken');f.controller.setConnection(2,identity,f.api);
  assert.equal(f.controller.snapshot().available,false);assert.equal(readFileSync(file,'utf8'),'{broken');
});
test('과도한 ID와 배열 빈칸으로 정상 원장을 다시 읽을 수 없게 만들지 못함',async()=>{
  for(const excludedIds of [['window:'+'1'.repeat(70_000)+':0'],Array(1)]){
    const f=fixture();await f.configure();const before=f.store.read(identity);
    await assert.rejects(f.configure({excludedIds}));assert.deepEqual(f.store.read(identity),before);
  }
});
test('재개·재연결로 분석 대기 시간을 초기화하지 못하고 수동 캡처 busy는 건너뜀',async()=>{
  const f=fixture();await f.configure({analysisEnabled:true,modelId:'fixed'});await f.start();await f.step();
  f.controller.pause();f.controller.setConnection(2,identity,f.api);await f.start();await f.step(10_000);
  assert.equal(f.calls.analyze.length,1);
  f.native.capture=async()=>{throw Error('capture_busy');};await f.step();assert.equal(f.controller.snapshot().running,true);
  f.controller.pause();await f.step(3_600_000);assert.equal(f.store.read(identity).records.length,0);
});
test('분석 제공자 실패 원인을 보존하고 업로드한 자동 기록을 정리',async()=>{
  const f=fixture();f.api.analyze=async()=>{throw Error('provider_error');};
  await f.configure({analysisEnabled:true,modelId:'fixed'});await f.start();await f.step();
  assert.equal(f.controller.snapshot().reason,'provider_error');assert.equal(f.controller.snapshot().running,false);
  assert.equal(f.store.read(identity).records.length,0);assert.deepEqual(f.calls.delete,f.calls.upload);
});
test('대상 확인 대기 중 OFF 명령은 늦은 재개를 무효화',async()=>{
  const f=fixture(),wait=deferred();await f.configure();f.native.listSources=()=>wait.promise;
  const starting=f.start();await f.controller.disable();wait.resolve([target]);await assert.rejects(starting);
  await f.step();assert.equal(f.controller.snapshot().running,false);assert.equal(f.calls.capture,0);
});

test('긴 이모지 창 제목도 Unicode 문자 경계를 보존해 분석으로 전달한다',async()=>{
  const f=fixture(), named={...target,name:'가'.repeat(119)+'🙂 뒤의 창 제목'};
  f.native.listSources=async()=>[named];
  let uploadedTitle;
  f.api.upload=async(preview)=>{
    uploadedTitle=preview.title;
    // The real Brain upload route rejects a title containing a lone surrogate.
    assert.equal(uploadedTitle.isWellFormed(),true);
    return 'source';
  };
  await f.configure({targets:[named],analysisEnabled:true,modelId:'fixed'});await f.start();await f.step();
  assert.equal(uploadedTitle,'가'.repeat(119)+'🙂');
  assert.equal(f.calls.analyze.length,1);assert.equal(f.controller.snapshot().running,true);
});
