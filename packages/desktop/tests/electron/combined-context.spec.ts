import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const snapshot = (page: Page): Promise<DesktopSnapshot> => page.evaluate(() => (window as any).kirianDesktop.getSnapshot());
const screens = (page: Page): Promise<ScreenState> => page.evaluate(() => (window as any).kirianDesktop.getScreenState());
const sourceCard = (page: Page, id: string) => page.locator(`[data-testid="memory-source"][data-source-id="${id}"]`);

async function panel(page: Page, name: 'memory' | 'note-folders' | 'screen', open = true): Promise<void> {
  if ((await page.getByTestId(name + '-panel').getAttribute('open') !== null) !== open)
    await page.getByTestId(name + '-toggle').click();
}
async function refreshSources(page: Page): Promise<void> {
  await panel(page, 'memory');
  await page.getByTestId('memory-search').fill('');
  await page.getByTestId('memory-refresh').click();
  await expect(page.getByTestId('memory-refresh')).toBeEnabled();
}
async function selectSources(page: Page, ids: string[]): Promise<void> {
  await refreshSources(page);
  for (const selected of (await snapshot(page)).library.selectedSourceIds) {
    if (ids.includes(selected)) continue;
    await sourceCard(page, selected).getByTestId('memory-select').uncheck();
    await expect.poll(async () => (await snapshot(page)).library.selectedSourceIds.includes(selected)).toBe(false);
  }
  for (const id of ids) {
    await sourceCard(page, id).getByTestId('memory-select').check();
    await expect.poll(async () => (await snapshot(page)).library.selectedSourceIds.includes(id)).toBe(true);
  }
  await expect.poll(async () => [...(await snapshot(page)).library.selectedSourceIds].sort()).toEqual([...ids].sort());
  await panel(page, 'memory', false);
}
async function newConversation(page: Page): Promise<string> {
  const previous = (await snapshot(page)).library.conversationId;
  await panel(page, 'memory'); await page.getByTestId('conversation-new').click();
  await expect.poll(async () => (await snapshot(page)).library.conversationId).not.toBe(previous);
  await expect(page.getByTestId('conversation-new')).toBeEnabled();
  const id = (await snapshot(page)).library.conversationId;
  expect(id).toBeTruthy(); return id!;
}
async function send(page: Page, prompt: string, response: string): Promise<void> {
  await page.getByTestId('chat-input').fill(prompt); await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('messages')).toContainText(response);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
}

