import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {compileScript,parse} from '@vue/compiler-sfc';
import {createRenderer,nextTick,reactive,h} from 'vue';
import {emptyProactive} from '../dist-electron/shared/proactive.js';
const {descriptor}=parse(readFileSync(new URL('../src/renderer/components/ProactivePanel.vue',import.meta.url),'utf8'));
const script=compileScript(descriptor,{id:'proactive-test'});
const {outputFiles}=await build({stdin:{contents:script.content,loader:'ts',resolveDir:fileURLToPath(new URL('../src/renderer/components/',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',packages:'external',
 plugins:[{name:'vue',setup(api){api.onResolve({filter:/^vue$/},()=>({path:import.meta.resolve('vue'),external:true}));}}]});
const {default:Panel}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const renderer=createRenderer({createElement:type=>({type,children:[]}),createText:text=>({text}),createComment:text=>({text}),insert:(node,parent)=>parent.children.push(node),remove(){},patchProp(){},setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
const flush=async()=>{await Promise.resolve();await nextTick();await Promise.resolve();};
async function fixture(t){let receive;const calls=[],hooks={};let current={...emptyProactive(),available:true,reason:'ready'};
 const old=globalThis.window;globalThis.window={kirianDesktop:{getProactive:async()=>structuredClone(current),subscribeProactive:listener=>{receive=listener;return ()=>{};},
  configureProactive:async input=>{calls.push(structuredClone(input));current={...current,version:current.version+1,revision:current.revision+1,settings:input.settings};return structuredClone(current);},
  getExternalState:async()=>hooks.external?hooks.external():{connections:[]},listExternalCalendars:async()=>[],}};
 const props=reactive({brain:{phase:'ready',models:[]}}),component={...Panel,render:()=>null},app=renderer.createApp({render:()=>h(component,props)});app.mount({children:[]});
 t.after(()=>{app.unmount();globalThis.window=old;});await flush();return {state:app._instance.subTree.component.setupState,props,calls,hooks,receive:v=>receive(v)};
}
test('실제 Vue 설정 proxy를 plain JSON으로 저장하며 외부 실행을 보내지 않음',async t=>{
 const f=await fixture(t);f.state.draft.enabled=true;f.state.draft.screenAnalyses=true;f.state.dirty=true;await f.state.save();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].settings.screenAnalyses,true);assert.equal(f.state.dirty,false);
 assert.deepEqual(Object.keys(f.calls[0]),['revision','settings']);
});
test('연결 해제 뒤 늦은 Google 계정 응답은 화면에 돌아오지 않음',async t=>{
 const f=await fixture(t);let resolve;f.hooks.external=()=>new Promise(r=>resolve=r);const pending=f.state.loadConnections();
 f.props.brain.phase='disconnected';await flush();resolve({connections:[{id:'private-account',kind:'google',phase:'ready'}]});await pending;
 assert.deepEqual(f.state.connections,[]);assert.equal(f.state.state,null);
});
test('정지 뒤 낮은 version의 생성 응답은 카드 복원 불가',async t=>{
 const f=await fixture(t);f.receive({...emptyProactive(),version:8});f.receive({...emptyProactive(),version:7,cards:[{text:'오래된 제안'}]});
 assert.deepEqual(f.state.state.cards,[]);
});
