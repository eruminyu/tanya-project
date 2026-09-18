import {test, expect, _electron as electron, type ElectronApplication} from '@playwright/test';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeWindowTransparent} from '../fixtures/window-style.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.test-output');
const packaged = process.env.KIRIAN_PACKAGED_EXE;
const shortcut = 'CommandOrControl+Alt+T';
async function profile() { await mkdir(output, {recursive:true}); return mkdtemp(join(output, 'window-profile-')); }
async function launch(directory: string): Promise<ElectronApplication> {
  const env = {...process.env,KIRIAN_DESKTOP_TEST:'1',KIRIAN_TEST_PROFILE:directory};
  for (const key of ['ELECTRON_RUN_AS_NODE','KIRIAN_RENDERER_URL','KIRIAN_BRAIN_URL','KIRIAN_BRAIN_TOKEN']) delete env[key];
  return electron.launch({cwd:root,args:packaged?[]:[root],executablePath:packaged,env,chromiumSandbox:true});
}
async function state(app: ElectronApplication) {
  return (await app.firstWindow()).evaluate(async () => (await window.kirianDesktop!.getSnapshot()).window);
}
async function nativeTransparent(app: ElectronApplication): Promise<boolean> {
  const handle = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readBigUInt64LE().toString());
  return nativeWindowTransparent(handle);
}
async function settings(app: ElectronApplication) {
  const page = await app.firstWindow();
  await expect(page.getByTestId('desktop-shell')).toBeVisible();
  await page.locator('details.window-settings > summary').click();
  return page;
}
test('창 설정 UI와 native 클릭 통과, 복구 명령, 등록 상실과 재시작 OFF', async () => {
  test.setTimeout(60000);
  const directory = await profile();let app = await launch(directory);
  try {
    const page = await settings(app);
    expect((await state(app)).recoveryAvailable).toBe(true);
    await expect(page.getByTestId('click-through-toggle')).toHaveAttribute('aria-pressed','false');
    await page.getByTestId('click-through-toggle').click();
    await expect(page.getByTestId('click-through-notice')).toBeVisible();
    expect(await nativeTransparent(app)).toBe(true);
    expect(await page.evaluate(()=>window.kirianDesktop!.setClickThrough('true' as any))).toEqual({ok:false,code:'invalid_request'});
    // This command operates only on the test-owned window. No OS keyboard injection.
    expect(await page.evaluate(()=>window.kirianDesktop!.recoverWindow())).toEqual({ok:true});
    expect(await nativeTransparent(app)).toBe(false);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.hide());
    await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true));
    await app.evaluate(({powerMonitor})=>powerMonitor.emit('lock-screen'));
    expect(await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true))).toEqual({ok:false,code:'interaction_blocked'});
    expect(await page.evaluate(()=>window.kirianDesktop!.setClickThrough(false))).toEqual({ok:true});
    await app.evaluate(({powerMonitor})=>powerMonitor.emit('unlock-screen'));
    expect((await state(app)).clickThrough).toBe(false);expect(await nativeTransparent(app)).toBe(false);
    await app.evaluate(({powerMonitor})=>{powerMonitor.emit('suspend');powerMonitor.emit('lock-screen');powerMonitor.emit('resume');});
    expect(await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true))).toEqual({ok:false,code:'interaction_blocked'});
    await app.evaluate(({powerMonitor})=>powerMonitor.emit('unlock-screen'));
    expect((await state(app)).clickThrough).toBe(false);
    await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true));
    await app.evaluate(({globalShortcut})=>globalShortcut.setSuspended(true));
    await expect.poll(async()=> (await state(app)).clickThrough).toBe(false);
    expect(await nativeTransparent(app)).toBe(false);
    await expect(page.getByTestId('click-through-toggle')).toBeDisabled();
    await app.evaluate(({globalShortcut})=>globalShortcut.setSuspended(false));
    await expect.poll(async()=> (await state(app)).recoveryAvailable).toBe(true);
    await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true));
    await app.evaluate(({globalShortcut},key)=>globalShortcut.unregister(key),shortcut);
    await expect.poll(async()=> (await state(app)).clickThrough).toBe(false);
    expect(await nativeTransparent(app)).toBe(false);
    await app.close();app = await launch(directory);
    expect((await state(app)).clickThrough).toBe(false);
    expect(await nativeTransparent(app)).toBe(false);
  } finally {await app.close();}
});

