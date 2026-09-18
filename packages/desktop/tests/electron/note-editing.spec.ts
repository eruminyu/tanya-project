import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApprovalLedger, type ActionDraft, type ExecutionSnapshot } from '@kirian/contracts';
import type { DesktopSnapshot } from '../../src/shared/bridge.js';
import type { NoteEditReview, NoteEditSummary } from '../../src/shared/note-editing.js';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

test.use({actionTimeout: 20000});

async function launch(profile: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KIRIAN_BRAIN_URL', 'KIRIAN_BRAIN_TOKEN', 'KIRIAN_RENDERER_URL']) delete env[key];
  return electron.launch({ cwd: desktopRoot, args: process.env.KIRIAN_PACKAGED_EXE ? [] : [desktopRoot],
    executablePath: process.env.KIRIAN_PACKAGED_EXE, env, chromiumSandbox: true });
}
const snapshot = (page: Page): Promise<DesktopSnapshot> => page.evaluate(() => (window as any).kirianDesktop.getSnapshot());
const history = (page: Page): Promise<NoteEditSummary[]> => page.evaluate(() => (window as any).kirianDesktop.listNoteEdits());
const detail = (page: Page, id: string): Promise<NoteEditReview> => page.evaluate(id => (window as any).kirianDesktop.reviewNoteEdit(id), id);
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const serialize = (text: string): Buffer => Buffer.from('\uFEFF' + text.replace(/\r?\n/g, '\r\n'), 'utf8');
const record = (page: Page, id: string) => page.locator(`[data-testid="note-edit-record"][data-draft-id="${id}"]`);

async function connect(page: Page, brain: {url: string; token: string}): Promise<void> {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url);
  await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await page.getByTestId('brain-settings-toggle').click();
  await expect.poll(async () => (await snapshot(page)).noteFolders.available).toBe(true);
  await expect.poll(async () => (await snapshot(page)).noteFolders.busy).toBe(false);
}
async function panel(page: Page, name: 'memory' | 'note-folders', open = true): Promise<void> {
  if ((await page.getByTestId(name + '-panel').getAttribute('open') !== null) !== open)
    await page.getByTestId(name + '-toggle').click();
}
async function search(page: Page, query: string, count: number): Promise<void> {
  await panel(page, 'memory');
  await page.getByTestId('memory-search').fill(query);
  await page.getByTestId('memory-refresh').click();
  await expect(page.getByTestId('memory-refresh')).toBeEnabled();
  await expect(page.getByTestId('memory-source')).toHaveCount(count);
}
async function preview(page: Page, text: string): Promise<NoteEditReview> {
  const before = new Set((await history(page)).map(item => item.draftId));
  await page.getByTestId('note-edit-text').fill(text);
  await page.getByTestId('note-edit-preview').click();
  await expect.poll(async () => (await history(page)).filter(item => !before.has(item.draftId)).length).toBe(1);
  const created = (await history(page)).find(item => !before.has(item.draftId))!;
  const review = await detail(page, created.draftId);
  await expect(page.getByTestId('note-edit-after')).toHaveText(review.afterText);
  await expect(page.getByTestId('note-edit-consent')).not.toBeChecked();
  await expect(page.getByTestId('note-edit-approve')).toBeDisabled();
  return review;
}
async function approve(page: Page, id: string, status: NoteEditSummary['status'] = 'succeeded'): Promise<void> {
  await page.getByTestId('note-edit-consent').check();
  await page.getByTestId('note-edit-approve').click();
  await expect.poll(async () => (await history(page)).find(item => item.draftId === id)?.status).toBe(status);
  await expect(page.getByTestId('note-edit-status')).toHaveText(status === 'succeeded' ? '파일 저장 완료' : '저장 실패');
  await expect(page.getByTestId('note-edit-refresh')).toBeEnabled();
}

