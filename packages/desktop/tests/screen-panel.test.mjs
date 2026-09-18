import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick, reactive } from 'vue';

const source = readFileSync(new URL('../src/renderer/components/ScreenPanel.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: 'screen-panel-test' });
const { outputFiles } = await build({
  stdin: { contents: script.content, loader: 'ts', resolveDir: fileURLToPath(new URL('../src/renderer/components/', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'es2022',
  plugins: [{ name: 'vue-entry', setup(api) {
    api.onResolve({ filter: /^vue$/ }, () => ({ path: import.meta.resolve('vue'), external: true }));
  } }],
});
const { default: ScreenPanel } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// Execute the actual component setup and Vue lifecycle without Electron or a screen capture API.
const renderer = createRenderer({
  createElement: type => ({ type, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert: (node, parent) => { parent.children.push(node); }, remove() {}, patchProp() {},
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; },
  parentNode: () => null, nextSibling: () => null,
});
const empty = () => ({ version: 1, available: true, phase: 'idle', targets: [], preview: null, analysis: null, saved: [], error: null });
const preview = () => ({ id: 'capture-one', revision: 1, title: '선택한 창', capturedAt: 1_800_000_000_000,
  width: 800, height: 600, boundary: 'local', dataUrl: 'data:image/png;base64,AAAA' });
const analysis = () => ({ sourceId: 'analysis-source', revision: 1, screenSourceId: 'screen-source', screenRevision: 1,
  text: '실제 완료된 분석', actualModel: { provider_id: 'local', model_id: 'vision', endpoint_id: 'local-endpoint' } });
const saved = () => ({ captureId: 'old-capture', sourceId: 'old-source', revision: 3, title: '이전 창',
  capturedAt: 1_800_000_000_000, boundary: 'local', imageAvailable: false, analysisSourceId: 'old-analysis', actualModel: analysis().actualModel });
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
};
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); };

async function fixture(t, { initial = empty(), firstRead } = {}) {
  const calls = [], listeners = new Set(), hooks = {};
  let current = structuredClone(initial), reads = 0;
  const publish = patch => {
    current = { ...current, ...structuredClone(patch), version: current.version + 1 };
    for (const listener of listeners) listener(structuredClone(current));
  };
  const bridge = {
    getScreenState: async () => { calls.push({ method: 'get' }); reads += 1; return reads === 1 && firstRead ? firstRead : structuredClone(current); },
    subscribeScreens: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshRouting: async () => ({ok:true}),
  };
  for (const method of ['listScreenSources', 'captureScreen', 'analyzeScreen', 'cancelScreenAnalysis', 'releaseScreenPreview', 'deleteScreenCapture', 'useScreenAnalysis', 'refreshSavedScreens']) {
    bridge[method] = async input => {
      calls.push({ method, input: structuredClone(input) });
      return hooks[method] ? hooks[method](input) : { ok: true };
    };
  }
  const previousWindow = globalThis.window;
  globalThis.window = { kirianDesktop: bridge };
  const props = reactive({ enabled: true, brain: { phase: 'ready', reason: null, url: 'http://127.0.0.1:8766', selectedModelId: 'text',
    models: [
      { id: 'text', label: '텍스트 모델', providerId: 'local', modelId: 'text', supportsImages: false, boundary: 'local' },
      { id: 'vision', label: '로컬 이미지 모델', providerId: 'local', modelId: 'vision', supportsImages: true, boundary: 'local' },
      { id: 'lan-vision', label: '개인 서버 모델', providerId: 'lan', modelId: 'vision', supportsImages: true, boundary: 'private_lan' },
      { id: 'cloud-vision', label: '외부 API', providerId: 'cloud', modelId: 'vision', supportsImages: true, boundary: 'cloud' },
    ], speech: { available: false, enabled: false, label: null, phase: 'idle', sentence: null, error: null }, transcription: { available: false, label: null } },
    library: { available: true, conversationId: 'conversation', conversations: [], sources: [], selectedSourceIds: [], defaultModelId: 'vision', defaultMissing: false } });
  const app = renderer.createApp({ ...ScreenPanel, render: () => null }, props);
  app.mount({ children: [] });
  const state = app._instance.setupState;
  t.after(() => { app.unmount(); globalThis.window = previousWindow; });
  await flush();
  return { state, props, calls, hooks, publish, listeners, app };
}
const commandCalls = f => f.calls.filter(call => call.method !== 'get');

test('mount, prop changes and received metadata never list, capture, analyze or select references automatically', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 1); assert.equal(f.listeners.size, 1);
  f.props.brain.selectedModelId = 'vision';
  f.publish({ targets: [{ id: 'window:one', name: '선택 가능한 창', kind: 'window' }], saved: [saved()] });
  await flush();
  assert.equal(f.state.selectedTarget, '');
  assert.deepEqual(commandCalls(f), []);
  f.state.capture(); await flush();
  assert.deepEqual(commandCalls(f), []);
  f.state.selectedTarget = 'window:one'; f.state.selectedBoundary = 'private_lan';
  f.state.capture(); await flush();
  assert.deepEqual(commandCalls(f), [{ method: 'captureScreen', input: { sourceId: 'window:one', boundary: 'private_lan' } }]);
});

test('unsupported defaults and disallowed model boundaries block analysis without an automatic replacement', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview() } });
  f.state.imageLoaded = true;
  assert.equal(f.state.modelId, 'text'); assert.equal(f.state.canAnalyze, false);
  f.state.analyze(); await flush(); assert.deepEqual(commandCalls(f), []);
  f.state.selectedModelId = 'lan-vision'; assert.equal(f.state.canAnalyze, false);
  f.state.selectedModelId = 'cloud-vision'; assert.equal(f.state.canAnalyze, false);
  f.state.selectedModelId = 'vision'; assert.equal(f.state.canAnalyze, true);
  f.state.prompt = '🙂'.repeat(2049); assert.equal(f.state.canAnalyze, false);
  f.state.prompt = '🙂'.repeat(2048); assert.equal(f.state.canAnalyze, true);
  f.state.analyze(); await flush();
  assert.equal(commandCalls(f).length, 1);
  assert.deepEqual(commandCalls(f)[0], { method: 'analyzeScreen', input: {
    captureId: 'capture-one', revision: 1, modelId: 'vision', prompt: '🙂'.repeat(2048),
  } });
});

