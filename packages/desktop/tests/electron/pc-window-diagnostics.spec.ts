import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output } from './brain-fixture.js';

test('isolated bounds diagnostics compare constructor, setBounds, persistence and display scale', async () => {
  test.setTimeout(60000);
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'pc-window-diagnostics-')), profile = join(directory, 'profile');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(KIRIAN_|TANYA_|ELECTRON_RUN_AS_NODE$)/i.test(key)) env[key] = value;
  Object.assign(env, { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: profile });
  const executablePath = process.env.KIRIAN_PACKAGED_EXE;
  const launch = () => electron.launch({ cwd: desktopRoot, args: executablePath ? [] : [desktopRoot], executablePath, env, chromiumSandbox: true });
  const measurements: Record<string, unknown> = {};
  const inspect = (app: ElectronApplication) => app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return { bounds: window.getBounds(), normal: window.getNormalBounds(), content: window.getContentBounds(),
      displays: screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor })) };
  });
  const file = join(profile, 'kirian-settings/window-bounds.json');
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); await expect((await app.firstWindow()).getByTestId('desktop-shell')).toBeVisible();
    measurements.initial = await inspect(app);
    const requested = await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const bounds = { x: area.x + 20, y: area.y + 20, width: Math.min(800, area.width - 40), height: Math.min(680, area.height - 40) };
      BrowserWindow.getAllWindows()[0]!.setBounds(bounds);
      return bounds;
    });
    measurements.requested = requested; measurements.afterSet = await inspect(app);
    await expect.poll(async () => { try { return JSON.parse(await readFile(file, 'utf8')).bounds; } catch { return null; } }).toEqual((measurements.afterSet as any).bounds);
    await app.close(); app = undefined;
    const persisted = JSON.parse(await readFile(file, 'utf8')); measurements.persisted = persisted;
    app = await launch(); await expect((await app.firstWindow()).getByTestId('desktop-shell')).toBeVisible();
    measurements.restored = await inspect(app);
    measurements.restorationDelta = Object.fromEntries(['x','y','width','height'].map(key =>
      [key, (measurements.restored as any).bounds[key] - persisted.bounds[key]]));
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds), persisted.bounds);
    measurements.afterReapply = await inspect(app);
    measurements.nativeProbe = await app.evaluate(({ BrowserWindow }, bounds) => {
      return [true, false].map(thickFrame => {
        const window = new BrowserWindow({ ...bounds, frame: false, thickFrame, show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try {
          const constructed = { bounds: window.getBounds(), content: window.getContentBounds() };
          window.setBounds(bounds);
          const afterSet = { bounds: window.getBounds(), content: window.getContentBounds() };
          const attempts = [];
          let command = {...bounds};
          for (let attempt = 0; attempt < 4; attempt++) {
            window.setBounds(command);
            const actual = window.getBounds(); attempts.push({command, actual});
            if (['x','y','width','height'].every(key => actual[key as keyof typeof actual] === bounds[key as keyof typeof bounds])) break;
            command = Object.fromEntries(['x','y','width','height'].map(key => [key,
              command[key as keyof typeof command] + bounds[key as keyof typeof bounds] - actual[key as keyof typeof actual]])) as typeof bounds;
          }
          return { thickFrame, requested: bounds, constructed, afterSet, measuredRestoration: attempts };
        } finally { window.destroy(); }
      });
    }, persisted.bounds);
  } finally {
    await app?.close();
    await writeFile(join(directory, 'bounds.json'), JSON.stringify(measurements, null, 2));
  }
});
