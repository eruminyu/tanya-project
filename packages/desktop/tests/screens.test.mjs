import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenManager } from '../dist-electron/main/screens/screen-manager.js';
import { ScreenClient } from '../dist-electron/main/screens/screen-client.js';
import { BrainConnection, validateCatalog } from '../dist-electron/main/brain-connection.js';
import { SessionController } from '../dist-electron/main/session-controller.js';
import { parseOptions } from '../scripts/start-local.mjs';

const model = {provider_id: 'ollama', endpoint_id: 'fixture', model_id: 'vision'};
const modelId = JSON.stringify(['fixture', 'ollama', 'vision']);
const identity = {instance_id: 'screen-test', mode: 'personal', principal_id: 'owner'};
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], images = [], changes = [], selected = [];
  let records = [], holdCapture = null, holdAnalysis = null;
  const native = {
    async listSources() { calls.push('list'); return [{id: 'window:77:0', name: 'Safe fixture', kind: 'window'}]; },
    async capture(id, name, signal) { calls.push(['capture', id, name, signal]);
      if (holdCapture) return holdCapture.promise;
      const jpeg = Buffer.from([255,216,1,2,255,217]); images.push(jpeg); return {jpeg,width:100,height:50}; }
  };
  const api = {
    async list() {calls.push('saved'); return structuredClone(records);},
    model(id,boundary) {calls.push(['model',id,boundary]); if (id !== modelId) throw new Error('unsupported_model'); return model;},
    async upload(p,jpeg) {calls.push(['upload',p.id,p.boundary,jpeg.toString('base64')]); records=[{captureId:p.id,sourceId:'root',revision:1,title:p.title,boundary:p.boundary,analysisSourceId:null}];return 'root';},
    async analyze(p,root,m,prompt,signal) {calls.push(['analyze',p.id,root,m,prompt,signal]); if (holdAnalysis) return holdAnalysis.promise;
      records[0].analysisSourceId='result'; return {sourceId:'result',revision:1,screenSourceId:'root',screenRevision:1,text:'fixture analysis',actualModel:model};},
    async cancel(id,revision) {calls.push(['cancel',id,revision]);},
    async delete(id,revision) {calls.push(['delete',id,revision]);records=records.filter(s=>s.captureId!==id);}
  };
  const manager = new ScreenManager(native, s=>changes.push(s), ()=>calls.push('imported'), async (id,r)=>{selected.push([id,r]);return {ok:true};});
  manager.setConnection(1,api);
  return {manager,api,native,calls,images,changes,selected,
    captureHold(v){holdCapture=v;}, analysisHold(v){holdAnalysis=v;}, records(v){records=v;} };
}
async function capture(f) { await f.manager.list(); assert.deepEqual(await f.manager.capture({sourceId:'window:77:0',boundary:'local'}),{ok:true});return f.manager.snapshot().preview; }
const input = p => ({captureId:p.id,revision:p.revision,modelId,prompt:'Explain this fixture'});

test('collection is explicit, preview pixels equal inference bytes; use requires another command', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());await tick();
  assert.deepEqual(f.calls,['saved']);
  assert.equal((await f.manager.capture({sourceId:'window:77:0',boundary:'local'})).ok,false);
  const p=await capture(f); assert.equal(f.calls.some(v=>Array.isArray(v)&&v[0]==='upload'),false);
  assert.deepEqual(await f.manager.analyze(input(p)),{ok:true});
  const upload=f.calls.find(v=>Array.isArray(v)&&v[0]==='upload');assert.equal(p.dataUrl,'data:image/jpeg;base64,'+upload[3]);
  assert.deepEqual(f.selected,[]); assert.deepEqual(await f.manager.use({captureId:p.id,revision:1}),{ok:true});assert.deepEqual(f.selected,[['result',1]]);
  assert.equal((await f.manager.analyze(input(p))).ok,false);
});
test('arbitrary renderer image bytes, stale preview and unsupported model do not upload', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());await f.manager.list();
  assert.equal((await f.manager.capture({sourceId:'window:77:0',boundary:'local',jpeg:'forged'})).ok,false);
  const p=await capture(f);
  assert.equal((await f.manager.analyze({...input(p),revision:2})).ok,false);
  assert.equal((await f.manager.analyze({...input(p),modelId:'other'})).ok,false);
  assert.equal(f.calls.some(v=>Array.isArray(v)&&v[0]==='upload'),false);
});