test('whole Markdown edits require per-folder grants and exact approval; conflicts, undo and restart remain durable', async () => {
  test.setTimeout(420000);
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'note-editing-'));
  const profile = join(root, 'profile'), vault = join(root, '편집 검증 보관함'), data = join(root, 'brain');
  await mkdir(profile); await mkdir(join(vault, 'nested'), {recursive: true});
  await writeFile(join(profile, 'Preferences'), '{}');
  const file = join(vault, 'nested', 'whole.md');
  const emptyFile = join(vault, 'empty.md');
  const originalText = '# 원본 전체 노트\nSEEDNOTE 첫 번째 조각 🙂\n' + '오늘의 기록 가나다 🌿 '.repeat(1300) + '\nWHOLETAIL 마지막 조각\n';
  const originalBytes = serialize(originalText);
  const changedText = originalText.replace('SEEDNOTE', 'UPDATEDNOTE').replace('마지막 조각', '마지막 조각 수정됨');
  const changedBytes = serialize(changedText);
  await writeFile(file, originalBytes);
  await writeFile(emptyFile, '');

  // Every file, profile, service, token and port belongs to this synthetic fixture.
  // Editing and indexing must never make a model request or send native paths upstream.
  let modelRequests = 0;
  const upstream = createServer((_request, response) => {
    modelRequests++; response.setHeader('content-type', 'application/x-ndjson');
    response.end(JSON.stringify({model: 'note-edit-fixture', message: {content: 'fixture'}, done: true}) + '\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const modelUrl = 'http://127.0.0.1:' + (upstream.address() as {port: number}).port;
  const start = () => startBrain(modelUrl, 'note-edit-fixture', 'local', {data_dir: data});
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await start(); app = await launch(profile); let page = await app.firstWindow();
    await connect(page, brain);
    await app.evaluate(({dialog}, selected) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [selected]});
    }, vault);
    await panel(page, 'note-folders');
    await page.getByTestId('note-folder-choose').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.path === vault)?.phase).toBe('ready');
    const folder = (await snapshot(page)).noteFolders.folders.find(item => item.path === vault)!;
    const folderId = folder.id;
    const card = () => page.locator(`[data-testid="note-folder-card"][data-folder-id="${folderId}"]`);
    expect(folder.writeEnabled).toBe(false);
    expect(folder.sourceCount).toBeGreaterThan(1);
    await expect(card().getByTestId('note-folder-write')).not.toBeChecked();
    await search(page, 'WHOLETAIL', 1);
    await expect(page.getByTestId('memory-edit-file')).toBeDisabled();
    const refusal = await page.evaluate(async input => {
      try { await (window as any).kirianDesktop.openNoteFile(input); return 'unexpected success'; }
      catch (error) { return String(error); }
    }, {folderId, path: 'nested/whole.md'});
    expect(refusal).toContain('write_not_enabled');
    expect(await readFile(file)).toEqual(originalBytes);

    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-write').check();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.writeEnabled).toBe(true);
    await expect(card().getByTestId('note-folder-write')).toBeChecked();
    await panel(page, 'note-folders', false);
    await expect(page.getByTestId('memory-edit-file')).toBeEnabled();
    await page.getByTestId('memory-edit-file').click();
    await expect(page.getByTestId('note-edit-text')).toHaveValue(originalText);
    await expect(page.getByTestId('note-edit-target')).toHaveText(file);
    const first = await preview(page, changedText);
    expect(first.beforeText).toBe(originalText.replace(/\n/g, '\r\n'));
    expect(first.beforeSha256).toBe(hash(originalBytes));
    expect(first.afterSha256).toBe(hash(changedBytes));
    expect(first.beforeBytes).toBe(originalBytes.length);
    expect(first.afterBytes).toBe(changedBytes.length);
    expect(first.afterText).toContain('UPDATEDNOTE');
    expect(first.afterText).toContain('WHOLETAIL 마지막 조각 수정됨');
    expect(await readFile(file)).toEqual(originalBytes); // Preview is not a write.

    await page.getByTestId('note-edit-consent').check();
    await expect(page.getByTestId('note-edit-approve')).toBeEnabled();
    await page.getByTestId('note-edit-text').fill(changedText + '미리보기 이후 변경\n');
    await expect(page.getByTestId('note-edit-consent')).not.toBeChecked();
    await expect(page.getByTestId('note-edit-approve')).toBeDisabled();
    await expect(page.getByTestId('note-edit-stale')).toBeVisible();
    const approved = await preview(page, changedText);
    await app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(384, 600); window.setSize(384, 732);
    });
    await page.getByTestId('note-edit-consent').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const png = await app.evaluate(async ({BrowserWindow}) =>
      (await BrowserWindow.getAllWindows()[0]!.capturePage(undefined, {stayHidden: true, stayAwake: true})).toPNG().toString('base64'));
    await writeFile(join(root, 'note-edit-review-384.png'), Buffer.from(png, 'base64'));
    await approve(page, approved.draftId);
    expect(await readFile(file)).toEqual(changedBytes);
    await search(page, 'UPDATEDNOTE', 1);
    const indexed = (await snapshot(page)).library.sources[0]!;
    expect(indexed.origin).toMatchObject({collection_id: folderId, path: 'nested/whole.md'});
    expect(indexed.text).toContain('UPDATEDNOTE');
    await search(page, 'SEEDNOTE', 0);

    const duplicate = await page.evaluate(async input => {
      try { await (window as any).kirianDesktop.approveNoteEdit(input); return 'unexpected success'; }
      catch (error) { return String(error); }
    }, {draftId: approved.draftId, revision: approved.revision, payloadSha256: approved.payloadSha256});
    expect(duplicate).not.toBe('unexpected success');
    expect((await detail(page, approved.draftId)).status).toBe('succeeded');
    expect(await readFile(file)).toEqual(changedBytes);

    await search(page, 'WHOLETAIL', 1);
    await page.getByTestId('memory-edit-file').click();
    const conflict = await preview(page, changedText + '충돌하면 저장하지 않을 줄\n');
    const externalBytes = serialize(changedText.replace('UPDATEDNOTE', 'EXTERNALNOTE'));
    await writeFile(file, externalBytes);
    await approve(page, conflict.draftId, 'failed');
    expect((await detail(page, conflict.draftId)).error).toBe('note_file_conflict');
    expect(await readFile(file)).toEqual(externalBytes);
    await record(page, approved.draftId).getByTestId('note-edit-undo').click();
    await expect(page.getByTestId('note-edit-error')).toContainText('다른 프로그램에서 원본을 변경');
    expect(await readFile(file)).toEqual(externalBytes); // Undo cannot overwrite a later external edit.

    // Restore this fixture's exact successful bytes to exercise a permitted undo.
    await writeFile(file, changedBytes);
    const beforeUndo = new Set((await history(page)).map(item => item.draftId));
    await record(page, approved.draftId).getByTestId('note-edit-undo').click();
    await expect.poll(async () => (await history(page)).filter(item => !beforeUndo.has(item.draftId)).length).toBe(1);
    const undo = (await history(page)).find(item => !beforeUndo.has(item.draftId))!;
    expect(undo.kind).toBe('undo');
    expect((await detail(page, undo.draftId)).afterSha256).toBe(hash(originalBytes));
    await expect(page.getByTestId('note-edit-approve')).toBeDisabled();
    expect(await readFile(file)).toEqual(changedBytes);
    await approve(page, undo.draftId);
    expect(await readFile(file)).toEqual(originalBytes);
    await search(page, 'SEEDNOTE', 1);

    await search(page, 'WHOLETAIL', 1);
    await page.getByTestId('memory-edit-file').click();
    const restartText = originalText.replace('SEEDNOTE', 'RESTARTNOTE');
    const pending = await preview(page, restartText);
    await page.getByTestId('note-edit-consent').check();
    expect(await readFile(file)).toEqual(originalBytes);
    await app.close(); app = undefined; await brain.stop(); brain = undefined;
    brain = await start(); app = await launch(profile); page = await app.firstWindow();
    await connect(page, brain);
    expect((await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.writeEnabled).toBe(true);
    expect((await detail(page, pending.draftId)).status).toBe('pending');
    expect(await readFile(file)).toEqual(originalBytes); // No replay of a checked but unapproved change.
    await page.getByTestId('note-editor-toggle').click();
    await page.getByTestId('note-edit-refresh').click();
    await record(page, pending.draftId).getByTestId('note-edit-review').click();
    await expect(page.getByTestId('note-edit-consent')).not.toBeChecked();
    await expect(page.getByTestId('note-edit-approve')).toBeDisabled();
    await expect(page.getByTestId('note-edit-after')).toHaveText(restartText.replace(/\n/g, '\r\n'));
    await approve(page, pending.draftId);
    expect(await readFile(file)).toEqual(serialize(restartText));
    await search(page, 'RESTARTNOTE', 1);

    // Empty files have no searchable source. A native picker scoped to the granted
    // folder must open them before and after a whole-file empty save.
    await app.evaluate(({dialog}, selected) => {
      (globalThis as any).__noteFilePickerCalls = 0;
      dialog.showOpenDialog = async () => {
        (globalThis as any).__noteFilePickerCalls++;
        return {canceled: false, filePaths: [selected]};
      };
    }, emptyFile);
    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-edit-choose').click();
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__noteFilePickerCalls)).toBe(1);
    await expect(page.getByTestId('note-edit-text')).toHaveValue('');
    await expect(page.getByTestId('note-edit-target')).toHaveText(emptyFile);
    const populated = await preview(page, 'EMPTYRESCUE 비어 있던 노트에 기록\n');
    await approve(page, populated.draftId);
    expect(await readFile(emptyFile, 'utf8')).toBe('EMPTYRESCUE 비어 있던 노트에 기록\n');
    await search(page, 'EMPTYRESCUE', 1);
    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-edit-choose').click();
    await expect(page.getByTestId('note-edit-text')).toHaveValue('EMPTYRESCUE 비어 있던 노트에 기록\n');
    const emptied = await preview(page, '');
    await expect(page.getByTestId('note-edit-review-panel')).toContainText('전체 내용이 비워져요');
    await approve(page, emptied.draftId);
    expect((await readFile(emptyFile)).length).toBe(0);
    await search(page, 'EMPTYRESCUE', 0);
    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-edit-choose').click();
    await expect(page.getByTestId('note-edit-text')).toHaveValue('');
    await expect(page.getByTestId('note-edit-target')).toHaveText(emptyFile);

    // Forgetting an executed edit removes its dependent undo and owned backups,
    // requires a separate confirmation, and does not modify the current file.
    const beforeForget = await history(page);
    await record(page, approved.draftId).getByTestId('note-edit-forget').click();
    await expect(record(page, approved.draftId).getByTestId('note-edit-forget-review')).toContainText('연결된 편집 기록과 보관한 원본 백업을 삭제');
    expect((await history(page)).length).toBe(beforeForget.length);
    await record(page, approved.draftId).getByTestId('note-edit-forget-confirm').click();
    await expect.poll(async () => (await history(page)).some(item => item.draftId === approved.draftId || item.draftId === undo.draftId)).toBe(false);
    expect(await readFile(file)).toEqual(serialize(restartText));
    expect((await readFile(emptyFile)).length).toBe(0);

    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-write').uncheck();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.writeEnabled).toBe(false);
    const readonlyText = restartText.replace('RESTARTNOTE', 'READONLYSYNC');
    await writeFile(file, serialize(readonlyText));
    await card().getByTestId('note-folder-sync').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.busy).toBe(false);
    await search(page, 'READONLYSYNC', 1);
    await expect(page.getByTestId('memory-edit-file')).toBeDisabled();
    expect(await readFile(file)).toEqual(serialize(readonlyText));
    expect(modelRequests).toBe(0);
  } finally {
    await app?.close(); await brain?.stop(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('a persisted running write becomes unknown after restart and requires reviewed recovery of its original bytes', async () => {
  test.setTimeout(240000);
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'note-edit-recovery-'));
  const profile = join(root, 'profile'), vault = join(root, '복구 검증 보관함'), data = join(root, 'brain');
  await mkdir(profile); await mkdir(vault); await writeFile(join(profile, 'Preferences'), '{}');
  const file = join(vault, 'recover.md');
  const originalText = '# 복구할 원본\nRECOVERYSEED 한글 원본과 그림 🙂\n';
  const original = serialize(originalText), partial = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xc3]);
  await writeFile(file, original);
  let modelRequests = 0;
  const upstream = createServer((_request, response) => { modelRequests++; response.end(); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const modelUrl = 'http://127.0.0.1:' + (upstream.address() as {port: number}).port;
  const start = () => startBrain(modelUrl, 'note-recovery-fixture', 'local', {data_dir: data});
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  try {
    brain = await start(); app = await launch(profile); let page = await app.firstWindow();
    await connect(page, brain);
    await app.evaluate(({dialog}, selected) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [selected]});
    }, vault);
    await panel(page, 'note-folders'); await page.getByTestId('note-folder-choose').click();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.path === vault)?.phase).toBe('ready');
    const folderId = (await snapshot(page)).noteFolders.folders.find(item => item.path === vault)!.id;
    const card = () => page.locator(`[data-testid="note-folder-card"][data-folder-id="${folderId}"]`);
    await card().getByTestId('note-folder-write').check();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.writeEnabled).toBe(true);
    await search(page, 'RECOVERYSEED', 1);
    await page.getByTestId('memory-edit-file').click();
    const interrupted = await preview(page, originalText.replace('RECOVERYSEED', 'NEVERREPLAY'));
    expect(await readFile(file)).toEqual(original);
    await app.close(); app = undefined; await brain.stop(); brain = undefined;

    // Fault injection is confined to this closed application's synthetic profile.
    // Use the real contract ledger to model a durable claim followed by a crash
    // during file I/O, before the executor could persist its receipt.
    const owner = hash(Buffer.from(JSON.stringify(['desktop-test', 'personal', 'owner'])));
    const journalPath = join(profile, 'note-edits', owner, 'note-edits.json');
    const saved = JSON.parse(await readFile(journalPath, 'utf8')) as {
      version: number; revision: number; records: {draft: ActionDraft}[]; ledger: ExecutionSnapshot;
    };
    const ledger = new ApprovalLedger(saved.ledger.identity, saved.ledger.executor_id, true, saved.ledger);
    for (const item of saved.records) await ledger.registerDraft(item.draft);
    const approved = ledger.approve(interrupted.draftId, interrupted.revision, randomUUID(), randomUUID(), Date.now());
    ledger.claim(approved, Date.now()); saved.ledger = ledger.snapshot(); saved.revision++;
    await writeFile(journalPath, JSON.stringify(saved));
    await writeFile(file, partial);

    brain = await start(); app = await launch(profile); page = await app.firstWindow();
    await connect(page, brain);
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.error).toBe('note_write_unknown');
    expect((await detail(page, interrupted.draftId)).status).toBe('unknown');
    expect((await detail(page, interrupted.draftId)).canUndo).toBe(true);
    expect(await readFile(file)).toEqual(partial);
    await search(page, 'RECOVERYSEED', 0);
    expect((await snapshot(page)).library.sources.filter(item => item.origin?.collection_id === folderId)).toEqual([]);
    // An unresolved write must retain its folder ID so its original-byte recovery
    // remains reachable; removing and re-adding must not re-index a partial file.
    await panel(page, 'note-folders');
    await card().getByTestId('note-folder-remove').click();
    await card().getByTestId('note-folder-remove-confirm').click();
    await expect(page.getByTestId('app-notice')).toContainText('폴더 연결을 해제하지 않았어요');
    expect((await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.path).toBe(vault);
    expect(await readFile(file)).toEqual(partial);
    // Removal revokes the active grant immediately. Renew permission explicitly
    // before the separately reviewed recovery; OFF remains independently usable.
    expect(await page.evaluate(async id => (window as any).kirianDesktop.setNoteFolderWriteEnabled({id, enabled: false}), folderId)).toEqual({ok: true});
    await card().getByTestId('note-folder-write').check();
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.writeEnabled).toBe(true);
    await page.getByTestId('note-editor-toggle').click();
    await page.getByTestId('note-edit-refresh').click();
    await expect(record(page, interrupted.draftId)).toContainText('결과 확인 필요');
    await expect(record(page, interrupted.draftId).getByTestId('note-edit-forget')).toHaveCount(0);
    await record(page, interrupted.draftId).getByTestId('note-edit-review').click();
    await expect(page.getByTestId('note-edit-unknown')).toContainText('자동으로 다시 실행하지 않아요');
    await expect(page.getByTestId('note-edit-approve')).toHaveCount(0);

    const beforeRecovery = new Set((await history(page)).map(item => item.draftId));
    await record(page, interrupted.draftId).getByTestId('note-edit-undo').click();
    await expect.poll(async () => (await history(page)).filter(item => !beforeRecovery.has(item.draftId)).length).toBe(1);
    const recovery = await detail(page, (await history(page)).find(item => !beforeRecovery.has(item.draftId))!.draftId);
    expect(recovery.kind).toBe('recovery');
    expect(recovery.beforeText).toBe(null);
    expect(recovery.beforeSha256).toBe(hash(partial));
    expect(recovery.afterSha256).toBe(hash(original));
    await expect(page.getByTestId('note-edit-before')).toContainText('UTF-8 문자로 표시할 수 없어요');
    await expect(page.getByTestId('note-edit-after')).toHaveText(originalText.replace(/\n/g, '\r\n'));
    await expect(page.getByTestId('note-edit-approve')).toBeDisabled();
    expect(await readFile(file)).toEqual(partial);
    await approve(page, recovery.draftId);
    expect(await readFile(file)).toEqual(original);
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.phase).toBe('ready');
    await search(page, 'RECOVERYSEED', 1);
    expect((await detail(page, interrupted.draftId)).resolvedBy).toBe(recovery.draftId);

    await app.close(); app = undefined; await brain.stop(); brain = undefined;
    brain = await start(); app = await launch(profile); page = await app.firstWindow();
    await connect(page, brain);
    await expect.poll(async () => (await snapshot(page)).noteFolders.folders.find(item => item.id === folderId)?.phase).toBe('ready');
    expect(await readFile(file)).toEqual(original);
    expect(await detail(page, interrupted.draftId)).toMatchObject({status: 'unknown', canUndo: false, resolvedBy: recovery.draftId});
    expect((await detail(page, recovery.draftId)).status).toBe('succeeded');
    await search(page, 'RECOVERYSEED', 1);
    const replay = await page.evaluate(async input => {
      try { await (window as any).kirianDesktop.approveNoteEdit(input); return 'unexpected success'; }
      catch (error) { return String(error); }
    }, {draftId: interrupted.draftId, revision: interrupted.revision, payloadSha256: interrupted.payloadSha256});
    expect(replay).not.toBe('unexpected success');
    expect(await readFile(file)).toEqual(original);
    expect(modelRequests).toBe(0);
  } finally {
    await app?.close(); await brain?.stop(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
