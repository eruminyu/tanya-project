import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {compileScript,parse} from '@vue/compiler-sfc';
import {createRenderer,nextTick} from 'vue';
const {descriptor}=parse(readFileSync(new URL('../src/renderer/components/RuntimePanel.vue',import.meta.url),'utf8'));
const script=compileScript(descriptor,{id:'runtime-test'});
const {outputFiles}=await build({stdin:{contents:script.content,loader:'ts',resolveDir:fileURLToPath(new URL('../src/renderer/components/',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',packages:'external',plugins:[{name:'vue',setup(api){api.onResolve({filter:/^vue$/},()=>({path:import.meta.resolve('vue'),external:true}));}}]});
const {default:Panel}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const renderer=createRenderer({createElement:type=>({type,children:[]}),createText:text=>({text}),createComment:text=>({text}),insert:(node,parent)=>parent.children.push(node),remove(){},patchProp(){},setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
const initial={sequence:0,available:true,busy:false,phase:'stopped',reason:null,canRestore:false,version:'0.1.0',dataDirectory:'fixture'};
async function fixture(t){const calls=[],hooks={};let receive;const before=globalThis.window;globalThis.window={kirianDesktop:{getRuntime:async()=>initial,subscribeRuntime:f=>{receive=f;return()=>calls.push('unsubscribe');},startRuntime:async()=>{calls.push('start');return hooks.result?hooks.result():{...initial,phase:'ready'};}}};const app=renderer.createApp({...Panel,render:()=>null});app.mount({children:[]});await nextTick();t.after(()=>{app.unmount();globalThis.window=before;});return{state:app._instance.setupState,calls,hooks,receive:state=>receive(state)};}
test('명시 시작은 고정 명령 한 번으로 실행하고 실패를 성공으로 표시하지 않는다',async t=>{
 const f=await fixture(t);f.hooks.result=()=>({...initial,phase:'error',reason:'runtime_start_failed'});await f.state.command('start');
 assert.deepEqual(f.calls,['start']);assert.equal(f.state.status,'복구 필요');assert.match(f.state.notice,/시작하지 못/);
});
test('서비스 작업 중 중복 시작을 보내지 않고 호스트 변경 상태를 표시한다',async t=>{
 const f=await fixture(t);f.receive({...initial,busy:true,phase:'starting'});await f.state.command('start');assert.deepEqual(f.calls,[]);assert.equal(f.state.status,'시작 중');
});
test('늦은 시작 응답이 이미 종료된 최신 상태를 덮지 않는다',async t=>{
 const f=await fixture(t);let done;f.hooks.result=()=>new Promise(resolve=>done=resolve);const pending=f.state.command('start');
 f.receive({...initial,sequence:8,phase:'error',reason:'runtime_exited'});done({...initial,sequence:7,phase:'ready'});await pending;
 assert.equal(f.state.status,'복구 필요');
});
