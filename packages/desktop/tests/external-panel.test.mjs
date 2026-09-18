import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive } from 'vue';

const { descriptor } = parse(readFileSync(new URL('../src/renderer/components/ExternalToolsPanel.vue', import.meta.url), 'utf8'));
const script = compileScript(descriptor, { id: 'external-panel-test' });
const { outputFiles } = await build({
  stdin: { contents: script.content, loader: 'ts', resolveDir: fileURLToPath(new URL('../src/renderer/components/', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'vue-entry', setup(api) {
    api.onResolve({ filter: /^vue$/ }, () => ({ path: import.meta.resolve('vue'), external: true }));
    api.onLoad({filter:/\.vue$/}, args=>({contents:compileScript(parse(readFileSync(args.path,'utf8')).descriptor,{id:'external-child-test'}).content,loader:'ts'}));
  } }],
});
const { default: Panel } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const renderer = createRenderer({
  createElement: type => ({ type, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert: (node, parent) => { parent.children.push(node); }, remove() {}, patchProp() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
});
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); };
const connection = id => ({ id, kind: 'google', label: id, destination: 'Google', phase: 'ready', errorCode: null, tools: [] });
const initial = () => ({ available: true, connections: [connection('connection-a'), connection('connection-b')], actions: [] });
const event = () => ({ id: 'event-a', summary: '기존 일정', description: '기존 설명', location: '기존 장소', editable: true,
  start: { dateTime: '2026-09-10T01:00:30.123Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-09-10T02:05:45.678Z', timeZone: 'Europe/London' } });

async function fixture(t) {
  const hooks = {}, calls = [];
  const bridge = { getExternalState: async () => hooks.read ? hooks.read() : initial() };
  for (const method of ['listExternalEvents', 'listExternalCalendars', 'addGoogleCalendar', 'addMcpConnection', 'previewExternalAction', 'approveExternalAction', 'cancelExternalConnections']) {
    bridge[method] = async input => { calls.push({ method, input: structuredClone(input) }); return hooks[method] ? hooks[method](input) : method.startsWith('list') ? [] : null; };
  }
  const previous = globalThis.window; globalThis.window = { kirianDesktop: bridge };
  const props = reactive({ enabled: true }), component = { ...Panel, render: () => null };
  const app = renderer.createApp({ render: () => h(component, props) }); app.mount({ children: [] });
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; app.unmount(); } };
  t.after(() => { unmount(); globalThis.window = previous; });
  await flush();
  const state = app._instance.subTree.component.setupState;
  state.connectionId = 'connection-a'; await flush(); state.calendarId = 'calendar-a'; await flush();
  return { state, props, hooks, calls, unmount };
}

test('캘린더를 바꾼 뒤 도착한 이전 일정 조회를 새 대상에 표시하지 않는다', async t => {
  const f = await fixture(t), late = deferred(); f.hooks.listExternalEvents = () => late.promise;
  const waiting = f.state.loadEvents(); await flush(); f.state.calendarId = 'calendar-b'; await flush();
  late.resolve([event()]); await waiting;
  assert.equal(f.state.calendarId, 'calendar-b'); assert.deepEqual(f.state.events, []); assert.equal(f.state.busy, false);
});

test('다른 캘린더를 거쳐 원래 대상으로 돌아와도 이전 조회를 폐기한다', async t => {
  const f = await fixture(t), late = deferred(); f.hooks.listExternalEvents = () => late.promise;
  const waiting = f.state.loadEvents(); await flush(); f.state.calendarId = 'calendar-b'; await flush(); f.state.calendarId = 'calendar-a'; await flush();
  late.resolve([event()]); await waiting; assert.deepEqual(f.state.events, []);
});

test('계정 연결을 바꾼 뒤 도착한 이전 캘린더 목록을 폐기한다', async t => {
  const f = await fixture(t), late = deferred(); f.hooks.listExternalCalendars = () => late.promise;
  const waiting = f.state.loadCalendars(); await flush(); f.state.connectionId = 'connection-b'; await flush();
  late.resolve([{ id: 'old-calendar', label: '이전 목록' }]); await waiting; assert.deepEqual(f.state.calendars, []);
});

