import { contextBridge, ipcRenderer } from 'electron';
import type { AudioEvent, DesktopBridge, DesktopSnapshot } from '../shared/bridge.js';
import type { ScreenState } from '../shared/screens.js';
import type { AutoScreenState } from '../shared/auto-screen.js';
import type { ProactiveState } from '../shared/proactive.js';
import type {RuntimeState} from '../shared/runtime.js';
const bridge: DesktopBridge = {
  getRuntime:()=>ipcRenderer.invoke('kirian:runtime-state'),
  startRuntime:()=>ipcRenderer.invoke('kirian:runtime-start'),
  stopRuntime:()=>ipcRenderer.invoke('kirian:runtime-stop'),
  importRuntimeSettings:()=>ipcRenderer.invoke('kirian:runtime-import'),
  restoreRuntimeSettings:()=>ipcRenderer.invoke('kirian:runtime-restore'),
  openRuntimeDataFolder:()=>ipcRenderer.invoke('kirian:runtime-data-folder'),
  subscribeRuntime:listener=>{
    if(typeof listener!=='function')throw new TypeError('Expected a listener');
    const handler=(_event:Electron.IpcRendererEvent,state:RuntimeState)=>listener(state);
    ipcRenderer.on('kirian:runtime-changed',handler);return()=>ipcRenderer.removeListener('kirian:runtime-changed',handler);
  },
  getProactive:()=>ipcRenderer.invoke('kirian:proactive-state'),
  refreshProactiveSources:()=>ipcRenderer.invoke('kirian:proactive-sources'),
  configureProactive:input=>ipcRenderer.invoke('kirian:proactive-configure',input),
  startProactive:()=>ipcRenderer.invoke('kirian:proactive-start'),
  pauseProactive:()=>ipcRenderer.invoke('kirian:proactive-pause'),
  dismissProactive:id=>ipcRenderer.invoke('kirian:proactive-dismiss',id),
  subscribeProactive:listener=>{
    if(typeof listener!=='function')throw new TypeError('Expected a listener');
    const handler=(_event:Electron.IpcRendererEvent,state:ProactiveState)=>listener(state);
    ipcRenderer.on('kirian:proactive-changed',handler);return ()=>ipcRenderer.removeListener('kirian:proactive-changed',handler);
  },
  version: 1,
  getAutoScreen: () => ipcRenderer.invoke('kirian:auto-screen-state'),
  subscribeAutoScreen: listener => {
    if (typeof listener !== 'function') throw new TypeError('Expected a listener');
    const handler = (_event: Electron.IpcRendererEvent, value: AutoScreenState) => listener(value);
    ipcRenderer.on('kirian:auto-screen-changed', handler);
    return () => ipcRenderer.removeListener('kirian:auto-screen-changed', handler);
  },
  listAutoScreenSources: () => ipcRenderer.invoke('kirian:auto-screen-list'),
  configureAutoScreen: input => ipcRenderer.invoke('kirian:auto-screen-configure', input),
  startAutoScreen: input => ipcRenderer.invoke('kirian:auto-screen-start', input),
  pauseAutoScreen: () => ipcRenderer.invoke('kirian:auto-screen-pause'),
  disableAutoScreen: () => ipcRenderer.invoke('kirian:auto-screen-disable'),
  clearAutoScreens: () => ipcRenderer.invoke('kirian:auto-screen-clear'),
  getExternalState: () => ipcRenderer.invoke('kirian:external-state'),
  getConversationTools: () => ipcRenderer.invoke('kirian:conversation-tools-state'),
  configureConversationTools: input => ipcRenderer.invoke('kirian:conversation-tools-configure', input),
  addMcpConnection: () => ipcRenderer.invoke('kirian:external-mcp-add'),
  addGoogleCalendar: () => ipcRenderer.invoke('kirian:external-google-add'),
  connectExternal: id => ipcRenderer.invoke('kirian:external-connect', id),
  disconnectExternal: id => ipcRenderer.invoke('kirian:external-disconnect', id),
  cancelExternalConnections: () => ipcRenderer.invoke('kirian:external-cancel-connections'),
  discoverExternalTools: id => ipcRenderer.invoke('kirian:external-discover', id),
  listExternalCalendars: id => ipcRenderer.invoke('kirian:external-calendars', id),
  listExternalEvents: input => ipcRenderer.invoke('kirian:external-events', input),
  previewExternalAction: input => ipcRenderer.invoke('kirian:external-preview', input),
  approveExternalAction: input => ipcRenderer.invoke('kirian:external-approve', input),
  cancelExternalAction: id => ipcRenderer.invoke('kirian:external-cancel', id),
  reconcileExternalAction: id => ipcRenderer.invoke('kirian:external-reconcile', id),
  getAutoMemory: () => ipcRenderer.invoke('kirian:auto-memory-state'),
  configureAutoMemory: input => ipcRenderer.invoke('kirian:auto-memory-configure',input),
  searchAutoMemory: query => ipcRenderer.invoke('kirian:auto-memory-search',query),
  getScreenState: () => ipcRenderer.invoke('kirian:screen-state'),
  subscribeScreens: listener => {
    if (typeof listener !== 'function') throw new TypeError('Expected a listener');
    const handler = (_event: Electron.IpcRendererEvent, value: ScreenState) => listener(value);
    ipcRenderer.on('kirian:screen-changed', handler);
    return () => ipcRenderer.removeListener('kirian:screen-changed', handler);
  },
  listScreenSources: () => ipcRenderer.invoke('kirian:screen-list'),
  refreshSavedScreens: () => ipcRenderer.invoke('kirian:screen-refresh'),
  captureScreen: input => ipcRenderer.invoke('kirian:screen-capture', input),
  analyzeScreen: input => ipcRenderer.invoke('kirian:screen-analyze', input),
  cancelScreenAnalysis: () => ipcRenderer.invoke('kirian:screen-cancel'),
  releaseScreenPreview: () => ipcRenderer.invoke('kirian:screen-release'),
  deleteScreenCapture: input => ipcRenderer.invoke('kirian:screen-delete', input),
  useScreenAnalysis: input => ipcRenderer.invoke('kirian:screen-use', input),
  getSnapshot: () => ipcRenderer.invoke('kirian:snapshot'),
  subscribe: (listener) => {
    if (typeof listener !== 'function')
      throw new TypeError('Expected a listener');
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: DesktopSnapshot
    ) => listener(snapshot);
    ipcRenderer.on('kirian:snapshot-changed', handler);
    return () => ipcRenderer.removeListener('kirian:snapshot-changed', handler);
  },
  setAlwaysOnTop: (enabled) =>
    ipcRenderer.invoke('kirian:always-on-top', enabled),
  setClickThrough: enabled => ipcRenderer.invoke('kirian:click-through', enabled),
  recoverWindow: () => ipcRenderer.invoke('kirian:recover-window'),
  minimize: () => ipcRenderer.invoke('kirian:minimize'),
  close: () => ipcRenderer.invoke('kirian:close'),
  sendText: (text) => ipcRenderer.invoke('kirian:send-text', text),
  cancelTurn: () => ipcRenderer.invoke('kirian:cancel-turn'),
  connectBrain: (options) => ipcRenderer.invoke('kirian:connect-brain', options),
  disconnectBrain: () => ipcRenderer.invoke('kirian:disconnect-brain'),
  reconnectBrain: () => ipcRenderer.invoke('kirian:reconnect-brain'),
  selectModel: (id) => ipcRenderer.invoke('kirian:select-model', id),
  configureRouting: input => ipcRenderer.invoke('kirian:routing-settings', input),
  refreshRouting: () => ipcRenderer.invoke('kirian:routing-refresh'),
  setVoiceEnabled: enabled => ipcRenderer.invoke('kirian:voice-enabled', enabled),
  onAudio: listener => {
    if (typeof listener !== 'function') throw new TypeError('Expected a listener');
    const handler = (_event: Electron.IpcRendererEvent, value: AudioEvent) => listener(value);
    ipcRenderer.on('kirian:audio', handler);
    return () => ipcRenderer.removeListener('kirian:audio', handler);
  },
  reportPlayback: report => ipcRenderer.invoke('kirian:playback', report),
  armMicrophone: () => ipcRenderer.invoke('kirian:arm-microphone'),
  transcribeAudio: audio => ipcRenderer.invoke('kirian:transcribe', audio),
  cancelTranscription: () => ipcRenderer.invoke('kirian:cancel-transcription'),
  refreshLibrary: query => ipcRenderer.invoke('kirian:library-refresh', query),
  newConversation: () => ipcRenderer.invoke('kirian:conversation-new'),
  openConversation: id => ipcRenderer.invoke('kirian:conversation-open', id),
  deleteConversation: id => ipcRenderer.invoke('kirian:conversation-delete', id),
  saveDefaultModel: () => ipcRenderer.invoke('kirian:default-model-save'),
  createSource: input => ipcRenderer.invoke('kirian:source-create', input),
  updateSource: input => ipcRenderer.invoke('kirian:source-update', input),
  deleteSource: input => ipcRenderer.invoke('kirian:source-delete', input),
  selectSources: ids => ipcRenderer.invoke('kirian:source-select', ids),
  listActions: () => ipcRenderer.invoke('kirian:actions-list'),
  createNoteDraft: input => ipcRenderer.invoke('kirian:note-draft', input),
  approveAction: input => ipcRenderer.invoke('kirian:action-approve', input),
  dismissAction: id => ipcRenderer.invoke('kirian:action-dismiss', id),
  chooseNoteFolder: boundary => ipcRenderer.invoke('kirian:note-folder-choose', boundary),
  syncNoteFolder: id => ipcRenderer.invoke('kirian:note-folder-sync', id),
  removeNoteFolder: id => ipcRenderer.invoke('kirian:note-folder-remove', id),
  setNoteFolderBoundary: input => ipcRenderer.invoke('kirian:note-folder-boundary', input),
  setNoteFolderWriteEnabled: input => ipcRenderer.invoke('kirian:note-folder-write', input),
  listNoteEdits: () => ipcRenderer.invoke('kirian:note-edit-list'),
  openNoteFile: input => ipcRenderer.invoke('kirian:note-edit-open', input),
  chooseNoteFile: id => ipcRenderer.invoke('kirian:note-edit-choose', id),
  previewNoteEdit: input => ipcRenderer.invoke('kirian:note-edit-preview', input),
  approveNoteEdit: input => ipcRenderer.invoke('kirian:note-edit-approve', input),
  dismissNoteEdit: id => ipcRenderer.invoke('kirian:note-edit-dismiss', id),
  reviewNoteEdit: id => ipcRenderer.invoke('kirian:note-edit-review', id),
  previewNoteUndo: id => ipcRenderer.invoke('kirian:note-edit-undo', id),
  closeNoteFile: id => ipcRenderer.invoke('kirian:note-edit-close', id),
  forgetNoteEdit: id => ipcRenderer.invoke('kirian:note-edit-forget', id),
};
contextBridge.exposeInMainWorld('kirianDesktop', Object.freeze(bridge));
