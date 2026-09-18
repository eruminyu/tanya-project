import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
  dialog,
  powerMonitor,
  globalShortcut,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { mkdirSync } from 'node:fs';
import {open} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioEvent, CommandResult, DesktopSnapshot } from '../shared/bridge.js';
import { SessionController } from './session-controller.js';
import { BrainConnection } from './brain-connection.js';
import { BrainLifecycle } from './brain-lifecycle.js';
import { sameIdentity, type Identity } from '@kirian/contracts';
import { LocalPreferences } from './local-preferences.js';
import { WindowControls } from './window/window-controls.js';
import { WindowStateStore } from './window/window-state-store.js';
import { emptyWindowControls } from '../shared/window-controls.js';
import {DesktopRuntime} from './runtime/desktop-runtime.js';
import {parseHostFile} from './runtime/runtime-store.js';
import type {RuntimeState} from '../shared/runtime.js';
import { DurableLocalExecutor, type LocalExecutionContextGuard } from './local-executor.js';
import { NoteFoldersManager } from './notes/note-folders-manager.js';
import { NoteEditJournal } from './notes/editing/note-edit-journal.js';
import { NoteEditor } from './notes/editing/note-editor.js';
import { registerNoteEditingIpc } from './notes/editing/note-editing-ipc.js';
import { registerExternalIpc } from './external/external-ipc.js';
import { ExternalConversation } from './external/external-conversation.js';
import { emptyNoteFolders, type NoteFolderBoundary } from '../shared/note-folders.js';
import { ScreenManager } from './screens/screen-manager.js';
import { NativeScreenCapture } from './screens/native-capture.js';
import { AutoScreenController } from './screens/auto-screen-controller.js';
import { AutoScreenStore } from './screens/auto-screen-store.js';
import { ProactiveController } from './proactive/proactive-controller.js';
import { ProactiveStore } from './proactive/proactive-store.js';
import { proactiveLabels } from '../shared/proactive.js';
import {
  APP_URL,
  PRODUCTION_CSP,
  isRendererDocument,
  resolveAsset,
  validText,
} from './window-policy.js';

app.setName('Kirian');
app.setAppUserModelId('com.kirian.desktop');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kirian',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const smokeTest = process.env.KIRIAN_DESKTOP_TEST === '1';
if (smokeTest && process.env.KIRIAN_TEST_PROFILE) {
  const profile = resolve(process.env.KIRIAN_TEST_PROFILE);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
} else {
  // Create the Kirian profile before Electron registers its data directory.
  const profile = join(app.getPath('appData'), app.isPackaged ? 'Kirian' : 'Kirian Development');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
export const sessionController = new SessionController();
// Chromium owns the case-insensitive "Preferences" file in this directory.
const preferences = new LocalPreferences(join(app.getPath('userData'), 'kirian-settings'));
const executors = new Map<string, Promise<DurableLocalExecutor>>();
const editJournals = new Map<string, Promise<NoteEditJournal>>();
let noteEditor: NoteEditor | null = null;
let noteManager: NoteFoldersManager | null = null;
let noteGeneration = -1;
let noteSetup: Promise<void> | null = null;
let noteSetupFailed = false;
let mainWindow: BrowserWindow | null = null;
let windowControls: WindowControls | null = null;
const windowInteraction = {locked: false, suspended: false};
let externalIpc: ReturnType<typeof registerExternalIpc> | undefined;
let microphoneDeadline = 0;
let rendererDocument = APP_URL;
const devUrl = !app.isPackaged ? process.env.KIRIAN_RENDERER_URL : undefined;
if (devUrl) {
  const url = new URL(devUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '5178' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Invalid development renderer URL');
  rendererDocument = url.href;
}
export function getDesktopSnapshot(): DesktopSnapshot {
  return {
    conversationTools: conversationTools.snapshot(),
    session: sessionController.snapshot(),
    brain: brainConnection.snapshot(),
    window: { alwaysOnTop: mainWindow?.isAlwaysOnTop() ?? false, ...(windowControls?.snapshot() ?? emptyWindowControls()) },
    capabilities: {
      chat: brainConnection.snapshot().phase === 'ready',
      voice: brainConnection.snapshot().phase === 'ready' && brainConnection.snapshot().speech.available,
      live2d: true,
    },
    library: brainConnection.librarySnapshot(),
    noteFolders: noteGeneration === brainConnection.connectionGeneration() && brainConnection.snapshot().phase === 'ready'
      ? noteManager?.snapshot() ?? {...emptyNoteFolders(), busy: noteSetup !== null}
      : emptyNoteFolders(),
  };
}
function broadcast(): void {
  externalIpc?.refreshContext();
  queueMicrotask(updateNoteConnection);
  queueMicrotask(updateScreenConnection);
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  )
    mainWindow.webContents.send('kirian:snapshot-changed', getDesktopSnapshot());
}
function deliverAudio(event: AudioEvent): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send('kirian:audio', event);
}
export const brainConnection = new BrainConnection(
  sessionController,
  broadcast,
  deliverAudio,
  preferences,
  () => proactive.invalidateSources()
);
const conversationTools = new ExternalConversation({brain:brainConnection,session:sessionController,changed:broadcast,
  manager:async()=>{if(!externalIpc)throw Error('external_unavailable');return externalIpc.proposalManager();}});
