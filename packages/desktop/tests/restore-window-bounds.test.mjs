import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreWindowBounds} from '../dist-electron/main/window/restore-window-bounds.js';
const target = {x:20,y:20,width:801,height:681};
function fixture(convert = value => value) {
  let actual = {...target,width:804,height:683}; const calls = [];
  return {calls, getBounds:()=>({...actual}), setBounds(value){calls.push({...value}); actual=convert({...value});}};
}
test('measured native error converges without a fixed pixel or DPI offset', () => {
  for (const offset of [1, 3, 7]) {
    const window=fixture(value=>({...value,width:value.width+offset}));
    assert.equal(restoreWindowBounds(window,target,()=>true),true);
    assert.deepEqual(window.getBounds(),target);assert.equal(window.calls.length,2);
    assert.equal(restoreWindowBounds(window,target,()=>true),true);assert.equal(window.calls.length,2);
  }
});
test('unrepresentable values stop on an oscillating command and retain the nearest observation', () => {
  const window=fixture(value=>({...value,width:Math.ceil(value.width/2)*2,height:Math.ceil(value.height/2)*2}));
  assert.equal(restoreWindowBounds(window,target,()=>true),false);
  assert.ok(window.calls.length<=4);
  assert.ok(Math.abs(window.getBounds().width-target.width)<=1);
});
test('DPI or user interaction changes stop correction before another native request', () => {
  let stable=true;
  const window=fixture(value=>{stable=false;return {...value,width:value.width+2};});
  assert.equal(restoreWindowBounds(window,target,()=>stable),false);assert.equal(window.calls.length,1);
  const blocked=fixture();assert.equal(restoreWindowBounds(blocked,target,()=>false),false);assert.equal(blocked.calls.length,0);
});
test('nonconvergent native constraints have a strict four-call ceiling', () => {
  const window=fixture(()=>({x:0,y:0,width:560,height:640}));
  assert.equal(restoreWindowBounds(window,target,()=>true),false);assert.ok(window.calls.length<=4);
});
