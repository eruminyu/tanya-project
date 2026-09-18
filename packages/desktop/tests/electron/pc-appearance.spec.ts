import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output } from './brain-fixture.js';

test('isolated appearance records actual Live2D readiness and a reviewable desktop frame', async () => {
  test.setTimeout(60000);
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'pc-appearance-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(KIRIAN_|TANYA_|ELECTRON_RUN_AS_NODE$)/i.test(key)) env[key] = value;
  }
  Object.assign(env, { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: join(directory, 'profile') });
  const startedAt = Date.now(), executablePath = process.env.KIRIAN_PACKAGED_EXE;
  const app = await electron.launch({ cwd: desktopRoot, args: executablePath ? [] : [desktopRoot],
    executablePath, env, chromiumSandbox: true });
  const samples: { elapsedMs: number; state: string | null; progress: string | null }[] = [];
  const errors: string[] = [], consoleErrors: string[] = [], assetErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', request => {
      if (request.url().startsWith('kirian://app/live2d/')) assetErrors.push(request.url() + ': ' + request.failure()?.errorText);
    });
    page.on('response', response => {
      if (response.url().startsWith('kirian://app/live2d/') && response.status() >= 400) assetErrors.push(response.url() + ': ' + response.status());
    });
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    await expect.poll(async () => {
      const state = await page.locator('.live2d-stage').getAttribute('data-state');
      const progress = await page.evaluate(() => document.querySelector('[data-testid=live2d-status]')?.textContent ?? null);
      samples.push({ elapsedMs: Date.now() - startedAt, state, progress });
      return state;
    }, { timeout: 25000, intervals: [250, 500, 1000], message: 'Live2D must reach ready within the measured startup window' }).toBe('ready');
    expect(errors).toEqual([]);
    await expect(page.getByTestId('connection-status')).toHaveText('연결 안 됨');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'kirian://app/index.html')!;
      return (await main.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64');
    });
    await writeFile(join(directory, 'appearance.png'), Buffer.from(png, 'base64'));
  } finally {
    await writeFile(join(directory, 'startup.json'), JSON.stringify({ executablePath: executablePath ?? 'development', samples, errors, consoleErrors, assetErrors }, null, 2));
    await app.close();
  }
});