test('일반 창 bounds 저장·복원과 화면 밖 보정, 최소화 및 renderer 재시작 복구', async () => {
  test.setTimeout(60000);
  const directory = await profile();let app = await launch(directory);
  try {
    let page = await app.firstWindow();await expect(page.getByTestId('desktop-shell')).toBeVisible();
    const expected = await app.evaluate(({BrowserWindow,screen})=>{
      const window=BrowserWindow.getAllWindows()[0]!, area=screen.getPrimaryDisplay().workArea;
      window.setBounds({x:area.x+20,y:area.y+20,width:Math.min(800,area.width-40),height:Math.min(680,area.height-40)});
      return window.getBounds();
    });
    const file=join(directory,'kirian-settings/window-bounds.json');
    await expect.poll(async()=>{try{return JSON.parse(await readFile(file,'utf8')).bounds;}catch{return null;}}).toEqual(expected);
    await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true));
    await app.close();app=await launch(directory);page=await app.firstWindow();
    await expect(page.getByTestId('desktop-shell')).toBeVisible();
    expect((await state(app)).clickThrough).toBe(false);
    const restored = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.getBounds());
    for(const key of ['x','y','width','height'] as const) expect(Math.abs(restored[key]-expected[key])).toBeLessThanOrEqual(1);
    const restarts = [{restored, persisted:JSON.parse(await readFile(file,'utf8')).bounds}];
    // Repeated close/reopen and no-op recovery must not accumulate native rounding.
    for (let restart=0;restart<2;restart++) {
      expect(await page.evaluate(()=>window.kirianDesktop!.recoverWindow())).toEqual({ok:true});
      await app.close();
      expect(JSON.parse(await readFile(file,'utf8')).bounds).toEqual(expected);
      app=await launch(directory);page=await app.firstWindow();
      await expect(page.getByTestId('desktop-shell')).toBeVisible();
      const current=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.getBounds());
      restarts.push({restored:current,persisted:JSON.parse(await readFile(file,'utf8')).bounds});
      for(const key of ['x','y','width','height'] as const) expect(Math.abs(current[key]-expected[key])).toBeLessThanOrEqual(1);
    }
    await writeFile(join(directory,'bounds-restarts.json'),JSON.stringify({expected,restarts},null,2));
    await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true));await page.reload();
    expect((await state(app)).clickThrough).toBe(false);expect(await nativeTransparent(app)).toBe(false);
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0]!;window.setPosition(90000,90000);window.minimize();});
    // Exercise the same handler invoked by the single-instance lock, scoped to our app.
    await app.evaluate(({app})=>app.emit('second-instance',{},[],''));
    const recovered=await app.evaluate(({BrowserWindow,screen})=>{
      const window=BrowserWindow.getAllWindows()[0]!, bounds=window.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
      return {minimized:window.isMinimized(),inside:bounds.x>=area.x-1 && bounds.y>=area.y-1 && bounds.x+bounds.width<=area.x+area.width+1 && bounds.y+bounds.height<=area.y+area.height+1};
    });
    expect(recovered).toEqual({minimized:false,inside:true});
    await app.close();
    await writeFile(file,JSON.stringify({version:1,displayId:99999,bounds:{x:-90000,y:90000,width:9000,height:9000}}));
    app=await launch(directory);page=await app.firstWindow();await expect(page.getByTestId('desktop-shell')).toBeVisible();
    const fit=await app.evaluate(({BrowserWindow,screen})=>{
      const bounds=BrowserWindow.getAllWindows()[0]!.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
      return {bounds,area};
    });
    expect(Math.abs(fit.bounds.width-fit.area.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(fit.bounds.height-fit.area.height)).toBeLessThanOrEqual(1);
  } finally {await app.close();}
});

test('다른 테스트 인스턴스의 단축키 점유 시 클릭 통과를 차단한다', async () => {
  test.setTimeout(60000);
  const owner=await launch(await profile());let blocked:ElectronApplication|undefined;
  try {
    expect((await state(owner)).recoveryAvailable).toBe(true);
    blocked=await launch(await profile());const page=await settings(blocked);
    expect((await state(blocked)).recoveryAvailable).toBe(false);
    await expect(page.getByTestId('click-through-toggle')).toBeDisabled();
    await expect(page.getByTestId('shortcut-unavailable')).toBeVisible();
    expect(await page.evaluate(()=>window.kirianDesktop!.setClickThrough(true))).toEqual({ok:false,code:'shortcut_unavailable'});
    expect(await nativeTransparent(blocked)).toBe(false);
    const png=await blocked.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0]!.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
    await writeFile(join(output,'t073-shortcut-unavailable.png'),Buffer.from(png,'base64'));
  } finally {await blocked?.close();await owner.close();}
});
