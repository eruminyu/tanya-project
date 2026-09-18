// One anonymous visitor: a Brain WebSocket on loopback, the desktop's session projection and speech
// coordinator reused unchanged, and a small snapshot/command surface for the browser. The browser never
// sees Brain protocol messages and never holds the Brain token.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { assertDefinition, parseMessage, type ModelRef, type ModelSelection, type ProtocolMessage, type Scope } from '@kirian/contracts';
import { SessionController, type ConnectionBinding } from '../../desktop/src/main/session-controller.js';
import { SpeechCoordinator } from '../../desktop/src/main/speech-coordinator.js';
import type { AudioEvent, BrainSnapshot, CommandResult, SessionSnapshot, SpeechSnapshot } from '../../desktop/src/shared/bridge.js';
import type { TurnSlots } from './limits.js';
import { DemoCalendarTools, type CalendarExecutor, type DemoToolsState } from './demo-calendar.js';
import { DemoProactive, type DemoProactiveState } from './demo-proactive.js';

export interface PublicCatalog {
  identity: { instance_id: string; mode: 'public_demo'; principal_id: string };
  models: { model: ModelRef; label: string; supports_text?: boolean; supports_tools?: boolean; boundary?: string }[];
  default_selection: ModelSelection;
  speech?: { model: ModelRef; label: string };
  persistence?: boolean;
}

export interface DemoState {
  turnsUsed: number;
  turnsLimit: number;
  messageCharacters: number;
  /** Set while the gateway refused the last turn because every generation slot was taken. */
  busy: boolean;
}

export interface VisitorSnapshot {
  session: SessionSnapshot;
  brain: BrainSnapshot;
  capabilities: { chat: boolean; voice: boolean; live2d: boolean };
  demo: DemoState;
  tools: DemoToolsState;
  proactive: DemoProactiveState;
}

export interface VisitorLimits { turnsPerSession: number; messageCharacters: number; idleMs: number; sessionMs: number; }

export interface VisitorEvents {
  snapshot(value: VisitorSnapshot): void;
  audio(event: AudioEvent): void;
  /** Called once; the browser socket is closed with this reason afterwards. */
  closed(reason: string, detail?: { deletedEvents: number }): void;
}

export interface VisitorOptions {
  brainUrl: string;
  brainToken: string;
  catalog: PublicCatalog;
  limits: VisitorLimits;
  slots: TurnSlots;
  events: VisitorEvents;
  /** Calendar tool executor; when present and the model supports tools, every turn offers the calendar tool. */
  executor?: CalendarExecutor;
  /** Ordered like the desktop: connect timeout, heartbeat interval. Tests shrink them. */
  connectTimeoutMs?: number;
  heartbeatMs?: number;
  /** Proactive card lead time and poll interval; tests shrink them. */
  proactiveLeadMs?: number;
  proactiveTickMs?: number;
  /** Label shown on proactive cards; defaults to the executor's calendar label. */
  proactiveCalendarLabel?: string;
}

const OUTBOUND_KINDS = new Set(['input.finished', 'turn.start', 'turn.cancel', 'response.delta', 'response.completed',
  'speech.request', 'speech.chunk', 'speech.finished', 'playback.state', 'turn.ended', 'session.closed',
  'tool.context', 'tool.proposed', 'tool.offers', 'tool.resolved',
  // Broadcast to every session when any conversation is deleted (another visitor leaving); nothing to do here.
  'context.invalidated']);

