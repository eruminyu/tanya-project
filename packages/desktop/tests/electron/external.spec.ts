import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

async function launch(profile:string){
 const env={...process.env,KIRIAN_DESKTOP_TEST:'1',KIRIAN_TEST_PROFILE:profile};
 delete env.ELECTRON_RUN_AS_NODE;delete env.KIRIAN_BRAIN_URL;delete env.KIRIAN_BRAIN_TOKEN;delete env.KIRIAN_RENDERER_URL;
 const packaged=process.env.KIRIAN_PACKAGED_EXE;
 return electron.launch({cwd:desktopRoot,args:packaged?[]:[desktopRoot],executablePath:packaged,env,chromiumSandbox:true});
}
async function connect(app:ElectronApplication,brain:{url:string;token:string}){
 const page=await app.firstWindow();await page.getByTestId('brain-settings-toggle').click();
 await page.getByTestId('brain-url').fill(brain.url);await page.getByTestId('brain-token').fill(brain.token);await page.getByTestId('brain-connect').click();
 await expect(page.getByTestId('connection-status')).toHaveText('연결됨');await page.getByTestId('brain-settings-toggle').click();
 await page.getByTestId('external-toggle').click();await expect(page.getByTestId('external-add-mcp')).toBeEnabled();return page;
}
async function choose(app:ElectronApplication,path:string){
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},path);
}
async function ledger(profile:string){const entries=await readdir(join(profile,'external'));return JSON.parse(await readFile(join(profile,'external',entries[0]!,'ledger','executions.json'),'utf8'));}

