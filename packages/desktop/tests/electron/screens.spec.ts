import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopSnapshot } from '../../src/shared/bridge.js';
import type { ScreenState } from '../../src/shared/screens.js';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

async function launch(profile: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KIRIAN_BRAIN_URL', 'KIRIAN_BRAIN_TOKEN', 'KIRIAN_RENDERER_URL']) delete env[key];
  return electron.launch({ cwd: desktopRoot, args: process.env.KIRIAN_PACKAGED_EXE ? [] : [desktopRoot],
    executablePath: process.env.KIRIAN_PACKAGED_EXE, env, chromiumSandbox: true });
}
async function snapshot(page: Page): Promise<DesktopSnapshot> { return page.evaluate(() => (window as any).kirianDesktop.getSnapshot()); }
async function screens(page: Page): Promise<ScreenState> { return page.evaluate(() => (window as any).kirianDesktop.getScreenState()); }
async function connect(page: Page, brain: { url: string; token: string }): Promise<void> {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url); await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await expect(page.getByTestId('brain-token')).toHaveValue('');
  await page.getByTestId('brain-settings-toggle').click();
  await expect.poll(async () => (await screens(page)).available).toBe(true);
}
async function screenPanel(page: Page, open = true): Promise<void> {
  if ((await page.getByTestId('screen-panel').getAttribute('open') !== null) !== open) await page.getByTestId('screen-toggle').click();
}
async function ownedWindow(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const fixture = new BrowserWindow({ width: 420, height: 280, show: false, focusable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Kirian owned screen fixture</title><body style="margin:0;background:rgb(31,89,147);color:white;font:24px sans-serif">KIRIAN CAPTURE FIXTURE<br />Only this test window.</body>'));
    fixture.showInactive();
    await new Promise(resolve => setTimeout(resolve, 350));
    return fixture.getMediaSourceId();
  });
}
async function captureOwned(page: Page, sourceId: string, boundary: 'local' | 'private_lan') {
  await screenPanel(page);
  await page.getByTestId('screen-boundary').selectOption(boundary);
  await page.getByTestId('screen-list').click();
  await expect(page.getByTestId('screen-target')).toBeVisible();
  await page.getByTestId('screen-target').selectOption(sourceId);
  await page.getByTestId('screen-capture').click();
  await expect(page.getByTestId('screen-preview-image')).toBeVisible();
  await expect.poll(async () => page.getByTestId('screen-preview-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  return (await screens(page)).preview!;
}
async function deletePreview(page: Page): Promise<void> {
  await page.getByTestId('screen-delete').click();
  await page.getByTestId('screen-delete-confirm').click();
  await expect(page.getByTestId('screen-preview')).toHaveCount(0);
}
async function modelId(page: Page, name: string): Promise<string> {
  const model = (await snapshot(page)).brain.models.find(item => item.modelId === name);
  expect(model).toBeDefined(); return model!.id;
}
async function chatModel(page: Page, id: string): Promise<void> {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('model-select').selectOption(id);
  await page.getByTestId('brain-settings-toggle').click();
  await expect.poll(async () => (await snapshot(page)).brain.selectedModelId).toBe(id);
}
async function captureApp(app: ElectronApplication, path: string): Promise<void> {
  const page = await app.firstWindow();
  await page.getByTestId('screen-analysis').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'kirian://app/index.html')!;
    return (await main.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64');
  });
  await writeFile(path, Buffer.from(png, 'base64'));
}

