import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WindowControls} from '../dist-electron/main/window/window-controls.js';
import {WindowStateStore} from '../dist-electron/main/window/window-state-store.js';
import {RECOVERY_SHORTCUT} from '../dist-electron/shared/window-controls.js';
const display = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}};
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kirian-window-'));
  const window = Object.assign(new EventEmitter(), {bounds: {x: 100, y: 100, width: 800, height: 700}, ignored: false,
    destroyed: false, minimized: false, maximized: false, shown: false, focused: false, min: [], calls: [],
    isDestroyed(){return this.destroyed;}, isMinimized(){return this.minimized;}, isMaximized(){return this.maximized;}, isFullScreen(){return false;},
    getBounds(){return {...this.bounds};}, getNormalBounds(){return {...this.bounds};},
    setBounds(value){this.bounds = {...value}; this.emit('move');}, setMinimumSize(w,h){this.min=[w,h];},
    setIgnoreMouseEvents(value){this.calls.push(value); if(options.nativeFailure) throw Error('native'); this.ignored=value;},
    restore(){this.minimized=false;}, unmaximize(){this.maximized=false;}, show(){this.shown=true;}, focus(){this.focused=true;},
    close(){this.destroyed=true; this.emit('closed');}});
  const screen = Object.assign(new EventEmitter(), {displays: [display], getAllDisplays(){return this.displays;}, getPrimaryDisplay(){return this.displays[0];}});
  const shortcuts = {registered:false, suspended:false, callback:null, attempts:0,
    register(key, callback){assert.equal(key, RECOVERY_SHORTCUT); this.attempts++; if(options.registrationThrows) throw Error('shortcut'); this.registered=options.registered !== false; this.callback=callback; return this.registered;},
    isRegistered(){return this.registered;}, isSuspended(){return this.suspended;}, unregister(){this.registered=false;}};
  const store = new WindowStateStore(root);
  if(options.corrupt) {mkdirSync(root,{recursive:true}); writeFileSync(join(root,'window-bounds.json'),'{bad');}
  let changes=0;
  const interaction = {locked:false,suspended:false};
  const controls = new WindowControls({store, screen, shortcuts, interactionAllowed:()=>!interaction.locked && !interaction.suspended, changed:()=>changes++});
  const initial = controls.initialBounds(); controls.attach(window);
  t.after(()=>{controls.dispose(); rmSync(root,{recursive:true,force:true});});
  return {root,window,screen,shortcuts,store,controls,interaction,initial,changes:()=>changes};
}
test('기본 OFF이며 복구 단축키를 확보한 후에만 클릭 통과를 허용한다', t => {
  const f=fixture(t); assert.equal(f.controls.snapshot().clickThrough,false);
  assert.deepEqual(f.controls.setClickThrough(true),{ok:true}); assert.equal(f.window.ignored,true);
  assert.deepEqual(f.controls.setClickThrough('true'),{ok:false,code:'invalid_request'});
});
for(const options of [{registered:false},{registrationThrows:true}]) test('단축키 등록 실패는 클릭 통과를 차단한다 '+JSON.stringify(options), t=>{
  const f=fixture(t,options); assert.equal(f.controls.snapshot().recoveryAvailable,false);
  assert.deepEqual(f.controls.setClickThrough(true),{ok:false,code:'shortcut_unavailable'}); assert.equal(f.window.ignored,false);
});
test('전역 복구는 클릭 통과 해제, 최소화 복원, 화면 안 보정, 표시와 포커스를 수행한다', t=>{
  const f=fixture(t); f.controls.setClickThrough(true); f.window.minimized=true; f.window.bounds.x=99999;
  f.shortcuts.callback(); assert.equal(f.window.ignored,false); assert.equal(f.window.minimized,false);
  assert.equal(f.window.bounds.x,1120); assert.equal(f.window.shown,true); assert.equal(f.window.focused,true);
});
test('잠금 뒤 대기하던 ON 요청은 거부하고 잠금 해제 후에도 OFF를 유지한다', t=>{
  const f=fixture(t);f.controls.setClickThrough(true);
  f.interaction.locked=true;f.controls.disableClickThrough();
  assert.deepEqual(f.controls.setClickThrough(true),{ok:false,code:'interaction_blocked'});
  assert.deepEqual(f.controls.setClickThrough(false),{ok:true});
  f.interaction.locked=false;assert.equal(f.controls.snapshot().clickThrough,false);assert.equal(f.window.ignored,false);
});
test('절전과 잠금이 겹치면 두 상태가 해제되기 전에는 ON 요청을 허용하지 않는다', t=>{
  const f=fixture(t);f.interaction.locked=true;f.interaction.suspended=true;f.controls.disableClickThrough();
  f.interaction.suspended=false;assert.deepEqual(f.controls.setClickThrough(true),{ok:false,code:'interaction_blocked'});
  f.interaction.locked=false;assert.equal(f.window.ignored,false);
  assert.deepEqual(f.controls.setClickThrough(true),{ok:true});
});
test('등록 상실과 단축키 중단 상태는 클릭 통과를 즉시 해제하고 다시 켜지 않는다', t=>{
  const f=fixture(t); f.controls.setClickThrough(true); f.shortcuts.suspended=true; f.controls.checkRecovery();
  assert.equal(f.window.ignored,false); assert.equal(f.controls.snapshot().recoveryAvailable,false);
  f.shortcuts.suspended=false; f.controls.checkRecovery(); assert.equal(f.window.ignored,false);
  f.controls.setClickThrough(true); f.shortcuts.registered=false; f.controls.checkRecovery(); assert.equal(f.window.ignored,false);
});
test('native 클릭 통과 해제 실패 시 조작 불가능한 창을 남기지 않는다', t=>{
  const f=fixture(t); f.controls.setClickThrough(true);
  f.window.setIgnoreMouseEvents=()=>{throw Error('native');};
  assert.deepEqual(f.controls.setClickThrough(false),{ok:false,code:'window_unavailable'}); assert.equal(f.window.destroyed,true);
});
test('이동 저장과 재시작 복구에서 클릭 통과 상태는 저장하지 않는다', t=>{
  const f=fixture(t); f.controls.setClickThrough(true); f.controls.flushBounds();
  const data=JSON.parse(readFileSync(join(f.root,'window-bounds.json'),'utf8'));
  assert.deepEqual(Object.keys(data).sort(),['bounds','displayId','version']);
  const second=new WindowControls({store:new WindowStateStore(f.root),screen:f.screen,shortcuts:f.shortcuts,interactionAllowed:()=>true,changed:()=>{}});
  assert.deepEqual(second.initialBounds().bounds,f.window.bounds); assert.equal(second.snapshot().clickThrough,false); second.dispose();
});
test('최소화와 최대화는 마지막 일반 창 위치를 덮어쓰지 않는다', t=>{
  const f=fixture(t); f.controls.flushBounds(); const before=f.store.read();
  f.window.minimized=true; f.window.bounds={x:-32000,y:-32000,width:0,height:0}; f.controls.flushBounds();
  assert.deepEqual(f.store.read(),before); f.window.minimized=false; f.window.maximized=true; f.controls.flushBounds(); assert.deepEqual(f.store.read(),before);
});
test('이동 직후 최소화하거나 최대화해도 대기 중인 일반 창 위치를 저장한다', t=>{
  const f=fixture(t); f.window.bounds.x=330; f.window.emit('move');
  f.window.minimized=true; f.window.bounds={x:-32000,y:-32000,width:0,height:0}; f.controls.flushBounds();
  assert.equal(f.store.read()?.bounds.x,330);
});
test('모니터 변경은 최소 크기를 조정하고 조작 가능하게 돌린다', t=>{
  const f=fixture(t); f.controls.setClickThrough(true); f.screen.displays=[{id:2,workArea:{x:0,y:0,width:480,height:500}}];
  f.screen.emit('display-removed'); assert.equal(f.window.ignored,false); assert.deepEqual(f.window.min,[480,500]);
  assert.deepEqual(f.window.bounds,{x:0,y:0,width:480,height:500});
});
test('작은 화면에서 큰 화면으로 옮기면 기본 최소 크기를 다시 적용한다', t=>{
  const f=fixture(t),small={id:2,workArea:{x:0,y:0,width:480,height:500}};
  f.screen.displays=[small];f.screen.emit('display-removed');
  f.screen.displays=[small,{id:1,workArea:{x:480,y:0,width:1920,height:1040}}];
  f.window.bounds={x:600,y:0,width:480,height:500};f.window.emit('move');f.controls.flushBounds();
  assert.deepEqual(f.window.min,[560,640]);
});
test('모니터 전환 중 빈 목록에서 복원 이벤트가 와도 클릭 통과를 끄고 앱을 유지한다', t=>{
  const f=fixture(t);f.controls.setClickThrough(true);f.screen.displays=[];
  assert.doesNotThrow(()=>f.window.emit('restore'));assert.equal(f.window.ignored,false);
});
test('손상된 저장 파일은 보존하며 복구 경로와 일반 창 사용은 유지한다', t=>{
  const f=fixture(t,{corrupt:true}); assert.equal(f.controls.snapshot().boundsPersistenceError,true);
  f.controls.flushBounds(); assert.equal(readFileSync(join(f.root,'window-bounds.json'),'utf8'),'{bad');
  assert.deepEqual(f.controls.recover(),{ok:true});
});
test('저장 실패는 표시하고 다음 정상 저장으로 회복한다', t=>{
  const f=fixture(t),write=f.store.write.bind(f.store); f.store.write=()=>{throw Error('disk');}; f.controls.flushBounds();
  assert.equal(f.controls.snapshot().boundsPersistenceError,true); f.store.write=write; f.controls.flushBounds();
  assert.equal(f.controls.snapshot().boundsPersistenceError,false);
});
test('종료 시 변경을 저장하고 자기 단축키와 디스플레이 리스너만 정리한다', t=>{
  const f=fixture(t); f.window.bounds.x=220; f.window.emit('close'); f.window.close();
  assert.equal(f.store.read().bounds.x,220); assert.equal(f.shortcuts.registered,false);
  assert.equal(f.screen.listenerCount('display-removed'),0);
  assert.deepEqual(f.controls.setClickThrough(true),{ok:false,code:'window_unavailable'});
});

