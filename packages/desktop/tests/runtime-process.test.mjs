import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ManagedBrain} from '../dist-electron/main/runtime/managed-brain.js';
const fixture=()=>{let child,options,command,args;const calls=[];
 const runtime=new ManagedBrain({executable:'C:/app/resources/brain/kirian-brain.exe',dataDirectory:'C:/profile/brain',
  environment:{PATH:'system',KIRIAN_V1_TOKEN:'inherited-secret',KIRIAN_V1_CONFIG_FILE:'outside',KIRIAN_V1_OLLAMA_URL:'https://outside',PYTHONPATH:'untrusted',OPENAI_API_KEY:'provider-key'},timeoutMs:80,stopTimeoutMs:20,
  spawn:(c,a,o)=>{command=c;args=a;options=o;child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null,kill(){this.exitCode=1;this.emit('exit',1);}});return child;},
  request:async(url,o)=>{calls.push({url,options:o});return new Response('{}');}});
 return {runtime,calls,get child(){return child;},get options(){return options;},get args(){return args;},get command(){return command;}};};
test('토큰은 stdin으로만 넘기고 고정 loopback 준비 메시지를 인증 조회한다',async()=>{
 const f=fixture(),pending=f.runtime.start();f.child.stdout.write('{"type":"ready","port":32145}\n');const result=await pending;
 assert.equal(result.url,'http://127.0.0.1:32145');assert.match(result.token,/^[a-f0-9]{64}$/);
 assert.equal(f.options.env.KIRIAN_V1_TOKEN,undefined);assert.equal(f.options.env.KIRIAN_V1_CONFIG_FILE,undefined);assert.equal(f.options.env.KIRIAN_V1_OLLAMA_URL,undefined);assert.equal(f.options.env.PYTHONPATH,undefined);
 assert.equal(f.options.env.OPENAI_API_KEY,'provider-key');assert.ok(!JSON.stringify(f.args).includes(result.token));
 assert.equal(f.options.windowsHide,true);assert.equal(f.calls[0].options.headers.Authorization,'Bearer '+result.token);
 await f.runtime.stop();assert.equal(f.child.stdin.writableEnded,true);assert.equal(f.child.exitCode,1);
});
test('준비 응답 주소·과대 출력·시작 종료·무응답을 거부한다',async()=>{
 for(const message of ['{"type":"ready","port":0}\n','{"type":"ready","port":1234,"url":"https://evil"}\n','x'.repeat(2049)]){
  const f=fixture(),pending=f.runtime.start();f.child.stdout.write(message);await assert.rejects(pending);await f.runtime.stop();
 }
 const f=fixture(),pending=f.runtime.start();await assert.rejects(pending);await f.runtime.stop();
});
test('준비 전에 중단하면 늦은 결과로 연결하지 않는다',async()=>{
 const f=fixture(),pending=f.runtime.start();const rejected=assert.rejects(pending);await f.runtime.stop();f.child.stdout.write('{"type":"ready","port":32145}\n');await rejected;assert.equal(f.calls.length,0);
});
test('설정 검증은 별도 모드로만 실행하며 서비스 조회를 하지 않는다',async()=>{
 const f=fixture(),pending=f.runtime.validate('C:/staged/host.json');assert.deepEqual(f.args,['--validate-config']);
 assert.equal(f.options.env.KIRIAN_V1_CONFIG_FILE,'C:/staged/host.json');f.child.exitCode=0;f.child.emit('exit',0);await pending;assert.equal(f.calls.length,0);
});
