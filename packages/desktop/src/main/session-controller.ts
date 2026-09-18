import { Buffer } from 'node:buffer';
import {
  ContractError,
  SessionLifecycle,
  parseMessage,
  type ProtocolMessage,
  type Scope,
} from '@kirian/contracts';
import type { ChatMessage, SessionSnapshot } from '../shared/bridge.js';

export type IngestResult =
  | { kind: 'accepted' | 'duplicate' }
  | { kind: 'discarded'; reason: string }
  | { kind: 'rejected'; code: string }
  | {
      kind: 'approval-ledger-unavailable';
      action: 'action.draft' | 'action.approve' | 'action.receipt';
    };

export interface ConnectionBinding {
  ingest(value: unknown): IngestResult;
  disconnect(): void;
}

export interface SessionControllerLimits {
  maxEvents?: number;
  maxBytes?: number;
  maxResponseCharacters?: number;
}

const DEFAULT_LIMITS = {
  maxEvents: 5_000,
  maxBytes: 16 * 1024 * 1024,
  maxResponseCharacters: 32_768,
};
const MAX_MESSAGES = 100;
type Listener = (snapshot: SessionSnapshot) => void;

function sameSession(left: Scope, right: Scope): boolean {
  return (
    left.instance_id === right.instance_id &&
    left.mode === right.mode &&
    left.principal_id === right.principal_id &&
    left.session_id === right.session_id
  );
}

/** Main-only projection of authenticated traffic; this class never authorizes or executes actions. */
export class SessionController {
  private readonly limits: typeof DEFAULT_LIMITS;
  private lifecycle: SessionLifecycle | null = null;
  private scope: Scope | null = null;
  private bindingGeneration = 0;
  private disposed = false;
  private events = 0;
  private bytes = 0;
  private exhausted = false;
  private readonly seenRows = new Set<string>();
  private readonly responseCharacters = new Map<string, number>();
  // Independent of the 100 visible rows; accepted-event budgets bound this set too.
  private readonly activeTurns = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private state: SessionSnapshot = {
    revision: 0,
    connection: { phase: 'disconnected', reason: null },
    actualModel: null,
    messages: [],
    activeTurnId: null,
  };

