import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  assertDefinition,
  parseMessage,
  sameIdentity,
  sameModel,
  type Identity,
  type ModelRef,
  type ModelSelection,
  type ProtocolMessage,
  type Scope,
} from '@kirian/contracts';
import type { AudioEvent, BrainSnapshot, CommandResult, TranscriptionResult } from '../shared/bridge.js';
import { SpeechCoordinator } from './speech-coordinator.js';
import {
  SessionController,
  type ConnectionBinding,
} from './session-controller.js';
import { validText } from './window-policy.js';
import { LibraryClient, type ConversationDetail } from './library-client.js';
import { emptyLibrary, type LibraryState, type SourceInput, type SourceUpdate } from '../shared/persistence.js';
import type { LocalPreferences } from './local-preferences.js';
import { ScreenClient } from './screens/screen-client.js';
import { AutoMemoryClient } from './auto-memory-client.js';
import { ProactiveClient } from './proactive/proactive-client.js';
import { proactiveLabels } from '../shared/proactive.js';
import { memoryStatusLabels } from '../shared/auto-memory.js';
export interface ConversationToolHooks {
  enabled(): boolean;
  begin(start: Extract<ProtocolMessage, {kind:'turn.start'}>): void;
  receive(message: ProtocolMessage): void;
  invalidate(reason: string): void;
}