brainConnection.bindConversationTools(conversationTools);
export const nativeScreenCapture = new NativeScreenCapture();
let quitting = false, shutdownComplete = false;
export const desktopRuntime = new DesktopRuntime({
  directory:app.getPath('userData'),executable:join(process.resourcesPath,'brain','kirian-brain.exe'),
  available:app.isPackaged,version:app.getVersion(),
  connect:options=>brainConnection.connect(options),disconnect:()=>{brainConnection.disconnect();},
  changed:()=>{if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send('kirian:runtime-changed',desktopRuntime.snapshot());},
});
export const brainLifecycle = new BrainLifecycle(brainConnection, desktopRuntime);
let captureBlocked = false;
export const proactive=new ProactiveController(new ProactiveStore(join(app.getPath('userData'),'proactive')),state=>{
  if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send('kirian:proactive-changed',state);
},()=>app.isReady()&&!captureBlocked&&!windowInteraction.locked&&!windowInteraction.suspended&&powerMonitor.getSystemIdleState(1)!=='locked');
export const autoScreen = new AutoScreenController(nativeScreenCapture,
  new AutoScreenStore(join(app.getPath('userData'), 'auto-screen')), state => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('kirian:auto-screen-changed', state);
  }, () => brainConnection.refreshFileSources(), undefined,
  () => app.isReady() && !captureBlocked && !windowInteraction.locked && !windowInteraction.suspended && powerMonitor.getSystemIdleState(1) !== 'locked');
