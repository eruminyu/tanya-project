import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const {outputFiles} = await build({stdin:{contents:`export * from './src/main/external/external-executor.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',packages:'external',plugins:[{name:'contracts',setup(api){api.onResolve({filter:/^@kirian\/contracts$/},()=>({path:import.meta.resolve('@kirian/contracts'),external:true}));}}]});
const {ExternalExecutor, canonicalJson} = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const identity={instance_id:'external-test',mode:'personal',principal_id:'owner'};
const select=d=>({draftId:d.draftId,revision:d.revision,payloadSha256:d.payloadSha256});
const result={status:'succeeded',operationId:'fixture-operation',errorCode:null,resultJson:'{"ok":true}'};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function fixture(t,options={}) {
 const root=mkdtempSync(join(tmpdir(),'kirian-external-executor-'));t.after(()=>{
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('kirian-external-executor-'));
  rmSync(root,{recursive:true,force:true});
 });
 let current=true,calls=0;
 const plan={providerId:'mcp',connectionId:'connection-1',generation:'generation-1',fingerprint:'a'.repeat(64),accountId:'server-1',label:'격리 서버',target:'stdio:fixture',operation:'tool-call',effect:'untrusted',payload:{name:'write',arguments:{text:'검토한 내용'}}};
 const binding={current:()=>current,execute:async(p,id,signal,guard)=>{guard();calls++;assert.equal(JSON.parse(readFileSync(join(root,'executions.json'),'utf8')).ledger.claims[0].state,'running');return result;},reconcile:async()=>result};
 const executor=new ExternalExecutor(root,identity,p=>p.connectionId===plan.connectionId?binding:undefined,options);await executor.initialize();
 return {root,plan,binding,executor,calls:()=>calls,revoke:()=>{current=false;}};
}
test('정확한 payload 승인과 영속 claim 뒤에만 실행하고 중복 승인은 차단한다',async t=>{
 const f=await fixture(t);const d=await f.executor.preview(f.plan);assert.equal(f.calls(),0);
 await assert.rejects(f.executor.approve({...select(d),payloadSha256:'b'.repeat(64)}),/stale/);
 const both=await Promise.allSettled([f.executor.approve(select(d)),f.executor.approve(select(d))]);
 assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls(),1);assert.equal(f.executor.list()[0].status,'succeeded');
 const recovered=new ExternalExecutor(f.root,identity,()=>f.binding);await recovered.initialize();
 await assert.rejects(recovered.approve(select(d)),/decided/);assert.equal(recovered.list()[0].status,'succeeded');
});
test('연결 해제와 renderer 문맥 변경은 승인 후 실제 I/O도 차단한다',async t=>{
 const f=await fixture(t);const d=await f.executor.preview(f.plan);f.revoke();await assert.rejects(f.executor.approve(select(d)),/connection/);assert.equal(f.calls(),0);
 const g=await fixture(t);const e=await g.executor.preview(g.plan);await assert.rejects(g.executor.approve(select(e),()=>false),/context/);assert.equal(g.calls(),0);
});
test('claim 저장 실패에는 provider 호출이 없고 저장 후 충돌은 unknown으로 복구한다',async t=>{
 let fail=false;const f=await fixture(t,{fault:p=>{if(fail&&p==='before_claim_persist')throw Error('disk');}});const d=await f.executor.preview(f.plan);fail=true;
 await assert.rejects(f.executor.approve(select(d)));assert.equal(f.calls(),0);
 const g=await fixture(t,{fault:p=>{if(p==='after_claim_persist')throw Error('crash');}});const e=await g.executor.preview(g.plan);
 await assert.rejects(g.executor.approve(select(e)));assert.equal(g.calls(),0);
 const recovered=new ExternalExecutor(g.root,identity,()=>g.binding);await recovered.initialize();assert.equal(recovered.list()[0].status,'unknown');await assert.rejects(recovered.approve(select(e)),/decided/);
});
test('시작 후 취소·응답 유실은 unknown이며 재시작 시 자동 실행하지 않는다',async t=>{
 const f=await fixture(t),entered=deferred();
 f.binding.execute=async(_p,_id,signal,guard)=>{guard();entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}));return result;};
 const d=await f.executor.preview(f.plan);const execution=f.executor.approve(select(d));await entered.promise;
 assert.equal(f.executor.cancel(d.draftId).status,'running');assert.equal((await execution).status,'unknown');
 const recovered=new ExternalExecutor(f.root,identity,()=>f.binding);await recovered.initialize();assert.equal(recovered.list()[0].status,'unknown');
 await assert.rejects(recovered.approve(select(d)),/decided/);
 assert.equal((await recovered.reconcile(d.draftId)).status,'succeeded');
});
test('미실행 취소와 재시작은 기존 미리보기를 무효화한다',async t=>{
 const f=await fixture(t);const d=await f.executor.preview(f.plan);f.executor.cancel(d.draftId);await assert.rejects(f.executor.approve(select(d)),/decided/);
 const e=await f.executor.preview(f.plan);const recovered=new ExternalExecutor(f.root,identity,()=>f.binding);await recovered.initialize();assert.equal(recovered.list().find(x=>x.draftId===e.draftId).status,'dismissed');
});
test('정규화·입력 복사·foreign identity·손상된 저장소 경계를 검증한다',async t=>{
 assert.equal(canonicalJson({b:1,a:{d:2,c:3}}),'{"a":{"c":3,"d":2},"b":1}');
 assert.throws(()=>canonicalJson(JSON.parse('{"__proto__":{}}')));
 const f=await fixture(t);const d=await f.executor.preview(f.plan);f.plan.payload.arguments.text='바꾼 내용';assert.match(d.argumentsJson,/검토한 내용/);
 const foreign=new ExternalExecutor(f.root,{...identity,principal_id:'foreign'},()=>f.binding);await assert.rejects(foreign.initialize());
 const saved=JSON.parse(readFileSync(join(f.root,'executions.json'),'utf8'));saved.records[0].draft.action.target='forged';writeFileSync(join(f.root,'executions.json'),JSON.stringify(saved));
 const corrupt=new ExternalExecutor(f.root,identity,()=>f.binding);await assert.rejects(corrupt.initialize());
});

test('무효화 전에 시작한 미리보기는 비동기 해시 검증 뒤 승인 화면으로 돌아오지 않는다',async t=>{
 const f=await fixture(t);const pending=f.executor.preview(f.plan);f.executor.invalidate();
 await assert.rejects(pending,/context_changed/);assert.deepEqual(f.executor.list(),[]);assert.equal(f.calls(),0);
 const fresh=await f.executor.preview(f.plan);assert.equal(fresh.status,'pending');
});

test('전역 저장 실패는 대기 중인 외부 I/O를 중단하고 unknown의 복구를 재시작까지 막는다',async t=>{
 let failOnce=false,receiptAttempts=0;
 const f=await fixture(t,{fault:point=>{if(point==='before_receipt_persist'){receiptAttempts++;if(failOnce){failOnce=false;throw Error('fixture disk failure');}}}});
 const calendar={...f.plan,providerId:'google_calendar'};
 f.binding.execute=async()=>({status:'unknown',operationId:null,errorCode:'external_result_unknown'});
 const uncertain=await f.executor.preview(calendar);await f.executor.approve(select(uncertain));
 assert.equal(f.executor.list()[0].recoverable,true);
 const enteredA=deferred(),enteredB=deferred(),releaseA=deferred(),releaseB=deferred();let calls=0,signalB;
 f.binding.execute=async(plan,_id,signal,guard)=>{
  if(plan.payload.name==='A'){enteredA.resolve();await releaseA.promise;}
  else{signalB=signal;enteredB.resolve();await releaseB.promise;}
  guard();calls++;return result;
 };
 const draftA=await f.executor.preview({...calendar,payload:{name:'A'}}),draftB=await f.executor.preview({...calendar,payload:{name:'B'}});
 const runA=f.executor.approve(select(draftA));await enteredA.promise;
 const runB=f.executor.approve(select(draftB));await enteredB.promise;
 const attemptsBefore=receiptAttempts;failOnce=true;releaseA.resolve();await assert.rejects(runA,/store_unavailable/);
 assert.equal(signalB.aborted,true);
 assert.equal(f.executor.list().find(action=>action.draftId===draftB.draftId).status,'unknown');
 assert(f.executor.list().every(action=>action.recoverable===false));
 await assert.rejects(f.executor.reconcile(uncertain.draftId),/store_unavailable/);
 releaseB.resolve();await assert.rejects(runB,/store_unavailable/);
 assert.equal(calls,1);assert.equal(receiptAttempts,attemptsBefore+1);
 const stored=JSON.parse(readFileSync(join(f.root,'executions.json'),'utf8'));
 assert.deepEqual(stored.ledger.claims.slice(1).map(claim=>claim.state),['running','running']);
 const recovered=new ExternalExecutor(f.root,identity,()=>f.binding);await recovered.initialize();
 assert(recovered.list().every(action=>action.status==='unknown'&&action.recoverable));
 assert.equal(calls,1);
});