test('native 복원 오차를 정정하고 정상 크기에 대한 복구는 다시 setBounds하지 않는다', t=>{
  const f=fixture(t);f.controls.dispose();const expected={version:1,displayId:1,bounds:{x:100,y:100,width:801,height:681}};
  f.store.write(expected);f.window.bounds={...expected.bounds,width:804,height:683};let calls=0;
  f.window.setBounds=value=>{calls++;f.window.bounds={...value,width:value.width+1};};
  const controls=new WindowControls({store:f.store,screen:f.screen,shortcuts:f.shortcuts,interactionAllowed:()=>true,changed:()=>{}});
  controls.initialBounds();controls.attach(f.window);t.after(()=>controls.dispose());
  assert.deepEqual(f.window.bounds,expected.bounds);assert.equal(calls,2);
  controls.recover();controls.flushBounds();assert.equal(calls,2);assert.deepEqual(f.store.read(),expected);
});

test('비수렴 복원 결과는 원본 저장값에 누적하지 않고 이후 사용자 변경은 저장한다', t=>{
  const f=fixture(t);f.controls.dispose();const expected={version:1,displayId:1,bounds:{x:100,y:100,width:801,height:681}};
  f.store.write(expected);f.window.bounds={...expected.bounds,width:804,height:683};
  f.window.setBounds=value=>{f.window.bounds={...value,width:Math.ceil(value.width/2)*2,height:Math.ceil(value.height/2)*2};};
  const controls=new WindowControls({store:f.store,screen:f.screen,shortcuts:f.shortcuts,interactionAllowed:()=>true,changed:()=>{}});
  controls.initialBounds();controls.attach(f.window);t.after(()=>controls.dispose());
  controls.flushBounds();controls.recover();controls.flushBounds();assert.deepEqual(f.store.read(),expected);
  f.window.emit('will-resize');f.window.bounds={x:200,y:100,width:900,height:700};
  controls.recover();assert.deepEqual(f.window.bounds,{x:200,y:100,width:900,height:700});
  f.window.emit('resized');controls.flushBounds();assert.deepEqual(f.store.read().bounds,f.window.bounds);
});