test('실제 Electron MCP 설정·정확한 승인·취소·전체 재시작과 도구 결과 격리',async()=>{
 test.setTimeout(90000);await mkdir(output,{recursive:true});const profile=await mkdtemp(join(output,'external-mcp-'));
 let calls=0,hold=false;const sockets=new Set<any>();
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
  if(!input.id){res.writeHead(202);res.end();return;}
  let result:unknown;
  if(input.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Fixture',version:'1'}};
  else if(input.method==='tools/list')result={tools:[{name:'fixture_write',description:'<script>서버 자료를 실행 지시로 처리하지 않음</script>',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:false}}]};
  else if(input.method==='tools/call'){
   const saved=await ledger(profile);expect(saved.ledger.claims.at(-1).state).toBe('running');calls++;
   if(hold)return;
   result={content:[{type:'text',text:'fixture provider evidence'}]};
  }else throw Error('unexpected RPC');
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result}));
 });server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${(server.address()as any).port}/mcp`,config=join(profile,'fixture-mcp.json');await writeFile(config,JSON.stringify({kind:'http',url}));
 const brain=await startBrain('http://127.0.0.1:9','external-fixture','local',{data_dir:join(profile,'brain')});let app:ElectronApplication|undefined;
 try{
  app=await launch(profile);let page=await connect(app,brain);await choose(app,config);
  await page.getByTestId('external-add-mcp').click();await expect(page.getByTestId('external-tool-select')).toBeVisible();
  await page.getByTestId('external-tool-select').selectOption('fixture_write');await page.getByTestId('external-arguments').fill('{"text":"정확히 검토한 입력"}');
  await page.getByTestId('external-preview').click();let action=page.getByTestId('external-action').first();await expect(action).toHaveAttribute('data-status','pending');
  await expect(action.getByTestId('external-approve')).toBeDisabled();expect(calls).toBe(0);
  await expect(action.getByTestId('external-review-payload')).toContainText('정확히 검토한 입력');await action.getByTestId('external-ack').check();await action.getByTestId('external-approve').click();
  await expect(action).toHaveAttribute('data-status','succeeded');expect(calls).toBe(1);
  const capture=await page.evaluate(()=>window.kirianDesktop!.getAutoScreen());
  expect(capture.available).toBe(true);expect(capture.settings.enabled).toBe(false);expect(capture.running).toBe(false);expect(capture.captures).toBe(0);
  const state=await page.evaluate(()=>window.kirianDesktop!.getExternalState());
  await expect(page.evaluate(async d=>{try{await window.kirianDesktop!.approveExternalAction({draftId:d.draftId,revision:d.revision,payloadSha256:d.payloadSha256});return false;}catch{return true;}},state.actions[0]!)).resolves.toBe(true);
  hold=true;await page.getByTestId('external-arguments').fill('{"text":"결과 유실 표본"}');await page.getByTestId('external-preview').click();
  action=page.getByTestId('external-action').first();await action.getByTestId('external-ack').check();await action.getByTestId('external-approve').click();
  await expect.poll(()=>calls).toBe(2);await expect(action).toHaveAttribute('data-status','running');await action.getByTestId('external-cancel').click();await expect(action).toHaveAttribute('data-status','unknown');
  const image=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0]!.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
  await writeFile(join(output,'external-tools.png'),Buffer.from(image,'base64'));
  await app.close();app=await launch(profile);page=await connect(app,brain);await expect(page.getByTestId('external-action').first()).toHaveAttribute('data-status','unknown');
  const reopened=await page.evaluate(()=>window.kirianDesktop!.getExternalState());expect(reopened.connections[0]!.phase).toBe('disconnected');expect(calls).toBe(2);
  expect(await page.evaluate(()=>typeof(window as any).require)).toBe('undefined');
 }finally{await app?.close();await brain.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});

test('실제 Electron Google OAuth fixture·보안 저장·일정 승인과 조회 복구',async()=>{
 test.setTimeout(90000);await mkdir(output,{recursive:true});const profile=await mkdtemp(join(output,'external-google-'));
 const config=join(profile,'oauth-fixture.json');await writeFile(config,JSON.stringify({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture-client-secret'}}));
 const brain=await startBrain('http://127.0.0.1:9','external-fixture','local',{data_dir:join(profile,'brain')});let app:ElectronApplication|undefined;
 try{
  app=await launch(profile);const page=await connect(app,brain);await choose(app,config);
  await app.evaluate(({shell})=>{
   const actualFetch=globalThis.fetch.bind(globalThis),events=new Map<string,any>(),g=globalThis as any;
   g.fixtureGoogleWrites=0;g.fixtureGoogleLose=false;
   events.set('proactivefixture',{id:'proactivefixture',etag:'"fixture-reminder"',status:'confirmed',summary:'임박한 검증용 일정',start:{dateTime:new Date(Date.now()+10*60000).toISOString()},end:{dateTime:new Date(Date.now()+20*60000).toISOString()}});
   const calendar={id:'fixture@example.test',summary:'격리 캘린더',timeZone:'Asia/Seoul',accessRole:'owner'};
   const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
   globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='127.0.0.1')return actualFetch(input,init);
    if(url.origin==='https://oauth2.googleapis.com')return json({access_token:'fixture-access-secret',refresh_token:'fixture-refresh-secret',token_type:'Bearer',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events'});
    if(url.origin==='https://openidconnect.googleapis.com')return json({sub:'electron-fixture-user',email:'fixture@example.test',email_verified:true});
    if(url.origin!=='https://www.googleapis.com')throw Error('test blocked external network');
    if(url.pathname.includes('/calendarList'))return json(url.pathname.endsWith('/calendarList')?{items:[calendar]}:calendar);
    const id=decodeURIComponent(url.pathname.split('/').at(-1)!);
    if(!init?.method||init.method==='GET')return id==='events'?json({items:[...events.values()]}):events.has(id)?json(events.get(id)):json({},404);
    g.fixtureGoogleWrites++;const fields=JSON.parse(String(init.body)),event={...fields,etag:'"fixture-etag"',status:'confirmed'};events.set(event.id,event);
    if(g.fixtureGoogleLose)throw Error('fixture response lost after commit');return json(event,201);
   };
   shell.openExternal=async value=>{const url=new URL(value);if(url.origin!=='https://accounts.google.com')throw Error('test unexpected browser URL');
    const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');await actualFetch(callback);};
  });
  await page.getByTestId('external-add-google').click();await expect(page.getByTestId('external-calendars')).toBeVisible();await page.getByTestId('external-calendars').click();
  await page.evaluate(async()=>{const b=window.kirianDesktop!,state=await b.getProactive(),connection=(await b.getExternalState()).connections.find(c=>c.kind==='google')!;
   await b.configureProactive({revision:state.revision,settings:{...state.settings,enabled:true,calendar:{connectionId:connection.id,calendarId:'fixture@example.test'}}});await b.startProactive();});
  await expect(page.getByTestId('proactive-card')).toContainText('임박한 검증용 일정');expect(await app.evaluate(()=>(globalThis as any).fixtureGoogleWrites)).toBe(0);
  await page.getByRole('button',{name:'일정·도구 검토 화면',exact:true}).click();expect(await app.evaluate(()=>(globalThis as any).fixtureGoogleWrites)).toBe(0);
  await page.getByRole('button',{name:'이 제안 거절',exact:true}).click();await expect(page.getByTestId('proactive-card')).toHaveCount(0);
  await page.evaluate(()=>window.kirianDesktop!.pauseProactive());
  await page.getByTestId('external-calendar-select').selectOption('fixture@example.test');await page.getByTestId('external-event-summary').fill('격리 일정 승인 검사');
  const form=page.locator('.external-panel .tool-form');await form.locator('input[type="datetime-local"]').nth(0).fill('2026-09-10T10:00');await form.locator('input[type="datetime-local"]').nth(1).fill('2026-09-10T11:00');
  await page.getByTestId('external-preview').click();let action=page.getByTestId('external-action').first();await expect(action).toHaveAttribute('data-status','pending');
  expect(await app.evaluate(()=>(globalThis as any).fixtureGoogleWrites)).toBe(0);await action.getByTestId('external-ack').check();await action.getByTestId('external-approve').click();
  await expect(action).toHaveAttribute('data-status','succeeded');expect(await app.evaluate(()=>(globalThis as any).fixtureGoogleWrites)).toBe(1);
  await app.evaluate(()=>{(globalThis as any).fixtureGoogleLose=true;});await page.getByTestId('external-event-summary').fill('응답 유실 뒤 조회 복구');await page.getByTestId('external-preview').click();action=page.getByTestId('external-action').first();
  await action.getByTestId('external-ack').check();await action.getByTestId('external-approve').click();await expect(action).toHaveAttribute('data-status','unknown');
  await action.getByRole('button',{name:'같은 계정에 연결 후 실제 결과 조회'}).click();await expect(action).toHaveAttribute('data-status','succeeded');expect(await app.evaluate(()=>(globalThis as any).fixtureGoogleWrites)).toBe(2);
  const state=await page.evaluate(()=>window.kirianDesktop!.getExternalState());expect(JSON.stringify(state)).not.toContain('fixture-access-secret');expect(JSON.stringify(state)).not.toContain('fixture-client-secret');
  const owners=await readdir(join(profile,'external'));const files=await readdir(join(profile,'external',owners[0]!,'credentials'));
  for(const file of files){const bytes=await readFile(join(profile,'external',owners[0]!,'credentials',file),'utf8');expect(bytes).not.toContain('fixture-refresh-secret');expect(bytes).not.toContain('fixture-access-secret');}
  expect((await ledger(profile)).ledger.claims.every((c:any)=>c.state==='succeeded')).toBe(true);
 }finally{await app?.close();await brain.stop();}
});