test('비활성화 뒤 완료된 계정 추가는 이전 선택을 복원하지 않는다', async t => {
  const f = await fixture(t), late = deferred(); f.hooks.addGoogleCalendar = () => late.promise;
  const waiting = f.state.add('google'); await flush(); f.props.enabled = false; await flush();
  late.resolve(connection('old-account')); await waiting; assert.equal(f.state.connectionId, ''); assert.equal(f.state.state.available, false);
});

test('이전 연결에서 발생한 즉시 취소 오류가 새 화면 오류를 덮지 않는다', async t => {
  const f = await fixture(t), late = deferred();
  const waiting = f.state.immediate(() => late.promise); f.props.enabled = false; await flush(); f.props.enabled = true; await flush();
  f.state.error = '현재 화면의 안내'; late.reject(new Error('old_request_failed')); await waiting;
  assert.equal(f.state.error, '현재 화면의 안내');
});

test('역순으로 완료된 상태 조회는 최신 실행 상태를 되돌리지 않는다', async t => {
  const f = await fixture(t), late = deferred(); let reads = 0;
  f.hooks.read = () => ++reads === 1 ? late.promise : { ...initial(), connections: [connection('latest-connection')] };
  const old = f.state.refresh(); await f.state.refresh(); late.resolve(initial()); await old;
  assert.equal(f.state.state.connections[0].id, 'latest-connection');
});

test('제목만 수정할 때 원래 초·밀리초·시간대를 정확히 보존한다', async t => {
  const f = await fixture(t), original = event(); f.state.selectEvent(original); f.state.summary = '변경 제목';
  await f.state.preview(); const request = f.calls.find(c => c.method === 'previewExternalAction').input;
  assert.deepEqual(request.event.start, original.start); assert.deepEqual(request.event.end, original.end);
  assert.equal(request.event.summary, '변경 제목');
});

