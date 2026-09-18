import type { Identity, ProtocolMessage, Scope } from './protocol.generated.js';
import { assertActualModel } from './policy.js';
import { assertDefinition, ContractError, parseMessage } from './validation.js';

type Message<K extends ProtocolMessage['kind']> = Extract<ProtocolMessage, { kind: K }>;
type ActionMessage = Message<'action.draft' | 'action.approve' | 'action.receipt'>;
type TurnMessage = Extract<ProtocolMessage, { turn_id: string }>;
type StageState = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
type PlaybackState = 'idle' | Message<'playback.state'>['payload']['state'];

export type LifecycleResult =
  | { kind: 'accepted' | 'duplicate'; message: ProtocolMessage }
  | { kind: 'discarded'; reason: 'stale_connection' | 'closed_session' | 'terminal_turn'; message: ProtocolMessage }
  | { kind: 'approval-ledger'; message: ActionMessage };

export interface SpeechLifecycleSnapshot {
  readonly sentenceId: string;
  readonly sentenceIndex: number;
  readonly requestId: string;
  readonly generation: StageState;
  readonly playback: PlaybackState;
  readonly chunks: number;
}

export interface TurnLifecycleSnapshot {
  readonly turnId: string;
  readonly intentId: string;
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed';
  readonly ended: boolean;
  readonly input: 'absent' | 'transcribing' | 'ready' | 'cancelled' | 'failed';
  readonly generation: StageState;
  readonly speechExpected: boolean;
  readonly speechFinished: boolean;
  readonly speech: readonly SpeechLifecycleSnapshot[];
}

interface SpeechState {
  sentenceId: string;
  sentenceIndex: number;
  requestId: string;
  generation: StageState;
  playback: PlaybackState;
  playbackRequestId?: string;
  chunks: number;
  codec?: Message<'speech.chunk'>['payload']['codec'];
  sampleRate?: number;
}

interface TurnState {
  turnId: string;
  intentId: string;
  status: TurnLifecycleSnapshot['status'];
  ended: boolean;
  input: TurnLifecycleSnapshot['input'];
  inputId?: string;
  inputRequestId?: string;
  responseRequestId?: string;
  selection?: Message<'turn.start'>['payload']['selection'];
  actualModel?: Message<'response.delta'>['payload']['actual_model'];
  routingCandidates?: Message<'turn.start'>['payload']['routing_candidates'];
  routingReason?: Message<'response.delta'>['payload']['routing_reason'];
  toolsRequested?: boolean;
  toolContextId?: string;
  toolOffers?: string[];
  toolOfferProviders?: Record<string,'mcp'|'google_calendar'>;
  toolProposalId?: string;
  toolResolved?: boolean;
  generation: StageState;
  speechExpected: boolean;
  speechFinished: boolean;
  speech: Map<string, SpeechState>;
}

interface RequestState {
  family: string;
  turnId: string | null;
  intentId: string | null;
  nextSequence: number;
  terminal: boolean;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.instance_id === right.instance_id && left.mode === right.mode
    && left.principal_id === right.principal_id;
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  throw new ContractError('non_json_value');
}

function emptyTurn(turnId: string, intentId: string): TurnState {
  return {
    turnId, intentId, status: 'active', ended: false, input: 'absent', generation: 'idle',
    speechExpected: false, speechFinished: false, speech: new Map(),
  };
}

/**
 * In-memory guard for one authenticated session, independent of Vue, audio and transports.
 * The host MUST obtain authenticatedScope from its authenticated connection binding;
 * scope fields received in JSON do not establish identity or authority.
 *
 * Request IDs identify one stream family: input.finished/transcript, turn.start/response,
 * speech.request/chunk (one sentence), or playback.state (one sentence). Other commands
 * use their own request ID. Each request starts at sequence 0 and is contiguous. Exact
 * message retransmissions are duplicates; ID conflicts and gaps are errors, not retries.
 *
 * Client owns capture, sentence segmentation, the utterance queue and actual playback.
 * Brain owns conversation/policy; the inference adapter owns each computation job.
 * Different turns may overlap until explicitly cancelled. response.completed ends only
 * LLM generation; turn.ended completed requires all requested speech to have played.
 * Opt-in speech turns also require speech.finished to close sentence submission,
 * including the zero-sentence case. Legacy turns do not require this handshake.
 * Tombstones/request IDs survive reconnect. A new authenticated session needs a new guard.
 * This guard does not execute commands, authorize models or verify external receipts.
 */
