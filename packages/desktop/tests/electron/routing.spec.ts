import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

const state = (page: Page) => page.evaluate(() => (window as any).kirianDesktop.getSnapshot());
async function launch(profile: string) {
  const env = {...process.env, KIRIAN_DESKTOP_TEST:'1', KIRIAN_TEST_PROFILE:profile};
  for (const key of ['ELECTRON_RUN_AS_NODE','KIRIAN_BRAIN_URL','KIRIAN_BRAIN_TOKEN','KIRIAN_RENDERER_URL']) delete env[key];
  return electron.launch({cwd:desktopRoot, args:process.env.KIRIAN_PACKAGED_EXE ? [] : [desktopRoot], executablePath:process.env.KIRIAN_PACKAGED_EXE, env, chromiumSandbox:true});
}
async function connect(page: Page, brain: {url:string;token:string}) {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url); await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await page.getByTestId('brain-settings-toggle').click();
}
async function send(page: Page, text: string) {
  const count = (await state(page)).session.messages.length;
  await page.getByTestId('chat-input').fill(text); await page.getByTestId('chat-send').click();
  await expect.poll(async () => (await state(page)).session.messages.length).toBe(count + 2);
  await expect.poll(async () => (await state(page)).session.messages.at(-1)?.status).toBe('completed');
}
async function select(page: Page, model: string | null) {
  const id = model ? (await state(page)).brain.models.find((m: any) => m.modelId === model).id : '';
  await page.getByTestId('model-select').selectOption(id);
  await expect.poll(async () => (await state(page)).brain.selectedModelId).toBe(id || null);
}

test('automatic routing persists limits across restart and uses fixed, context and native screen boundaries', async () => {
  test.setTimeout(180000);
  await mkdir(output, {recursive:true}); const root = await mkdtemp(join(output, 'routing-'));
  const profile = join(root, 'profile'); await mkdir(profile);
  const requests: any[] = [];
  const upstream = createServer(async (request,response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const query = JSON.parse(body); requests.push(query);
    response.setHeader('content-type','application/x-ndjson');
    response.end(JSON.stringify({model:query.model,message:{content:'[검증 표본] ' + query.model},done:true}) + '\n');
  });
  await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:' + (upstream.address() as {port:number}).port;
  const binding = (name: string, boundary: string, budget_units: number, supports_images = false) => ({
    model:{provider_id:'ollama',model_id:name,endpoint_id:name}, label:name,kind:'ollama',url,boundary,
    supports_images,automatic_allowed:true,budget_units,
  });
  const options = {data_dir:join(root,'brain'),bindings:[binding('local-vision','local',2,true),binding('lan-text','private_lan',1)]};
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await startBrain(url,'unused','local',options); app = await launch(profile);
    let page = await app.firstWindow(); await connect(page,brain);
    expect((await state(page)).brain.routing.enabled).toBe(false);
    await send(page,'기존 기본 모델'); expect(requests.at(-1).model).toBe('local-vision');
    expect((await state(page)).brain.routing.calls_used).toBe(0);
    await page.getByTestId('routing-panel').locator('summary').click();
    await page.getByTestId('routing-calls').fill('4'); await page.getByTestId('routing-units').fill('7');
    await page.getByTestId('routing-save').click();
    await expect.poll(async () => (await state(page)).brain.routing.daily_call_limit).toBe(4);
    await page.getByTestId('routing-enabled').check();
    await expect.poll(async () => (await state(page)).brain.routing.enabled).toBe(true);
    const invalid = await page.evaluate(() => (window as any).kirianDesktop.configureRouting({enabled:true,expected_revision:2,daily_call_limit:4,daily_budget_units:7,url:'https://invalid'}));
    expect(invalid).toEqual({ok:false,code:'invalid_request'});
    await send(page,'자동으로 답변'); expect(requests.at(-1).model).toBe('lan-text');
    await expect(page.getByTestId('message-routing').last()).toContainText('자동 선택');
    await select(page,'local-vision'); await send(page,'고정 모델 우선');
    expect(requests.at(-1).model).toBe('local-vision');
    await expect(page.getByTestId('message-routing').last()).toContainText('이 대화에 고정');
    await select(page,null);

    // Capture only a test-owned window, never an existing user window or display.
    const sourceId = await app.evaluate(async ({BrowserWindow}) => {
      const owned = new BrowserWindow({width:400,height:260,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      await owned.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>Kirian routing fixture</title><body style="background:#184777;color:white">ROUTING TEST ONLY</body>'));
      owned.showInactive(); await new Promise(resolve => setTimeout(resolve,350)); return owned.getMediaSourceId();
    });
    await page.getByTestId('screen-toggle').click(); await page.getByTestId('screen-list').click();
    await page.getByTestId('screen-target').selectOption(sourceId); await page.getByTestId('screen-capture').click();
    await expect(page.getByTestId('screen-analyze')).toBeEnabled();
    await page.getByTestId('screen-analyze').click(); await expect(page.getByTestId('screen-analysis')).toBeVisible();
    await expect(page.getByTestId('screen-routing-reason')).toContainText('자동 선택');
    expect(requests.at(-1).model).toBe('local-vision'); expect(requests.at(-1).messages.at(-1).images.length).toBe(1);
    const screen = await page.evaluate(() => (window as any).kirianDesktop.getScreenState());
    const used = await page.evaluate(input => (window as any).kirianDesktop.useScreenAnalysis(input), {captureId:screen.preview.id,revision:screen.preview.revision});
    expect(used.ok).toBe(true);
    await send(page,'이 화면 분석을 참고해'); expect(requests.at(-1).model).toBe('local-vision');
    await expect.poll(async () => (await state(page)).brain.routing.calls_used).toBe(4);
    await expect(page.getByTestId('routing-usage')).toContainText('7 / 7');
    await page.getByTestId('routing-panel').scrollIntoViewIfNeeded();
    const png = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === 'kirian://app/index.html')!.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
    await writeFile(join(root,'routing-ui.png'),Buffer.from(png,'base64'));
    await app.close(); app = undefined; await brain.stop(); brain = undefined;
    brain = await startBrain(url,'unused','local',options); app = await launch(profile); page = await app.firstWindow(); await connect(page,brain);
    expect((await state(page)).brain.routing).toMatchObject({enabled:true,calls_used:4,budget_units_used:7});
    const restored = (await state(page)).session.messages.filter((m: any) => m.role === 'assistant');
    expect(restored.map((m: any) => [m.actualModel?.modelId,m.routingReason])).toEqual([
      ['local-vision','initial_local'],['lan-text','automatic_budget'],['local-vision','conversation_fixed'],['local-vision','automatic_budget'],
    ]);
    await page.getByTestId('chat-input').fill('한도 초과'); await page.getByTestId('chat-send').click();
    await expect.poll(async () => (await state(page)).session.messages.at(-1)?.errorCode).toBe('routing_no_candidate');
    expect(requests.length).toBe(5);
    await writeFile(join(root,'verified.json'),JSON.stringify({requests:requests.map(q => ({model:q.model,images:!!q.messages.at(-1).images})),routing:(await state(page)).brain.routing},null,2));
  } finally { await app?.close().catch(() => {}); await brain?.stop(); await new Promise<void>(resolve => {upstream.closeAllConnections();upstream.close(() => resolve());}); }
});