const ok: CommandResult = { ok: true };
const failure = (code: Extract<CommandResult, { ok: false }>['code']): CommandResult => ({ ok: false, code });
const modelId = (model: ModelRef) => JSON.stringify([model.endpoint_id, model.provider_id, model.model_id]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Validates the public Brain's /v1/config. Anything a personal instance would advertise is refused here. */
export function validatePublicCatalog(value: unknown): PublicCatalog {
  if (!object(value) || !Array.isArray(value.models) || !value.models.length || value.models.length > 32) throw new Error('invalid_catalog');
  // 'routing' is reported by a Brain with a store; the demo never enables automatic routing and ignores it.
  const allowed = new Set(['identity', 'models', 'default_selection', 'speech', 'persistence', 'routing']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('invalid_catalog');
  if ('persistence' in value && typeof value.persistence !== 'boolean') throw new Error('invalid_catalog');
  assertDefinition('Identity', value.identity);
  assertDefinition('ModelSelection', value.default_selection);
  const identity = value.identity as PublicCatalog['identity'];
  if (identity.mode !== 'public_demo') throw new Error('brain_not_public_demo');
  for (const item of value.models) {
    if (!object(item) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 160) throw new Error('invalid_catalog');
    assertDefinition('ModelRef', item.model);
    if (item.boundary === 'cloud') throw new Error('brain_not_public_demo');
  }
  if ('speech' in value) {
    if (!object(value.speech) || typeof value.speech.label !== 'string' || !value.speech.label.trim()) throw new Error('invalid_catalog');
    assertDefinition('ModelRef', value.speech.model);
  }
  const { routing: _routing, ...catalog } = value;
  return structuredClone(catalog) as unknown as PublicCatalog;
}

export class VisitorSession {
  private readonly controller = new SessionController();
  private readonly speech: SpeechCoordinator;
  private socket: WebSocket | null = null;
  private binding: ConnectionBinding | null = null;
  private scope: Scope | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lifeTimer: NodeJS.Timeout | null = null;
  private closedReason: string | null = null;
  private slotHeld = false;
  private readonly intents = new Map<string, string>();
  private voiceEnabled: boolean;
  private readonly brain: BrainSnapshot;
  private readonly demo: DemoState;
  private readonly tools: DemoCalendarTools | null;
  private readonly proactive: DemoProactive | null;
  private readonly issuedToolMessages = new Set<string>();
  private conversationId: string | null = null;
  private readonly createdEventIds: string[] = [];
  private finishing = false;

  constructor(private readonly options: VisitorOptions) {
    const { catalog } = options;
    this.voiceEnabled = Boolean(catalog.speech);
    this.brain = {
      phase: 'connecting', reason: null, url: 'public-demo',
      models: catalog.models.map(item => ({ id: modelId(item.model), label: item.label, providerId: item.model.provider_id, modelId: item.model.model_id,
        supportsText: item.supports_text !== false, ...(item.boundary ? { boundary: item.boundary as 'local' | 'private_lan' | 'cloud' } : {}) })),
      selectedModelId: null,
      speech: { available: Boolean(catalog.speech), enabled: this.voiceEnabled, label: catalog.speech?.label ?? null, phase: 'idle', sentence: null, error: null },
      transcription: { available: false, label: null },
    };
    this.demo = { turnsUsed: 0, turnsLimit: options.limits.turnsPerSession, messageCharacters: options.limits.messageCharacters, busy: false };
    this.speech = new SpeechCoordinator(messages => this.send(messages), event => this.options.events.audio(event), state => {
      Object.assign(this.brain.speech, state);
      this.publish();
    });
    this.controller.subscribe(() => this.publish());
    const toolsSupported = Boolean(options.executor) && catalog.models.some(item => item.model.model_id === catalog.default_selection.model.model_id && item.supports_tools === true);
    this.proactive = toolsSupported ? new DemoProactive({ changed: () => this.publish(), leadMs: options.proactiveLeadMs, tickMs: options.proactiveTickMs,
      timeZone: options.executor!.calendar.timeZone, calendarLabel: options.proactiveCalendarLabel ?? options.executor!.calendar.label }) : null;
    this.tools = toolsSupported ? new DemoCalendarTools({ identity: catalog.identity, executor: options.executor!, changed: () => this.publish(),
      request: (path, method, body) => this.request(path, method, body),
      executed: (receipt, event) => { if (receipt.created) this.createdEventIds.push(receipt.created.eventId); this.proactive?.record(receipt, event); },
      send: messages => { for (const message of messages) this.issuedToolMessages.add(message.message_id); return this.send(messages); } }) : null;
  }

  /** Brain HTTP for the gateway host role (loopback, bearer, no Origin). */
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.options.brainUrl), { method, redirect: 'error',
      headers: { Authorization: 'Bearer ' + this.options.brainToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    if (!response.ok) throw new Error(response.status === 409 ? 'source_changed' : 'brain_request_failed:' + response.status);
    if (text.length > 2 * 1024 * 1024) throw new Error('invalid_response');
    return JSON.parse(text);
  }

  snapshot(): VisitorSnapshot {
    return { session: this.controller.snapshot(), brain: structuredClone(this.brain),
      capabilities: { chat: true, voice: this.brain.speech.available, live2d: true }, demo: { ...this.demo },
      tools: this.tools ? this.tools.snapshot() : { available: false, phase: 'off', draft: null, receipt: null, errorCode: null },
      proactive: this.proactive ? this.proactive.snapshot() : { available: false, watching: 0, cards: [] } };
  }

  /** Opens the Brain socket; resolves once session.ready arrived, rejects with a reason code otherwise. */
  async open(): Promise<void> {
    const { brainUrl, brainToken, catalog } = this.options;
    const url = new URL('v1/chat', brainUrl);
    url.protocol = 'ws:';
    if (this.tools) {
      // The tool handshake needs a conversation; it is created for this visitor and deleted with the session.
      try {
        const created = await this.request('v1/conversations', 'POST', {}) as { conversation: { id: string } };
        this.conversationId = created.conversation.id;
        url.searchParams.set('conversation_id', this.conversationId);
      } catch { this.close('connection_failed'); throw new Error('connection_failed'); }
      if (this.closedReason !== null) throw new Error(this.closedReason);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { this.close(error); reject(new Error(error)); } else resolve();
      };
      const timer = setTimeout(() => settle('connection_failed'), this.options.connectTimeoutMs ?? 10000);
      const socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + brainToken }, followRedirects: false, perMessageDeflate: false,
        maxPayload: 131072, handshakeTimeout: this.options.connectTimeoutMs ?? 10000 });
      this.socket = socket;
      socket.on('unexpected-response', (_request, response) => { response.resume(); settle('connection_failed'); });
      socket.on('error', () => { settle('connection_failed'); this.fail('connection_failed'); });
      socket.on('close', () => { settle('connection_failed'); this.fail('connection_failed'); });
      socket.on('message', (data, binary) => {
        if (this.closedReason !== null || this.socket !== socket) return;
        try {
          if (binary) throw new Error('protocol_error');
          const message = parseMessage(JSON.parse(data.toString()));
          if (!this.binding) {
            if (message.kind !== 'session.ready' || message.scope.instance_id !== catalog.identity.instance_id
              || message.scope.mode !== 'public_demo' || message.payload.client_kind !== 'web'
              || !message.payload.capabilities.some(capability => capability === 'text')) throw new Error('protocol_error');
            this.binding = this.controller.connect(message.scope);
            this.scope = structuredClone(message.scope);
            if (this.binding.ingest(message).kind !== 'accepted') throw new Error('protocol_error');
            this.brain.phase = 'ready';
            this.brain.reason = null;
            this.armTimers();
            let alive = true;
            socket.on('pong', () => { alive = true; });
            this.heartbeat = setInterval(() => {
              if (!alive) { this.fail('connection_failed'); return; }
              alive = false;
              socket.ping();
            }, this.options.heartbeatMs ?? 20000);
            this.publish();
            settle();
            return;
          }
          if (!OUTBOUND_KINDS.has(message.kind)) throw new Error('protocol_error');
          const hostToolMessage = message.kind === 'tool.offers' || message.kind === 'tool.resolved';
          if (hostToolMessage && !this.issuedToolMessages.has(message.message_id)) throw new Error('protocol_error');
          const result = this.binding.ingest(message);
          if (hostToolMessage && result.kind !== 'duplicate') throw new Error('protocol_error');
          if (result.kind === 'rejected' || result.kind === 'approval-ledger-unavailable') throw new Error('protocol_error');
          if (result.kind === 'accepted') { this.speech.receive(message); this.tools?.receive(message); }
          if (message.kind === 'turn.ended' && result.kind !== 'discarded') this.finishTurn(message.turn_id);
          if (message.kind === 'session.closed' && result.kind === 'accepted') this.fail('connection_failed');
        } catch {
          this.fail('protocol_error');
        }
      });
    });
  }

  sendText(text: unknown): CommandResult {
    if (typeof text !== 'string') return failure('invalid_request');
    const trimmed = text.trim();
    if (!trimmed || [...trimmed].length > this.options.limits.messageCharacters || /[ --]/.test(trimmed)) return failure('invalid_request');
    if (this.brain.phase !== 'ready' || !this.scope || !this.binding || this.socket?.readyState !== WebSocket.OPEN) return failure('brain_unavailable');
    if (this.controller.snapshot().activeTurnId) return failure('busy');
    if (this.demo.turnsUsed >= this.demo.turnsLimit) return failure('routing_limit');
    if (!this.options.slots.acquire()) {
      this.demo.busy = true;
      this.publish();
      return failure('busy');
    }
    this.slotHeld = true;
    this.demo.busy = false;
    const { catalog } = this.options;
    const turnId = randomUUID(), intentId = randomUUID();
    const base = { protocol: 'kirian.rearchitecture.v1', scope: this.scope, turn_id: turnId, intent_id: intentId, sequence: 0 };
    const input = parseMessage({ ...base, kind: 'input.finished', message_id: randomUUID(), request_id: randomUUID(),
      payload: { input_id: randomUUID(), kind: 'text', text: trimmed } });
    const speaking = this.voiceEnabled && Boolean(catalog.speech);
    const start = parseMessage({ ...base, kind: 'turn.start', message_id: randomUUID(), request_id: randomUUID(),
      payload: { selection: catalog.default_selection, context: [], ...(speaking ? { speech: true } : {}), ...(this.tools ? { external_tools: true } : {}) } });
    this.intents.set(turnId, intentId);
    if (this.tools && start.kind === 'turn.start') this.tools.begin(start, trimmed);
    if (speaking && catalog.speech) this.speech.begin(this.scope, turnId, intentId, catalog.speech.model);
    const result = this.send([input, start]);
    if (result.ok) {
      this.demo.turnsUsed += 1;
      this.armTimers();
      this.publish();
    } else this.releaseSlot();
    return result;
  }

  cancelTurn(): CommandResult {
    const turnId = this.controller.snapshot().activeTurnId;
    const intentId = turnId ? this.intents.get(turnId) : null;
    if (!turnId || !intentId || !this.scope) return failure('invalid_request');
    this.speech.reset();
    return this.send([parseMessage({ protocol: 'kirian.rearchitecture.v1', scope: this.scope, turn_id: turnId, intent_id: intentId, kind: 'turn.cancel',
      message_id: randomUUID(), request_id: randomUUID(), sequence: 0, payload: { reason: 'user' } })]);
  }

  setVoiceEnabled(enabled: unknown): CommandResult {
    if (typeof enabled !== 'boolean') return failure('invalid_request');
    if (!this.brain.speech.available) return failure('invalid_request');
    this.voiceEnabled = enabled;
    this.brain.speech.enabled = enabled;
    if (!enabled) this.speech.reset();
    this.publish();
    return ok;
  }

  reportPlayback(report: unknown): CommandResult { return this.speech.report(report); }

  approveDraft(draftId: unknown): Promise<CommandResult> { return this.tools ? this.tools.approve(draftId) : Promise.resolve(failure('invalid_request')); }
  rejectDraft(draftId: unknown): CommandResult { return this.tools ? this.tools.reject(draftId) : failure('invalid_request'); }
  dismissSuggestion(cardId: unknown): CommandResult { return this.proactive ? this.proactive.dismiss(cardId) : failure('invalid_request'); }

  /** The visitor ends the demo: events this session created are deleted now (not at the sweep). The caller then
   * closes the session with reason 'finished' and the count, after acknowledging the command. */
  async finish(): Promise<{ deletedEvents: number } | null> {
    if (this.closedReason !== null || this.finishing) return null;
    this.finishing = true;
    if (this.controller.snapshot().activeTurnId) this.cancelTurn();
    let deletedEvents = 0;
    const ids = this.createdEventIds.splice(0);
    if (ids.length && this.options.executor?.deleteCreated) { try { deletedEvents = await this.options.executor.deleteCreated(ids); } catch { deletedEvents = 0; } }
    return { deletedEvents };
  }

  close(reason: string, detail?: { deletedEvents: number }): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.releaseSlot();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.lifeTimer) clearTimeout(this.lifeTimer);
    this.heartbeat = this.idleTimer = this.lifeTimer = null;
    this.speech.reset();
    this.tools?.dispose();
    this.proactive?.dispose();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    this.binding?.disconnect();
    this.binding = null;
    this.controller.dispose();
    this.intents.clear();
    // The visitor's conversation leaves the Brain with the session; a failed delete is not retried.
    if (this.conversationId) { const id = this.conversationId; this.conversationId = null; void this.request('v1/conversations/' + id, 'DELETE').catch(() => {}); }
    this.options.events.closed(reason, detail);
  }

  private send(messages: ProtocolMessage[]): CommandResult {
    if (this.brain.phase !== 'ready' || !this.binding || this.socket?.readyState !== WebSocket.OPEN) return failure('brain_unavailable');
    try {
      for (const message of messages) {
        if (this.socket.bufferedAmount > 262144) throw new Error('protocol_error');
        if (this.binding.ingest(message).kind !== 'accepted') throw new Error('protocol_error');
        this.socket.send(JSON.stringify(message), error => { if (error) this.fail('connection_failed'); });
      }
      return ok;
    } catch {
      this.fail('protocol_error');
      return failure('protocol_error');
    }
  }

  private finishTurn(turnId: string): void {
    this.intents.delete(turnId);
    this.releaseSlot();
    this.armTimers();
    this.publish();
  }

  private releaseSlot(): void {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    this.options.slots.release();
  }

  private armTimers(): void {
    if (this.closedReason !== null) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('idle'), this.options.limits.idleMs);
    if (!this.lifeTimer) this.lifeTimer = setTimeout(() => this.close('session_expired'), this.options.limits.sessionMs);
  }

  private fail(code: 'connection_failed' | 'protocol_error'): void {
    if (this.closedReason !== null) return;
    this.brain.phase = 'error';
    this.brain.reason = code;
    this.close(code);
  }

  private publish(): void {
    if (this.closedReason !== null) return;
    this.options.events.snapshot(this.snapshot());
  }
}
