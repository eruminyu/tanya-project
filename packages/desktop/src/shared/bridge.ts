/** Renderer view models only. No credentials, raw protocol envelopes, or IPC handles. */
import type { LibraryState, SourceInput, SourceUpdate } from './persistence.js';
import type { RoutingSettings, RoutingState } from './routing.js';
import type { ActionView } from './actions.js';
import type { NoteFoldersState, NoteFolderBoundary } from './note-folders.js';
import type { ScreenState, ScreenCaptureInput, ScreenAnalyzeInput, ScreenCommandResult } from './screens.js';
import type { NoteEditApproval, NoteEditDocument, NoteEditReview, NoteEditSummary } from './note-editing.js';
import type { AutoMemoryState, AutoMemoryUpdate, SemanticSearch } from './auto-memory.js';
import type { AutoScreenState, AutoScreenUpdate } from './auto-screen.js';
import type { ProactiveState, ProactiveSettings } from './proactive.js';
import type { ExternalState, ExternalConnection, ExternalPreviewInput, ExternalApproval, ExternalActionView, CalendarView, ConversationToolsSettings, ConversationToolsState } from './external.js';
import type { WindowState, WindowCommandResult } from './window-controls.js';
import type {RuntimeState} from './runtime.js';
export interface ChatMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'streaming' | 'completed' | 'cancelled' | 'failed';
  errorCode?: string;
  routingReason?: string;
  actualModel?: { providerId: string; modelId: string; endpointId: string };
}
export interface SessionSnapshot {
  revision: number;
  connection: {
    phase: 'disconnected' | 'connecting' | 'ready' | 'error';
    reason: string | null;
  };
  actualModel: {
    providerId: string;
    modelId: string;
    endpointId: string;
  } | null;
  routingReason?: string;
  messages: ChatMessage[];
  activeTurnId: string | null;
}
export interface ModelOption {
  id: string;
  label: string;
  providerId: string;
  modelId: string;
  supportsImages?: boolean;
  supportsText?: boolean;
  automaticAllowed?: boolean;
  budgetUnits?: number | null;
  boundary?: 'local' | 'private_lan' | 'cloud';
}
export interface BrainSnapshot {
  phase: 'disconnected' | 'connecting' | 'ready' | 'error';
  reason: string | null;
  url: string;
  models: ModelOption[];
  selectedModelId: string | null;
  speech: SpeechSnapshot;
  transcription: { available: boolean; label: string | null };
  routing?: RoutingState | null;
}
export interface SpeechSnapshot {
  available: boolean;
  enabled: boolean;
  label: string | null;
  phase: 'idle' | 'generating' | 'playing' | 'error';
  sentence: string | null;
  error: string | null;
}
export type AudioEvent =
  | { kind: 'reset' }
  | { kind: 'audio'; playbackId: string; sentence: string; data: Uint8Array };
export interface PlaybackReport {
  playbackId: string;
  state: 'queued' | 'playing' | 'completed' | 'failed';
}
export interface MicrophoneAudio { data: Uint8Array; contentType: 'audio/webm' | 'audio/wav'; }
export type TranscriptionResult = { ok: true; text: string } | { ok: false; code: string };
export interface DesktopSnapshot {
  conversationTools?: ConversationToolsState;
  session: SessionSnapshot;
  brain: BrainSnapshot;
  window: WindowState;
  capabilities: { chat: boolean; voice: boolean; live2d: boolean };
  library: LibraryState;
  noteFolders: NoteFoldersState;
}
export type CommandResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'invalid_request'
        | 'brain_unavailable'
        | 'window_unavailable'
        | 'busy'
        | 'auth_failed'
        | 'connection_failed'
        | 'invalid_response'
        | 'endpoint_not_allowed'
        | 'protocol_error'
        | 'storage_unavailable'
        | 'note_write_unknown'
        | 'source_changed'
        | 'default_unavailable'
        | 'routing_changed'
        | 'routing_limit'
        | 'routing_no_candidate'
        | 'persistence_unavailable';
    };
