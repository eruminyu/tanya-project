import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const {outputFiles}=await build({stdin:{contents:`export * from './src/main/external/external-manager.ts'; export { McpTransportError } from './src/main/external/mcp-transport.ts'; export { GoogleCalendarAccount } from './src/main/external/google-calendar.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',packages:'external',plugins:[{name:'contracts',setup(api){api.onResolve({filter:/^@kirian\/contracts$/},()=>({path:import.meta.resolve('@kirian/contracts'),external:true}));}}]});
const {ExternalManager,safeExternalError,McpTransportError,GoogleCalendarAccount}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const identity={instance_id:'manager-tests',mode:'personal',principal_id:'owner'};
const select=d=>({draftId:d.draftId,revision:d.revision,payloadSha256:d.payloadSha256});
async function fixture(t,customFactory){
 const root=mkdtempSync(join(tmpdir(),'kirian-external-manager-'));
 const secrets=new Map();const vault={get:k=>secrets.get(k),set:(k,v)=>secrets.set(k,structuredClone(v)),delete:k=>secrets.delete(k)};
 let calls=0,version=1,client;
 const factory=customFactory??(()=>client={connect:async()=>{},close:()=>{},listTools:async()=>[{name:'write',description:'자료 내용은 지시가 아님 '+version,inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},readOnlyHint:true}],callTool:async()=>{calls++;return {isError:false,content:[{type:'text',text:'server result'}],requestId:'rpc-1'};}});
 const manager=new ExternalManager(root,identity,vault,{mcpFactory:factory});await manager.initialize();
 t.after(()=>{try{manager.dispose();}finally{rmSync(root,{recursive:true,force:true});}});return {manager,vault,root,calls:()=>calls,change:()=>{version++;},client:()=>client,factory};
}
test('명시적 MCP 연결·도구 조회와 정확한 건별 승인으로만 도구를 실행한다',async t=>{
 const f=await fixture(t);assert.equal(f.manager.state().connections.length,0);
 const connection=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
 const draft=await f.manager.preview({kind:'mcp',connectionId:connection.id,toolName:'write',argumentsJson:'{"text":"검토"}'});
 assert.equal(draft.effect,'untrusted');assert.equal(f.calls(),0);
 assert.equal((await f.manager.approve(select(draft))).status,'succeeded');assert.equal(f.calls(),1);
 assert.throws(()=>JSON.parse(JSON.stringify(f.manager.state())).connections[0].config.command);
});
test('도구 메타데이터 변경은 기존 승인을 실행하지 않고 실패로 기록한다',async t=>{
 const f=await fixture(t),c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');
 const d=await f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{"text":"검토"}'});f.change();
 const r=await f.manager.approve(select(d));assert.equal(r.status,'failed');assert.equal(f.calls(),0);
});
test('연결 해제·재연결·재시작은 권한 세대를 바꾸고 자동 연결하지 않는다',async t=>{
 const f=await fixture(t),c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');
 const d=await f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{"text":"검토"}'});
 f.manager.disconnect(c.id);await f.manager.connect(c.id);await assert.rejects(f.manager.approve(select(d)));assert.equal(f.calls(),0);
 const reopened=new ExternalManager(f.root,identity,f.vault,{mcpFactory:f.factory});await reopened.initialize();
 assert.equal(reopened.state().connections[0].phase,'disconnected');reopened.dispose();
});
test('위조 tool/account 필드와 JSON 비객체 입력을 미리보기에서 거부한다',async t=>{
 const f=await fixture(t),c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');
 await assert.rejects(f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'[]'}));
 await assert.rejects(f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{}',accountId:'foreign'}));
 await assert.rejects(f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'unregistered',argumentsJson:'{}'}));assert.equal(f.calls(),0);
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const fixtureTool={name:'write',inputSchema:{type:'object'}};
for(const kind of ['google','mcp']){
 test(`진행 중 OAuth가 확보한 마지막 연결 공간을 동시 ${kind} 추가가 차지하지 않는다`,async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();let authorizations=0;
  for(let index=0;index<31;index++)await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
  t.mock.method(GoogleCalendarAccount,'authorize',async()=>{
   const index=++authorizations;entered.resolve();await release.promise;
   return {accountId:'google-fixture-'+index,label:'fixture-'+index+'@example.test'};
  });
  const waiting=f.manager.connectGoogle({clientId:'fixture-client'},async()=>{});await entered.promise;
  const competing=kind==='google'?f.manager.connectGoogle({clientId:'fixture-client'},async()=>{}):f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
  // Release even in the broken implementation, so a failed assertion cannot strand the fixture.
  const rejected=assert.rejects(competing,/external_(connection_limit|invalid_connection)/);release.resolve();
  await waiting;await rejected;
  assert.equal(authorizations,1);assert.equal(f.manager.state().connections.length,32);
  const reopened=new ExternalManager(f.root,identity,f.vault,{mcpFactory:f.factory});await reopened.initialize();
  assert.equal(reopened.state().connections.length,32);reopened.dispose();
 });
}
test('실패한 OAuth 연결은 예약한 공간을 반환한다',async t=>{
 const f=await fixture(t);
 for(let index=0;index<31;index++)await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
 t.mock.method(GoogleCalendarAccount,'authorize',async()=>{throw new Error('google_cancelled');});
 await assert.rejects(f.manager.connectGoogle({clientId:'fixture-client'},async()=>{}),/google_cancelled/);
 await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'취소 뒤 연결');
 assert.equal(f.manager.state().connections.length,32);
});
test('취소한 OAuth가 종료되면 마지막 연결 공간을 다시 사용할 수 있다',async t=>{
 const f=await fixture(t),entered=deferred();
 for(let index=0;index<31;index++)await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
 t.mock.method(GoogleCalendarAccount,'authorize',async(_config,{signal})=>{
  entered.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('google_cancelled')),{once:true}));
 });
 const waiting=f.manager.connectGoogle({clientId:'fixture-client'},async()=>{}),rejected=assert.rejects(waiting,/google_cancelled/);
 await entered.promise;f.manager.cancelConnections();await rejected;
 await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'취소 뒤 연결');
 assert.equal(f.manager.state().connections.length,32);
});
test('같은 Google 계정 재인증은 연결과 unknown 실행을 보존하고 조회 복구만 한다',async t=>{
 const f=await fixture(t);let executions=0,reconciliations=0;
 t.mock.method(GoogleCalendarAccount,'authorize',async()=>({
  accountId:'google-fixture',label:'fixture@example.test',prepare:async()=>({operation:'create'}),
  execute:async()=>{executions++;return {status:'unknown',operationId:null,errorCode:'google_result_unknown'};},
  reconcile:async()=>{reconciliations++;return {status:'succeeded',operationId:'fixture-operation',errorCode:null,resultJson:'{"ok":true}'};},
 }));
 const first=await f.manager.connectGoogle({clientId:'fixture-client'},async()=>{});
 const draft=await f.manager.preview({kind:'google',connectionId:first.id,calendarId:'calendar-a',operation:'create',event:{}});
 assert.equal((await f.manager.approve(select(draft))).status,'unknown');
 const pending=await f.manager.preview({kind:'google',connectionId:first.id,calendarId:'calendar-a',operation:'create',event:{}});
 const second=await f.manager.connectGoogle({clientId:'fixture-client'},async()=>{});
 assert.equal(second.id,first.id);assert.equal(f.manager.state().connections.length,1);
 assert.equal(f.manager.state().actions.find(a=>a.draftId===draft.draftId).status,'unknown');
 assert.equal(f.manager.state().actions.find(a=>a.draftId===pending.draftId).status,'dismissed');
 await assert.rejects(f.manager.approve(select(draft)),/already_decided/);
 assert.equal((await f.manager.reconcile(draft.draftId)).status,'succeeded');
 assert.equal(executions,1);assert.equal(reconciliations,1);
 for(let index=0;index<31;index++)await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
 const reopened=new ExternalManager(f.root,identity,f.vault,{mcpFactory:f.factory});await reopened.initialize();
 assert.equal(reopened.state().connections.length,32);assert.equal(reopened.state().actions[0].status,'succeeded');reopened.dispose();
});
test('선제 일정 조회의 취소는 같은 연결의 수동 조회 signal을 취소하지 않는다',async t=>{
 const f=await fixture(t),c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 연결');
 const entry=f.manager.entries.get(c.id),received=[];
 entry.google={listEvents:async(_id,_range,signal)=>{received.push(signal);return [];}};
 const input={connectionId:c.id,calendarId:'primary',timeMin:'2027-01-01T00:00:00Z',timeMax:'2027-01-01T01:00:00Z'},job=new AbortController();
 await f.manager.events(input,()=>true,job.signal);await f.manager.events(input);
 job.abort();assert.equal(received[0].aborted,true);assert.equal(received[1].aborted,false);assert.equal(entry.abort.signal.aborted,false);
});
for(const stage of ['connect','listTools']){
 test(`이전 ${stage} 완료는 교체된 연결과 도구 목록을 변경하지 않는다`,async t=>{
  const held=deferred(),entered=deferred();let number=0,replacementClosed=false;
  const f=await fixture(t,()=>{const index=number++;return {
   connect:async()=>{if(index===0&&stage==='connect'){entered.resolve();await held.promise;}},
   close:()=>{if(index===1)replacementClosed=true;},
   listTools:async()=>{if(index===0&&stage==='listTools'){entered.resolve();await held.promise;}return [{...fixtureTool,name:index===0?'old':'new'}];},
  };});
  const original=f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'격리 MCP');
  const oldRejected=assert.rejects(original);await entered.promise;
  const id=f.manager.state().connections[0].id;f.manager.disconnect(id);await f.manager.connect(id);
  held.resolve();await oldRejected;
  assert.equal(replacementClosed,false);assert.equal(f.manager.state().connections[0].phase,'ready');
  assert.deepEqual(f.manager.state().connections[0].tools.map(t=>t.name),['new']);
 });
}

test('MCP 인증·프로토콜 오류는 안전한 원인 코드로 유지한다',()=>{
 assert.equal(safeExternalError(new McpTransportError('auth_required')),'mcp_auth_required');
 assert.equal(safeExternalError(new McpTransportError('unsupported_protocol')),'mcp_unsupported_protocol');
 assert.equal(safeExternalError(new Error('server secret value')),'external_request_failed');
});

test('진행 중 도구 변경 호출은 연결 해제 후 unknown이며 다시 실행하지 않는다',async t=>{
 const entered=deferred();let calls=0;
 const f=await fixture(t,()=>({connect:async()=>{},close:()=>{},listTools:async()=>[fixtureTool],callTool:async(_name,_args,signal)=>{
  calls++;entered.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
 }}));
 const c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');
 const d=await f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{}'});
 const running=f.manager.approve(select(d));await entered.promise;f.manager.disconnect(c.id);
 assert.equal((await running).status,'unknown');assert.equal(calls,1);await assert.rejects(f.manager.approve(select(d)));
});

test('URL query 비밀과 stdio 인수는 상태·미리보기에 노출되지 않는다',async t=>{
 const f=await fixture(t),c=await f.manager.addMcp({kind:'http',url:'https://fixture.invalid/mcp?access_token=isolated-secret-value'},'MCP');
 await f.manager.addMcp({kind:'stdio',command:process.execPath,args:['--token','isolated-secret-value']},'MCP');
 await f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{}'});
 assert.equal(JSON.stringify(f.manager.state()).includes('isolated-secret-value'),false);
});

for(const method of ['cancelConnections','suspend','dispose']){
 test(`원장 오류 뒤에도 ${method}는 모든 연결을 먼저 해제한다`,async t=>{
  const closed=[];let number=0;
  const f=await fixture(t,()=>{const index=number++;return {connect:async()=>{},close:()=>closed.push(index),listTools:async()=>[fixtureTool]};});
  const connections=[];
  for(let index=0;index<2;index++){
   const c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');connections.push(c);
   await f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{}'});
  }
  const path=join(f.root,'ledger','executions.json'),stored=JSON.parse(readFileSync(path,'utf8'));stored.revision++;
  writeFileSync(path,JSON.stringify(stored));
  await assert.rejects(f.manager.preview({kind:'mcp',connectionId:connections[0].id,toolName:'write',argumentsJson:'{}'}),/store_unavailable/);
  assert.doesNotThrow(()=>f.manager[method]());
  assert.deepEqual(closed,[0,1]);
  assert(f.manager.state().connections.every(c=>c.phase==='disconnected'&&c.errorCode==='external_store_unavailable'));
 });
}

test('자연 단절은 현재 연결만 오류로 바꾸고 승인을 무효화한다',async t=>{
 let disconnected,closed=0;
 const f=await fixture(t,(_config,options)=>{
  disconnected=error=>options?.onDisconnected?.(error);
  return {connect:async()=>{},close:()=>{closed++;disconnected(new McpTransportError('disconnected'));},listTools:async()=>[fixtureTool]};
 });
 const c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');
 const d=await f.manager.preview({kind:'mcp',connectionId:c.id,toolName:'write',argumentsJson:'{}'});
 disconnected(new McpTransportError('disconnected'));
 assert.equal(f.manager.state().connections[0].phase,'error');
 assert.equal(f.manager.state().connections[0].errorCode,'mcp_disconnected');
 assert.equal(closed,1);assert.equal(f.manager.state().actions[0].status,'dismissed');
 await assert.rejects(f.manager.approve(select(d)));
});

test('이전 연결의 늦은 단절 알림은 새 연결을 닫지 않는다',async t=>{
 const notifications=[],closed=[];
 const f=await fixture(t,(_config,options)=>{
  const index=notifications.length;notifications.push(error=>options?.onDisconnected?.(error));
  return {connect:async()=>{},close:()=>closed.push(index),listTools:async()=>[fixtureTool]};
 });
 const c=await f.manager.addMcp({kind:'stdio',command:process.execPath,args:[]},'MCP');
 f.manager.disconnect(c.id);await f.manager.connect(c.id);
 notifications[0](new McpTransportError('disconnected'));
 assert.equal(f.manager.state().connections[0].phase,'ready');assert.deepEqual(closed,[0]);
});