type Failure = Extract<CommandResult, { ok: false }>['code'];
interface Credentials {
  url: string;
  token: string;
}
import { validateRouting, validateRoutingSettings, automaticCandidates } from './routing-client.js';
import type { RoutingState } from '../shared/routing.js';
interface Catalog {
  identity: Identity;
  models: { model: ModelRef; label: string; supports_images?: boolean; supports_text?: boolean; supports_tools?: boolean; automatic_allowed?: boolean; budget_units?: number | null; boundary?: 'local' | 'private_lan' | 'cloud' }[];
  default_selection: ModelSelection;
  speech?: { model: ModelRef; label: string };
  transcription?: { label: string };
  persistence?: boolean;
  routing?: RoutingState;
}
const failure = (code: Failure): Extract<CommandResult, { ok: false }> => ({ ok: false, code });
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === expected.sort().join(',');
}
export function validateConnection(value: unknown): Credentials {
  if (
    !object(value) ||
    !keys(value, ['url', 'token']) ||
    typeof value.url !== 'string' ||
    value.url.length > 2048 ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9._~-]{32,256}(?![\s\S])/.test(value.token)
  )
    throw new Error('invalid_request');
  const url = new URL(value.url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('endpoint_not_allowed');
  url.pathname = url.pathname.replace(/\/?$/, '/');
  return { url: url.href, token: value.token };
}
export function validateCatalog(value: unknown): Catalog {
  if (
    !object(value) ||
    !keys(value, ['identity', 'models', 'default_selection', ...('speech' in value ? ['speech'] : []), ...('transcription' in value ? ['transcription'] : []), ...('persistence' in value ? ['persistence'] : []), ...('routing' in value ? ['routing'] : [])]) ||
    !Array.isArray(value.models) ||
    value.models.length === 0 ||
    value.models.length > 32
  )
    throw new Error('invalid_response');
  assertDefinition('Identity', value.identity);
  assertDefinition('ModelSelection', value.default_selection);
  const catalog = value as unknown as Catalog;
  if ('routing' in value) validateRouting(value.routing);
  if ('persistence' in value && typeof value.persistence !== 'boolean') throw new Error('invalid_response');
  if ('speech' in value) {
    if (!object(value.speech) || !keys(value.speech, ['model', 'label']) || typeof value.speech.label !== 'string'
      || !value.speech.label.trim() || value.speech.label.length > 160) throw new Error('invalid_response');
    assertDefinition('ModelRef', value.speech.model);
  }
  if ('transcription' in value && (!object(value.transcription) || !keys(value.transcription, ['label'])
    || typeof value.transcription.label !== 'string' || !value.transcription.label.trim() || value.transcription.label.length > 160))
    throw new Error('invalid_response');
  if (
    catalog.identity.mode !== 'personal' ||
    !['initial_local', 'saved_default'].includes(
      catalog.default_selection.source
    )
  )
    throw new Error('invalid_response');
  const ids = new Set<string>();
  for (const item of catalog.models) {
    if (
      !object(item) ||
      !keys(item, ['model', 'label', ...['supports_images','supports_text','supports_tools','automatic_allowed','budget_units','boundary'].filter(key => key in item)]) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 160
    )
      throw new Error('invalid_response');
    if (('supports_tools' in item && typeof item.supports_tools !== 'boolean')
      || ('supports_images' in item && typeof item.supports_images !== 'boolean')
      || ('supports_text' in item && typeof item.supports_text !== 'boolean')
      || ('automatic_allowed' in item && typeof item.automatic_allowed !== 'boolean')
      || ('budget_units' in item && item.budget_units !== null && (!Number.isSafeInteger(item.budget_units) || item.budget_units! < 0 || item.budget_units! > 1000000000))
      || ('boundary' in item && !['local', 'private_lan', 'cloud'].includes(item.boundary!))) throw new Error('invalid_response');
    assertDefinition('ModelRef', item.model);
    const id = modelId(item.model);
    if (ids.has(id)) throw new Error('invalid_response');
    ids.add(id);
  }
  if (
    !catalog.persistence && !catalog.models.some((item) =>
      sameModel(item.model, catalog.default_selection.model)
    )
  )
    throw new Error('invalid_response');
  return structuredClone(catalog);
}
function modelId(model: ModelRef): string {
  return JSON.stringify([model.endpoint_id, model.provider_id, model.model_id]);
}
async function boundedJson(response: Response, limit = 131072): Promise<unknown> {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('invalid_response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Main-process owner of credentials, authenticated transport and outbound command IDs. */
export class BrainConnection {
  private conversationTools: ConversationToolHooks | null = null;
  private readonly issuedToolMessages = new Set<string>();
  private routingBusy = false;
  private credentials: Credentials | null = null;
  private catalog: Catalog | null = null;
  private scope: Scope | null = null;
  private binding: ConnectionBinding | null = null;
  private socket: WebSocket | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pendingResolve: ((result: CommandResult) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptionAbort: AbortController | null = null;
  private readonly speechCoordinator: SpeechCoordinator;
  private voicePreference = true;
  private library: LibraryClient | null = null;
  private conversationId: string | null = null;
  private libraryBusy = false;
  private libraryInvalidated = false;
  private readonly intents = new Map<string, string>();
  private state: BrainSnapshot = {
    phase: 'disconnected',
    reason: null,
    url: '',
    models: [],
    selectedModelId: null,
    speech: { available: false, enabled: false, label: null, phase: 'idle', sentence: null, error: null },
    transcription: { available: false, label: null },
  };
  constructor(
    private readonly controller: SessionController,
    private readonly onChange: () => void = () => {},
    onAudio: (event: AudioEvent) => void = () => {},
    private readonly preferences?: LocalPreferences,
    private readonly onSourcesInvalidated:()=>void = ()=>{}
  ) {
    this.speechCoordinator = new SpeechCoordinator(messages => this.send(messages), onAudio, state => {
      Object.assign(this.state.speech, state); this.changed();
    });
  }
  snapshot(): BrainSnapshot {
    return structuredClone(this.state);
  }
  bindConversationTools(hooks: ConversationToolHooks): void { this.conversationTools = hooks; }
  conversationToolContext() {
    return { generation: this.generation, scope: this.scope ? structuredClone(this.scope) : null,
      ready: this.state.phase === 'ready', models: structuredClone(this.catalog?.models ?? []),
      loopback: Boolean(this.credentials && ['127.0.0.1','localhost','[::1]'].includes(new URL(this.credentials.url).hostname)) };
  }
  /** Main-only authenticated observation/source channel; no renderer path or credential access. */
  async conversationToolRequest(path: string, body?: unknown): Promise<unknown> {
    const credentials=this.credentials, abort=this.abort, generation=this.generation;
    if (!credentials || !abort || !this.conversationToolContext().loopback || this.state.phase!=='ready'
      || !/^v1\/external-tools\/(?:sources|results|turns\/[A-Za-z0-9._:-]+)$/.test(path)) throw Error('external_context_changed');
    const response=await fetch(new URL(path,credentials.url), {method:body===undefined?'GET':'POST',redirect:'error',
      headers:{Authorization:'Bearer '+credentials.token,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])});
    const value=await boundedJson(response,256*1024);
    if (generation!==this.generation || this.state.phase!=='ready') throw Error('external_context_changed');
    if (!response.ok) throw Error('external_observation_unavailable');
    return value;
  }
  sendConversationTool(message: ProtocolMessage): CommandResult {
    if (!['tool.offers','tool.resolved'].includes(message.kind)) return failure('invalid_request');
    this.issuedToolMessages.add(message.message_id);
    return this.send([message]);
  }
  private async routingRequest(input?: unknown): Promise<CommandResult> {
    if (this.state.phase !== 'ready' || !this.credentials || !this.abort || !this.catalog?.routing) return failure('brain_unavailable');
    const generation = this.generation, credentials = this.credentials, abort = this.abort;
    try {
      const payload = input === undefined ? undefined : validateRoutingSettings(input);
      const response = await fetch(new URL('v1/routing', credentials.url), {method: payload ? 'PUT' : 'GET',
        headers: {Authorization:'Bearer ' + credentials.token, ...(payload ? {'Content-Type':'application/json'} : {})},
        ...(payload ? {body:JSON.stringify(payload)} : {}), redirect:'error', signal:AbortSignal.any([abort.signal, AbortSignal.timeout(12000)])});
      const result = await boundedJson(response);
      if (generation !== this.generation) return failure('brain_unavailable');
      if (!response.ok) {
        const codes: Failure[] = ['routing_changed','routing_limit','persistence_unavailable','storage_unavailable','invalid_request'];
        return failure(object(result) && codes.includes(result.detail as Failure) ? result.detail as Failure : 'invalid_response');
      }
      const state = validateRouting(result);
      if (state.revision >= (this.state.routing?.revision ?? 0)) {
        this.state.routing = state; this.catalog!.routing = structuredClone(state); this.changed();
      }
      return {ok:true};
    } catch (error) { return failure(error instanceof Error && error.message === 'invalid_request' ? 'invalid_request' : 'invalid_response'); }
  }
  async configureRouting(input: unknown): Promise<CommandResult> {
    try { validateRoutingSettings(input); } catch { return failure('invalid_request'); }
    if (this.routingBusy) return failure('busy');
    this.routingBusy = true;
    try { const result = await this.routingRequest(input); if (!result.ok) await this.routingRequest(); return result; }
    finally { this.routingBusy = false; }
  }
  async refreshRouting(): Promise<CommandResult> { return this.routingRequest(); }
  librarySnapshot(): LibraryState { return this.library?.snapshot() ?? emptyLibrary(); }
  collectionClient() { return this.state.phase === 'ready' ? this.library?.collections() ?? null : null; }
  autoMemoryClient(): AutoMemoryClient {
    const credentials = this.credentials, abort = this.abort, generation = this.generation, library = this.library;
    if (this.state.phase !== 'ready' || !library || !credentials || !abort) throw new Error('brain_unavailable');
    return new AutoMemoryClient(async (path, method = 'GET', body) => {
      if (generation !== this.generation || this.state.phase !== 'ready') throw new Error('connection_changed');
      const response = await fetch(new URL(path, credentials.url), {method, headers: {Authorization: 'Bearer ' + credentials.token,
        ...(body === undefined ? {} : {'Content-Type':'application/json'})}, redirect:'error',
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(path.endsWith('/search') ? 120000 : 12000)])});
      const value = await boundedJson(response, 512 * 1024);
      if (generation !== this.generation || this.state.phase !== 'ready') throw new Error('connection_changed');
      if (!response.ok) throw new Error(object(value) && typeof value.detail === 'string' && Object.hasOwn(memoryStatusLabels,value.detail) ? value.detail : 'invalid_response');
      return value;
    }, () => {
      if (generation !== this.generation || this.state.phase !== 'ready' || this.libraryInvalidated) throw new Error('source_changed');
      return library.contexts();
    });
  }
  proactiveClient():ProactiveClient|null {
    const credentials=this.credentials,abort=this.abort,generation=this.generation,catalog=this.catalog;
    if(this.state.phase!=='ready'||!catalog?.persistence||!credentials||!abort||!['127.0.0.1','localhost','[::1]'].includes(new URL(credentials.url).hostname))return null;
    return new ProactiveClient(async(path,body,signal)=>{
      if(generation!==this.generation||this.state.phase!=='ready')throw Error('context_changed');
      const response=await fetch(new URL(path,credentials.url),{method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:'Bearer '+credentials.token,
        ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal:AbortSignal.any([abort.signal,AbortSignal.timeout(body===undefined?12000:120000),...(signal?[signal]:[])])});
      const value=await boundedJson(response,64*1024);
      if(generation!==this.generation||this.state.phase!=='ready')throw Error('context_changed');
      if(!response.ok)throw Error(object(value)&&typeof value.detail==='string'&&Object.hasOwn(proactiveLabels,value.detail)?value.detail:'invalid_response');
      return value;
    },catalog.models);
  }
  screenClient(): ScreenClient | null {
    const credentials = this.credentials, catalog = this.catalog, abort = this.abort, generation = this.generation;
    if (this.state.phase !== 'ready' || !catalog?.persistence || !credentials || !abort) return null;
    // The model boundary does not describe the Brain upload destination.
    // Pixels first enter the on-device Brain. Its separately approved inference
    // binding may forward only a LAN-authorized image to another machine.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(credentials.url).hostname)) return null;
    return new ScreenClient(catalog.identity, catalog.models, async (path, method, body, signal) => {
      if (generation !== this.generation || this.state.phase !== 'ready') throw new Error('connection_changed');
      const response = await fetch(new URL(path, credentials.url), { method, headers: { Authorization: 'Bearer ' + credentials.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(path.endsWith('/analyze') || path.endsWith('/auto-analyze') ? 120000 : 12000), ...(signal ? [signal] : [])]) });
      const result = await boundedJson(response, 2 * 1024 * 1024);
      if (generation !== this.generation || this.state.phase !== 'ready') throw new Error('connection_changed');
      if (!response.ok) {
        const codes = ['source_changed', 'context_blocked', 'model_not_allowed', 'unsupported_model', 'screen_busy', 'screen_limit', 'image_limit',
          'routing_changed', 'routing_limit', 'routing_no_candidate', 'persistence_unavailable',
          'provider_error', 'provider_unavailable', 'turn_timeout', 'model_mismatch', 'incomplete_response', 'storage_unavailable', 'invalid_request', 'not_found', 'screen_cancelled'];
        throw new Error(object(result) && typeof result.detail === 'string' && codes.includes(result.detail) ? result.detail : 'provider_error');
      }
      return result;
    }, () => this.state.routing?.enabled === true);
  }
  refreshFileSources(): void { if (this.library) { this.libraryInvalidated = true; this.refreshInvalidated(); } }
  async waitForLibrary(): Promise<boolean> {
    const generation = this.generation, deadline = Date.now() + 12000;
    while ((this.libraryBusy || this.libraryInvalidated) && generation === this.generation && Date.now() < deadline) {
      this.refreshInvalidated(); await new Promise(resolve => setTimeout(resolve, 10));
    }
    return generation === this.generation && this.state.phase === 'ready' && !this.libraryBusy && !this.libraryInvalidated;
  }
  authenticatedIdentity(): Identity | null { return this.state.phase === 'ready' && this.catalog ? structuredClone(this.catalog.identity) : null; }
  async connect(options: unknown): Promise<CommandResult> {
    if (this.disposed) return failure('brain_unavailable');
    let credentials: Credentials;
    try {
      credentials = validateConnection(options);
    } catch (error) {
      return failure(
        error instanceof Error && error.message === 'endpoint_not_allowed'
          ? 'endpoint_not_allowed'
          : 'invalid_request'
      );
    }
    const continuing =
      this.credentials?.url === credentials.url &&
      this.credentials.token === credentials.token;
    this.stop();
    if (!continuing) {
      this.scope = null;
      this.catalog = null;
      this.state.models = [];
      this.state.selectedModelId = null;
    }
    this.credentials = credentials;
    this.state.url = credentials.url;
    this.state.phase = 'connecting';
    this.state.reason = null;
    this.changed();
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    let catalog: Catalog;
    try {
      const response = await fetch(new URL('v1/config', credentials.url), {
        headers: { Authorization: 'Bearer ' + credentials.token },
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'auth_failed'
            : 'connection_failed'
        );
      }
      catalog = validateCatalog(await boundedJson(response));
    } catch (error) {
      if (generation !== this.generation) return failure('brain_unavailable');
      const code: Failure =
        error instanceof Error && error.message === 'auth_failed'
          ? 'auth_failed'
          : error instanceof Error && error.message === 'invalid_response'
            ? 'invalid_response'
            : 'connection_failed';
      this.fail(code);
      return failure(code);
    }
    if (generation !== this.generation || this.disposed)
      return failure('brain_unavailable');
    if (this.scope && !sameIdentity(this.scope, catalog.identity))
      this.scope = null;
    this.catalog = catalog;
    let history: ConversationDetail | null = null;
    try {
      const saved = this.preferences?.read(catalog.identity);
      if (saved) this.voicePreference = saved.voiceEnabled;
      if (catalog.persistence) {
        this.library = new LibraryClient(catalog, async (path, method = 'GET', body) => {
          const response = await fetch(new URL(path, credentials.url), { method, headers: {
            Authorization: 'Bearer ' + credentials.token, ...(body === undefined ? {} : {'Content-Type': 'application/json'}) },
            ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error',
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 409 ? 'source_changed' : response.status === 503 ? 'storage_unavailable' : 'invalid_request'); }
          const result = await boundedJson(response, 2 * 1024 * 1024);
          if (generation !== this.generation) throw new Error('brain_unavailable');
          return result;
        }, () => { if (generation === this.generation) this.changed(); });
        history = await this.library.initialize(saved?.conversationId ?? this.conversationId);
        this.conversationId = history.conversation.id;
        this.preferences?.write(catalog.identity, { conversationId: this.conversationId });
        this.state.selectedModelId = history.conversation.modelId;
      }
    } catch (error) {
      if (generation !== this.generation) return failure('brain_unavailable');
      const code = error instanceof Error && error.message === 'invalid_response' ? 'invalid_response' : 'storage_unavailable';
      this.fail(code); return failure(code);
    }
    this.state.speech.available = Boolean(catalog.speech);
    this.state.speech.enabled = Boolean(catalog.speech) && this.voicePreference;
    this.state.speech.label = catalog.speech?.label ?? null;
    this.state.transcription = { available: Boolean(catalog.transcription), label: catalog.transcription?.label ?? null };
    this.state.routing = catalog.routing ? structuredClone(catalog.routing) : null;
    this.state.models = catalog.models.map((item) => ({
      id: modelId(item.model),
      label: item.label,
      providerId: item.model.provider_id,
      modelId: item.model.model_id,
      supportsImages: item.supports_images === true,
      supportsText: item.supports_text !== false,
      automaticAllowed: item.automatic_allowed === true,
      budgetUnits: item.budget_units ?? null,
      ...(item.boundary ? { boundary: item.boundary } : {}),
    }));
    if (
      !catalog.persistence && !this.state.models.some((item) => item.id === this.state.selectedModelId)
    )
      this.state.selectedModelId = null;
    const url = new URL('v1/chat', credentials.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.scope) url.searchParams.set('session_id', this.scope.session_id);
    if (this.library && this.conversationId) url.searchParams.set('conversation_id', this.conversationId);
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.pendingTimer = setTimeout(() => {
        if (generation === this.generation) this.fail('connection_failed');
      }, 10000);
      const socket = new WebSocket(url, {
        headers: { Authorization: 'Bearer ' + credentials.token },
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: 131072,
        handshakeTimeout: 10000,
      });
      this.socket = socket;
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        if (generation === this.generation)
          this.fail(
            response.statusCode === 401 || response.statusCode === 403
              ? 'auth_failed'
              : 'connection_failed'
          );
      });
      socket.on('error', () => {
        if (generation === this.generation) this.fail('connection_failed');
      });
      socket.on('close', (_code, reason) => {
        if (generation === this.generation) {
          if (reason.toString() === 'fresh_session_required') this.scope = null;
          this.fail('connection_failed');
        }
      });
      socket.on('message', (data, binary) => {
        if (generation !== this.generation) return;
        try {
          if (binary) throw new Error('protocol_error');
          const message = parseMessage(JSON.parse(data.toString()));
          if (!this.binding) {
            if (
              message.kind !== 'session.ready' ||
              !sameIdentity(message.scope, catalog.identity) ||
              message.payload.client_kind !== 'electron' ||
              !message.payload.capabilities.some(
                (capability) => capability === 'text'
              )
            )
              throw new Error('protocol_error');
            this.binding = this.controller.connect(message.scope);
            this.scope = structuredClone(message.scope);
            const readyResult = this.binding.ingest(message);
            if (readyResult.kind !== 'accepted') {
              if (
                readyResult.kind === 'rejected' &&
                readyResult.code === 'fresh_session_required'
              )
                this.scope = null;
              throw new Error('protocol_error');
            }
            this.state.phase = 'ready';
            this.state.reason = null;
            if (history) this.controller.restoreConversation(history.messages, history.actualModel);
            this.settle({ ok: true });
            this.changed();
            let alive = true;
            socket.on('pong', () => {
              alive = true;
            });
            this.heartbeat = setInterval(() => {
              if (!alive) {
                this.fail('connection_failed');
                return;
              }
              alive = false;
              socket.ping();
            }, 20000);
          } else {
            if (
              ![
                'input.finished',
                'turn.start',
                'turn.cancel',
                'response.delta',
                'response.completed',
                'speech.request',
                'speech.chunk',
                'speech.finished',
                'playback.state',
                'turn.ended',
                'session.closed',
                'context.invalidated',
                'tool.context',
                'tool.proposed',
                'tool.offers',
                'tool.resolved',
              ].includes(message.kind)
            )
              throw new Error('protocol_error');
            const hostToolMessage=message.kind==='tool.offers'||message.kind==='tool.resolved';
            if(hostToolMessage&&!this.issuedToolMessages.has(message.message_id))throw Error('protocol_error');
            const result = this.binding.ingest(message);
            if(hostToolMessage&&result.kind!=='duplicate')throw Error('protocol_error');
            if (
              result.kind === 'rejected' ||
              result.kind === 'approval-ledger-unavailable'
            ) {
              if (
                result.kind === 'rejected' &&
                result.code === 'fresh_session_required'
              )
                this.scope = null;
              throw new Error('protocol_error');
            }
            if (result.kind === 'accepted') {
              this.speechCoordinator.receive(message);
              this.conversationTools?.receive(message);
            }
            if (
              message.kind === 'turn.ended' &&
              (result.kind === 'accepted' || result.kind === 'duplicate')
            )
              this.intents.delete(message.turn_id);
            if (message.kind === 'session.closed' && result.kind === 'accepted')
              this.fail('connection_failed');
            if (message.kind === 'context.invalidated' && result.kind === 'accepted') {
              this.conversationTools?.invalidate('source_changed');
              if(this.library){this.onSourcesInvalidated();
                this.libraryInvalidated = true; this.refreshInvalidated();}
            }
            if (message.kind === 'turn.ended') { this.refreshInvalidated(); if (this.catalog?.routing) void this.refreshRouting(); }
            if (message.kind === 'turn.ended' && this.library && !this.libraryBusy)
              void this.library.refreshConversations().catch(() => {});
          }
        } catch {
          if (generation === this.generation) this.fail('protocol_error');
        }
      });
    });
  }
  reconnect(): Promise<CommandResult> {
    return this.credentials
      ? this.connect(this.credentials)
      : Promise.resolve(failure('brain_unavailable'));
  }
  connectionGeneration(): number { return this.generation; }
  disconnect(): CommandResult {
    this.stop();
    this.state.phase = 'disconnected';
    this.state.reason = null;
    this.changed();
    return { ok: true };
  }
  selectModel(id: unknown): CommandResult | Promise<CommandResult> {
    if (this.state.phase !== 'ready') return failure('brain_unavailable');
    if (this.controller.snapshot().activeTurnId) return failure('busy');
    if (
      id !== null &&
      (typeof id !== 'string' ||
        !this.state.models.some((item) => item.id === id))
    )
      return failure('invalid_request');
    if (this.library) return this.runLibrary(async library => {
      const model = this.catalog!.models.find(item => modelId(item.model) === id)?.model ?? null;
      await library.saveConversationModel(model); this.state.selectedModelId = id; this.changed();
    });
    this.state.selectedModelId = id;
    this.changed();
    return { ok: true };
  }
  setVoiceEnabled(enabled: unknown): CommandResult {
    if (typeof enabled !== 'boolean') return failure('invalid_request');
    if (this.controller.snapshot().activeTurnId) return failure('busy');
    try { if (this.catalog) this.preferences?.write(this.catalog.identity, { voiceEnabled: enabled }); }
    catch { return failure('storage_unavailable'); }
    this.voicePreference = enabled;
    this.state.speech.enabled = enabled && this.state.speech.available;
    this.changed(); return { ok: true };
  }
  reportPlayback(report: unknown): CommandResult { return this.speechCoordinator.report(report); }
  private async runLibrary(operation: (library: LibraryClient) => Promise<void>): Promise<CommandResult> {
    if (this.state.phase !== 'ready' || !this.library) return failure('brain_unavailable');
    if (this.libraryBusy || this.controller.snapshot().activeTurnId) return failure('busy');
    this.libraryBusy = true;
    const generation = this.generation;
    try { await operation(this.library); if (generation !== this.generation) return failure('brain_unavailable'); return {ok: true}; }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      return failure(['invalid_request', 'invalid_response', 'source_changed', 'brain_unavailable', 'default_unavailable'].includes(code) ? code as Failure : 'storage_unavailable');
    } finally { if (generation === this.generation) { this.libraryBusy = false; this.refreshInvalidated(); } }
  }
  private refreshInvalidated(): void {
    if (!this.libraryInvalidated || this.libraryBusy || !this.library || this.state.phase !== 'ready' || this.controller.snapshot().activeTurnId) return;
    this.libraryInvalidated = false;
    const generation = this.generation;
    void this.runLibrary(async library => { await library.refreshSources(); await this.restoreCurrent(library); }).then(result => {
      if (!result.ok && generation === this.generation) this.fail('storage_unavailable');
    });
  }
  private async restoreCurrent(library: LibraryClient): Promise<void> {
    const current = library.snapshot().conversationId;
    if (!current) return;
    const detail = await library.open(current, true);
    if (!this.controller.snapshot().activeTurnId) this.controller.restoreConversation(detail.messages, detail.actualModel);
  }
  refreshLibrary(query: string): Promise<CommandResult> { return this.runLibrary(async library => { await library.search(query); await library.refreshConversations(); }); }
  selectSources(ids: unknown): CommandResult {
    if (!this.library || this.state.phase !== 'ready') return failure('brain_unavailable');
    if (this.libraryBusy || this.controller.snapshot().activeTurnId) return failure('busy');
    try { this.library.select(ids); return {ok: true}; } catch { return failure('invalid_request'); }
  }
  saveDefaultModel(): Promise<CommandResult> { return this.runLibrary(async library => {
    const model = this.catalog!.models.find(item => modelId(item.model) === (this.state.selectedModelId ?? library.snapshot().defaultModelId));
    if (!model) throw new Error('default_unavailable');
    await library.saveDefault(model.model);
  }); }
  createSource(input: SourceInput): Promise<CommandResult> { return this.runLibrary(library => library.createSource(input)); }
  updateSource(input: SourceUpdate): Promise<CommandResult> { return this.runLibrary(async library => { await library.updateSource(input); await this.restoreCurrent(library); }); }
  deleteSource(input: { id: string; revision: number }): Promise<CommandResult> { return this.runLibrary(async library => { await library.deleteSource(input); await this.restoreCurrent(library); }); }
  async changeConversation(id: string | null): Promise<CommandResult> {
    const prepared = await this.runLibrary(async library => {
      const detail = id === null ? await library.createConversation() : await library.open(id);
      this.conversationId = detail.conversation.id;
      this.preferences?.write(this.catalog!.identity, { conversationId: this.conversationId });
    });
    if (!prepared.ok) return prepared;
    this.scope = null; return this.reconnect();
  }
  async deleteConversation(id: string): Promise<CommandResult> {
    let currentDeleted = false;
    const removed = await this.runLibrary(async library => {
      currentDeleted = id === library.snapshot().conversationId;
      await library.deleteConversation(id);
      if (!currentDeleted) { await this.restoreCurrent(library); return; }
      const detail = await library.initialize(null);
      this.conversationId = detail.conversation.id;
      this.preferences?.write(this.catalog!.identity, { conversationId: this.conversationId });
    });
    if (!removed.ok || !currentDeleted) return removed;
    this.scope = null; return this.reconnect();
  }
  cancelTranscription(): CommandResult {
    this.transcriptionAbort?.abort(); this.transcriptionAbort = null; return { ok: true };
  }
  async transcribeAudio(value: unknown): Promise<TranscriptionResult> {
    if (!object(value) || !keys(value, ['data', 'contentType']) || !(value.data instanceof Uint8Array)
      || !['audio/wav', 'audio/webm'].includes(String(value.contentType)) || value.data.length < 32
      || value.data.length > 4 * 1024 * 1024) return failure('invalid_request');
    if (this.state.phase !== 'ready' || !this.catalog?.transcription || !this.credentials) return failure('brain_unavailable');
    if (this.transcriptionAbort) return failure('busy');
    const generation = this.generation, abort = new AbortController(); this.transcriptionAbort = abort;
    try {
      const response = await fetch(new URL('v1/transcriptions', this.credentials.url), {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.credentials.token, 'Content-Type': String(value.contentType) },
        body: Buffer.from(value.data), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)])
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('transcription_failed'); }
      const result = await boundedJson(response);
      if (generation !== this.generation || abort.signal.aborted) return { ok: false, code: 'cancelled' };
      if (!object(result) || !keys(result, ['text']) || !validText(result.text)) return { ok: false, code: 'transcription_failed' };
      return { ok: true, text: result.text.trim() };
    } catch { return { ok: false, code: abort.signal.aborted ? 'cancelled' : 'transcription_failed' }; }
    finally { if (this.transcriptionAbort === abort) this.transcriptionAbort = null; }
  }
  sendText(text: unknown): CommandResult {
    if (!validText(text)) return failure('invalid_request');
    if (
      this.state.phase !== 'ready' ||
      !this.catalog ||
      !this.scope ||
      !this.binding ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return failure('brain_unavailable');
    if (this.controller.snapshot().activeTurnId || this.libraryBusy || this.routingBusy) return failure('busy');
    const selected = this.catalog.models.find(
      (item) => modelId(item.model) === this.state.selectedModelId
    );
    const selection: ModelSelection = selected
      ? { model: selected.model, source: 'conversation' }
      : this.catalog.default_selection;
    if ((!selected && this.state.selectedModelId !== null) || !this.catalog.models.some(item => sameModel(item.model, selection.model)))
      return failure('default_unavailable');
    if (selected?.supports_text === false) return failure('default_unavailable');
    const candidates = !selected && this.state.routing?.enabled ? automaticCandidates(this.catalog.models, 'text') : undefined;
    if (candidates && !candidates.length) return failure('routing_no_candidate');
    const turnId = randomUUID(),
      intentId = randomUUID();
    const base = {
      protocol: 'kirian.rearchitecture.v1',
      scope: this.scope,
      turn_id: turnId,
      intent_id: intentId,
      sequence: 0,
    };
    const input = parseMessage({
      ...base,
      kind: 'input.finished',
      message_id: randomUUID(),
      request_id: randomUUID(),
      payload: { input_id: randomUUID(), kind: 'text', text: text.trim() },
    });
    const start = parseMessage({
      ...base,
      kind: 'turn.start',
      message_id: randomUUID(),
      request_id: randomUUID(),
      payload: { selection, context: this.library?.contexts() ?? [], ...(candidates ? {routing_candidates:candidates} : {}), ...(this.state.speech.enabled ? { speech: true } : {}),
        ...(this.conversationTools?.enabled() && this.conversationToolContext().loopback ? {external_tools:true} : {}) },
    });
    this.intents.set(turnId, intentId);
    if (start.kind === 'turn.start' && start.payload.external_tools) this.conversationTools?.begin(start);
    if (this.state.speech.enabled && this.catalog.speech)
      this.speechCoordinator.begin(this.scope, turnId, intentId, this.catalog.speech.model);
    return this.send([input, start]);
  }
  cancelTurn(): CommandResult {
    const turnId = this.controller.snapshot().activeTurnId;
    const intentId = turnId ? this.intents.get(turnId) : null;
    if (!turnId || !intentId || !this.scope) return failure('invalid_request');
    this.conversationTools?.invalidate('cancelled');
    this.speechCoordinator.reset();
    return this.send([
      parseMessage({
        protocol: 'kirian.rearchitecture.v1',
        scope: this.scope,
        turn_id: turnId,
        intent_id: intentId,
        kind: 'turn.cancel',
        message_id: randomUUID(),
        request_id: randomUUID(),
        sequence: 0,
        payload: { reason: 'user' },
      }),
    ]);
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.credentials = null;
    this.catalog = null;
    this.scope = null;
    this.state.models = [];
  }
  private send(messages: ProtocolMessage[]): CommandResult {
    if (
      this.state.phase !== 'ready' ||
      !this.binding ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return failure('brain_unavailable');
    const generation = this.generation;
    try {
      for (const message of messages) {
        if (this.socket.bufferedAmount > 262144)
          throw new Error('protocol_error');
        const result = this.binding.ingest(message);
        if (result.kind !== 'accepted') {
          if (
            result.kind === 'rejected' &&
            result.code === 'fresh_session_required'
          )
            this.scope = null;
          throw new Error('protocol_error');
        }
        this.socket.send(JSON.stringify(message), (error) => {
          if (error && generation === this.generation)
            this.fail('connection_failed');
        });
      }
      return { ok: true };
    } catch {
      this.fail('protocol_error');
      return failure('protocol_error');
    }
  }
  private changed(): void {
    this.onChange();
  }
  private settle(result: CommandResult): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingResolve?.(result);
    this.pendingResolve = null;
  }
  private stop(): void {
    this.conversationTools?.invalidate('connection_changed');
    this.issuedToolMessages.clear();
    ++this.generation;
    this.library = null; this.libraryBusy = false; this.libraryInvalidated = false;
    this.cancelTranscription();
    this.speechCoordinator.reset();
    this.abort?.abort();
    this.abort = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.settle(failure('brain_unavailable'));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    this.binding?.disconnect();
    this.binding = null;
    this.intents.clear();
  }
  private fail(code: Failure): void {
    this.settle(failure(code));
    this.stop();
    this.state.phase = 'error';
    this.state.reason = code;
    this.changed();
  }
}