test('사용자가 시작만 바꾸면 시작만 PC 시간대로 변환하고 종료는 보존한다', async t => {
  const f = await fixture(t), original = event(); f.state.selectEvent(original); f.state.start = '2026-09-12T09:15';
  await f.state.preview(); const request = f.calls.find(c => c.method === 'previewExternalAction').input;
  assert.deepEqual(request.event.start, { dateTime: new Date('2026-09-12T09:15').toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  assert.deepEqual(request.event.end, original.end);
});

test('선택한 원본 이벤트 객체의 후속 변경은 미변경 시간에 섞이지 않는다', async t => {
  const f = await fixture(t), original = event(), start = structuredClone(original.start); f.state.selectEvent(original);
  original.start.dateTime = '2030-01-01T00:00:00Z'; await f.state.preview();
  assert.deepEqual(f.calls.find(c => c.method === 'previewExternalAction').input.event.start, start);
});

test('종일 일정의 종료일 배타 경계를 제목 수정에서 유지한다', async t => {
  const f = await fixture(t), original = { ...event(), start: { date: '2026-09-10' }, end: { date: '2026-09-11' } };
  f.state.selectEvent(original); f.state.summary = '제목 변경'; await f.state.preview();
  const request = f.calls.find(c => c.method === 'previewExternalAction').input;
  assert.deepEqual(request.event.start, original.start); assert.deepEqual(request.event.end, original.end);
});

test('해제된 화면은 늦은 일정 조회를 반영하지 않는다', async t => {
  const f = await fixture(t), late = deferred(); f.hooks.listExternalEvents = () => late.promise;
  const waiting = f.state.loadEvents(); await flush(); f.unmount(); late.resolve([event()]); await waiting;
  assert.deepEqual(f.state.events, []);
});

test('현재 선택에서 성공한 캘린더·일정 조회와 계정 추가는 화면에 반영한다', async t => {
  const f = await fixture(t), calendar = { id: 'calendar-a', label: '현재 캘린더', timeZone: 'Asia/Seoul', canWrite: true, accessRole: 'owner' };
  f.hooks.listExternalCalendars = () => [calendar]; await f.state.loadCalendars(); assert.deepEqual(f.state.calendars, [calendar]);
  f.hooks.listExternalEvents = () => [event()]; await f.state.loadEvents(); assert.deepEqual(f.state.events, [event()]);
  f.hooks.addGoogleCalendar = () => connection('new-connection'); await f.state.add('google'); assert.equal(f.state.connectionId, 'new-connection');
});

test('MCP 기본 미리보기는 실제 도구·입력값을 보존하고 내부 실행 메타데이터를 접는다', async t => {
  const f = await fixture(t);
  const action = { providerId: 'mcp', argumentsJson: JSON.stringify({ providerId: 'mcp', generation: 'internal-generation', fingerprint: 'internal-fingerprint', payload: { name: 'notes.write', arguments: { text: '사용자가 검토할 내용', path: '/note.md' }, inputSchema: { type: 'object' } } }) };
  const before = action.argumentsJson, review = JSON.parse(f.state.reviewPayload(action));
  assert.deepEqual(review, { tool: 'notes.write', arguments: { text: '사용자가 검토할 내용', path: '/note.md' } });
  assert.equal(action.argumentsJson, before);
  assert(descriptor.template.content.includes('data-testid="external-review-payload">{{ reviewPayload(action) }}'));
  assert(descriptor.template.content.includes('<summary>전체 실행 기록</summary>'));
});

test('Google 기본 미리보기는 계정·캘린더·변경 전후 시간을 보존한다', async t => {
  const f = await fixture(t), original = event(), fields = { summary: original.summary, description: original.description, location: original.location, start: original.start, end: original.end };
  const action = { providerId: 'google_calendar', argumentsJson: JSON.stringify({ generation: 'internal-generation', payload: { calendarPlan: { accountLabel: 'fixture@example.test', calendarId: 'calendar-a', calendarLabel: '개인 일정', calendarTimeZone: 'Asia/Seoul', operation: 'update', before: { ...fields, id: original.id, etag: '"etag"' }, event: { ...fields, summary: '변경된 제목' }, marker: 'private-marker' } } }) };
  const before = action.argumentsJson, review = JSON.parse(f.state.reviewPayload(action));
  assert.equal(review.account, 'fixture@example.test'); assert.equal(review.calendar.id, 'calendar-a'); assert.equal(review.operation, 'update');
  assert.deepEqual(review.before.start, original.start); assert.deepEqual(review.event.end, original.end); assert.equal(review.event.summary, '변경된 제목');
  assert(!f.state.reviewPayload(action).includes('private-marker')); assert.equal(action.argumentsJson, before);
});

test('철회·만료된 Google 인증은 새 OAuth 연결을 안내하고 실행을 반복하지 않는다', async t => {
  const f = await fixture(t);
  f.hooks.listExternalCalendars = () => { throw new Error('google_reconnect_required'); };
  await f.state.loadCalendars();
  assert.match(f.state.error, /Google 계정 연결 버튼/);
  assert.match(f.state.error, /이전 실행은 자동으로 반복하지 않아요/);
  assert.deepEqual(f.calls.map(call => call.method), ['listExternalCalendars']);
});

for (const status of ['failed', 'unknown']) {
  test(`Google ${status} 실행 기록의 인증 오류도 새 OAuth 연결을 안내하며 재실행하지 않는다`, async t => {
    const f = await fixture(t);
    const pending = { draftId: 'google-draft', revision: 1, payloadSha256: 'a'.repeat(64), argumentsJson: '{}', target: 'calendar-a', accountLabel: 'fixture@example.test', expiresAt: Date.now() + 60_000, status: 'pending', errorCode: null };
    let action = pending;
    f.hooks.read = () => ({ ...initial(), actions: [action] });
    f.hooks.approveExternalAction = () => action = { ...pending, status, errorCode: 'google_reconnect_required' };
    await f.state.refresh(); f.state.opened = true;
    f.state.acknowledge(pending, { target: { checked: true } }); await f.state.approve(pending);
    const receipt = f.state.state.actions[0];
    assert.equal(receipt.status, status);
    assert.match(f.state.actionError(receipt.errorCode), /Google 계정 연결 버튼/);
    assert.match(f.state.actionError(receipt.errorCode), /이전 실행은 자동으로 반복하지 않아요/);
    assert(descriptor.template.content.includes('{{ actionError(action.errorCode) }}'));
    await f.state.approve(receipt);
    assert.deepEqual(f.calls.map(call => call.method), ['approveExternalAction']);
  });
}
