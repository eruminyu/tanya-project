import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWindowBounds, parseSavedBounds } from '../dist-electron/main/window/window-bounds.js';
const primary = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}, scaleFactor: 1};
const left = {id: 2, workArea: {x: -1280, y: 0, width: 1280, height: 984}, scaleFactor: 1.5};
const saved = (bounds, displayId = 1) => ({version: 1, bounds, displayId});
test('처음 실행은 주 화면 안에서 기본 크기로 배치한다', () => {
  assert.deepEqual(fitWindowBounds(null, [left, primary], 1), {
    bounds: {x: 400, y: 130, width: 1120, height: 780}, displayId: 1, minWidth: 560, minHeight: 640});
});
test('음수 좌표의 보조 화면과 DIP 크기를 재시작에도 보존한다', () => {
  const bounds = {x: -1200, y: 20, width: 800, height: 700};
  assert.deepEqual(fitWindowBounds(saved(bounds, 2), [primary, left], 1).bounds, bounds);
  assert.deepEqual(fitWindowBounds(saved(bounds, 2), [primary, {...left, scaleFactor: 2}], 1).bounds, bounds);
});
test('모니터 제거와 화면 밖 좌표는 남은 화면 안으로 보정한다', () => {
  assert.deepEqual(fitWindowBounds(saved({x: -1200, y: -999, width: 800, height: 700}, 2), [primary], 1).bounds,
    {x: 0, y: 0, width: 800, height: 700});
  assert.deepEqual(fitWindowBounds(saved({x: 90000, y: 90000, width: 800, height: 700}), [primary], 1).bounds,
    {x: 1120, y: 340, width: 800, height: 700});
});
test('축소된 작업 영역과 최소 크기를 동시에 충족한다', () => {
  const small = {id: 1, workArea: {x: 0, y: 30, width: 480, height: 500}, scaleFactor: 2.5};
  assert.deepEqual(fitWindowBounds(saved({x: 100, y: 100, width: 800, height: 700}), [small], 1),
    {bounds: {x: 0, y: 30, width: 480, height: 500}, displayId: 1, minWidth: 480, minHeight: 500});
  assert.equal(fitWindowBounds(saved({x: 10, y: 10, width: 1, height: 1}), [primary], 1).bounds.height, 640);
});
test('정상 창 이동은 가장 많이 겹친 화면을 선택하고 화면 틈은 가까운 화면으로 보정한다', () => {
  const bounds = {x: -1000, y: 30, width: 800, height: 700};
  assert.equal(fitWindowBounds(saved(bounds, null), [primary, left], 1).displayId, 2);
  const distant = {...left, workArea: {...left.workArea, x: -4000}};
  assert.equal(fitWindowBounds(saved({x: -2400, y: 10, width: 600, height: 650}, null), [primary, distant], 1).displayId, 2);
});
test('저장 형식은 유한한 정수와 허용된 필드만 수용한다', () => {
  const valid = saved({x: 0, y: 0, width: 800, height: 700});
  assert.deepEqual(parseSavedBounds(valid), valid);
  for (const value of [null, [], {...valid, version: 2}, {...valid, clickThrough: true}, {...valid, displayId: '1'},
    {...valid, bounds: {...valid.bounds, x: Infinity}}, {...valid, bounds: {...valid.bounds, x: 0.5}},
    {...valid, bounds: {...valid.bounds, width: 0}}, {...valid, bounds: {...valid.bounds, height: 1e9}}])
    assert.throws(() => parseSavedBounds(value));
});