test('routing failures keep their specific reason and do not upload a replacement', async t => {
  const f=fixture(); t.after(()=>f.manager.dispose()); const p=await capture(f);
  for (const code of ['routing_no_candidate','routing_changed','routing_limit']) {
    f.api.model=()=>{throw new Error(code);};
    assert.deepEqual(await f.manager.analyze(input(p)),{ok:false,code});
    assert.equal(f.manager.snapshot().error,code);
  }
  assert.equal(f.calls.some(v=>Array.isArray(v)&&v[0]==='upload'),false);
});
test('connection change discards and erases delayed native frame and clears titles', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());await f.manager.list();const wait=deferred();f.captureHold(wait);
  const operation=f.manager.capture({sourceId:'window:77:0',boundary:'local'});f.manager.setConnection(2,null);
  const jpeg=Buffer.from([255,216,9,255,217]);wait.resolve({jpeg,width:20,height:10});await operation;
  assert.equal(f.manager.snapshot().preview,null);assert.deepEqual(f.manager.snapshot().targets,[]);assert.ok(jpeg.every(b=>b===0));
});
test('cancel aborts inference and rejects late success without implicit selection', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());const p=await capture(f),wait=deferred();f.analysisHold(wait);
  const operation=f.manager.analyze(input(p));await tick();await f.manager.cancel();
  assert.ok(f.calls.find(v=>Array.isArray(v)&&v[0]==='analyze')[5].aborted);
  wait.resolve({sourceId:'late',revision:1,screenSourceId:'root',screenRevision:1,text:'late',actualModel:model});await operation;
  assert.equal(f.manager.snapshot().analysis,null);assert.equal(f.manager.snapshot().preview.dataUrl,'');assert.deepEqual(f.selected,[]);
});
test('deletion revokes late result and keeps failed deletion reviewable for retry', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());const p=await capture(f);await f.manager.analyze(input(p));
  const remove=f.api.delete;f.api.delete=async()=>{throw new Error('network_failure');};
  assert.deepEqual(await f.manager.delete({captureId:p.id,revision:1}),{ok:false,code:'deletion_unconfirmed'});
  assert.equal(f.manager.snapshot().preview.id,p.id);f.api.delete=remove;
  assert.deepEqual(await f.manager.delete({captureId:p.id,revision:1}),{ok:true});assert.equal(f.manager.snapshot().preview,null);
  assert.ok(f.images[0].every(b=>b===0));
});
test('late saved-list request from old identity cannot restore metadata', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());await tick();const wait=deferred();f.api.list=()=>wait.promise;
  const pending=f.manager.refreshSaved();f.manager.setConnection(2,null);wait.resolve([{captureId:'old',title:'private'}]);await pending;
  assert.deepEqual(f.manager.snapshot().saved,[]);
});
test('model catalog has explicit optional capability; malformed host capability is rejected', () => {
  const catalog={identity,models:[{model,label:'Vision',supports_images:true,boundary:'private_lan'}],default_selection:{model,source:'initial_local'}};
  assert.equal(validateCatalog(catalog).models[0].supports_images,true);
  assert.throws(()=>validateCatalog({...catalog,models:[{...catalog.models[0],supports_images:'true'}]}));
  assert.throws(()=>validateCatalog({...catalog,models:[{...catalog.models[0],boundary:'internet'}]}));
});
test('screen model policy has no unsupported/cloud/local-to-LAN fallback', () => {
  for (const [supports_images,boundary,permission,code] of [[false,'local','local','unsupported_model'],[true,'cloud','private_lan','context_blocked'],[true,'private_lan','local','context_blocked']]) {
    const client=new ScreenClient(identity,[{model,label:'Vision',supports_images,boundary}],()=>{throw new Error('must not send');});
    assert.throws(()=>client.model(modelId,permission),new RegExp(code));
  }
  const client=new ScreenClient(identity,[{model,label:'Vision',supports_images:true,boundary:'private_lan'}],()=>{});
  assert.deepEqual(client.model(modelId,'private_lan'),model);
});
test('completed analysis can be kept while releasing preview; preparing another capture does not capture', async t => {
  const f=fixture();t.after(()=>f.manager.dispose());const p=await capture(f);await f.manager.analyze(input(p));
  assert.deepEqual(await f.manager.release(),{ok:true});assert.equal(f.manager.snapshot().preview,null);
  assert.equal(f.manager.snapshot().saved[0].analysisSourceId,'result');assert.ok(f.images[0].every(b=>b===0));
  assert.equal(f.calls.filter(v=>Array.isArray(v)&&v[0]==='capture').length,1);
  assert.deepEqual(await f.manager.delete({captureId:p.id,revision:1}),{ok:true});
});
test('external Brain is never an image upload destination even with a local vision catalog', () => {
  const session=new SessionController(), brain=new BrainConnection(session);
  // Isolate destination authorization from transport, which is tested separately.
  brain.state.phase='ready';brain.catalog={identity,persistence:true,models:[{model,label:'local',supports_images:true,boundary:'local'}]};
  brain.abort=new AbortController();
  brain.credentials={url:'https://remote.example/',token:'x'.repeat(48)};
  assert.equal(brain.screenClient(),null);
  brain.credentials.url='http://127.0.0.1:9876/';assert.ok(brain.screenClient() instanceof ScreenClient);
  brain.dispose();session.dispose();
});
test('image capability launcher flag is explicit and cannot override a host configuration', () => {
  assert.equal(parseOptions(['--model','vision','--images','true'],{}).supportsImages,true);
  assert.equal(parseOptions(['--images','false'],{}).supportsImages,false);
  assert.equal(parseOptions([],{}).supportsImages,undefined);
  assert.throws(()=>parseOptions(['--images','yes'],{}));
  assert.throws(()=>parseOptions(['--config','host.json','--images','true'],{}));
});
test('preview expiry also revokes a later-uploaded server image and preserves completed text', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();t.after(()=>f.manager.dispose());const p=await capture(f);await f.manager.analyze(input(p));
  t.mock.timers.tick(600001);await tick();
  assert.equal(f.manager.snapshot().preview.dataUrl,'');
  assert.ok(f.calls.some(v=>Array.isArray(v)&&v[0]==='cancel'&&v[1]===p.id));
  assert.equal(f.manager.snapshot().analysis.text,'fixture analysis');
});