test('selected native pixels obey screen policy, explicit chat selection, cancellation and durable deletion', async () => {
  test.setTimeout(180000);
  await mkdir(output, { recursive: true }); const root = await mkdtemp(join(output, 'screens-'));
  const profile = join(root, 'profile'), data = join(root, 'brain'); await mkdir(profile);
  const requests: any[] = []; let connections = 0, chatCount = 0, slowClosed = false;
  let lateResponse: (() => void) | undefined;
  const upstream = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const query = JSON.parse(body); requests.push(query);
    response.setHeader('content-type', 'application/x-ndjson');
    const prompt = query.messages.at(-1).content;
    if (typeof prompt === 'string' && prompt.includes('SLOW_SCREEN')) {
      response.write(JSON.stringify({ model: query.model, message: { content: 'CANCELLED_PARTIAL_SCREEN' }, done: false }) + '\n');
      response.on('close', () => { slowClosed = true; });
      lateResponse = () => response.end(JSON.stringify({ model: query.model, message: { content: 'LATE_SCREEN_RESULT' }, done: true }) + '\n');
      return;
    }
    const image = query.messages.some((message: any) => Array.isArray(message.images));
    response.end(JSON.stringify({ model: query.model, message: { content: image
      ? '[HTTP 표본] SCREENFACT 파란 배경과 KIRIAN CAPTURE FIXTURE 글자입니다.' : '화면 참고 대화 ' + ++chatCount }, done: true }) + '\n');
  });
  upstream.on('connection', () => connections++);
  upstream.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port, url = 'http://127.0.0.1:' + port;
  const binding = (name: string, boundary: 'local' | 'private_lan' | 'cloud') => ({
    model: { provider_id: 'ollama', model_id: name, endpoint_id: 'test-ollama' }, label: name,
    kind: boundary === 'cloud' ? 'openai-compatible' : 'ollama', url: boundary === 'cloud' ? 'https://127.0.0.1:' + port : url,
    boundary, supports_images: true, think: false, num_ctx: 8192,
  });
  const start = () => startBrain(url, 'screen-local', 'local', { data_dir: data,
    bindings: [binding('screen-local', 'local'), binding('screen-lan', 'private_lan'), binding('screen-cloud', 'cloud')] });
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await start(); app = await launch(profile); let page = await app.firstWindow(); await connect(page, brain);
    const sourceId = await ownedWindow(app), local = await captureOwned(page, sourceId, 'local');
    const lanId = await modelId(page, 'screen-lan'), cloudId = await modelId(page, 'screen-cloud');
    const pixelCount = await app.evaluate(({ nativeImage }, dataUrl) => {
      const pixels = nativeImage.createFromDataURL(dataUrl).toBitmap(); let found = 0;
      for (let offset = 0; offset < pixels.length; offset += 4)
        if (Math.abs(pixels[offset]! - 147) < 8 && Math.abs(pixels[offset + 1]! - 89) < 8 && Math.abs(pixels[offset + 2]! - 31) < 8) found++;
      return found;
    }, local.dataUrl);
    expect(pixelCount).toBeGreaterThan(1000);
    expect(local.width).toBeLessThanOrEqual(1600); expect(local.height).toBeLessThanOrEqual(1600);
    await page.getByTestId('screen-model').selectOption(lanId);
    await expect(page.getByTestId('screen-analyze')).toBeDisabled();
    await expect(page.getByTestId('screen-model-warning')).toContainText('삭제 후 개인 LAN 허용으로 다시 캡처');
    const blocked = await page.evaluate(input => (window as any).kirianDesktop.analyzeScreen(input),
      { captureId: local.id, revision: local.revision, modelId: lanId, prompt: '권한 경계 검증' });
    expect(blocked).toEqual({ ok: false, code: 'context_blocked' });
    expect(requests).toHaveLength(0); expect(connections).toBe(0);
    expect((await screens(page)).saved).toEqual([]);
    await deletePreview(page);

    const allowed = await captureOwned(page, sourceId, 'private_lan');
    await page.getByTestId('screen-model').selectOption(lanId);
    await page.getByTestId('screen-prompt').fill('테스트 창에서 보이는 내용을 설명해 줘.');
    await page.getByTestId('screen-analyze').click();
    await expect(page.getByTestId('screen-analysis-text')).toContainText('SCREENFACT');
    await expect(page.getByTestId('screen-actual-model')).toContainText('ollama / screen-lan');
    expect(requests).toHaveLength(1); expect(requests[0].model).toBe('screen-lan');
    expect(requests[0].messages.at(-1).images).toEqual([allowed.dataUrl.slice('data:image/jpeg;base64,'.length)]);
    const analysis = (await screens(page)).analysis!;
    expect((await snapshot(page)).library.selectedSourceIds).toEqual([]);
    await captureApp(app, join(root, 'screen-analysis.png'));
    await screenPanel(page, false);
    await page.getByTestId('chat-input').fill('자료를 선택하지 않은 일반 대화');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('화면 참고 대화 1');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    expect(JSON.stringify(requests[1].messages)).not.toContain('SCREENFACT');
    expect(requests[1].messages.every((message: any) => !message.images)).toBe(true);
    await screenPanel(page); await page.getByTestId('screen-use').click();
    await expect.poll(async () => (await snapshot(page)).library.selectedSourceIds).toEqual([analysis.sourceId]);
    await screenPanel(page, false); await chatModel(page, lanId);
    await page.getByTestId('chat-input').fill('선택한 화면 분석을 참고해줘'); await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('화면 참고 대화 2');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    expect(JSON.stringify(requests[2].messages)).toContain('SCREENFACT');
    expect(requests[2].messages.every((message: any) => !message.images)).toBe(true);
    const beforeCloud = connections;
    await chatModel(page, cloudId);
    await page.getByTestId('chat-input').fill('같은 화면 참고 자료의 API 경계 검증'); await page.getByTestId('chat-send').click();
    await expect.poll(async () => (await snapshot(page)).session.messages.findLast(message => message.role === 'assistant')?.errorCode).toBe('context_blocked');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    expect(requests).toHaveLength(3); expect(connections).toBe(beforeCloud);

    // Keep a completed analysis while releasing its pixels, then independently
    // verify that reconnect drops a new, never-submitted preview.
    await screenPanel(page); await page.getByTestId('screen-release').click();
    await expect.poll(async () => (await screens(page)).preview).toBeNull();
    expect((await screens(page)).saved.some(item => item.captureId === allowed.id && item.analysisSourceId === analysis.sourceId)).toBe(true);
    expect((await snapshot(page)).library.selectedSourceIds).toContain(analysis.sourceId);
    const unsubmitted = await captureOwned(page, sourceId, 'local');
    expect(requests).toHaveLength(3); expect(connections).toBe(beforeCloud);
    await page.getByTestId('brain-settings-toggle').click(); await page.getByTestId('brain-reconnect').click();
    await expect(page.getByTestId('connection-status')).toHaveText('연결됨'); await page.getByTestId('brain-settings-toggle').click();
    await expect.poll(async () => (await screens(page)).preview).toBeNull();
    await expect.poll(async () => (await screens(page)).saved.some(item => item.captureId === allowed.id)).toBe(true);
    expect((await screens(page)).saved.some(item => item.captureId === unsubmitted.id)).toBe(false);
    expect(requests).toHaveLength(3);
    const cancelled = await captureOwned(page, sourceId, 'private_lan');
    await page.getByTestId('screen-model').selectOption(lanId); await page.getByTestId('screen-prompt').fill('SLOW_SCREEN 늦은 분석 취소');
    await page.getByTestId('screen-analyze').click();
    await expect.poll(() => !!lateResponse).toBe(true);
    await page.getByTestId('screen-cancel').click();
    await expect.poll(() => slowClosed).toBe(true);
    lateResponse!();
    await expect.poll(async () => (await screens(page)).phase).not.toBe('analyzing');
    expect((await screens(page)).analysis).toBeNull();
    await page.getByTestId('screen-history-refresh').click();
    await expect.poll(async () => (await screens(page)).saved.find(item => item.captureId === cancelled.id)?.analysisSourceId).toBeNull();
    expect(JSON.stringify((await snapshot(page)).library.sources)).not.toContain('LATE_SCREEN_RESULT');
    expect(JSON.stringify((await snapshot(page)).library.sources)).not.toContain('CANCELLED_PARTIAL_SCREEN');
    await deletePreview(page);
    expect(requests).toHaveLength(4);
    await app.close(); app = undefined; await brain.stop(); brain = undefined;

    brain = await start(); app = await launch(profile); page = await app.firstWindow(); await connect(page, brain);
    await screenPanel(page);
    await expect(page.getByTestId('screen-history-item')).toHaveCount(1);
    await expect(page.getByTestId('screen-history-item')).toContainText('이미지는 지워짐');
    const restored = (await screens(page)).saved[0]!;
    expect(restored).toMatchObject({ captureId: allowed.id, imageAvailable: false, analysisSourceId: analysis.sourceId });
    expect((await screens(page)).preview).toBeNull(); expect((await screens(page)).analysis).toBeNull();
    expect(requests).toHaveLength(4);
    await expect.poll(async () => (await snapshot(page)).library.sources.find(source => source.id === analysis.sourceId)?.text).toContain('SCREENFACT');
    await page.getByTestId('screen-history-delete').click(); await page.getByTestId('screen-delete-confirm').click();
    await expect(page.getByTestId('screen-history-item')).toHaveCount(0);
    await expect.poll(async () => (await snapshot(page)).library.sources.some(source => source.id === analysis.sourceId || source.id === analysis.screenSourceId)).toBe(false);
    await expect(page.getByTestId('messages')).not.toContainText('화면 참고 대화 2');
    expect((await screens(page)).saved).toEqual([]); expect(requests).toHaveLength(4);
  } finally {
    await app?.close(); await brain?.stop(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('live selected Ollama vision model analyzes only the owned test window', async () => {
  test.skip(!process.env.KIRIAN_LIVE_OLLAMA_URL || !process.env.KIRIAN_LIVE_OLLAMA_MODEL, 'Explicit live endpoint and model required');
  test.setTimeout(150000);
  await mkdir(output, { recursive: true }); const root = await mkdtemp(join(output, 'live-screen-'));
  const profile = join(root, 'profile'); await mkdir(profile);
  const model = process.env.KIRIAN_LIVE_OLLAMA_MODEL!, url = process.env.KIRIAN_LIVE_OLLAMA_URL!;
  const brain = await startBrain(url, model, 'private_lan', { data_dir: join(root, 'brain'), bindings: [{
    model: { provider_id: 'ollama', model_id: model, endpoint_id: 'test-ollama' }, label: model, kind: 'ollama', url,
    boundary: 'private_lan', supports_images: true, think: false, num_ctx: 8192,
  }] });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile); const page = await app.firstWindow(); await connect(page, brain);
    const selected = await ownedWindow(app); await captureOwned(page, selected, 'private_lan');
    await page.getByTestId('screen-model').selectOption(await modelId(page, model));
    await page.getByTestId('screen-prompt').fill('제공된 테스트 창에서 실제 보이는 영어 문구와 배경색을 한국어 한 문장으로 설명해 줘.');
    await page.getByTestId('screen-analyze').click();
    await expect(page.getByTestId('screen-analysis-text')).not.toHaveText('', { timeout: 120000 });
    const analysis = (await screens(page)).analysis!;
    expect(analysis.actualModel.model_id).toBe(model); expect(analysis.text.trim().length).toBeGreaterThan(0);
    expect((await snapshot(page)).library.selectedSourceIds).toEqual([]);
    await writeFile(join(root, 'live-analysis.json'), JSON.stringify({ actualModel: analysis.actualModel, text: analysis.text }, null, 2));
    await captureApp(app, join(root, 'live-analysis.png'));
    await deletePreview(page);
  } finally { await app?.close(); await brain.stop(); }
});
