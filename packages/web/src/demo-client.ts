// Browser side of the public demo: one visitor token, one WebSocket to the gateway, snapshots in and
// commands out. It exposes the same shape the desktop renderer expects from its bridge for the parts the
// demo has (snapshot, text, cancel, voice, audio, playback) so the renderer components run unchanged.
import type { AudioEvent, BrainSnapshot, CommandResult, PlaybackReport, SessionSnapshot } from '../../desktop/src/shared/bridge.js';

export interface DemoInfo {
  modelLabel: string;
  speechAvailable: boolean;
  speechLabel: string | null;
  turnsPerSession: number;
  messageCharacters: number;
  idleSeconds: number;
  calendar: { kind: string; label: string; timeZone: string } | null;
}

export interface DemoState { turnsUsed: number; turnsLimit: number; messageCharacters: number; busy: boolean; }

export type EventTime = { date: string } | { dateTime: string; timeZone?: string };
export interface DraftEvent { summary: string; start: EventTime; end: EventTime; description: string; location: string; }
export interface DemoDraft { draftId: string; proposalId: string; event: DraftEvent; calendarLabel: string; timeZone: string; expiresAt: number; }
export interface DemoReceipt {
  status: 'succeeded' | 'failed';
  executorKind: string;
  draftId: string;
  executionId: string;
  providerOperationId: string | null;
  recordedAt: number;
  errorCode: string | null;
  handoff: { googleCalendarUrl: string; icsText: string; icsFileName: string } | null;
  created: { eventId: string; htmlLink: string | null; calendarLabel: string; readBack: boolean } | null;
}
export interface DemoToolsState {
  available: boolean;
  phase: 'off' | 'ready' | 'preparing' | 'awaiting_approval' | 'running' | 'summarizing' | 'finished' | 'unavailable';
  draft: DemoDraft | null;
  receipt: DemoReceipt | null;
  errorCode: string | null;
}

export interface ProactiveCard { id: string; kind: 'calendar'; text: string; quote: string; title: string; at: number; createdAt: number; expiresAt: number; }
export interface DemoProactiveState { available: boolean; watching: number; cards: ProactiveCard[]; }

export interface VisitorSnapshot {
  session: SessionSnapshot;
  brain: BrainSnapshot;
  capabilities: { chat: boolean; voice: boolean; live2d: boolean };
  demo: DemoState;
  tools: DemoToolsState;
  proactive: DemoProactiveState;
}

export type ClientPhase = 'idle' | 'requesting' | 'connecting' | 'ready' | 'closed';

export interface ClientState {
  phase: ClientPhase;
  /** Gateway reason after a close, or the HTTP/limit error while requesting. */
  reason: string | null;
  retryAfterSeconds: number | null;
  /** Set when the visitor ended the demo: how many demo events the gateway deleted for this session. */
  deletedEvents: number | null;
  info: DemoInfo | null;
  snapshot: VisitorSnapshot | null;
}

type GatewayMessage =
  | { kind: 'snapshot'; snapshot: VisitorSnapshot }
  | { kind: 'audio'; playbackId: string; sentence: string; audioBase64: string }
  | { kind: 'audio-reset' }
  | { kind: 'result'; id: number; result: CommandResult }
  | { kind: 'closed'; reason: string; deletedEvents?: number };

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface DemoClientOptions {
  /** Origin of the gateway; defaults to the page origin (the gateway serves the page). */
  origin?: string;
  fetch?: typeof fetch;
  createSocket?: (url: string) => WebSocket;
  commandTimeoutMs?: number;
}

export class DemoClient {
  private state: ClientState = { phase: 'idle', reason: null, retryAfterSeconds: null, deletedEvents: null, info: null, snapshot: null };
  private socket: WebSocket | null = null;
  private generation = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(state: ClientState) => void>();
  private readonly audioListeners = new Set<(event: AudioEvent) => void>();
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly commandTimeoutMs: number;

  constructor(options: DemoClientOptions = {}) {
    this.origin = options.origin ?? (typeof location === 'undefined' ? 'http://127.0.0.1:8090' : location.origin);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.createSocket = options.createSocket ?? (url => new WebSocket(url));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15000;
  }

  getState(): ClientState { return structuredClone(this.state); }
  getSnapshot(): VisitorSnapshot | null { return this.state.snapshot ? structuredClone(this.state.snapshot) : null; }

