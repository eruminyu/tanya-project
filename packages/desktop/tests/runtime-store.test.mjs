import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RuntimeStore, parseHostFile} from '../dist-electron/main/runtime/runtime-store.js';

const host = label => ({identity:{instance_id:'runtime-test',mode:'personal',principal_id:'owner'},bindings:[{model:{provider_id:'ollama',model_id:'fixture',endpoint_id:'local'},label,kind:'ollama',url:'http://127.0.0.1:11434',boundary:'local'}]});
const fixture = () => {const root=mkdtempSync(join(tmpdir(),'kirian-runtime-store-'));return {root,store:new RuntimeStore(root)};};
test('기본 설정은 파일을 만들지 않으며 가져온 설정과 이전 설정을 재시작 후 복원한다',()=>{
 const {root,store}=fixture();assert.equal(store.read(),null);assert.equal(store.canRestore(),false);
 store.save(host('첫 설정'));assert.deepEqual(new RuntimeStore(root).read(),host('첫 설정'));assert.equal(store.canRestore(),true);
 store.save(host('새 설정'));store.restore();assert.deepEqual(store.read(),host('첫 설정'));
 store.restore();assert.deepEqual(store.read(),host('새 설정'));
});
test('첫 가져오기 이전의 기본 설정도 명시적으로 복원할 수 있다',()=>{
 const {store}=fixture();store.save(host('가져옴'));store.restore();assert.equal(store.read(),null);
});
test('손상된 설정은 읽기·저장 시 보존하며 명시 복원만 이전 설정으로 돌린다',()=>{
 const {root,store}=fixture();store.save(host('first'));store.save(host('second'));
 writeFileSync(join(root,'settings.json'),'broken-original');assert.throws(()=>store.read());assert.throws(()=>store.save(host('third')));
 assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'broken-original');store.restore();assert.deepEqual(store.read(),host('first'));
 assert.ok(readdirSync(root).some(name=>name.startsWith('settings-recovered-') && readFileSync(join(root,name),'utf8')==='broken-original'));
});
test('자료 경로 지정·직접 자격 증명·잘못된 경계·과대 파일을 가져오지 않는다',()=>{
 for(const value of [{...host('x'),data_dir:'C:/other'},{...host('x'),extra:true},{...host('x'),bindings:[{...host('x').bindings[0],api_key:'secret'}]},
  {...host('x'),bindings:[{...host('x').bindings[0],url:'https://remote.example',boundary:'local'}]}]) assert.throws(()=>parseHostFile(JSON.stringify(value)));
 assert.throws(()=>parseHostFile(' '.repeat(131073)));assert.deepEqual(parseHostFile('\ufeff'+JSON.stringify(host('x'))),host('x'));
});
