import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

async function launch(profile:string){
  const env:Record<string,string>={};for(const [key,value]of Object.entries(process.env))if(value!==undefined)env[key]=value;
  Object.assign(env,{KIRIAN_DESKTOP_TEST:'1',KIRIAN_TEST_PROFILE:profile});
  for(const key of ['ELECTRON_RUN_AS_NODE','KIRIAN_BRAIN_URL','KIRIAN_BRAIN_TOKEN','KIRIAN_RENDERER_URL'])delete env[key];
  return electron.launch({cwd:desktopRoot,args:process.env.KIRIAN_PACKAGED_EXE?[]:[desktopRoot],executablePath:process.env.KIRIAN_PACKAGED_EXE,env,chromiumSandbox:true});
}
const state=(page:Page)=>page.evaluate(()=>(window as any).kirianDesktop.getAutoScreen());
async function connect(page:Page,brain:{url:string;token:string}){
  await page.evaluate(options=>(window as any).kirianDesktop.connectBrain(options),{url:brain.url,token:brain.token});
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await expect.poll(async()=>(await state(page)).available).toBe(true);
}
async function owned(app:ElectronApplication){
  return app.evaluate(async({BrowserWindow})=>{
    const fixture=new BrowserWindow({width:420,height:280,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    await fixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Kirian automatic capture fixture</title><body style="background:#1f5993;color:white;font:24px sans-serif">AUTO CAPTURE TEST<br>Only this test window.</body>'));
    fixture.showInactive();await new Promise(resolve=>setTimeout(resolve,350));return fixture.getMediaSourceId();
  });
}
test('자동 수집 UI, 실제 허용 창의 JPEG, 고정 모델 예산 경로, 중단·재시작·수동 기록 보존',async()=>{
  test.setTimeout(150000);await mkdir(output,{recursive:true});const root=await mkdtemp(join(output,'auto-screens-'));
  const profile=join(root,'profile');await mkdir(profile);const requests:any[]=[];
  const upstream=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;
    const value=JSON.parse(body);requests.push(value);res.setHeader('content-type','application/x-ndjson');
    res.end(JSON.stringify({model:value.model,message:{content:'[HTTP 테스트 표본] 자동 화면 설명'},done:true})+'\n');
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+(upstream.address()as{port:number}).port;
  const brain=await startBrain(url,'auto-local','local',{data_dir:join(root,'brain'),bindings:[{
    model:{provider_id:'ollama',model_id:'auto-local',endpoint_id:'test-ollama'},label:'auto-local',kind:'ollama',url,boundary:'local',
    supports_images:true,supports_text:true,automatic_allowed:true,budget_units:1,think:false,num_ctx:8192,
  }]});
  let app:ElectronApplication|undefined;
  try{
    app=await launch(profile);let page=await app.firstWindow();await connect(page,brain);const source=await owned(app);
    expect(await page.evaluate(async()=>(await(window as any).kirianDesktop.getExternalState()).actions)).toEqual([]);
    await page.getByTestId('auto-screen-panel').locator('summary').click();
    await page.getByTestId('auto-screen-list').click();await page.getByTestId('auto-screen-targets').selectOption(source);
    await page.getByTestId('auto-screen-enabled').check();await page.getByTestId('auto-screen-save').click();
    await page.getByTestId('auto-screen-start').click();
    await expect(page.getByTestId('auto-screen-preview')).toBeVisible({timeout:20000});
    await expect.poll(async()=>page.getByTestId('auto-screen-preview').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
    expect(requests).toHaveLength(0);
    await page.getByTestId('auto-screen-pause').click();await expect(page.getByTestId('auto-screen-preview')).toHaveCount(0);
    await page.getByTestId('auto-screen-analysis-enabled').check();
    const model=await page.evaluate(async()=>{const s=await(window as any).kirianDesktop.getSnapshot();return s.brain.models[0].id;});
    await page.getByTestId('auto-screen-model').selectOption(model);await page.getByTestId('auto-screen-save').click();
    await page.getByTestId('auto-screen-start').click();await expect.poll(async()=>(await state(page)).analysis?.text,{timeout:25000}).toContain('자동 화면 설명');
    const analysisState=await state(page);expect(requests).toHaveLength(1);
    const external=await page.evaluate(()=>(window as any).kirianDesktop.getExternalState());
    expect(external.actions).toEqual([]);expect(external.connections).toEqual([]);
    expect(requests[0].messages.at(-1).images).toEqual([analysisState.preview.dataUrl.split(',')[1]]);
    const budget=await fetch(brain.url+'/v1/routing',{headers:{Authorization:'Bearer '+brain.token}}).then(r=>r.json());
    expect(budget.enabled).toBe(false);expect(budget.calls_used).toBe(1);
    await page.getByTestId('auto-screen-panel').scrollIntoViewIfNeeded();
    const png=await app.evaluate(async({BrowserWindow})=>{
      const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='kirian://app/index.html')!;
      return (await main.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');
    });
    await writeFile(join(root,'auto-screen.png'),Buffer.from(png,'base64'));
    // Simulate the Electron notification; this does not lock the user's PC.
    await app.evaluate(({powerMonitor})=>{powerMonitor.emit('suspend');powerMonitor.emit('lock-screen');powerMonitor.emit('resume');});
    await expect.poll(async()=>(await state(page)).running).toBe(false);expect((await state(page)).preview).toBeNull();
    const denied=await page.evaluate(async()=>{try{const b=(window as any).kirianDesktop;await b.startAutoScreen({revision:(await b.getAutoScreen()).revision});return false;}catch{return true;}});
    expect(denied).toBe(true);await app.evaluate(({powerMonitor})=>powerMonitor.emit('unlock-screen'));
    expect((await state(page)).running).toBe(false);
    // Manual records are independent of automatic retention.
    await page.evaluate(async({source,model})=>{
      const b=(window as any).kirianDesktop;await b.listScreenSources();await b.captureScreen({sourceId:source,boundary:'local'});
      const preview=(await b.getScreenState()).preview;
      await b.analyzeScreen({captureId:preview.id,revision:preview.revision,modelId:model,prompt:'수동 화면 테스트'});
    },{source,model});
    const manual=await page.evaluate(async()=>(await(window as any).kirianDesktop.getScreenState()).preview.id);
    await app.close();app=await launch(profile);page=await app.firstWindow();await connect(page,brain);
    expect((await state(page)).settings.enabled).toBe(true);expect((await state(page)).running).toBe(false);
    expect((await state(page)).preview).toBeNull();expect((await state(page)).records).toHaveLength(1);
    expect(requests).toHaveLength(2);
    await page.getByTestId('auto-screen-panel').locator('summary').click();
    await page.getByRole('button',{name:'자동 기록 전체 삭제',exact:true}).click();await page.getByTestId('auto-screen-clear').click();
    await expect.poll(async()=>(await state(page)).records.length).toBe(0);
    const saved=await fetch(brain.url+'/v1/screens',{headers:{Authorization:'Bearer '+brain.token}}).then(r=>r.json());
    expect(saved.screens.map((s:any)=>s.capture_id)).toEqual([manual]);
    await page.getByTestId('auto-screen-disable').click();await expect.poll(async()=>(await state(page)).settings.enabled).toBe(false);
  }finally{await app?.close();await brain.stop();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