export interface DesktopBridge {
  getRuntime():Promise<RuntimeState>;
  subscribeRuntime(listener:(state:RuntimeState)=>void):()=>void;
  startRuntime():Promise<RuntimeState>;
  stopRuntime():Promise<RuntimeState>;
  importRuntimeSettings():Promise<RuntimeState>;
  restoreRuntimeSettings():Promise<RuntimeState>;
  openRuntimeDataFolder():Promise<void>;
  getProactive():Promise<ProactiveState>;
  subscribeProactive(listener:(state:ProactiveState)=>void):()=>void;
  refreshProactiveSources():Promise<ProactiveState>;
  configureProactive(input:{revision:number;settings:ProactiveSettings}):Promise<ProactiveState>;
  startProactive():Promise<ProactiveState>;
  pauseProactive():Promise<ProactiveState>;
  dismissProactive(id:string):Promise<ProactiveState>;
  readonly version: 1;
  getAutoScreen(): Promise<AutoScreenState>;
  subscribeAutoScreen(listener: (state: AutoScreenState) => void): () => void;
  listAutoScreenSources(): Promise<AutoScreenState>;
  configureAutoScreen(input: AutoScreenUpdate): Promise<AutoScreenState>;
  startAutoScreen(input: {revision:number}): Promise<AutoScreenState>;
  pauseAutoScreen(): Promise<AutoScreenState>;
  disableAutoScreen(): Promise<AutoScreenState>;
  clearAutoScreens(): Promise<AutoScreenState>;
  getExternalState(): Promise<ExternalState>;
  getConversationTools(): Promise<ConversationToolsState>;
  configureConversationTools(input: ConversationToolsSettings): Promise<ConversationToolsState>;
  addMcpConnection(): Promise<ExternalConnection | null>;
  addGoogleCalendar(): Promise<ExternalConnection | null>;
  connectExternal(id: string): Promise<ExternalConnection>;
  disconnectExternal(id: string): Promise<void>;
  cancelExternalConnections(): Promise<void>;
  discoverExternalTools(id: string): Promise<ExternalConnection>;
  listExternalCalendars(id: string): Promise<CalendarView[]>;
  listExternalEvents(input: {connectionId: string; calendarId: string; timeMin: string; timeMax: string}): Promise<unknown[]>;
  previewExternalAction(input: ExternalPreviewInput): Promise<ExternalActionView>;
  approveExternalAction(input: ExternalApproval): Promise<ExternalActionView>;
  cancelExternalAction(id: string): Promise<ExternalActionView>;
  reconcileExternalAction(id: string): Promise<ExternalActionView>;
  getAutoMemory(): Promise<AutoMemoryState>;
  configureAutoMemory(input: AutoMemoryUpdate): Promise<AutoMemoryState>;
  searchAutoMemory(query: string): Promise<SemanticSearch>;
  getScreenState(): Promise<ScreenState>;
  subscribeScreens(listener: (state: ScreenState) => void): () => void;
  listScreenSources(): Promise<ScreenCommandResult>;
  refreshSavedScreens(): Promise<ScreenCommandResult>;
  captureScreen(input: ScreenCaptureInput): Promise<ScreenCommandResult>;
  analyzeScreen(input: ScreenAnalyzeInput): Promise<ScreenCommandResult>;
  cancelScreenAnalysis(): Promise<ScreenCommandResult>;
  releaseScreenPreview(): Promise<ScreenCommandResult>;
  deleteScreenCapture(input: {captureId: string; revision: number}): Promise<ScreenCommandResult>;
  useScreenAnalysis(input: {captureId: string; revision: number}): Promise<ScreenCommandResult>;
  getSnapshot(): Promise<DesktopSnapshot>;
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void;
  setAlwaysOnTop(enabled: boolean): Promise<CommandResult>;
  setClickThrough(enabled: boolean): Promise<WindowCommandResult>;
  recoverWindow(): Promise<WindowCommandResult>;
  minimize(): Promise<CommandResult>;
  close(): Promise<CommandResult>;
  sendText(text: string): Promise<CommandResult>;
  cancelTurn(): Promise<CommandResult>;
  connectBrain(options: { url: string; token: string }): Promise<CommandResult>;
  disconnectBrain(): Promise<CommandResult>;
  reconnectBrain(): Promise<CommandResult>;
  selectModel(id: string | null): Promise<CommandResult>;
  configureRouting(input: RoutingSettings): Promise<CommandResult>;
  refreshRouting(): Promise<CommandResult>;
  setVoiceEnabled(enabled: boolean): Promise<CommandResult>;
  onAudio(listener: (event: AudioEvent) => void): () => void;
  reportPlayback(report: PlaybackReport): Promise<CommandResult>;
  armMicrophone(): Promise<CommandResult>;
  transcribeAudio(audio: MicrophoneAudio): Promise<TranscriptionResult>;
  cancelTranscription(): Promise<CommandResult>;
  refreshLibrary(query: string): Promise<CommandResult>;
  newConversation(): Promise<CommandResult>;
  openConversation(id: string): Promise<CommandResult>;
  deleteConversation(id: string): Promise<CommandResult>;
  saveDefaultModel(): Promise<CommandResult>;
  createSource(input: SourceInput): Promise<CommandResult>;
  updateSource(input: SourceUpdate): Promise<CommandResult>;
  deleteSource(input: { id: string; revision: number }): Promise<CommandResult>;
  selectSources(ids: string[]): Promise<CommandResult>;
  listActions(): Promise<ActionView[]>;
  createNoteDraft(input: {title: string; body: string}): Promise<ActionView>;
  approveAction(input: {draftId: string; revision: number; payloadSha256: string}): Promise<ActionView>;
  dismissAction(draftId: string): Promise<void>;
  chooseNoteFolder(boundary: NoteFolderBoundary): Promise<CommandResult>;
  syncNoteFolder(id: string): Promise<CommandResult>;
  removeNoteFolder(id: string): Promise<CommandResult>;
  setNoteFolderBoundary(input: {id: string; boundary: NoteFolderBoundary}): Promise<CommandResult>;
  setNoteFolderWriteEnabled(input: {id: string; enabled: boolean}): Promise<CommandResult>;
  listNoteEdits(): Promise<NoteEditSummary[]>;
  openNoteFile(input: {folderId: string; path: string}): Promise<NoteEditDocument>;
  chooseNoteFile(folderId: string): Promise<NoteEditDocument | null>;
  previewNoteEdit(input: {documentId: string; text: string}): Promise<NoteEditReview>;
  approveNoteEdit(input: NoteEditApproval): Promise<NoteEditReview>;
  dismissNoteEdit(id: string): Promise<void>;
  reviewNoteEdit(id: string): Promise<NoteEditReview>;
  previewNoteUndo(id: string): Promise<NoteEditReview>;
  closeNoteFile(documentId: string): Promise<void>;
  forgetNoteEdit(id: string): Promise<void>;
}