  subscribe(listener: (state: ClientState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => { this.listeners.delete(listener); };
  }

  onAudio(listener: (event: AudioEvent) => void): () => void {
    this.audioListeners.add(listener);
    return () => { this.audioListeners.delete(listener); };
  }

  /** Requests a visitor token and opens the socket. Resolves when the first ready snapshot arrived. */
  async connect(): Promise<void> {
    this.disconnect(null);
    const generation = ++this.generation;
    this.update({ phase: 'requesting', reason: null, retryAfterSeconds: null, deletedEvents: null, snapshot: null });
    let token: string;
    try {
      const response = await this.fetchImpl(this.origin + '/demo/session', { method: 'POST', cache: 'no-store' });
      const body = await response.json() as { token?: string; demo?: DemoInfo; error?: string; retryAfterSeconds?: number };
      if (generation !== this.generation) return;
      if (!response.ok || typeof body.token !== 'string' || !body.demo) {
        this.update({ phase: 'closed', reason: body.error ?? 'session_unavailable', retryAfterSeconds: body.retryAfterSeconds ?? null });
        return;
      }
      token = body.token;
      this.update({ info: body.demo });
    } catch {
      if (generation === this.generation) this.update({ phase: 'closed', reason: 'network_error' });
      return;
    }
    this.update({ phase: 'connecting' });
    const url = new URL('/demo/ws', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    await new Promise<void>(resolve => {
      const socket = this.createSocket(url.toString());
      this.socket = socket;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      socket.onmessage = event => {
        if (generation !== this.generation) return;
        let value: GatewayMessage;
        try { value = JSON.parse(String(event.data)) as GatewayMessage; } catch { this.disconnect('protocol_error'); settle(); return; }
        this.receive(value);
        if (this.state.phase === 'ready' || this.state.phase === 'closed') settle();
      };
      socket.onerror = () => { if (generation === this.generation && this.state.phase !== 'closed') this.disconnect('network_error'); settle(); };
      socket.onclose = event => {
        if (generation !== this.generation) return;
        if (this.state.phase !== 'closed') this.disconnect(event.reason || 'connection_closed');
        settle();
      };
    });
  }

  disconnect(reason: string | null): void {
    const socket = this.socket;
    this.socket = null;
    ++this.generation;
    if (socket) { socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* already closed */ } }
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.resolve({ ok: false, code: 'brain_unavailable' }); }
    this.pending.clear();
    this.emitAudio({ kind: 'reset' });
    if (reason !== null) this.update({ phase: 'closed', reason });
  }

  sendText(text: string): Promise<CommandResult> { return this.command({ kind: 'send', text }); }
  cancelTurn(): Promise<CommandResult> { return this.command({ kind: 'cancel' }); }
  setVoiceEnabled(enabled: boolean): Promise<CommandResult> { return this.command({ kind: 'voice', enabled }); }
  reportPlayback(report: PlaybackReport): Promise<CommandResult> { return this.command({ kind: 'playback', playbackId: report.playbackId, state: report.state }); }
  /** Public demo calendar (google_demo executor only): upcoming events anyone can verify. */
  async fetchCalendar(): Promise<{ calendar: { kind: string; label: string; timeZone: string }; events: { id: string; summary: string; start: EventTime; end: EventTime }[] } | null> {
    try {
      const response = await this.fetchImpl(this.origin + '/demo/calendar', { cache: 'no-store' });
      if (!response.ok) return null;
      const body = await response.json() as { calendar: { kind: string; label: string; timeZone: string }; events: { id: string; summary: string; start: EventTime; end: EventTime }[] };
      if (!body || !Array.isArray(body.events)) return null;
      return { calendar: body.calendar, events: body.events.slice(0, 50) };
    } catch { return null; }
  }
  approveDraft(draftId: string): Promise<CommandResult> { return this.command({ kind: 'approve', draftId }); }
  rejectDraft(draftId: string): Promise<CommandResult> { return this.command({ kind: 'reject', draftId }); }
  dismissSuggestion(cardId: string): Promise<CommandResult> { return this.command({ kind: 'dismiss', cardId }); }
  /** Ends the demo now: the gateway deletes this session's demo events and closes with reason 'finished'. */
  finish(): Promise<CommandResult> { return this.command({ kind: 'finish' }); }

  private command(value: Record<string, unknown>): Promise<CommandResult> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state.phase !== 'ready') return Promise.resolve({ ok: false, code: 'brain_unavailable' });
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, code: 'brain_unavailable' }); }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, ...value }));
    });
  }

  private receive(value: GatewayMessage): void {
    switch (value.kind) {
      case 'snapshot': {
        const phase = value.snapshot.brain.phase === 'ready' ? 'ready' : this.state.phase === 'ready' ? 'ready' : 'connecting';
        this.update({ snapshot: value.snapshot, phase });
        return;
      }
      case 'audio': {
        if (typeof value.audioBase64 !== 'string' || value.audioBase64.length > MAX_AUDIO_BYTES * 4 / 3 + 4) return;
        let data: Uint8Array;
        try { data = decodeBase64(value.audioBase64); } catch { return; }
        this.emitAudio({ kind: 'audio', playbackId: String(value.playbackId), sentence: String(value.sentence), data });
        return;
      }
      case 'audio-reset':
        this.emitAudio({ kind: 'reset' });
        return;
      case 'result': {
        const entry = this.pending.get(value.id);
        if (!entry) return;
        this.pending.delete(value.id);
        clearTimeout(entry.timer);
        entry.resolve(value.result);
        return;
      }
      case 'closed':
        if (typeof value.deletedEvents === 'number') this.update({ deletedEvents: value.deletedEvents });
        this.disconnect(String(value.reason));
        return;
      default:
        this.disconnect('protocol_error');
    }
  }

  private emitAudio(event: AudioEvent): void {
    for (const listener of [...this.audioListeners]) { try { listener(event); } catch { /* a broken player must not break the session */ } }
  }

  private update(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    const copy = this.getState();
    for (const listener of [...this.listeners]) { try { listener(copy); } catch { /* view errors stay in the view */ } }
  }
}
