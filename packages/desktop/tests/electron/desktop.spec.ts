import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.test-output');
const packaged = process.env.KIRIAN_PACKAGED_EXE;
async function capture(app: ElectronApplication, name: string) {
  const page = await app.firstWindow();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage(
      undefined,
      { stayHidden: true, stayAwake: true }
    );
    return image.toPNG().toString('base64');
  });
  expect(png.length).toBeGreaterThan(100);
  await writeFile(join(output, name), Buffer.from(png, 'base64'));
}

test('actual Electron shell, isolated bridge, validated messages and window lifecycle', async () => {
  await mkdir(output, { recursive: true });
  const profile = await mkdtemp(join(output, 'profile-'));
  const env: Record<string, string> = {
    ...process.env,
    KIRIAN_DESKTOP_TEST: '1',
    KIRIAN_TEST_PROFILE: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KIRIAN_RENDERER_URL;
  delete env.KIRIAN_BRAIN_URL;
  delete env.KIRIAN_BRAIN_TOKEN;
  const app = await electron.launch({
    cwd: root,
    args: packaged ? [] : [root],
    env,
    executablePath: packaged,
    chromiumSandbox: true,
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect(page.getByTestId('connection-status')).toHaveText(
      '연결 안 됨'
    );
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.locator('.live2d-stage')).toHaveAttribute('data-state', 'ready');
    await expect(
      page.getByText('Live2D 연결됨', { exact: true })
    ).toBeVisible();
    expect(page.url()).toBe('kirian://app/index.html');
    await expect(page).toHaveTitle('Kirian');
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Kirian');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Kirian');

    const isolated = await page.evaluate(() => ({
      requireType: typeof (window as any).require,
      processType: typeof (window as any).process,
      keys: Object.keys((window as any).kirianDesktop).sort(),
    }));
    expect(isolated).toEqual({
      requireType: 'undefined',
      processType: 'undefined',
      keys: [
        'getRuntime','subscribeRuntime','startRuntime','stopRuntime','importRuntimeSettings','restoreRuntimeSettings','openRuntimeDataFolder',
        'getExternalState', 'addMcpConnection', 'addGoogleCalendar', 'connectExternal', 'disconnectExternal',
        'getConversationTools', 'configureConversationTools',
        'cancelExternalConnections', 'discoverExternalTools', 'listExternalCalendars', 'listExternalEvents',
        'previewExternalAction', 'approveExternalAction', 'cancelExternalAction', 'reconcileExternalAction',
        'getProactive', 'subscribeProactive', 'refreshProactiveSources', 'configureProactive', 'startProactive', 'pauseProactive', 'dismissProactive',
        'analyzeScreen',
        'approveAction',
        'approveNoteEdit',
        'armMicrophone',
        'cancelScreenAnalysis',
        'cancelTranscription',
        'cancelTurn',
        'captureScreen',
        'chooseNoteFile',
        'chooseNoteFolder',
        'clearAutoScreens',
        'close',
        'closeNoteFile',
        'configureAutoMemory',
        'configureAutoScreen',
        'configureRouting',
        'connectBrain',
        'createNoteDraft',
        'createSource',
        'deleteConversation',
        'deleteScreenCapture',
        'deleteSource',
        'disableAutoScreen',
        'disconnectBrain',
        'dismissAction',
        'dismissNoteEdit',
        'forgetNoteEdit',
        'getAutoMemory',
        'getAutoScreen',
        'getScreenState',
        'getSnapshot',
        'listActions',
        'listAutoScreenSources',
        'listNoteEdits',
        'listScreenSources',
        'minimize',
        'newConversation',
        'onAudio',
        'openConversation',
        'openNoteFile',
        'pauseAutoScreen',
        'previewNoteEdit',
        'previewNoteUndo',
        'reconnectBrain',
        'refreshLibrary',
        'refreshRouting',
        'refreshSavedScreens',
        'releaseScreenPreview',
        'removeNoteFolder',
        'reportPlayback',
        'reviewNoteEdit',
        'saveDefaultModel',
        'searchAutoMemory',
        'selectModel',
        'selectSources',
        'sendText',
        'setAlwaysOnTop',
        'setClickThrough',
        'recoverWindow',
        'setNoteFolderBoundary',
        'setNoteFolderWriteEnabled',
        'setVoiceEnabled',
        'startAutoScreen',
        'subscribe',
        'subscribeAutoScreen',
        'subscribeScreens',
        'syncNoteFolder',
        'transcribeAudio',
        'updateSource',
        'useScreenAnalysis',
        'version',
      ].sort(),
    });
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const prefs =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
      };
    });
    expect(preferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });

    await page.getByTestId('always-on-top').click();
    await expect(page.getByTestId('always-on-top')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isAlwaysOnTop()
      )
    ).toBe(true);
    await page.getByTestId('always-on-top').click();
    await expect(page.getByTestId('always-on-top')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(
      await page.evaluate(() =>
        (window as any).kirianDesktop.setAlwaysOnTop('yes')
      )
    ).toEqual({ ok: false, code: 'invalid_request' });
    expect(
      await page.evaluate(() => (window as any).kirianDesktop.sendText(' '))
    ).toEqual({ ok: false, code: 'invalid_request' });
    expect(
      await page.evaluate(() => (window as any).kirianDesktop.sendText('테스트'))
    ).toEqual({ ok: false, code: 'brain_unavailable' });
    await expect(page.getByTestId('conversation-empty')).toBeVisible();
    await capture(app, packaged ? 'packaged-empty.png' : 'desktop-empty.png');

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(560, 640)
    );
    // Windows display scaling can round the requested DIP size down by one pixel.
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(560);
    expect(await page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(
      559
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    await capture(
      app,
      packaged ? 'packaged-compact.png' : 'desktop-compact.png'
    );
    await page.evaluate(() => window.open('kirian://app/index.html'));
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
      )
    ).toBe(1);
    expect(errors).toEqual([]);
    await page.getByTestId('minimize-window').click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isMinimized()
        )
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].restore()
    );
    await page.evaluate(() => {
      window.location.href = 'kirian://app/blocked.html';
    });
    // Electron cancels before commit; inspect the retained document directly because
    // Playwright locator actions can keep waiting for this prevented navigation.
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getURL()
      )
    ).toBe('kirian://app/index.html');
    expect(
      await page.evaluate(() => ({
        url: location.href,
        shell: !!document.querySelector('[data-testid="desktop-shell"]'),
      }))
    ).toEqual({ url: 'kirian://app/index.html', shell: true });
    const closed = app.waitForEvent('close');
    await page.evaluate(() =>
      (
        document.querySelector(
          '[data-testid="close-window"]'
        ) as HTMLButtonElement
      ).click()
    );
    await closed;
  } finally {
    await app.close().catch(() => {});
  }
});