test('native setter 실패에도 창을 사용할 수 있고 저장된 복원값은 보존한다', t=>{
  const f=fixture(t);f.controls.dispose();const expected={version:1,displayId:1,bounds:{x:100,y:100,width:801,height:681}};
  f.store.write(expected);f.window.bounds={...expected.bounds,width:804};
  f.window.setBounds=()=>{throw Error('native');};
  const controls=new WindowControls({store:f.store,screen:f.screen,shortcuts:f.shortcuts,interactionAllowed:()=>true,changed:()=>{}});
  controls.initialBounds();assert.doesNotThrow(()=>controls.attach(f.window));t.after(()=>controls.dispose());
  controls.flushBounds();assert.deepEqual(f.store.read(),expected);assert.deepEqual(controls.setClickThrough(false),{ok:true});
});

test('조정 도중 DPI/화면이 바뀌면 이전 좌표 보정을 멈추고 새 workArea로 다시 맞춘다', async t=>{
  const f=fixture(t);let calls=0;
  f.window.bounds.x=99999;
  f.window.setBounds=value=>{
    calls++;f.window.bounds={...value};
    if(calls===1) f.screen.displays=[{id:2,workArea:{x:0,y:0,width:900,height:800},scaleFactor:1.5}];
    f.window.emit('resize');
  };
  f.controls.recover();assert.equal(calls,1);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(calls<=3);assert.ok(f.window.bounds.x+f.window.bounds.width<=900);
  f.controls.flushBounds();assert.equal(f.store.read().displayId,2);
});