test('preview pixels must be locally held and loaded before explicit analysis can run', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview() } });
  f.state.selectedModelId = 'vision';
  assert.equal(f.state.canAnalyze, false);
  f.state.imageLoaded = true; assert.equal(f.state.canAnalyze, true);
  f.publish({ preview: { ...preview(), dataUrl: 'https://example.com/screen.png' } }); await flush();
  assert.equal(f.state.previewUrl, null); assert.equal(f.state.canAnalyze, false);
  f.state.analyze(); await flush(); assert.deepEqual(commandCalls(f), []);
});

test('completed analysis is not reanalyzed or selected for chat until the explicit reference button', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview(), analysis: analysis() } });
  f.state.selectedModelId = 'vision'; f.state.imageLoaded = true;
  assert.equal(f.state.canAnalyze, false); assert.equal(f.state.analysisSelected, false);
  f.state.analyze(); await flush(); assert.deepEqual(commandCalls(f), []);
  f.state.useAnalysis(); await flush();
  assert.deepEqual(commandCalls(f), [{ method: 'useScreenAnalysis', input: { captureId: 'capture-one', revision: 1 } }]);
  f.props.library.selectedSourceIds = ['analysis-source']; await flush();
  assert.equal(f.state.analysisSelected, true);
  f.state.useAnalysis(); await flush(); assert.equal(commandCalls(f).length, 1);
});

test('releasing a completed preview preserves the analysis record and never automatically lists or captures again', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview(), analysis: analysis() } });
  const completed = { ...saved(), captureId: 'capture-one', revision: 1, analysisSourceId: 'analysis-source' };
  f.hooks.releaseScreenPreview = () => {
    f.publish({ phase: 'idle', preview: null, analysis: null, saved: [completed] }); return { ok: true };
  };
  f.state.releasePreview(); await flush();
  assert.deepEqual(commandCalls(f), [{ method: 'releaseScreenPreview', input: undefined }]);
  assert.equal(f.state.screens.preview, null);
  assert.deepEqual(f.state.screens.saved, [completed]);
  assert.equal(f.state.selectedTarget, ''); assert.equal(f.state.canCapture, false);
  f.state.releasePreview(); await flush(); assert.equal(commandCalls(f).length, 1);
});

