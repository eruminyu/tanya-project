import {test,expect,_electron as electron} from '@playwright/test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {desktopRoot,output,startBrain} from './brain-fixture.js';

test('자동 기억 설정·즉시 OFF·기존 수동 검색을 실제 격리 Electron에서 검증한다',async()=>{
  test.setTimeout(90000);
  await mkdir(output,{recursive:true});
  const directory=await mkdtemp(join(output,'auto-memory-')),profile=join(directory,'profile');
  await mkdir(profile);
  const brain=await startBrain('http://127.0.0.1:1','unconfigured-fixture','local',{data_dir:join(directory,'brain')});
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(process.env)) if(value!==undefined) env[key]=value;
  Object.assign(env,{KIRIAN_DESKTOP_TEST:'1',KIRIAN_TEST_PROFILE:profile});
  for(const key of ['ELECTRON_RUN_AS_NODE','KIRIAN_BRAIN_URL','KIRIAN_BRAIN_TOKEN','KIRIAN_RENDERER_URL']) delete env[key];
  const app=await electron.launch({cwd:desktopRoot,args:process.env.KIRIAN_PACKAGED_EXE?[]:[desktopRoot],
    executablePath:process.env.KIRIAN_PACKAGED_EXE,env,chromiumSandbox:true});
  try{
    const page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('brain-url').fill(brain.url);await page.getByTestId('brain-token').fill(brain.token);
    await page.getByTestId('brain-connect').click();await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
    await page.getByTestId('brain-settings-toggle').click();await page.getByTestId('memory-toggle').click();
    await expect(page.getByTestId('auto-memory-status')).toHaveText('자동 기능 꺼짐');
    await page.getByTestId('auto-memory-enabled').check();await page.getByTestId('auto-memory-retrieval').check();
    await page.getByTestId('auto-memory-save').click();
    await expect.poll(()=>page.evaluate(async()=>(await window.kirianDesktop!.getAutoMemory()).settings.enabled)).toBe(true);
    await expect(page.getByTestId('auto-memory-status')).toContainText(/미설정|사용할 수 없어요/);
    await page.getByTestId('auto-memory-stop').click();await expect(page.getByTestId('auto-memory-status')).toHaveText('자동 기능 꺼짐');
    expect(await page.evaluate(async()=>(await window.kirianDesktop!.getAutoMemory()).settings.retrieval_enabled)).toBe(false);
    expect(await page.evaluate(async()=>{try{await window.kirianDesktop!.searchAutoMemory({query:'주입',context:[]} as any);return 'accepted';}catch{return 'rejected';}})).toBe('rejected');
    await page.getByTestId('memory-new').click();await page.getByTestId('memory-title').fill('수동 기억 표본');
    await page.getByTestId('memory-text').fill('자동 기능이 꺼져도 수동 노트는 사용할 수 있다.');await page.getByTestId('memory-save').click();
    await expect(page.getByTestId('memory-source')).toHaveCount(1);
    await page.getByTestId('memory-search').fill('수동');await page.getByTestId('memory-refresh').click();await expect(page.getByTestId('memory-source')).toHaveCount(1);
    await page.getByTestId('memory-editor-close').click();
    await page.locator('#auto-memory-title').evaluate(element=>element.scrollIntoView({block:'start'}));
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0]!.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
    await writeFile(join(output,'auto-memory-settings.png'),Buffer.from(png,'base64'));
    expect(errors).toEqual([]);
  }finally{await app.close();await brain.stop();}
});
