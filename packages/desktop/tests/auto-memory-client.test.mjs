import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: `export {AutoMemoryClient} from './src/main/auto-memory-client.ts'; export {defaultAutoMemorySettings} from './src/shared/auto-memory.ts';`, loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'contracts', setup(api) { api.onResolve({filter: /^@kirian\/contracts$/}, args => ({path: import.meta.resolve(args.path), external: true})); } }] });
const {AutoMemoryClient, defaultAutoMemorySettings} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const state = () => ({settings: defaultAutoMemorySettings(), revision: 0, status: 'disabled', embedding_model: null, pending_count: 0, memory_count: 0, indexed_count: 0, evidence: [], recent_usage: []});

test('자동 기억 설정은 독립 OFF이며 원시 맥락은 main 공급자에서만 검색 요청에 넣는다', async () => {
  const calls = [], manual = [{source_id:'manual', revision:1, text:'허용된 원문'}];
  const client = new AutoMemoryClient(async (...args) => { calls.push(args); return args[0].endsWith('/search') ? {results:[],status:'disabled'} : state(); }, () => manual);
  assert.equal((await client.read()).settings.enabled, false);
  await client.search('차');
  assert.deepEqual(calls[1], ['v1/auto-memory/search','POST',{query:'차',context:manual}]);
  await assert.rejects(() => client.search({query:'차',context:[{text:'주입'}]}), /invalid_request/);
  await assert.rejects(() => client.configure({settings:{...defaultAutoMemorySettings(), categories:['execute']},expected_revision:0}), /invalid_request/);
  assert.equal(calls.length, 2);
});

test('main은 서버의 설정·근거·점수 DTO를 검증하며 응답 값을 그대로 신뢰하지 않는다', async () => {
  for (const changed of [{extra:'secret'}, {revision:true}, {status:'<unknown>'}, {embedding_model:{url:'https://bad.invalid'}},
    {evidence:[{source_id:'x',quote:'근거 없는 내용'}]}, {settings:{...defaultAutoMemorySettings(), note_collection_ids:['../bad']}}]) {
    const client = new AutoMemoryClient(async () => ({...state(),...changed}), () => []);
    await assert.rejects(() => client.read(), /invalid_response|Contract/);
  }
  const client = new AutoMemoryClient(async () => ({results:[{source_id:'x',revision:1,title:'차',score:NaN,reason:'semantic_similarity'}],status:'ready'}), () => []);
  await assert.rejects(() => client.search('차'), /invalid_response/);
});
