import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {compileScript,parse} from '@vue/compiler-sfc';
import {createRenderer,nextTick,reactive,h} from 'vue';

const {descriptor}=parse(readFileSync(new URL('../src/renderer/components/AutoMemoryPanel.vue',import.meta.url),'utf8'));
const script=compileScript(descriptor,{id:'auto-memory-panel-test'});
const {outputFiles}=await build({stdin:{contents:script.content,loader:'ts',resolveDir:fileURLToPath(new URL('../src/renderer/components/',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',packages:'external',
  plugins:[{name:'vue',setup(api){api.onResolve({filter:/^vue$/},()=>({path:import.meta.resolve('vue'),external:true}));}}]});
const {default:Panel}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const renderer=createRenderer({createElement:type=>({type,children:[]}),createText:text=>({text}),createComment:text=>({text}),insert:(node,parent)=>parent.children.push(node),remove(){},patchProp(){},setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
const defaults=()=>({enabled:false,conversations:false,conversation_boundary:'local',note_collection_ids:[],screen_analyses:false,categories:['preference','fact','task'],retrieval_enabled:false});
const snapshot=(revision=0,settings=defaults())=>({settings,revision,status:'disabled',embedding_model:null,pending_count:0,memory_count:0,indexed_count:0,evidence:[],recent_usage:[]});
const flush=async()=>{await Promise.resolve();await nextTick();await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
  const calls=[],hooks={};let current=snapshot();
  const bridge={getAutoMemory:async()=>hooks.read?hooks.read():structuredClone(current),configureAutoMemory:async input=>{calls.push(structuredClone(input));if(hooks.save)return hooks.save(input);current=snapshot(current.revision+1,structuredClone(input.settings));return structuredClone(current);},searchAutoMemory:async()=>hooks.search?hooks.search():{results:[],status:'ready'}};
  const old=globalThis.window;globalThis.window={kirianDesktop:bridge};
  const props=reactive({enabled:true,folders:[]});const component={...Panel,render:()=>null};const app=renderer.createApp({render:()=>h(component,props)});app.mount({children:[]});
  t.after(()=>{app.unmount();globalThis.window=old;});await flush();return {state:app._instance.subTree.component.setupState,props,calls,hooks};
}
test('실제 Vue reactive 설정을 저장하고 원문이나 history를 IPC에 넣지 않는다',async t=>{
  const f=await fixture(t);f.state.draft.enabled=true;f.state.draft.conversations=true;f.state.dirty=true;
  await f.state.save();assert.equal(f.calls.length,1);assert.equal(f.calls[0].settings.enabled,true);assert.equal(f.state.state.revision,1);assert.equal(f.state.dirty,false);
});
test('ON 저장이 대기 중이어도 즉시 OFF를 전송하며 늦은 ON 응답은 복원하지 않는다',async t=>{
  const f=await fixture(t),late=deferred();f.state.draft.enabled=true;f.state.dirty=true;
  f.hooks.save=input=>input.settings.enabled?late.promise:snapshot(2,defaults());
  const enabling=f.state.save();await flush();await f.state.save(true);
  late.resolve(snapshot(1,{...defaults(),enabled:true}));await enabling;
  assert.equal(f.calls.length,2);assert.equal(f.state.state.settings.enabled,false);assert.equal(f.state.state.revision,2);
});
test('더 오래된 상태 조회와 연결 해제 뒤 검색 결과를 버린다',async t=>{
  const f=await fixture(t),old=deferred();let count=0;f.hooks.read=()=>++count===1?old.promise:snapshot(0,{...defaults(),screen_analyses:true});
  const first=f.state.refresh();await f.state.refresh();old.resolve(snapshot());await first;
  assert.equal(f.state.state.settings.screen_analyses,true);
  const pending=deferred();f.hooks.search=()=>pending.promise;f.state.query='차';const searching=f.state.search();
  f.props.enabled=false;await flush();pending.resolve({results:[{title:'오래된 기억'}],status:'ready'});await searching;
  assert.equal(f.state.matches,null);assert.equal(f.state.state,null);
});
