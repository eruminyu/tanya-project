import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DesktopSnapshot } from '../../src/shared/bridge.js';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

async function launch(profile: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KIRIAN_BRAIN_URL', 'KIRIAN_BRAIN_TOKEN', 'KIRIAN_RENDERER_URL']) delete env[key];
  return electron.launch({ cwd: desktopRoot, args: process.env.KIRIAN_PACKAGED_EXE ? [] : [desktopRoot],
    executablePath: process.env.KIRIAN_PACKAGED_EXE, env, chromiumSandbox: true });
}
async function snapshot(page: Page): Promise<DesktopSnapshot> {
  return page.evaluate(() => (window as any).kirianDesktop.getSnapshot());
}
async function connect(page: Page, brain: { url: string; token: string }): Promise<void> {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url);
  await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await expect(page.getByTestId('brain-token')).toHaveValue('');
  await page.getByTestId('brain-settings-toggle').click();
  await expect.poll(async () => (await snapshot(page)).noteFolders.available).toBe(true);
  await expect.poll(async () => (await snapshot(page)).noteFolders.busy).toBe(false);
}
async function panel(page: Page, name: 'memory' | 'note-folders', open = true): Promise<void> {
  if ((await page.getByTestId(name + '-panel').getAttribute('open') !== null) !== open)
    await page.getByTestId(name + '-toggle').click();
}
async function search(page: Page, query: string): Promise<void> {
  await panel(page, 'memory');
  await page.getByTestId('memory-search').fill(query);
  await page.getByTestId('memory-refresh').click();
  await expect(page.getByTestId('memory-refresh')).toBeEnabled();
}
async function selectModel(page: Page, modelId: string): Promise<void> {
  const model = (await snapshot(page)).brain.models.find(item => item.modelId === modelId);
  expect(model).toBeDefined();
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('model-select').selectOption(model!.id);
  await page.getByTestId('brain-settings-toggle').click();
  await expect.poll(async () => (await snapshot(page)).brain.selectedModelId).toBe(model!.id);
}

