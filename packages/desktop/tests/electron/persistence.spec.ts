import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, access, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DesktopSnapshot } from '../../src/shared/bridge.js';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

async function launch(profile: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KIRIAN_BRAIN_URL', 'KIRIAN_BRAIN_TOKEN', 'KIRIAN_RENDERER_URL']) delete env[key];
  return electron.launch({ cwd: desktopRoot, args: process.env.KIRIAN_PACKAGED_EXE ? [] : [desktopRoot],
    executablePath: process.env.KIRIAN_PACKAGED_EXE, env, chromiumSandbox: true });
}
async function connect(page: Page, brain: {url: string; token: string}) {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url);
  await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await page.getByTestId('brain-settings-toggle').click();
}
async function snapshot(page: Page): Promise<DesktopSnapshot> { return page.evaluate(() => (window as any).kirianDesktop.getSnapshot()); }
async function capture(app: ElectronApplication, name = 'persistent-library-actions.png') {
  const page = await app.firstWindow();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0]!.capturePage(undefined, {stayHidden: true, stayAwake: true})).toPNG().toString('base64'));
  await writeFile(join(output, name), Buffer.from(png, 'base64'));
}

test('durable conversations, source invalidation, model defaults and exactly approved notes survive full restart', async () => {
  test.setTimeout(180000);
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'persistence-')), profile = join(root, 'profile'), data = join(root, 'brain');
  await mkdir(profile);
  // Windows treats Chromium's Preferences file and "preferences" as the same path.
  await writeFile(join(profile, 'Preferences'), '{}');
  const requests: any[] = [];
  const upstream = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const query = JSON.parse(body); requests.push(query);
    response.setHeader('content-type', 'application/x-ndjson');
    response.end(JSON.stringify({model: query.model, message: {content: '영속 응답 표본'}, done: true}) + '\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (upstream.address() as {port: number}).port;
  const binding = (name: string) => ({model: {provider_id: 'ollama', model_id: name, endpoint_id: 'test-ollama'},
    label: name, kind: 'ollama', url, boundary: 'local', think: false, num_ctx: 8192});
  const start = (removed = false) => startBrain(url, 'fixture-a', 'local', {
    data_dir: data, bindings: removed ? [binding('fixture-a')] : [binding('fixture-a'), binding('fixture-b')],
  });
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await start(); app = await launch(profile); let page = await app.firstWindow();
    await connect(page, brain);
    await expect.poll(async () => (await snapshot(page)).library.available).toBe(true);
    expect((await stat(join(profile, 'Preferences'))).isFile()).toBe(true);
    expect((await stat(join(profile, 'kirian-settings'))).isDirectory()).toBe(true);
    const conversationId = (await snapshot(page)).library.conversationId;
    await page.getByTestId('always-on-top').click();
    expect(await page.evaluate(() => (window as any).kirianDesktop.setVoiceEnabled(false))).toEqual({ok: true});
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('model-select').selectOption({index: 2});
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('default-model-save').click();
    await expect.poll(async () => (await snapshot(page)).library.defaultModelId).toContain('fixture-b');
    await page.getByTestId('memory-toggle').click();
    await page.getByTestId('memory-new').click();
    await page.getByTestId('memory-title').fill('검증 기억');
    await page.getByTestId('memory-text').fill('첫째 비밀표본: 진한 보라색을 좋아한다.');
    await page.getByTestId('memory-save').click();
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    const source = (await snapshot(page)).library.sources.find(item => !item.origin && item.title === '검증 기억')!;
    expect(source).toMatchObject({text: '첫째 비밀표본: 진한 보라색을 좋아한다.', revision: 1});
    const manualCard = () => page.locator('[data-testid="memory-source"][data-source-id="' + source.id + '"]');
    await manualCard().getByTestId('memory-select').check();
    await page.getByTestId('memory-toggle').click();
    await page.getByTestId('chat-input').fill('선택한 기억을 참고해줘');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('영속 응답 표본');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    expect(requests.at(-1).model).toBe('fixture-b');
    expect(JSON.stringify(requests.at(-1).messages)).toContain('첫째 비밀표본');

    await page.getByTestId('actions-toggle').click();
    await page.getByTestId('action-draft-toggle').click();
    await page.getByTestId('action-draft-title').fill('승인 검증');
    await page.getByTestId('action-draft-body').fill('사용자가 확인한 정확한 본문');
    await page.getByTestId('action-create').click();
    await expect(page.getByTestId('action-card')).toHaveCount(1);
    await page.getByTestId('action-review-toggle').click();
    const target = (await page.getByTestId('action-target').textContent())!;
    await expect(page.getByTestId('action-body')).toHaveText('사용자가 확인한 정확한 본문');
    await expect(page.getByTestId('action-approve')).toBeDisabled();
    await expect(access(target)).rejects.toMatchObject({code: 'ENOENT'});
    await page.getByTestId('action-reviewed').check();
    await page.getByTestId('action-approve').click();
    await expect(page.getByTestId('action-status')).toHaveText('노트 생성 완료');
    const approvedText = '# 승인 검증\n\n사용자가 확인한 정확한 본문\n';
    expect(await readFile(target, 'utf8')).toBe(approvedText);
    await expect(page.getByTestId('action-receipt')).toBeVisible();
    const action = await page.evaluate(() => (window as any).kirianDesktop.listActions());
    const repeat = await page.evaluate(async action => {
      try { await (window as any).kirianDesktop.approveAction({draftId: action.draftId, revision: action.revision, payloadSha256: action.payloadSha256}); return 'executed'; }
      catch { return 'rejected'; }
    }, action[0]);
    expect(repeat).toBe('rejected');
    await expect.poll(async () => (await snapshot(page)).library.sources.find(item => item.origin?.path === basename(target))?.text).toBe(approvedText);
    const managed = (await snapshot(page)).library.sources.find(item => item.origin?.path === basename(target))!;
    expect(managed).toMatchObject({kind: 'note', boundary: 'local', text: approvedText});
    expect(managed.origin!.collection_id).toBe((await snapshot(page)).noteFolders.folders.find(item => item.kind === 'approved_notes')!.id);
    const managedCard = () => page.locator('[data-testid="memory-source"][data-source-id="' + managed.id + '"]');
    await capture(app);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0]!.setSize(560, 640));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(app, 'persistent-actions-compact.png');
    await app.close(); app = undefined; await brain.stop(); brain = undefined;

    brain = await start(); app = await launch(profile); page = await app.firstWindow(); await connect(page, brain);
    await expect(page.getByTestId('always-on-top')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('messages')).toContainText('영속 응답 표본');
    expect(requests).toHaveLength(1); // Viewing durable history cannot replay inference or speech.
    await expect.poll(async () => (await snapshot(page)).library.sources.find(item => item.id === managed.id)?.text).toBe(approvedText);
    const restored = await snapshot(page);
    expect(restored.library.conversationId).toBe(conversationId);
    expect(restored.brain.selectedModelId).toContain('fixture-b');
    expect(restored.brain.speech.enabled).toBe(false);
    expect(restored.library.sources.find(item => item.id === source.id)?.text).toContain('첫째 비밀표본');
    expect(restored.library.sources.find(item => item.id === managed.id)).toMatchObject({text: approvedText, revision: managed.revision, origin: managed.origin});
    await page.getByTestId('actions-toggle').click();
    await expect(page.getByTestId('action-status')).toHaveText('노트 생성 완료');
    expect(await readdir(dirname(target))).toHaveLength(1);
    await page.getByTestId('actions-toggle').click();
    await page.getByTestId('memory-toggle').click();
    await manualCard().getByTestId('memory-edit').click();
    await page.getByTestId('memory-text').fill('둘째 표본: 이제 초록색을 좋아한다.');
    await page.getByTestId('memory-save').click();
    await expect.poll(async () => (await snapshot(page)).library.sources.find(item => item.id === source.id)?.revision).toBe(2);
    await expect(page.getByTestId('messages')).not.toContainText('영속 응답 표본');
    const stale = await page.evaluate(source => (window as any).kirianDesktop.updateSource({id: source.id, revision: source.revision,
      title: 'stale', text: 'must not replace', boundary: 'local'}), source);
    expect(stale).toEqual({ok: false, code: 'source_changed'});
    await page.getByTestId('memory-editor-close').click();
    await manualCard().getByTestId('memory-delete').click();
    await page.getByTestId('memory-delete-confirm').click();
    await expect(manualCard()).toHaveCount(0);
    await expect(managedCard()).toHaveCount(1);
    expect((await snapshot(page)).library.sources.some(item => item.id === source.id)).toBe(false);
    expect((await snapshot(page)).library.sources.find(item => item.id === managed.id)).toMatchObject({text: approvedText, revision: managed.revision, origin: managed.origin});
    expect(await readFile(target, 'utf8')).toBe(approvedText);
    await page.getByTestId('memory-search').fill('비밀표본');
    await page.getByTestId('memory-refresh').click();
    await expect(page.getByTestId('memory-source')).toHaveCount(0);
    await page.getByTestId('conversation-new').click();
    await expect.poll(async () => (await snapshot(page)).library.conversationId).not.toBe(conversationId);
    await page.getByTestId('memory-toggle').click();
    await page.getByTestId('chat-input').fill('새 대화 기본 모델 확인');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('영속 응답 표본');
    expect(requests.at(-1).model).toBe('fixture-b');
    expect(JSON.stringify(requests.at(-1).messages)).not.toContain('비밀표본');
    expect(JSON.stringify(requests.at(-1).messages)).not.toContain('사용자가 확인한 정확한 본문');
    await app.close(); app = undefined; await brain.stop(); brain = undefined;

    brain = await start(true); app = await launch(profile); page = await app.firstWindow(); await connect(page, brain);
    await expect.poll(async () => (await snapshot(page)).library.defaultMissing).toBe(true);
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect.poll(async () => (await snapshot(page)).library.sources.find(item => item.id === managed.id)?.text).toBe(approvedText);
    expect((await snapshot(page)).library.sources.some(item => item.id === source.id)).toBe(false);
    expect((await snapshot(page)).library.sources.find(item => item.id === managed.id)).toMatchObject({text: approvedText, revision: managed.revision, origin: managed.origin});
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('model-select').selectOption({index: 1});
    await page.getByTestId('brain-settings-toggle').click();
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await page.getByTestId('default-model-save').click();
    await expect.poll(async () => (await snapshot(page)).library.defaultMissing).toBe(false);
    expect(await readdir(dirname(target))).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe(approvedText);
  } finally {
    await app?.close(); await brain?.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