test('approved Markdown editing and screen deletion invalidate only their own context descendants', async () => {
  test.setTimeout(180000);
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, 'combined-context-'));
  const profile = join(root, 'profile'), vault = join(root, 'combined-vault'), data = join(root, 'brain');
  await mkdir(profile); await mkdir(vault); await writeFile(join(profile, 'Preferences'), '{}');
  const file = join(vault, 'combined.md');
  const original = '# Combined note\nNOTE_ORIGINAL_V1 승인 전 원본입니다.\n';
  const edited = '# Combined note\nNOTE_EDITED_V2 승인한 새 원본입니다.\n';
  await writeFile(file, original);

  // The real Brain and Electron communicate with an HTTP model fixture. The
  // native capture below reads only a window created by this test, never a vault
  // or desktop belonging to the user. Only the folder picker is mocked.
  const requests: { model: string; messages: { role: string; content: string; images?: string[] }[] }[] = [];
  const upstream = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const query = JSON.parse(body) as typeof requests[number]; requests.push(query);
    const isImage = query.messages.some(message => Array.isArray(message.images));
    const prompt = query.messages.at(-1)?.content;
    const answer = isImage ? '[HTTP 표본] SCREEN_EVIDENCE 파란 테스트 창입니다.'
      : prompt === 'TEST_COMBINED_OLD' ? 'COMBINED_OLD_RESPONSE'
      : prompt === 'TEST_NOTE_ONLY' ? 'NOTE_ONLY_RESPONSE'
      : prompt === 'TEST_SCREEN_ONLY' ? 'SCREEN_ONLY_RESPONSE' : 'UNEXPECTED_REQUEST';
    response.setHeader('content-type', 'application/x-ndjson');
    response.end(JSON.stringify({ model: query.model, message: { content: answer }, done: true }) + '\n');
  });
  upstream.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
  const modelName = 'combined-fixture';
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await startBrain(url, modelName, 'local', { data_dir: data, bindings: [{
      model: { provider_id: 'ollama', model_id: modelName, endpoint_id: 'test-ollama' }, label: modelName,
      kind: 'ollama', url, boundary: 'local', supports_images: true, think: false, num_ctx: 8192,
    }] });
    app = await launch(profile); const page = await app.firstWindow();
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('brain-url').fill(brain.url); await page.getByTestId('brain-token').fill(brain.token);
    await page.getByTestId('brain-connect').click();
    await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
    await expect(page.getByTestId('brain-token')).toHaveValue('');
    await page.getByTestId('brain-settings-toggle').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.available).toBe(true);
    await expect.poll(async () => (await snapshot(page)).noteFolders.busy).toBe(false);
    await expect.poll(async () => (await screens(page)).available).toBe(true);

    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, vault);
    await panel(page, 'note-folders'); await page.getByTestId('note-folder-choose').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(folder => folder.path === vault)?.phase).toBe('ready');
    const folder = (await snapshot(page)).noteFolders.folders.find(folder => folder.path === vault)!;
    expect(folder.writeEnabled).toBe(false); expect(folder.sourceCount).toBe(1);
    const folderCard = page.locator(`[data-testid="note-folder-card"][data-folder-id="${folder.id}"]`);
    await expect(folderCard.getByTestId('note-folder-write')).not.toBeChecked();
    await panel(page, 'note-folders', false); await refreshSources(page);
    const note = (await snapshot(page)).library.sources.find(source => source.origin?.collection_id === folder.id)!;
    expect(note).toMatchObject({ text: original, boundary: 'local', origin: { path: 'combined.md' } });
    await expect(sourceCard(page, note.id).getByTestId('memory-edit-file')).toBeDisabled();
    await panel(page, 'memory', false);

    const nativeSourceId = await app.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 420, height: 280, show: false, focusable: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><title>Kirian combined context fixture</title><body style="margin:0;background:rgb(31,89,147);color:white;font:24px sans-serif">COMBINED CONTEXT FIXTURE<br />Only this test window.</body>'));
      fixture.showInactive(); await new Promise(resolve => setTimeout(resolve, 350));
      return fixture.getMediaSourceId();
    });
    await panel(page, 'screen'); await page.getByTestId('screen-boundary').selectOption('local');
    await page.getByTestId('screen-list').click(); await page.getByTestId('screen-target').selectOption(nativeSourceId);
    await page.getByTestId('screen-capture').click();
    await expect(page.getByTestId('screen-preview-image')).toBeVisible();
    await expect.poll(async () => page.getByTestId('screen-preview-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const captured = (await screens(page)).preview!;
    const pixels = await app.evaluate(({ nativeImage }, dataUrl) => {
      const bitmap = nativeImage.createFromDataURL(dataUrl).toBitmap(); let matched = 0;
      for (let offset = 0; offset < bitmap.length; offset += 4)
        if (Math.abs(bitmap[offset]! - 147) < 8 && Math.abs(bitmap[offset + 1]! - 89) < 8 && Math.abs(bitmap[offset + 2]! - 31) < 8) matched++;
      return matched;
    }, captured.dataUrl);
    expect(pixels).toBeGreaterThan(10000);
    const model = (await snapshot(page)).brain.models.find(model => model.modelId === modelName)!;
    await page.getByTestId('screen-model').selectOption(model.id);
    await page.getByTestId('screen-prompt').fill('테스트 창을 설명해 주세요.'); await page.getByTestId('screen-analyze').click();
    await expect(page.getByTestId('screen-analysis-text')).toContainText('SCREEN_EVIDENCE');
    await expect(page.getByTestId('screen-actual-model')).toContainText('ollama / ' + modelName);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages.at(-1)!.images).toEqual([captured.dataUrl.slice('data:image/jpeg;base64,'.length)]);
    const analysis = (await screens(page)).analysis!;
    expect((await snapshot(page)).library.selectedSourceIds).toEqual([]);
    await panel(page, 'screen', false);
    await selectSources(page, [note.id, analysis.sourceId]);
    await send(page, 'TEST_COMBINED_OLD', 'COMBINED_OLD_RESPONSE');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain('NOTE_ORIGINAL_V1');
    expect(JSON.stringify(requests[1]!.messages)).toContain('SCREEN_EVIDENCE');

    // Approval changes the original file and resynchronizes its source. The
    // screen is a different root: its analysis must survive this invalidation.
    await panel(page, 'note-folders'); await folderCard.getByTestId('note-folder-write').check();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folder.id)?.writeEnabled).toBe(true);
    await panel(page, 'note-folders', false); await refreshSources(page);
    await sourceCard(page, note.id).getByTestId('memory-edit-file').click();
    await expect(page.getByTestId('note-edit-target')).toHaveText(file);
    await expect(page.getByTestId('note-edit-text')).toHaveValue(original);
    await page.getByTestId('note-edit-text').fill(edited); await page.getByTestId('note-edit-preview').click();
    await expect(page.getByTestId('note-edit-before')).toHaveText(original);
    await expect(page.getByTestId('note-edit-after')).toHaveText(edited);
    await expect(page.getByTestId('note-edit-consent')).not.toBeChecked();
    await expect(page.getByTestId('note-edit-approve')).toBeDisabled();
    expect(await readFile(file, 'utf8')).toBe(original);
    await page.getByTestId('note-edit-consent').check(); await page.getByTestId('note-edit-approve').click();
    await expect(page.getByTestId('note-edit-status')).toHaveText('파일 저장 완료');
    expect(await readFile(file, 'utf8')).toBe(edited);
    // Successful approval closes the editable document and keeps its receipt.
    await expect(page.getByTestId('note-edit-text')).toHaveCount(0);
    if (await page.getByTestId('note-editor').getAttribute('open') !== null)
      await page.getByTestId('note-editor-toggle').click();
    await refreshSources(page);
    await expect.poll(async () => (await snapshot(page)).library.sources.find(source => source.id === note.id)?.text).toBe(edited);
    const updated = (await snapshot(page)).library.sources.find(source => source.id === note.id)!;
    expect(updated.revision).toBeGreaterThan(note.revision);
    await expect(page.getByTestId('messages')).not.toContainText('COMBINED_OLD_RESPONSE');
    await page.evaluate(() => (window as any).kirianDesktop.refreshSavedScreens());
    expect((await screens(page)).analysis).toEqual(analysis);
    expect((await screens(page)).saved.find(item => item.captureId === captured.id)?.analysisSourceId).toBe(analysis.sourceId);
    expect((await snapshot(page)).library.sources.find(source => source.id === analysis.sourceId)).toMatchObject({
      id: analysis.sourceId, revision: analysis.revision, text: analysis.text,
    });
    expect(requests).toHaveLength(2);

    // Separate conversations ensure screen ancestry cannot enter the note-only
    // history through previous messages, or vice versa.
    const noteConversation = await newConversation(page);
    await expect.poll(async () => (await screens(page)).saved.find(item => item.captureId === captured.id)?.analysisSourceId).toBe(analysis.sourceId);
    expect((await screens(page)).preview).toBeNull(); // Conversation reconnect releases local pixels.
    await selectSources(page, [updated.id]); await send(page, 'TEST_NOTE_ONLY', 'NOTE_ONLY_RESPONSE');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.messages)).toContain('NOTE_EDITED_V2');
    expect(JSON.stringify(requests[2]!.messages)).not.toContain('SCREEN_EVIDENCE');
    expect(JSON.stringify(requests[2]!.messages)).not.toContain('NOTE_ORIGINAL_V1');
    await newConversation(page);
    await selectSources(page, [analysis.sourceId]); await send(page, 'TEST_SCREEN_ONLY', 'SCREEN_ONLY_RESPONSE');
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]!.messages)).toContain('SCREEN_EVIDENCE');
    expect(JSON.stringify(requests[3]!.messages)).not.toContain('NOTE_EDITED_V2');
    expect(requests.slice(1).every(request => request.messages.every(message => !message.images))).toBe(true);

    await panel(page, 'screen');
    await page.locator(`[data-testid="screen-history-item"][data-capture-id="${captured.id}"]`).getByTestId('screen-history-delete').click();
    await page.getByTestId('screen-delete-confirm').click();
    await expect(page.getByTestId('screen-preview')).toHaveCount(0);
    await expect.poll(async () => (await screens(page)).saved.some(item => item.captureId === captured.id)).toBe(false);
    await expect(page.getByTestId('messages')).not.toContainText('SCREEN_ONLY_RESPONSE');
    await panel(page, 'screen', false); await refreshSources(page);
    expect((await snapshot(page)).library.sources.some(source => source.id === analysis.sourceId || source.id === analysis.screenSourceId)).toBe(false);
    expect((await snapshot(page)).library.sources.find(source => source.id === updated.id)).toMatchObject({
      id: updated.id, revision: updated.revision, text: edited,
    });
    expect(await readFile(file, 'utf8')).toBe(edited);
    await page.getByTestId('conversation-select').selectOption(noteConversation);
    await expect.poll(async () => (await snapshot(page)).library.conversationId).toBe(noteConversation);
    await expect(page.getByTestId('messages')).toContainText('NOTE_ONLY_RESPONSE');
    await expect(page.getByTestId('messages')).not.toContainText('SCREEN_ONLY_RESPONSE');
    expect((await snapshot(page)).library.sources.find(source => source.id === updated.id)?.revision).toBe(updated.revision);
    expect(requests).toHaveLength(4);
  } finally {
    await app?.close(); await brain?.stop();
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