export const screenManager = new ScreenManager(nativeScreenCapture, state => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send('kirian:screen-changed', state);
}, () => brainConnection.refreshFileSources(), async (id, revision) => {
  const generation = brainConnection.connectionGeneration(), conversation = brainConnection.librarySnapshot().conversationId;
  const refreshed = await brainConnection.refreshLibrary('');
  if (!refreshed.ok) return refreshed;
  if (generation !== brainConnection.connectionGeneration() || conversation !== brainConnection.librarySnapshot().conversationId) return {ok: false, code: 'connection_changed'};
  const library = brainConnection.librarySnapshot(), source = library.sources.find(s => s.id === id && s.revision === revision);
  if (!source) return {ok: false, code: 'source_changed'};
  return brainConnection.selectSources([...new Set([...library.selectedSourceIds, id])]);
});
function updateScreenConnection(): void {
  proactive.setConnection(brainConnection.connectionGeneration(),brainConnection.authenticatedIdentity(),brainConnection.proactiveClient(),{
    read:(selection,signal)=>{if(!externalIpc)throw Error('calendar_unavailable');return externalIpc.readProactiveCalendar(selection,signal);},
  });
  screenManager.setConnection(brainConnection.connectionGeneration(), brainConnection.screenClient());
  autoScreen.setConnection(brainConnection.connectionGeneration(), brainConnection.authenticatedIdentity(), brainConnection.screenClient());
}
const unsubscribe = sessionController.subscribe(broadcast);
function executorFor(identity: Identity): Promise<DurableLocalExecutor> {
  const key = JSON.stringify([identity.instance_id, identity.mode, identity.principal_id]);
  let ready = executors.get(key);
  if (!ready) {
    if (executors.size >= 16) throw new Error('too_many_identities');
    ready = (async () => {
      const executor = new DurableLocalExecutor(join(app.getPath('userData'), 'actions'), identity);
      await executor.initialize(); return executor;
    })();
    executors.set(key, ready);
  }
  return ready;
}
function updateNoteConnection(): void {
  const generation = brainConnection.connectionGeneration();
  const identity = brainConnection.authenticatedIdentity(), api = brainConnection.collectionClient();
  if (!identity || identity.mode !== 'personal' || !api) {
    noteManager?.dispose(); noteManager = null; noteEditor = null; noteGeneration = -1; noteSetup = null; noteSetupFailed = false; return;
  }
  if (noteGeneration === generation) return;
  noteManager?.dispose(); noteManager = null; noteEditor = null; noteGeneration = generation; noteSetupFailed = false;
  const current = () => generation === brainConnection.connectionGeneration() && brainConnection.authenticatedIdentity() !== null;
  noteSetup = (async () => {
    const executor = await executorFor(identity); if (!current()) return;
    const owner = JSON.stringify([identity.instance_id, identity.mode, identity.principal_id]);
    let journalReady = editJournals.get(owner);
    if (!journalReady) {
      journalReady = (async () => { const journal = new NoteEditJournal(join(app.getPath('userData'), 'note-edits'), identity); await journal.initialize(); return journal; })();
      editJournals.set(owner, journalReady);
    }
    const journal = await journalReady; if (!current()) return;
    const manager = new NoteFoldersManager(join(app.getPath('userData'), 'kirian-settings'), identity, executor.noteDirectory(), api,
      broadcast, () => brainConnection.refreshFileSources(), current);
    noteManager = manager;
    manager.setEditingBlocked(id => journal.hasUnresolved(id));
    noteEditor = new NoteEditor(manager, journal);
    try { await manager.initialize(); } catch { if (current()) noteSetupFailed = true; manager.dispose(); }
  })().catch(() => { if (current()) noteSetupFailed = true; }).finally(() => {
    if (current()) { noteSetup = null; broadcast(); }
  });
}
async function currentNotes(): Promise<NoteFoldersManager> {
  updateNoteConnection(); const generation = brainConnection.connectionGeneration();
  await noteSetup;
  if (generation !== brainConnection.connectionGeneration() || !noteManager?.snapshot().available || noteSetupFailed) throw new Error('storage_unavailable');
  return noteManager;
}
function authorized(event: IpcMainInvokeEvent): BrowserWindow {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isRendererDocument(event.senderFrame.url, rendererDocument)
  )
    throw new Error('Request not allowed');
  return window;
}
function registerIpc(): void {
  const runtimeGuard = (event:IpcMainInvokeEvent) => {authorized(event);if(quitting||windowInteraction.locked||windowInteraction.suspended)throw Error('request_cancelled');};
  const runtimeCommand = async(event:IpcMainInvokeEvent,command:()=>Promise<RuntimeState>):Promise<RuntimeState>=>{
    runtimeGuard(event);return brainLifecycle.runtimeCommand(command);
  };
  ipcMain.handle('kirian:runtime-state',event=>{authorized(event);return desktopRuntime.snapshot();});
  ipcMain.handle('kirian:runtime-start',event=>{
    runtimeGuard(event);return brainLifecycle.start(()=>runtimeGuard(event));
  });
  ipcMain.handle('kirian:runtime-stop',event=>runtimeCommand(event,()=>desktopRuntime.stop()));
  ipcMain.handle('kirian:runtime-import',event=>runtimeCommand(event,async()=>{
    try {
      const window=authorized(event);
      const picked=await dialog.showOpenDialog(window,{title:'모델 서비스 설정 가져오기',properties:['openFile'],filters:[{name:'JSON 설정',extensions:['json']}]});
      runtimeGuard(event);if(picked.canceled||picked.filePaths.length!==1)return desktopRuntime.snapshot();
      const handle=await open(picked.filePaths[0]!,'r');let raw:Buffer;
      try{const buffer=Buffer.alloc(128*1024+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);raw=buffer.subarray(0,bytesRead);}finally{await handle.close();}
      const host=parseHostFile(new TextDecoder('utf-8',{fatal:true}).decode(raw));runtimeGuard(event);
      const endpoints=[...(host.bindings as Record<string,unknown>[]),...['speech','transcription','embedding'].flatMap(key=>host[key]==null?[]:[host[key] as Record<string,unknown>])];
      const summary=['local','private_lan','cloud'].map((boundary,index)=>['이 PC','사설망','클라우드'][index]+': '+endpoints.filter(item=>item.boundary===boundary).length+'개').join('\n');
      const approved=await dialog.showMessageBox(window,{type:'question',title:'모델 설정 변경',message:'가져온 설정으로 대화 서비스를 다시 시작할까요?',
        detail:summary+'\n기억·승인 기록의 저장 위치는 유지해요. API 키는 설정에서 지정한 환경 변수로만 읽어요. 실행 중인 대화는 중단되고 자동 화면 수집과 선제 제안은 일시 정지돼요.',buttons:['취소','적용'],defaultId:0,cancelId:0,noLink:true});
      runtimeGuard(event);if(approved.response!==1)return desktopRuntime.snapshot();
      return await desktopRuntime.configure(host,()=>runtimeGuard(event));
    }catch{return {...desktopRuntime.snapshot(),reason:'invalid_config'};}
  }));
  ipcMain.handle('kirian:runtime-restore',event=>runtimeCommand(event,async()=>{
    const result=await dialog.showMessageBox(authorized(event),{type:'question',title:'이전 모델 설정 복원',message:'이전 모델 설정으로 대화 서비스를 다시 시작할까요?',
      detail:'기억·승인 기록은 유지해요. 진행 중인 대화는 중단돼요. 손상된 설정 원본도 별도로 보존해요.',buttons:['취소','복원'],defaultId:0,cancelId:0,noLink:true});
    runtimeGuard(event);return result.response===1?desktopRuntime.restore(()=>runtimeGuard(event)):desktopRuntime.snapshot();
  }));
  ipcMain.handle('kirian:runtime-data-folder',async event=>{authorized(event);await shell.openPath(app.getPath('userData'));});
  for(const [channel,command] of Object.entries({
    'state':()=>proactive.snapshot(),'sources':()=>proactive.refreshSources(),'configure':(input:unknown)=>proactive.configure(input),
    'start':()=>proactive.start(),'pause':()=>proactive.pause(),'dismiss':(id:unknown)=>proactive.dismiss(id),
  }))ipcMain.handle('kirian:proactive-'+channel,async(event,input:unknown)=>{
    authorized(event);updateScreenConnection();try{return await command(input);}
    catch(error){throw Error(error instanceof Error&&Object.hasOwn(proactiveLabels,error.message)?proactiveLabels[error.message]:'제안을 사용할 수 없어요. 현재 연결과 설정을 확인해 주세요.');}
  });
  ipcMain.handle('kirian:click-through', (event, value: unknown) => {
    authorized(event); return windowControls?.setClickThrough(value) ?? {ok: false, code: 'window_unavailable'};
  });
  ipcMain.handle('kirian:recover-window', event => {
    authorized(event); return windowControls?.recover() ?? {ok: false, code: 'window_unavailable'};
  });
  for (const [channel, command] of Object.entries({
    'auto-screen-state': () => autoScreen.snapshot(), 'auto-screen-list': () => autoScreen.listSources(),
    'auto-screen-configure': (input: unknown) => autoScreen.configure(input), 'auto-screen-start': (input: unknown) => autoScreen.start(input),
    'auto-screen-pause': () => autoScreen.pause(), 'auto-screen-disable': () => autoScreen.disable(),
    'auto-screen-clear': () => autoScreen.clearRecords(),
  })) ipcMain.handle('kirian:' + channel, async (event, input: unknown) => {
    authorized(event); updateScreenConnection();
    try { return await command(input); }
    catch { throw new Error('자동 화면 설정이나 정리를 완료하지 못했어요. 연결과 현재 상태를 확인해 주세요.'); }
  });
  externalIpc = registerExternalIpc({root: join(app.getPath('userData'), 'external'), authorized,
    identity: () => brainConnection.authenticatedIdentity(), generation: () => brainConnection.connectionGeneration(), changed: id => {
      if(id)proactive.invalidateCalendar(id);conversationTools.refresh();broadcast();}});
  ipcMain.handle('kirian:conversation-tools-state',event=>{authorized(event);conversationTools.refresh();return conversationTools.snapshot();});
  ipcMain.handle('kirian:conversation-tools-configure',(event,input)=>{authorized(event);return conversationTools.configure(input);});
  ipcMain.handle('kirian:auto-memory-state', event => { authorized(event); return brainConnection.autoMemoryClient().read(); });
  ipcMain.handle('kirian:auto-memory-configure', (event, input) => { authorized(event); return brainConnection.autoMemoryClient().configure(input); });
  ipcMain.handle('kirian:auto-memory-search', (event, query) => { authorized(event); return brainConnection.autoMemoryClient().search(query); });
  registerNoteEditingIpc({authorized, generation: () => brainConnection.connectionGeneration(), changed: broadcast,
    editor: async () => { await currentNotes(); if (!noteEditor) throw new Error('note_store_unavailable'); return noteEditor; }});
  for (const [channel, command] of Object.entries({
    'screen-state': () => screenManager.snapshot(), 'screen-list': () => screenManager.list(),
    'screen-refresh': () => screenManager.refreshSaved(), 'screen-capture': (input: unknown) => screenManager.capture(input),
    'screen-analyze': (input: unknown) => screenManager.analyze(input), 'screen-cancel': () => screenManager.cancel(),
    'screen-release': () => screenManager.release(),
    'screen-delete': (input: unknown) => screenManager.delete(input), 'screen-use': (input: unknown) => screenManager.use(input),
  })) ipcMain.handle('kirian:' + channel, (event, input: unknown) => { authorized(event); updateScreenConnection(); return command(input); });
  for (const [channel, command] of Object.entries({
    'library-refresh': (query: any) => brainConnection.refreshLibrary(query),
    'conversation-new': () => brainConnection.changeConversation(null),
    'conversation-open': (id: any) => brainConnection.changeConversation(id),
    'conversation-delete': (id: any) => brainConnection.deleteConversation(id),
    'default-model-save': () => brainConnection.saveDefaultModel(),
    'routing-settings': (input: unknown) => brainConnection.configureRouting(input),
    'routing-refresh': () => brainConnection.refreshRouting(),
    'source-create': (input: any) => brainConnection.createSource(input),
    'source-update': (input: any) => brainConnection.updateSource(input),
    'source-delete': (input: any) => brainConnection.deleteSource(input),
    'source-select': (ids: any) => brainConnection.selectSources(ids),
  })) ipcMain.handle('kirian:' + channel, (event, value: unknown) => { authorized(event); return command(value); });
  async function actions<T>(event: IpcMainInvokeEvent, operation: (executor: DurableLocalExecutor, context: LocalExecutionContextGuard) => Promise<T> | T): Promise<T> {
    authorized(event);
    const identity = brainConnection.authenticatedIdentity();
    if (!identity) throw new Error('대화 서비스를 연결해 주세요.');
    const generation = brainConnection.connectionGeneration();
    const context: LocalExecutionContextGuard = () => {
      authorized(event);
      const current = brainConnection.authenticatedIdentity();
      return generation === brainConnection.connectionGeneration() && current !== null && sameIdentity(identity, current);
    };
    try {
      const executor = await executorFor(identity);
      if (!context()) throw new Error('context_changed');
      const result = await operation(executor, context);
      if (!context()) throw new Error('context_changed');
      return result;
    } catch { throw new Error('작업 기록을 확인하지 못했어요. 실행 결과가 불명확하면 자동으로 다시 실행하지 않아요.'); }
  }
  ipcMain.handle('kirian:actions-list', event => actions(event, executor => executor.list()));
  ipcMain.handle('kirian:note-draft', (event, input) => actions(event, (executor, context) => executor.createDraft(input, context)));
  ipcMain.handle('kirian:action-approve', async (event, input) => {
    const result = await actions(event, (executor, context) => executor.approve(input, context));
    // File execution stays successful if indexing later fails; never re-run the action.
    if (result.status === 'succeeded') void noteManager?.sync().catch(() => {});
    return result;
  });
  ipcMain.handle('kirian:action-dismiss', (event, id) => actions(event, async (executor, context) => { await executor.dismiss(id, context); }));
  async function notesCommand(event: IpcMainInvokeEvent, work: (manager: NoteFoldersManager) => Promise<unknown>): Promise<CommandResult> {
    authorized(event); const generation = brainConnection.connectionGeneration();
    try {
      const manager = await currentNotes();
      authorized(event);
      if (generation !== brainConnection.connectionGeneration()) return {ok: false, code: 'brain_unavailable'};
      await work(manager);
      return generation === brainConnection.connectionGeneration() ? {ok: true} : {ok: false, code: 'brain_unavailable'};
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return {ok: false, code: code === 'invalid_request' || code === 'note_write_unknown' ? code : 'storage_unavailable'};
    }
  }
  ipcMain.handle('kirian:note-folder-choose', (event, policy: unknown) => notesCommand(event, async manager => {
    if (policy !== 'local' && policy !== 'private_lan') throw new Error('invalid_request');
    const generation = brainConnection.connectionGeneration();
    const result = await dialog.showOpenDialog(authorized(event), {title: '키리안이 참고할 노트 폴더', buttonLabel: '이 폴더 연결',
      properties: ['openDirectory', 'dontAddToRecent', 'noResolveAliases']});
    authorized(event);
    if (generation !== brainConnection.connectionGeneration()) throw new Error('connection_changed');
    if (!result.canceled && result.filePaths.length === 1) await manager.add(result.filePaths[0]!, policy);
  }));
  ipcMain.handle('kirian:note-folder-sync', (event, id) => notesCommand(event, async manager => {
    if (typeof id !== 'string') throw new Error('invalid_request');
    if (!await manager.sync(id)) throw new Error('storage_unavailable');
  }));
  ipcMain.handle('kirian:note-folder-remove', (event, id) => notesCommand(event, manager => manager.remove(id)));
  ipcMain.handle('kirian:note-folder-write', (event, input) => notesCommand(event, manager => {
    if (!input || Object.keys(input).sort().join() !== 'enabled,id') throw new Error('invalid_request');
    return manager.setWriteEnabled(input.id, input.enabled);
  }));
  ipcMain.handle('kirian:note-folder-boundary', (event, input) => notesCommand(event, manager => {
    if (!input || Object.keys(input).sort().join() !== 'boundary,id') throw new Error('invalid_request');
    return manager.setBoundary(input.id, input.boundary as NoteFolderBoundary);
  }));
  ipcMain.handle('kirian:voice-enabled', (event, enabled: unknown) => {
    authorized(event); return brainConnection.setVoiceEnabled(enabled);
  });
  ipcMain.handle('kirian:playback', (event, report: unknown) => {
    authorized(event); return brainConnection.reportPlayback(report);
  });
  ipcMain.handle('kirian:arm-microphone', (event): CommandResult => {
    authorized(event);
    if (brainConnection.snapshot().phase !== 'ready' || !brainConnection.snapshot().transcription.available)
      return { ok: false, code: 'brain_unavailable' };
    microphoneDeadline = Date.now() + 30000;
    return { ok: true };
  });
  ipcMain.handle('kirian:transcribe', (event, audio: unknown) => {
    authorized(event); microphoneDeadline = 0; return brainConnection.transcribeAudio(audio);
  });
  ipcMain.handle('kirian:cancel-transcription', event => {
    authorized(event); microphoneDeadline = 0; return brainConnection.cancelTranscription();
  });
  ipcMain.handle('kirian:snapshot', (event) => {
    authorized(event);
    return getDesktopSnapshot();
  });
  ipcMain.handle(
    'kirian:always-on-top',
    (event, value: unknown): CommandResult => {
      const window = authorized(event);
      if (typeof value !== 'boolean')
        return { ok: false, code: 'invalid_request' };
      try { preferences.savePinned(value); } catch { return { ok: false, code: 'storage_unavailable' }; }
      window.setAlwaysOnTop(value);
      broadcast();
      return { ok: true };
    }
  );
  ipcMain.handle('kirian:minimize', (event): CommandResult => {
    authorized(event).minimize();
    return { ok: true };
  });
  ipcMain.handle('kirian:close', (event): CommandResult => {
    const window = authorized(event);
    setImmediate(() => {
      if (!window.isDestroyed()) window.close();
    });
    return { ok: true };
  });
  ipcMain.handle('kirian:connect-brain', async (event, options: unknown) => {
    authorized(event);
    return brainLifecycle.connectExternal(options,()=>runtimeGuard(event));
  });
  ipcMain.handle('kirian:disconnect-brain', async (event) => {
    authorized(event);
    return brainLifecycle.disconnect();
  });
  ipcMain.handle('kirian:reconnect-brain', (event) => {
    authorized(event);
    return brainLifecycle.reconnect(()=>runtimeGuard(event));
  });
  ipcMain.handle('kirian:select-model', (event, id: unknown) => {
    authorized(event);
    return brainConnection.selectModel(id);
  });
  ipcMain.handle('kirian:cancel-turn', (event) => {
    authorized(event);
    return brainConnection.cancelTurn();
  });
  ipcMain.handle('kirian:send-text', async (event, value: unknown): Promise<CommandResult> => {
    authorized(event);
    if (!validText(value)) return { ok: false, code: 'invalid_request' };
    if (brainConnection.librarySnapshot().available) {
      const generation = brainConnection.connectionGeneration();
      const conversation = brainConnection.librarySnapshot().conversationId;
      const model = brainConnection.snapshot().selectedModelId;
      const selection = () => {
        const library = brainConnection.librarySnapshot();
        return JSON.stringify(library.selectedSourceIds.map(id => [id, library.sources.find(source => source.id === id)?.revision]));
      };
      const before = selection();
      try {
        const manager = await currentNotes();
        if (!await manager.sync() || !await brainConnection.waitForLibrary()) return {ok: false, code: 'storage_unavailable'};
        authorized(event);
        if (generation !== brainConnection.connectionGeneration()) return {ok: false, code: 'brain_unavailable'};
        if (conversation !== brainConnection.librarySnapshot().conversationId || model !== brainConnection.snapshot().selectedModelId)
          return {ok: false, code: 'busy'};
        if (before !== selection()) return {ok: false, code: 'source_changed'};
      } catch { return {ok: false, code: 'storage_unavailable'}; }
    }
    return brainConnection.sendText(value);
  });
}
function createWindow(): BrowserWindow {
  const controls = new WindowControls({store: new WindowStateStore(join(app.getPath('userData'), 'kirian-settings')),
    screen, shortcuts: globalShortcut, interactionAllowed: () => !windowInteraction.locked && !windowInteraction.suspended, changed: broadcast});
  const initial = controls.initialBounds();
  const window = new BrowserWindow({
    ...initial.bounds,
    minWidth: initial.minWidth,
    minHeight: initial.minHeight,
    show: false,
    frame: false,
    backgroundColor: '#15141b',
    title: 'Kirian',
    webPreferences: {
      preload: join(app.getAppPath(), 'dist-electron/preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow = window;
  windowControls = controls;
  controls.attach(window);
  try { window.setAlwaysOnTop(preferences.pinned()); } catch { /* Corrupt preferences are preserved for recovery, never overwritten at startup. */ }
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) =>
    event.preventDefault()
  );
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault()
  );
  window.webContents.on('did-finish-load', broadcast);
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {controls.disableClickThrough();autoScreen.pause('renderer_changed');proactive.pause('closed');conversationTools.configure({enabled:false,selections:[]});}
  });
  window.webContents.on('render-process-gone', () => {
    controls.disableClickThrough();
    proactive.pause('closed');
    autoScreen.pause('renderer_changed');
    brainConnection.disconnect();
  });
  window.on('always-on-top-changed', broadcast);
  window.once('ready-to-show', () => {
    if (!smokeTest) window.show();
  });
  window.once('closed', () => {
    controls.dispose();
    if (windowControls === controls) windowControls = null;
    autoScreen.pause('closed');
    proactive.pause('closed');
    brainConnection.disconnect();
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(rendererDocument).catch(() => {
    brainConnection.disconnect();
    if (!window.isDestroyed()) window.close();
  });
  return window;
}

const singleInstance = smokeTest || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('before-quit',event=>{
    if(shutdownComplete)return;
    event.preventDefault();if(quitting)return;quitting=true;
    autoScreen.pause('closed');proactive.pause('closed');windowControls?.disableClickThrough();
    void brainLifecycle.shutdown().finally(()=>{shutdownComplete=true;app.quit();});
  });
  app.on('second-instance', () => {
    windowControls?.recover();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
  app.on('will-quit', () => {
    windowControls?.dispose();
    autoScreen.dispose();
    proactive.dispose();
    externalIpc?.dispose();
    screenManager.dispose();
    noteManager?.dispose();
    unsubscribe();
    brainConnection.dispose();
    sessionController.dispose();
  });
  void app.whenReady().then(() => {
    powerMonitor.on('lock-screen', () => { windowInteraction.locked = true; windowControls?.disableClickThrough(); captureBlocked = true; autoScreen.pause('locked'); proactive.pause('locked'); conversationTools.configure({enabled:false,selections:[]}); });
    powerMonitor.on('suspend', () => { windowInteraction.suspended = true; windowControls?.disableClickThrough(); captureBlocked = true; autoScreen.pause('suspended'); proactive.pause('suspended'); conversationTools.configure({enabled:false,selections:[]}); });
    powerMonitor.on('unlock-screen', () => { windowInteraction.locked = false; captureBlocked = false; });
    powerMonitor.on('resume', () => { windowInteraction.suspended = false; captureBlocked = false; });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === mainWindow?.webContents && permission === 'media' && Date.now() < microphoneDeadline
        && brainConnection.snapshot().phase === 'ready' && isRendererDocument(contents.getURL(), rendererDocument)
        && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
      contents === mainWindow?.webContents && permission === 'media' && Date.now() < microphoneDeadline
      && brainConnection.snapshot().phase === 'ready' && isRendererDocument(contents.getURL(), rendererDocument)
      && details.mediaType === 'audio');
    protocol.handle('kirian', async (request) => {
      const file = resolveAsset(join(app.getAppPath(), 'dist'), request.url);
      if (!file) return new Response('Not found', { status: 404 });
      try {
        const resource = await net.fetch(pathToFileURL(file).href);
        const headers = new Headers(resource.headers);
        headers.set('Content-Security-Policy', PRODUCTION_CSP);
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(resource.body, {
          status: resource.status,
          headers,
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    registerIpc();
    createWindow();
    if (process.env.KIRIAN_BRAIN_URL && process.env.KIRIAN_BRAIN_TOKEN) {
      const options = {
        url: process.env.KIRIAN_BRAIN_URL,
        token: process.env.KIRIAN_BRAIN_TOKEN,
      };
      delete process.env.KIRIAN_BRAIN_TOKEN;
      void brainLifecycle.connectExternal(options,()=>{if(quitting||!mainWindow||mainWindow.isDestroyed())throw Error('request_cancelled');});
    } else if (app.isPackaged && (!smokeTest || process.env.KIRIAN_TEST_MANAGED_BRAIN === '1')) {
      void brainLifecycle.start(()=>{if(quitting||!mainWindow||mainWindow.isDestroyed())throw Error('request_cancelled');});
    }
  });
}