test('selected Markdown folders preserve origins and policy, sync edits/deletions, and restore grants across full restart', async () => {
  test.setTimeout(240000);
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, 'note-folders-'));
  const profile = join(root, 'profile'), data = join(root, 'brain'), vault = join(root, '검증 노트');
  await mkdir(profile); await mkdir(join(vault, 'nested'), { recursive: true });
  await mkdir(join(vault, '.obsidian'));
  // This test only reads/writes its own .test-output fixture, never an existing vault.
  await writeFile(join(profile, 'Preferences'), '{}');
  const selectedPath = join(vault, 'nested', 'selected.md');
  const selectedText = '# 선택한 노트\r\nORCHIDSEED 고유 표본: 보라색 난초를 좋아한다. 🙂\r\n';
  const updatedText = '# 선택한 노트\r\nNEWORCHID 바뀐 표본: 초록색 잎을 좋아한다. 🌿\r\n';
  const longText = '# 장문 원본\nLONGHEAD ' + '가나다🙂 '.repeat(1900) + '\nLONGTAIL 마지막 근거\n';
  await writeFile(selectedPath, '\uFEFF' + selectedText);
  await writeFile(join(vault, 'long.MD'), longText);
  await writeFile(join(vault, 'deleted.md'), '# 제거할 파일\nGONEORCHID 삭제 표본\n');
  await writeFile(join(vault, '.obsidian', 'private.md'), 'HIDDENORCHID 가져오면 안 되는 설정');
  await writeFile(join(vault, 'attachment.png'), Buffer.from([0xff, 0x00]));

  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  const upstream = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const query = JSON.parse(body); requests.push(query);
    response.setHeader('content-type', 'application/x-ndjson');
    response.end(JSON.stringify({ model: query.model, message: { content: '노트 연결 응답 ' + requests.length }, done: true }) + '\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
  // Both servers are local HTTP fixtures; the catalog models an explicitly granted
  // LAN processing boundary, including the same loopback-tunnel case used by Kirian.
  const binding = (model: string, boundary: 'local' | 'private_lan') => ({
    model: { provider_id: 'ollama', model_id: model, endpoint_id: 'test-ollama' },
    label: model, kind: 'ollama', url, boundary, think: false, num_ctx: 8192,
  });
  const start = () => startBrain(url, 'fixture-local', 'local', {
    data_dir: data, bindings: [binding('fixture-local', 'local'), binding('fixture-lan', 'private_lan')],
  });
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await start(); app = await launch(profile); let page = await app.firstWindow();
    await connect(page, brain);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, vault);
    await panel(page, 'note-folders');
    await page.getByTestId('note-folder-boundary').selectOption('local');
    await page.getByTestId('note-folder-choose').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.path === vault)?.phase).toBe('ready');
    const folder = (await snapshot(page)).noteFolders.folders.find(item => item.path === vault)!;
    const folderId = folder.id;
    const card = () => page.locator('[data-testid="note-folder-card"][data-folder-id="' + folderId + '"]');
    expect(folder).toMatchObject({ kind: 'vault', boundary: 'local', documentCount: 3, skipped: 2 });
    await expect(card().getByTestId('note-folder-path')).toHaveText(vault);
    await expect(card().getByTestId('note-folder-status')).toHaveText('동기화됨');
    await search(page, '');
    await expect.poll(async () => (await snapshot(page)).library.sources.filter(source => source.origin?.collection_id === folderId).length).toBe(4);
    const originals = (await snapshot(page)).library.sources.filter(source => source.origin?.collection_id === folderId);
    expect(originals.every(source => source.boundary === 'local')).toBe(true);
    const longChunks = originals.filter(source => source.origin!.path === 'long.MD')
      .sort((left, right) => left.origin!.chunk_index - right.origin!.chunk_index);
    expect(longChunks.map(source => source.origin!.chunk_index)).toEqual([0, 1]);
    expect(longChunks.every(source => source.origin!.chunk_count === 2)).toBe(true);
    expect(longChunks.map(source => source.text).join('')).toBe(longText);

    await search(page, 'LONGTAIL');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    await page.getByTestId('memory-source-view').click();
    await expect(page.getByTestId('memory-source-origin')).toContainText('검증 노트 · long.MD · 2/2 조각');
    await expect(page.getByTestId('memory-edit')).toHaveCount(0);
    await expect(page.getByTestId('memory-delete')).toHaveCount(0);
    expect((await snapshot(page)).library.sources[0]!.origin).toMatchObject({ collection_id: folderId, path: 'long.MD', chunk_index: 1, chunk_count: 2 });
    await search(page, 'ORCHIDSEED');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    const selected = (await snapshot(page)).library.sources[0]!;
    expect(selected.text).toBe(selectedText);
    expect(selected.origin).toMatchObject({ collection_id: folderId, collection_label: '검증 노트', path: 'nested/selected.md', chunk_index: 0, chunk_count: 1 });
    await page.getByTestId('memory-select').check();
    await expect.poll(async () => (await snapshot(page)).library.selectedSourceIds).toEqual([selected.id]);
    await panel(page, 'memory', false); await panel(page, 'note-folders', false);
    await selectModel(page, 'fixture-lan');
    await page.getByTestId('chat-input').fill('선택한 노트를 참고해줘.');
    await page.getByTestId('chat-send').click();
    await expect.poll(async () => (await snapshot(page)).session.messages.findLast(message => message.role === 'assistant')?.errorCode).toBe('context_blocked');
    await expect(page.getByTestId('messages')).toContainText('실패');
    await expect(page.getByTestId('messages')).toContainText('이 모델에 전달할 수 없는 정보');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    expect(requests).toHaveLength(0);

    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-policy').selectOption('private_lan');
    await expect.poll(async () => {
      const current = (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId);
      return current?.phase === 'ready' && current.boundary === 'private_lan';
    }).toBe(true);
    await search(page, 'ORCHIDSEED');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    await expect.poll(async () => (await snapshot(page)).library.sources[0]?.boundary).toBe('private_lan');
    const allowed = (await snapshot(page)).library.sources[0]!;
    expect(allowed.revision).toBeGreaterThan(selected.revision);
    await page.getByTestId('memory-select').check();
    await panel(page, 'memory', false); await panel(page, 'note-folders', false);
    await page.getByTestId('chat-input').fill('허용한 노트 한 개를 참고해줘.');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('노트 연결 응답 1');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('fixture-lan');
    const sent = JSON.stringify(requests[0]!.messages);
    expect(sent).toContain('ORCHIDSEED');
    for (const omitted of ['GONEORCHID', 'LONGHEAD', 'HIDDENORCHID', vault]) expect(sent).not.toContain(omitted);
    await expect(page.getByTestId('actual-model')).toHaveText('fixture-lan');

    // A disconnected generation must immediately lose access to the previous
    // identity's folder paths, before the manager's asynchronous cleanup runs.
    await page.evaluate(() => (window as any).kirianDesktop.disconnectBrain());
    expect((await snapshot(page)).noteFolders).toEqual({available: false, folders: [], busy: false});

    await app.close(); app = undefined; await brain.stop(); brain = undefined;
    brain = await start(); app = await launch(profile); page = await app.firstWindow();
    await connect(page, brain);
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.phase).toBe('ready');
    expect((await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)).toMatchObject({ path: vault, boundary: 'private_lan', documentCount: 3 });
    await expect(page.getByTestId('messages')).toContainText('노트 연결 응답 1');
    expect(requests).toHaveLength(1); // Restoring a folder or history cannot replay a model request.
    expect((await snapshot(page)).library.selectedSourceIds).toEqual([]);
    await search(page, 'ORCHIDSEED');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    expect((await snapshot(page)).library.sources[0]).toMatchObject({ id: allowed.id, revision: allowed.revision, text: selectedText });

    await writeFile(selectedPath, updatedText); await unlink(join(vault, 'deleted.md'));
    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-sync').click();
    await expect.poll(async () => {
      const current = (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId);
      return current?.phase === 'ready' && current.documentCount === 2 && current.sourceCount === 3;
    }).toBe(true);
    await expect(page.getByTestId('messages')).not.toContainText('노트 연결 응답 1');
    await search(page, 'NEWORCHID');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    const updated = (await snapshot(page)).library.sources[0]!;
    expect(updated).toMatchObject({ id: allowed.id, text: updatedText, boundary: 'private_lan' });
    expect(updated.revision).toBeGreaterThan(allowed.revision);
    for (const removed of ['ORCHIDSEED', 'GONEORCHID', 'HIDDENORCHID']) {
      await search(page, removed); await expect(page.getByTestId('memory-source')).toHaveCount(0);
    }
    await search(page, 'NEWORCHID');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    await page.getByTestId('memory-source-view').click();
    await expect(page.getByTestId('memory-source')).toContainText('nested/selected.md');
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await writeFile(join(root, 'note-folder-synced.png'), Buffer.from(png, 'base64'));

    // Approved app-owned notes use the same importer, while writing still requires
    // the existing exact-content review and explicit approval.
    await panel(page, 'memory', false); await panel(page, 'note-folders', false);
    await page.getByTestId('actions-toggle').click();
    await page.getByTestId('action-draft-toggle').click();
    await page.getByTestId('action-draft-title').fill('승인 노트 연결');
    await page.getByTestId('action-draft-body').fill('APPROVEDORCHID 확인하고 생성한 로컬 파일');
    await page.getByTestId('action-create').click();
    await expect(page.getByTestId('action-card')).toHaveCount(1);
    await page.getByTestId('action-review-toggle').click();
    const approvedPath = (await page.getByTestId('action-target').textContent())!;
    await expect(page.getByTestId('action-approve')).toBeDisabled();
    await page.getByTestId('action-reviewed').check();
    await page.getByTestId('action-approve').click();
    await expect(page.getByTestId('action-status')).toHaveText('노트 생성 완료');
    const approvedText = '# 승인 노트 연결\n\nAPPROVEDORCHID 확인하고 생성한 로컬 파일\n';
    expect(await readFile(approvedPath, 'utf8')).toBe(approvedText);
    await page.getByTestId('actions-toggle').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.kind === 'approved_notes')?.sourceCount).toBe(1);
    await search(page, 'APPROVEDORCHID');
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    const approved = (await snapshot(page)).library.sources[0]!;
    expect(approved).toMatchObject({ text: approvedText, boundary: 'local' });
    expect(approved.origin).toMatchObject({ path: basename(approvedPath), chunk_index: 0, chunk_count: 1 });
    expect(approved.origin!.collection_id).toBe((await snapshot(page)).noteFolders.folders.find(item => item.kind === 'approved_notes')!.id);
    await expect(page.getByTestId('memory-source-origin')).toContainText(basename(approvedPath));

    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-remove').click();
    await expect(card().getByTestId('note-folder-path')).toHaveText(vault);
    await expect(card().getByTestId('note-folder-remove-review')).toContainText('검증 노트 연결을 해제할까요?');
    await expect(card().getByTestId('note-folder-remove-review')).toContainText('원본 파일은 그대로 남아요.');
    await card().getByTestId('note-folder-remove-confirm').click();
    await expect(card()).toHaveCount(0);
    await search(page, '');
    await expect.poll(async () => (await snapshot(page)).library.sources.filter(source => source.origin?.collection_id === folderId)).toEqual([]);
    expect(await readFile(selectedPath, 'utf8')).toBe(updatedText);
    expect(await readFile(join(vault, 'long.MD'), 'utf8')).toBe(longText);
    expect(await readFile(join(vault, '.obsidian', 'private.md'), 'utf8')).toBe('HIDDENORCHID 가져오면 안 되는 설정');

    await app.close(); app = undefined; await brain.stop(); brain = undefined;
    brain = await start(); app = await launch(profile); page = await app.firstWindow();
    await connect(page, brain);
    expect((await snapshot(page)).noteFolders.folders.filter(item => item.kind === 'vault')).toEqual([]);
    expect((await snapshot(page)).library.sources.filter(source => source.origin?.collection_id === folderId)).toEqual([]);
    expect((await snapshot(page)).library.sources.find(source => source.id === approved.id)).toMatchObject({ text: approvedText, revision: approved.revision });
    expect(await readFile(selectedPath, 'utf8')).toBe(updatedText);
    expect(await readFile(approvedPath, 'utf8')).toBe(approvedText);
    expect(requests).toHaveLength(1);
  } finally {
    await app?.close(); await brain?.stop(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