test('cancel remains callable during a pending analysis and its late failure cannot replace cancellation state', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview() } });
  f.state.selectedModelId = 'vision'; f.state.imageLoaded = true;
  const pending = deferred();
  f.hooks.analyzeScreen = () => { f.publish({ phase: 'analyzing' }); return pending.promise; };
  f.hooks.cancelScreenAnalysis = () => { f.publish({ phase: 'preview', error: 'capture_cancelled' }); return { ok: true }; };
  f.state.analyze(); await flush(); assert.equal(f.state.canCancel, true);
  f.state.cancel(); await flush();
  pending.resolve({ ok: false, code: 'provider_error' }); await flush();
  assert.equal(f.state.error, 'capture_cancelled'); assert.equal(f.state.localAction, null);
  assert.equal(f.state.screens.preview.id, 'capture-one');
});

test('native capture can be cancelled before there is a preview and its late failure stays discarded', async t => {
  const f = await fixture(t);
  f.publish({ targets: [{ id: 'window:one', name: '선택한 창', kind: 'window' }] }); await flush();
  f.state.selectedTarget = 'window:one';
  const pending = deferred();
  f.hooks.captureScreen = () => { f.publish({ phase: 'capturing' }); return pending.promise; };
  f.hooks.cancelScreenAnalysis = () => { f.publish({ phase: 'idle', error: null }); return { ok: true }; };
  f.state.capture(); await flush();
  assert.equal(f.state.screens.preview, null); assert.equal(f.state.canCancel, true);
  f.state.cancel(); await flush();
  pending.resolve({ ok: false, code: 'capture_cancelled' }); await flush();
  assert.equal(f.state.screens.phase, 'idle'); assert.equal(f.state.localError, null);
  assert.equal(f.state.screens.preview, null);
});

test('failed deletion preserves preview, stored results and confirmation so the same record can be retried', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview(), analysis: analysis(), saved: [saved()] } });
  f.hooks.deleteScreenCapture = () => ({ ok: false, code: 'deletion_unconfirmed' });
  f.state.requestDelete('capture-one', 1, '선택한 창'); f.state.confirmDelete(); await flush();
  assert.equal(f.state.error, 'deletion_unconfirmed'); assert.equal(f.state.deleting.captureId, 'capture-one');
  assert.equal(f.state.screens.preview.id, 'capture-one'); assert.equal(f.state.screens.analysis.text, analysis().text);
  f.hooks.deleteScreenCapture = () => { f.publish({ preview: null, analysis: null, phase: 'idle' }); return { ok: true }; };
  f.state.confirmDelete(); await flush(); assert.equal(f.state.deleting, null);
  assert.equal(f.state.screens.preview, null);
  f.state.requestDelete('old-capture', 3, '이전 창'); f.state.confirmDelete(); await flush();
  assert.deepEqual(commandCalls(f).at(-1).input, { captureId: 'old-capture', revision: 3 });
});

test('older initial state and late command failures cannot restore screen UI after disconnect', async t => {
  const first = deferred(); const f = await fixture(t, { firstRead: first.promise });
  f.publish({ phase: 'preview', preview: preview(), analysis: analysis() }); await flush();
  first.resolve(empty()); await flush();
  assert.equal(f.state.screens.preview.id, 'capture-one');
  const pending = deferred(); f.hooks.refreshSavedScreens = () => pending.promise;
  f.state.refreshHistory(); await flush();
  f.props.brain.phase = 'disconnected'; await flush();
  assert.equal(f.state.screens.preview, null); assert.equal(f.state.screens.analysis, null);
  pending.resolve({ ok: false, code: 'provider_error' }); await flush();
  f.publish({ preview: preview(), analysis: analysis() }); await flush();
  assert.equal(f.state.screens.preview, null); assert.equal(f.state.localError, null);
  f.app.unmount(); assert.equal(f.listeners.size, 0);
});

test('reconnecting cannot restore an already retired screen snapshot before a newer host version arrives', async t => {
  const f = await fixture(t, { initial: { ...empty(), phase: 'preview', preview: preview(), analysis: analysis() } });
  f.props.brain.phase = 'disconnected'; await flush();
  assert.equal(f.state.screens.preview, null);
  // The repeated get response still contains the previous connection's version.
  f.props.brain.phase = 'ready'; await flush();
  assert.equal(f.state.screens.preview, null); assert.equal(f.state.screens.analysis, null);
  f.publish({ phase: 'idle', preview: null, analysis: null }); await flush();
  assert.equal(f.state.connected, true);
  assert.equal(f.state.screens.preview, null);
});
