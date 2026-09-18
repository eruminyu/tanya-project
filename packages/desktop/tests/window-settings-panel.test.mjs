import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {compileScript,parse} from '@vue/compiler-sfc';
import {createRenderer,nextTick,reactive,h} from 'vue';
import {emptyWindowControls} from '../dist-electron/shared/window-controls.js';
const {descriptor}=parse(readFileSync(new URL('../src/renderer/components/WindowSettingsPanel.vue',import.meta.url),'utf8'));
const script=compileScript(descriptor,{id:'window-panel-test'});
const {outputFiles}=await build({stdin:{contents:script.content,loader:'ts',resolveDir:fileURLToPath(new URL('../src/renderer/components/',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',packages:'external',
  plugins:[{name:'vue',setup(api){api.onResolve({filter:/^vue$/},()=>({path:import.meta.resolve('vue'),external:true}));}}]});
const {default:Panel}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const renderer=createRenderer({createElement:type=>({type,children:[]}),createText:text=>({text}),createComment:text=>({text}),insert:(node,parent)=>parent.children.push(node),remove(){},patchProp(){},setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
async function fixture(t) {
  const calls=[],hooks={}; const previous=globalThis.window;
  globalThis.window={kirianDesktop:{setClickThrough:async input=>{calls.push(input);return hooks.result?await hooks.result():{ok:true};},recoverWindow:async()=>{calls.push('recover');return {ok:true};}}};
  const props=reactive({enabled:true,state:{alwaysOnTop:false,...emptyWindowControls(),recoveryAvailable:true}});
  const component={...Panel,render:()=>null};
  const app=renderer.createApp({render:()=>h(component,props)});app.mount({children:[]});
  t.after(()=>{app.unmount();globalThis.window=previous;});await nextTick();return {state:app._instance.subTree.component.setupState,props,calls,hooks};
}
test('창 설정은 host 명령에 boolean만 보내고 성공 전후 상태를 임의로 바꾸지 않는다',async t=>{
  const f=await fixture(t);await f.state.command('toggle');assert.deepEqual(f.calls,[true]);assert.equal(f.props.state.clickThrough,false);
  f.props.state.clickThrough=true;await f.state.command('toggle');assert.deepEqual(f.calls,[true,false]);
});
test('등록 실패 응답은 성공 표시 없이 복구 안내를 보여준다',async t=>{
  const f=await fixture(t);f.hooks.result=()=>({ok:false,code:'shortcut_unavailable'});await f.state.command('toggle');
  assert.match(f.state.notice,/복구 단축키/);assert.equal(f.props.state.clickThrough,false);
});
test('잠금 중 차단 응답은 해당 상태를 안내하며 켜짐으로 표시하지 않는다',async t=>{
  const f=await fixture(t);f.hooks.result=()=>({ok:false,code:'interaction_blocked'});await f.state.command('toggle');
  assert.match(f.state.notice,/잠금 또는 절전/);assert.equal(f.props.state.clickThrough,false);
});
test('pending 중 중복 클릭과 비활성 상태의 명령을 차단한다',async t=>{
  const f=await fixture(t);let complete;f.hooks.result=()=>new Promise(resolve=>complete=resolve);
  const first=f.state.command('toggle');await f.state.command('toggle');assert.deepEqual(f.calls,[true]);
  complete({ok:true});await first;f.props.enabled=false;await nextTick();await f.state.command('recover');assert.deepEqual(f.calls,[true]);
});
test('복구 버튼은 전용 명령을 호출하고 IPC 예외 후 다시 조작할 수 있다',async t=>{
  const f=await fixture(t);f.hooks.result=()=>{throw Error('IPC');};await f.state.command('toggle');
  assert.equal(f.state.pending,false);assert.match(f.state.notice,/다시 실행/);await f.state.command('recover');assert.deepEqual(f.calls,[true,'recover']);
});