export class SessionLifecycle {
  private scope: Scope;
  private ready = false;
  private closed = false;
  private reconnecting = false;
  private readonly turns = new Map<string, TurnState>();
  private readonly requests = new Map<string, RequestState>();
  private readonly messages = new Map<string, string>();
  private readonly inputs = new Set<string>();

  constructor(authenticatedScope: Scope) {
    assertDefinition('Scope', authenticatedScope);
    this.scope = structuredClone(authenticatedScope);
  }

  getTurn(turnId: string): TurnLifecycleSnapshot | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    return {
      turnId: turn.turnId, intentId: turn.intentId, status: turn.status, ended: turn.ended,
      input: turn.input, generation: turn.generation,
      speechExpected: turn.speechExpected, speechFinished: turn.speechFinished,
      speech: [...turn.speech.values()].map(speech => ({
        sentenceId: speech.sentenceId, sentenceIndex: speech.sentenceIndex,
        requestId: speech.requestId, generation: speech.generation,
        playback: speech.playback, chunks: speech.chunks,
      })),
    };
  }

  /** Call on a host-observed disconnect too; do not wait for a remote close message. */
  close(): void {
    this.closed = true;
    this.ready = false;
    for (const turn of this.turns.values()) {
      if (turn.status === 'active') this.terminate(turn, 'cancelled');
    }
  }

  /** A new authenticated connection invalidates every old active turn, without resuming it. */
  reconnect(authenticatedScope: Scope): void {
    assertDefinition('Scope', authenticatedScope);
    if (!sameIdentity(this.scope, authenticatedScope) || this.scope.session_id !== authenticatedScope.session_id) {
      throw new ContractError('scope_mismatch');
    }
    if (authenticatedScope.connection_epoch <= this.scope.connection_epoch
      || authenticatedScope.connection_id === this.scope.connection_id) {
      throw new ContractError('invalid_reconnect');
    }
    this.close();
    this.scope = structuredClone(authenticatedScope);
    this.closed = false;
    this.reconnecting = true;
  }

  receive(value: unknown): LifecycleResult {
    const message = parseMessage(value);
    if (!sameIdentity(this.scope, message.scope)) throw new ContractError('identity_mismatch');

    // Receipts have no conversational lifetime. The approval ledger must authenticate
    // executor/approval/digest and deduplicate execution IDs, even after this guard closes.
    if (message.kind === 'action.receipt') {
      if (!sameIdentity(message.scope, message.payload.receipt.identity)) {
        throw new ContractError('identity_mismatch');
      }
      return { kind: 'approval-ledger', message };
    }
    if (message.scope.session_id !== this.scope.session_id) throw new ContractError('scope_mismatch');
    if (message.scope.connection_id !== this.scope.connection_id
      || message.scope.connection_epoch !== this.scope.connection_epoch) {
      return { kind: 'discarded', reason: 'stale_connection', message };
    }
    if (this.closed) return { kind: 'discarded', reason: 'closed_session', message };

    const fingerprint = canonical(message);
    const seen = this.messages.get(message.message_id);
    if (seen !== undefined) {
      if (seen !== fingerprint) throw new ContractError('message_id_conflict');
      return { kind: 'duplicate', message };
    }

    if (message.kind === 'session.ready') {
      if (this.ready) throw new ContractError('session_already_ready');
      if (message.payload.resume !== (this.reconnecting ? 'turns_cancelled' : 'new_session')) {
        throw new ContractError('invalid_resume');
      }
      const commit = this.prepareRequest(message, 'session.ready', true);
      this.ready = true;
      commit();
    } else {
      if (!this.ready) throw new ContractError('session_not_ready');
      if (message.turn_id !== null) {
        const existing = this.turns.get(message.turn_id);
        if (existing && existing.intentId !== message.intent_id) throw new ContractError('intent_mismatch');
        const cancellationAck = existing?.status === 'cancelled' && !existing.ended
          && message.kind === 'turn.ended' && message.payload.status === 'cancelled';
        if (existing && existing.status !== 'active' && !cancellationAck) {
          return { kind: 'discarded', reason: 'terminal_turn', message };
        }
        this.receiveTurn(message);
      } else {
        const commit = this.prepareRequest(message, message.kind, true);
        if (message.kind === 'session.closed') this.close();
        commit();
      }
    }
    this.messages.set(message.message_id, fingerprint);
    if (message.kind === 'action.draft' || message.kind === 'action.approve') {
      return { kind: 'approval-ledger', message };
    }
    return { kind: 'accepted', message };
  }

  private prepareRequest(message: ProtocolMessage, family: string, terminal: boolean): () => void {
    const previous = this.requests.get(message.request_id);
    if (previous && (previous.family !== family || previous.turnId !== message.turn_id
      || previous.intentId !== message.intent_id)) throw new ContractError('request_binding_mismatch');
    if (previous?.terminal) throw new ContractError('request_terminated');
    if (message.sequence !== (previous?.nextSequence ?? 0)) throw new ContractError('sequence_mismatch');
    return () => this.requests.set(message.request_id, {
      family, turnId: message.turn_id, intentId: message.intent_id,
      nextSequence: message.sequence + 1, terminal,
    });
  }

  private receiveTurn(message: TurnMessage): void {
    const turn = this.turns.get(message.turn_id);
    if (message.kind === 'input.finished') {
      if (turn) throw new ContractError('input_already_started');
      if (this.inputs.has(message.payload.input_id)) throw new ContractError('input_id_reused');
      if (message.payload.kind === 'text' && !message.payload.text.trim()) throw new ContractError('empty_input');
      const commit = this.prepareRequest(message, 'input', message.payload.kind === 'text');
      const created = emptyTurn(message.turn_id, message.intent_id);
      created.input = message.payload.kind === 'audio' ? 'transcribing' : 'ready';
      created.inputId = message.payload.input_id;
      created.inputRequestId = message.request_id;
      this.turns.set(message.turn_id, created);
      this.inputs.add(message.payload.input_id);
      commit();
      return;
    }
    if (message.kind === 'turn.cancel') {
      const commit = this.prepareRequest(message, 'turn.cancel', true);
      const target = turn ?? emptyTurn(message.turn_id, message.intent_id);
      this.terminate(target, 'cancelled');
      this.turns.set(message.turn_id, target);
      commit();
      return;
    }
    if (message.kind === 'turn.start') {
      if (message.payload.routing_candidates && ['request', 'conversation'].includes(message.payload.selection.source)) {
        throw new ContractError('fixed_model_routing');
      }
      if (turn && (turn.generation !== 'idle' || turn.input === 'transcribing')) {
        throw new ContractError('invalid_turn_start');
      }
      const commit = this.prepareRequest(message, 'response', false);
      const target = turn ?? emptyTurn(message.turn_id, message.intent_id);
      target.responseRequestId = message.request_id;
      target.selection = structuredClone(message.payload.selection);
      target.routingCandidates = structuredClone(message.payload.routing_candidates);
      target.generation = 'running';
      target.toolsRequested = message.payload.external_tools === true;
      target.speechExpected = message.payload.speech ?? false;
      target.speechFinished = false;
      this.turns.set(message.turn_id, target);
      commit();
      return;
    }
    if (!turn) throw new ContractError('unknown_turn');

    switch (message.kind) {
      case 'tool.context': {
        if (!turn.toolsRequested || turn.generation !== 'running' || turn.toolContextId || turn.actualModel)
          throw new ContractError('invalid_tool_context');
        const commit = this.prepareRequest(message, message.kind, true);
        turn.toolContextId = message.payload.context_id;
        commit(); return;
      }
      case 'tool.offers': {
        if (!turn.toolsRequested || turn.generation !== 'running' || turn.toolContextId !== message.payload.context_id || turn.toolOffers)
          throw new ContractError('invalid_tool_offers');
        const ids = message.payload.offers.map(offer => offer.offer_id);
        if (new Set(ids).size !== ids.length) throw new ContractError('invalid_tool_offers');
        const commit = this.prepareRequest(message, message.kind, true);
        turn.toolOffers = ids;
        turn.toolOfferProviders=Object.fromEntries(message.payload.offers.map(offer=>[offer.offer_id,offer.provider_kind??'mcp']));
        commit(); return;
      }
      case 'tool.proposed': {
        if (!turn.toolsRequested || turn.generation !== 'running' || turn.toolProposalId || !turn.toolOffers?.includes(message.payload.offer_id) || turn.toolOfferProviders?.[message.payload.offer_id]!==message.payload.provider_kind)
          throw new ContractError('invalid_tool_proposal');
        if (!turn.selection) throw new ContractError('generation_not_started');
        if (turn.routingCandidates) {
          if (message.payload.routing_reason !== 'automatic_budget' || !turn.routingCandidates.some(model => canonical(model) === canonical(message.payload.actual_model)))
            throw new ContractError('actual_model_mismatch');
        } else {
          assertActualModel(turn.selection, message.payload.actual_model);
          const expected = {request:'request_fixed',conversation:'conversation_fixed',saved_default:'saved_default',initial_local:'initial_local'}[turn.selection.source];
          if (message.payload.routing_reason && message.payload.routing_reason !== expected) throw new ContractError('routing_reason_mismatch');
        }
        const commit = this.prepareRequest(message, message.kind, true);
        turn.toolProposalId = message.payload.proposal_id;
        turn.actualModel = structuredClone(message.payload.actual_model);
        turn.routingReason = message.payload.routing_reason;
        commit(); return;
      }
      case 'tool.resolved': {
        if (!turn.toolProposalId || turn.toolResolved || turn.toolProposalId !== message.payload.proposal_id || turn.generation !== 'running'
          || (message.payload.state === 'succeeded') !== Boolean(message.payload.source_ref)) throw new ContractError('invalid_tool_resolution');
        const commit = this.prepareRequest(message, message.kind, true);
        turn.toolResolved = true;
        commit(); return;
      }
      case 'input.transcript': {
        if (turn.inputRequestId !== message.request_id || turn.inputId !== message.payload.input_id) {
          throw new ContractError('input_binding_mismatch');
        }
        if (turn.input !== 'transcribing') throw new ContractError('input_terminated');
        const commit = this.prepareRequest(message, 'input', message.payload.final);
        if (message.payload.final) turn.input = 'ready';
        commit();
        return;
      }
      case 'response.delta':
      case 'response.completed': {
        if ((turn.toolContextId && !turn.toolOffers) || (turn.toolProposalId && !turn.toolResolved)) throw new ContractError('tool_resolution_pending');
        if (turn.responseRequestId !== message.request_id) throw new ContractError('response_binding_mismatch');
        if (turn.generation !== 'running') throw new ContractError('generation_terminated');
        if (turn.actualModel && canonical(turn.actualModel) !== canonical(message.payload.actual_model)) {
          throw new ContractError('actual_model_changed');
        }
        if (!turn.selection) throw new ContractError('generation_not_started');
        if (turn.routingCandidates) {
          if (!message.payload.routing_reason) throw new ContractError('routing_reason_missing');
          if (turn.routingReason && turn.routingReason !== message.payload.routing_reason) throw new ContractError('routing_reason_changed');
          if (message.payload.routing_reason !== 'automatic_budget') throw new ContractError('routing_reason_mismatch');
          if (!turn.routingCandidates.some(model => canonical(model) === canonical(message.payload.actual_model))) {
            throw new ContractError('actual_model_mismatch');
          }
        } else {
          assertActualModel(turn.selection, message.payload.actual_model);
          const expected = {request: 'request_fixed', conversation: 'conversation_fixed', saved_default: 'saved_default', initial_local: 'initial_local'}[turn.selection.source];
          if (message.payload.routing_reason && message.payload.routing_reason !== expected) throw new ContractError('routing_reason_mismatch');
        }
        const commit = this.prepareRequest(message, 'response', message.kind === 'response.completed');
        turn.actualModel = structuredClone(message.payload.actual_model);
        turn.routingReason = message.payload.routing_reason;
        if (message.kind === 'response.completed') turn.generation = 'completed';
        commit();
        return;
      }
      case 'speech.request': {
        if (turn.generation === 'idle') throw new ContractError('generation_not_started');
        if (turn.speechFinished) throw new ContractError('speech_already_finished');
        if (turn.speech.has(message.payload.sentence_id)) throw new ContractError('sentence_id_reused');
        if (message.payload.sentence_index !== turn.speech.size) throw new ContractError('sentence_order_mismatch');
        const commit = this.prepareRequest(message, 'speech:' + message.payload.sentence_id, false);
        turn.speech.set(message.payload.sentence_id, {
          sentenceId: message.payload.sentence_id, sentenceIndex: message.payload.sentence_index,
          requestId: message.request_id, generation: 'running', playback: 'idle', chunks: 0,
        });
        commit();
        return;
      }
      case 'speech.finished': {
        if (turn.generation !== 'completed') throw new ContractError('generation_incomplete');
        if (turn.speechFinished) throw new ContractError('speech_already_finished');
        if (message.payload.sentence_count !== turn.speech.size) throw new ContractError('sentence_count_mismatch');
        const commit = this.prepareRequest(message, 'speech.finished', true);
        turn.speechFinished = true;
        commit();
        return;
      }
      case 'speech.chunk': {
        const speech = turn.speech.get(message.payload.sentence_id);
        if (!speech || speech.requestId !== message.request_id
          || speech.sentenceIndex !== message.payload.sentence_index) throw new ContractError('speech_binding_mismatch');
        if (speech.generation !== 'running') throw new ContractError('speech_terminated');
        if (speech.codec !== undefined && (speech.codec !== message.payload.codec
          || speech.sampleRate !== message.payload.sample_rate_hz)) throw new ContractError('audio_format_changed');
        const commit = this.prepareRequest(message, 'speech:' + speech.sentenceId, message.payload.final);
        speech.chunks += 1;
        speech.codec = message.payload.codec;
        speech.sampleRate = message.payload.sample_rate_hz;
        if (message.payload.final) speech.generation = 'completed';
        commit();
        return;
      }
      case 'playback.state': {
        const speech = turn.speech.get(message.payload.sentence_id);
        if (!speech) throw new ContractError('unknown_sentence');
        if (speech.playbackRequestId !== undefined && speech.playbackRequestId !== message.request_id) {
          throw new ContractError('playback_binding_mismatch');
        }
        const next = message.payload.state;
        const valid = (speech.playback === 'idle' && next === 'queued')
          || (speech.playback === 'queued' && (next === 'playing' || next === 'cancelled' || next === 'failed'))
          || (speech.playback === 'playing' && (next === 'completed' || next === 'cancelled' || next === 'failed'));
        if (!valid) throw new ContractError('invalid_playback_transition');
        if (next === 'playing') {
          if (speech.chunks === 0) throw new ContractError('audio_not_ready');
          for (const earlier of turn.speech.values()) {
            if (earlier.sentenceIndex < speech.sentenceIndex && earlier.playback !== 'completed') {
              throw new ContractError('playback_order_mismatch');
            }
          }
        }
        if (next === 'completed' && speech.generation !== 'completed') throw new ContractError('speech_incomplete');
        const terminal = next === 'completed' || next === 'cancelled' || next === 'failed';
        const commit = this.prepareRequest(message, 'playback:' + speech.sentenceId, terminal);
        speech.playbackRequestId = message.request_id;
        speech.playback = next;
        commit();
        return;
      }
      case 'turn.ended': {
        if (message.payload.status === 'completed'
          && (turn.generation !== 'completed' || turn.input === 'transcribing'
            || (turn.speechExpected && !turn.speechFinished)
            || [...turn.speech.values()].some(speech => speech.generation !== 'completed' || speech.playback !== 'completed'))) {
          throw new ContractError('turn_incomplete');
        }
        const commit = this.prepareRequest(message, 'turn.ended', true);
        this.terminate(turn, message.payload.status);
        turn.ended = true;
        commit();
        return;
      }
      case 'action.draft':
      case 'action.approve': {
        const identity = message.kind === 'action.draft' ? message.payload.draft.identity : message.payload.approval.identity;
        if (!sameIdentity(this.scope, identity)) throw new ContractError('identity_mismatch');
        this.prepareRequest(message, message.kind, true)();
        return;
      }
    }
  }

  private terminate(turn: TurnState, status: 'completed' | 'cancelled' | 'failed'): void {
    turn.status = status;
    if (status === 'completed') return;
    if (turn.input === 'transcribing' || turn.input === 'absent') turn.input = status;
    if (turn.generation === 'idle' || turn.generation === 'running') turn.generation = status;
    for (const speech of turn.speech.values()) {
      if (speech.generation === 'running') speech.generation = status;
      if (speech.playback === 'idle' || speech.playback === 'queued' || speech.playback === 'playing') speech.playback = status;
    }
  }
}