  constructor(limits: SessionControllerLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const key of Object.keys(
      DEFAULT_LIMITS
    ) as (keyof typeof DEFAULT_LIMITS)[]) {
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > DEFAULT_LIMITS[key]
      ) {
        throw new Error('invalid_session_limit');
      }
    }
  }

  /** Scope must come from host authentication. Keep the returned binding inside the transport. */
  connect(authenticatedScope: Scope): ConnectionBinding {
    if (this.disposed) throw new Error('session_controller_disposed');
    const scope = structuredClone(authenticatedScope);
    const continuing = this.scope !== null && sameSession(this.scope, scope);
    if (continuing && this.lifecycle) {
      if (this.exhausted) throw new Error('fresh_session_required');
      this.lifecycle.reconnect(scope);
      this.finishStreaming('cancelled');
    } else {
      // Validate before replacing an existing authenticated session.
      const lifecycle = new SessionLifecycle(scope);
      this.lifecycle?.close();
      this.lifecycle = lifecycle;
      this.events = 0;
      this.bytes = 0;
      this.exhausted = false;
      this.seenRows.clear();
      this.responseCharacters.clear();
      this.state.messages = [];
    }
    this.scope = scope;
    const generation = ++this.bindingGeneration;
    this.state.connection = { phase: 'connecting', reason: null };
    this.state.actualModel = null;
    this.clearActiveTurns();
    this.changed();
    return {
      ingest: (value) =>
        this.disposed || generation !== this.bindingGeneration
          ? { kind: 'discarded', reason: 'stale_connection' }
          : this.ingest(value),
      disconnect: () => {
        if (!this.disposed && generation === this.bindingGeneration)
          this.disconnect();
      },
    };
  }

  ingest(value: unknown): IngestResult {
    if (this.disposed) return { kind: 'discarded', reason: 'disposed' };
    if (!this.lifecycle) return { kind: 'discarded', reason: 'disconnected' };
    if (this.exhausted)
      return { kind: 'rejected', code: 'fresh_session_required' };
    if (this.state.connection.phase === 'error')
      return { kind: 'discarded', reason: 'connection_error' };
    try {
      const message = parseMessage(value);
      // Streamed audio is bounded per chunk (48 KiB) and per turn by the response limits; charging it to
      // the session budget closed every voice session after about three minutes of speech.
      if (message.kind !== 'speech.chunk') {
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (
          this.events >= this.limits.maxEvents ||
          size > this.limits.maxBytes - this.bytes
        ) {
          this.exhausted = true;
          this.fail('session_limit_exceeded');
          return { kind: 'rejected', code: 'fresh_session_required' };
        }
        // The guard retains fingerprints/tombstones across reconnects, so its budget does too.
        this.events += 1;
        this.bytes += size;
      }
      const result = this.lifecycle.receive(message);
      if (result.kind === 'approval-ledger') {
        return {
          kind: 'approval-ledger-unavailable',
          action: result.message.kind,
        };
      }
      if (result.kind === 'discarded')
        return { kind: 'discarded', reason: result.reason };
      if (result.kind === 'duplicate') return { kind: 'duplicate' };
      if (this.project(result.message)) this.changed();
      return { kind: 'accepted' };
    } catch (error) {
      const code =
        error instanceof ContractError ? error.code : 'invalid_message';
      this.fail(code);
      return { kind: 'rejected', code };
    }
  }

  disconnect(): void {
    if (this.disposed) return;
    ++this.bindingGeneration;
    this.lifecycle?.close();
    this.finishStreaming('cancelled');
    this.clearActiveTurns();
    this.state.actualModel = null;
    // Exhaustion cannot be hidden by a disconnect or cleared by same-session reconnect.
    this.state.connection = this.exhausted
      ? { phase: 'error', reason: 'session_limit_exceeded' }
      : { phase: 'disconnected', reason: null };
    this.changed();
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.state);
  }

  /** Restored host-owned history is display data, never a replay of execution or wire events. */
  restoreConversation(messages: ChatMessage[], actualModel: SessionSnapshot['actualModel']): void {
    if (this.disposed || this.activeTurns.size || this.state.connection.phase !== 'ready') throw new Error('busy');
    if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || messages.some(message =>
      !['user', 'assistant'].includes(message.role) || !['completed', 'failed', 'cancelled'].includes(message.status)
      || typeof message.text !== 'string' || message.text.length > this.limits.maxResponseCharacters * 2
      || [...message.text].length > this.limits.maxResponseCharacters)
      || messages.reduce((count, message) => count + [...message.text].length, 0) > 32768) throw new Error('invalid_history');
    this.state.messages = structuredClone(messages);
    this.state.actualModel = structuredClone(actualModel);
    this.state.routingReason = [...messages].reverse().find(message => message.actualModel)?.routingReason;
    this.changed();
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    this.notify(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.bindingGeneration;
    this.lifecycle?.close();
    this.lifecycle = null;
    this.scope = null;
    this.listeners.clear();
    this.seenRows.clear();
    this.responseCharacters.clear();
    this.clearActiveTurns();
    this.state = {
      revision: this.state.revision + 1,
      connection: { phase: 'disconnected', reason: null },
      actualModel: null,
      messages: [],
      activeTurnId: null,
    };
  }

  private project(message: ProtocolMessage): boolean {
    switch (message.kind) {
      case 'session.ready':
        this.state.connection = { phase: 'ready', reason: null };
        return true;
      case 'session.closed':
        this.finishStreaming('cancelled');
        this.state.connection = {
          phase: 'disconnected',
          reason: message.payload.reason,
        };
        this.clearActiveTurns();
        this.state.actualModel = null;
        ++this.bindingGeneration;
        return true;
      case 'input.finished':
        this.upsert(
          message.turn_id,
          'user',
          message.payload.text,
          message.payload.kind === 'audio' ? 'streaming' : 'completed'
        );
        this.activateTurn(message.turn_id);
        return true;
      case 'input.transcript':
        this.upsert(
          message.turn_id,
          'user',
          message.payload.text,
          message.payload.final ? 'completed' : 'streaming'
        );
        return true;
      case 'turn.start':
        this.state.routingReason = undefined;
        this.upsert(message.turn_id, 'assistant', '', 'streaming');
        this.responseCharacters.set(message.turn_id, 0);
        this.activateTurn(message.turn_id);
        return true;
      case 'response.delta': {
        const row = this.find(message.turn_id, 'assistant');
        const characters =
          (this.responseCharacters.get(message.turn_id) ?? 0) +
          [...message.payload.text].length;
        if (characters > this.limits.maxResponseCharacters)
          throw new ContractError('response_limit_exceeded');
        this.responseCharacters.set(message.turn_id, characters);
        const text = (row?.text ?? '') + message.payload.text;
        this.upsert(message.turn_id, 'assistant', text, 'streaming');
        this.setActualModel(message.payload.actual_model, message.turn_id, message.payload.routing_reason);
        return true;
      }
      case 'response.completed':
        this.upsert(
          message.turn_id,
          'assistant',
          this.find(message.turn_id, 'assistant')?.text ?? '',
          'completed'
        );
        this.setActualModel(message.payload.actual_model, message.turn_id, message.payload.routing_reason);
        return true;
      case 'turn.cancel':
        this.finishTurn(message.turn_id, 'cancelled');
        return true;
      case 'turn.ended':
        this.finishTurn(message.turn_id, message.payload.status);
        if (message.payload.status === 'failed' && message.payload.error_code) {
          const row = this.find(message.turn_id, 'assistant');
          if (row) row.errorCode = message.payload.error_code;
        }
        return true;
      default:
        // Audio, policy data and action envelopes are not renderer view models.
        return false;
    }
  }

  private find(
    turnId: string,
    role: ChatMessage['role']
  ): ChatMessage | undefined {
    return this.state.messages.find(
      (message) => message.turnId === turnId && message.role === role
    );
  }

  private upsert(
    turnId: string,
    role: ChatMessage['role'],
    text: string,
    status: ChatMessage['status']
  ): void {
    const id = `${turnId}:${role}`;
    const existing = this.find(turnId, role);
    if (existing) Object.assign(existing, { text, status });
    else if (!this.seenRows.has(id)) {
      this.seenRows.add(id);
      this.state.messages.push({ id, turnId, role, text, status });
    }
    if (this.state.messages.length > MAX_MESSAGES)
      this.state.messages.splice(0, this.state.messages.length - MAX_MESSAGES);
  }

  private setActualModel(model: {
    provider_id: string;
    model_id: string;
    endpoint_id: string;
  }, turnId: string, reason?: string): void {
    this.state.actualModel = {
      providerId: model.provider_id,
      modelId: model.model_id,
      endpointId: model.endpoint_id,
    };
    this.state.routingReason = reason;
    const row = this.find(turnId, 'assistant');
    if (row) { row.actualModel = structuredClone(this.state.actualModel); row.routingReason = reason; }
  }

  private finishTurn(
    turnId: string,
    status: 'completed' | 'cancelled' | 'failed'
  ): void {
    for (const row of this.state.messages) {
      if (
        row.turnId === turnId &&
        (row.role === 'assistant' || row.status === 'streaming')
      )
        row.status = status;
    }
    this.activeTurns.delete(turnId);
    this.state.activeTurnId = [...this.activeTurns].at(-1) ?? null;
  }

  private activateTurn(turnId: string): void {
    this.activeTurns.delete(turnId);
    this.activeTurns.add(turnId);
    this.state.activeTurnId = turnId;
  }

  private clearActiveTurns(): void {
    this.activeTurns.clear();
    this.state.activeTurnId = null;
  }

  private finishStreaming(status: 'cancelled' | 'failed'): void {
    for (const row of this.state.messages)
      if (row.status === 'streaming') row.status = status;
  }

  private fail(code: string): void {
    this.lifecycle?.close();
    ++this.bindingGeneration;
    this.finishStreaming('failed');
    this.clearActiveTurns();
    this.state.connection = { phase: 'error', reason: code };
    this.changed();
  }

  private changed(): void {
    this.state.revision += 1;
    for (const listener of [...this.listeners]) {
      if (!this.disposed && this.listeners.has(listener)) this.notify(listener);
    }
  }

  private notify(listener: Listener): void {
    try {
      listener(this.snapshot());
    } catch {
      /* A closed view must not interrupt protocol state. */
    }
  }
}
