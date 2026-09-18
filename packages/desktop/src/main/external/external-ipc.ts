import { dialog, ipcMain, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { sameIdentity, type Identity } from '@kirian/contracts';
import { readJsonSync } from '../persistence/atomic-json.js';
import { SecureCredentialVault } from './credential-vault.js';
import { ExternalManager, safeExternalError } from './external-manager.js';
import type { McpConnectionConfig } from './mcp-transport.js';

/** Native configuration dialogs and fixed IPC commands are the only connection entrypoints. */
export function registerExternalIpc(options:{root:string;authorized:(event:IpcMainInvokeEvent)=>BrowserWindow;
 identity:()=>Identity|null;generation:()=>number;changed:(connectionId?:string)=>void}) {
 const managers=new Map<string,Promise<ExternalManager>>();
 let previousGeneration=options.generation(),previousOwner='';
 const owner=(identity:Identity)=>createHash('sha256').update(JSON.stringify([identity.instance_id,identity.mode,identity.principal_id])).digest('hex');
 const get=async(identity:Identity)=>{
  const key=owner(identity);let promise=managers.get(key);
  if(!promise){
   if(managers.size>=16)throw new Error('external_identity_limit');
   promise=(async()=>{
    const root=join(options.root,key),vault=new SecureCredentialVault(join(root,'credentials'),{
     isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable(),encryptString:s=>safeStorage.encryptString(s),decryptString:b=>safeStorage.decryptString(b),
     ...(process.platform==='linux'?{getSelectedStorageBackend:()=>safeStorage.getSelectedStorageBackend()}:{}),
    });
    const previous=new Map<string,string>();
    const manager=new ExternalManager(root,identity,vault,{changed:()=>{
     options.changed();
     const state=manager.state();
     for(const connection of state.connections.filter(c=>c.kind==='google')){
      const stamp=JSON.stringify([connection.phase,connection.destination,state.actions.filter(a=>a.connectionId===connection.id&&['running','succeeded','unknown'].includes(a.status)).map(a=>[a.draftId,a.status])]);
      if(previous.get(connection.id)!==stamp){previous.set(connection.id,stamp);options.changed(connection.id);}
     }
    }});await manager.initialize();return manager;
   })();managers.set(key,promise);
  }
  return promise;
 };
 async function scope(event:IpcMainInvokeEvent){
  options.authorized(event);const identity=options.identity(),generation=options.generation();
  if(!identity||identity.mode!=='personal')throw new Error('external_personal_connection_required');
  const context=()=>{options.authorized(event);const current=options.identity();return generation===options.generation()&&current!==null&&sameIdentity(identity,current);};
  const manager=await get(identity);if(!context())throw new Error('external_context_changed');return {manager,context};
 }
 async function configFile(event:IpcMainInvokeEvent,context:()=>boolean,title:string){
  const selected=await dialog.showOpenDialog(options.authorized(event),{title,buttonLabel:'설정 파일 선택',properties:['openFile','dontAddToRecent','noResolveAliases'],filters:[{name:'JSON',extensions:['json']}]});
  if(!context())throw new Error('external_context_changed');
  if(selected.canceled||selected.filePaths.length!==1)return null;
  const value=readJsonSync(selected.filePaths[0]!,64*1024);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('external_invalid_config');
  return {value:value as Record<string,unknown>,label:basename(selected.filePaths[0]!,'.json')};
 }
 const commands:Record<string,(manager:ExternalManager,input:any,context:()=>boolean,event:IpcMainInvokeEvent)=>unknown>={
  'state':manager=>manager.state(),
  'mcp-add':async(manager,_input,context,event)=>{
   const selected=await configFile(event,context,'실행할 MCP 서버 설정 선택');if(!selected)return null;
   const config=selected.value as unknown as McpConnectionConfig;
   const confirmed=await dialog.showMessageBox(options.authorized(event),{type:'warning',title:'이 MCP 서버에 연결',
    message:'선택한 서버 설정을 확인해 주세요.',detail:JSON.stringify(config,null,2)+'\n\n로컬 명령은 이 PC의 사용자 권한으로 실행됩니다. 연결한 뒤에도 도구 호출은 별도로 승인합니다.',buttons:['연결 취소','이 서버 연결'],defaultId:0,cancelId:0,noLink:true});
   if(!context())throw new Error('external_context_changed');if(confirmed.response!==1)return null;
   return manager.addMcp(config,selected.label,context);
  },
  'google-add':async(manager,_input,context,event)=>{
   const selected=await configFile(event,context,'Google Desktop OAuth 클라이언트 JSON 선택');if(!selected)return null;
   const installed=selected.value.installed;
   if(!installed||typeof installed!=='object'||Array.isArray(installed))throw new Error('external_google_desktop_config_required');
   const data=installed as Record<string,unknown>;
   if(typeof data.client_id!=='string'||(data.client_secret!==undefined&&typeof data.client_secret!=='string'))throw new Error('external_invalid_config');
   return manager.connectGoogle({clientId:data.client_id,...(typeof data.client_secret==='string'?{clientSecret:data.client_secret}:{})},async url=>{
    if(!context())throw new Error('external_context_changed');const target=new URL(url);
    if(target.origin!=='https://accounts.google.com'||target.pathname!=='/o/oauth2/v2/auth')throw new Error('external_invalid_oauth_url');
    await shell.openExternal(target.href);
   },context);
  },
  'connect':(manager,id,context)=>manager.connect(id,context),
  'disconnect':(manager,id)=>manager.disconnect(id),
  'cancel-connections':manager=>manager.cancelConnections(),
  'discover':(manager,id,context)=>manager.discover(id,context),
  'calendars':(manager,id,context)=>manager.calendars(id,context),
  'events':(manager,input,context)=>manager.events(input,context),
  'preview':(manager,input,context)=>manager.preview(input,context),
  'approve':(manager,input,context)=>manager.approve(input,context),
  'cancel':(manager,id)=>manager.cancel(id),
  'reconcile':(manager,id,context)=>manager.reconcile(id,context),
 };
 for(const [name,command] of Object.entries(commands))ipcMain.handle('kirian:external-'+name,async(event,input:unknown)=>{
  if(name==='state'&&!options.identity()){options.authorized(event);return {available:false,connections:[],actions:[]};}
  try{const {manager,context}=await scope(event);const result=await command(manager,input,context,event);if(!context())throw new Error('external_context_changed');return result;}
  catch(error){throw new Error(safeExternalError(error));}
 });
 return {
  async proposalManager(){
   const identity=options.identity(),generation=options.generation();
   if(!identity||identity.mode!=='personal')throw Error('external_personal_connection_required');
   const manager=await get(identity),current=options.identity();
   if(generation!==options.generation()||!current||!sameIdentity(identity,current))throw Error('external_context_changed');
   return manager;
  },
  async readProactiveCalendar(selection:{connectionId:string;calendarId:string},signal:AbortSignal){
   const identity=options.identity(),generation=options.generation();
   if(!identity||identity.mode!=='personal')throw Error('calendar_unavailable');
   const context=()=>{const current=options.identity();return !signal.aborted&&generation===options.generation()&&current!==null&&sameIdentity(identity,current);};
   const manager=await get(identity);if(!context())throw Error('context_changed');
   const connection=manager.state().connections.find(c=>c.id===selection.connectionId&&c.kind==='google'&&c.phase==='ready');
   if(!connection)throw Error('calendar_unavailable');
   const now=Date.now();
   try{return await manager.events({...selection,timeMin:new Date(now).toISOString(),timeMax:new Date(now+15*60000).toISOString()},context,signal);}
   catch{throw Error(signal.aborted?'context_changed':'calendar_unavailable');}
  },
  refreshContext(){
   const current=options.identity(),key=current?owner(current):'',generation=options.generation();
   if(previousGeneration===generation&&previousOwner===key)return;
   const old=managers.get(previousOwner);previousGeneration=generation;previousOwner=key;
   void old?.then(manager=>manager.suspend()).catch(()=>{});
  },
  dispose(){for(const manager of managers.values())void manager.then(value=>value.dispose()).catch(()=>{});},
 };
}
