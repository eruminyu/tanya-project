import { randomUUID } from 'node:crypto';
import { parseMessage, type ModelRef, type ProtocolMessage, type Scope } from '@kirian/contracts';
import type { AudioEvent, CommandResult, PlaybackReport, SpeechSnapshot } from '../shared/bridge.js';
import { createTtsChunker } from '../vendor/airi-audio/tts-chunker.js';

interface Sentence {
  id: string; index: number; requestId: string; playbackId: string; playbackRequestId: string;
  text: string; chunks: Buffer[]; bytes: number; ready: boolean; delivered: boolean;
  playback: 'idle' | PlaybackReport['state']; playbackSequence: number;
}
interface SpeechTurn {
  scope: Scope; turnId: string; intentId: string; model: ModelRef;
  chunker: ReturnType<typeof createTtsChunker>; pending: string[]; sentences: Sentence[];
  inFlight: number; textFinished: boolean; finishedSent: boolean; nextDelivery: number; bytes: number;
}
const ok: CommandResult = { ok: true };
const invalid: CommandResult = { ok: false, code: 'invalid_request' };

/** Client owns segmentation and ordering; Brain validates and performs each synthesis job. */
export class SpeechCoordinator {
  private turn: SpeechTurn | null = null;
  constructor(
    private readonly send: (messages: ProtocolMessage[]) => CommandResult,
    private readonly emit: (event: AudioEvent) => void,
    private readonly update: (state: Pick<SpeechSnapshot, 'phase' | 'sentence' | 'error'>) => void
  ) {}
  begin(scope: Scope, turnId: string, intentId: string, model: ModelRef): void {
    this.reset();
    this.turn = { scope: structuredClone(scope), turnId, intentId, model, chunker: createTtsChunker(),
      pending: [], sentences: [], inFlight: 0, textFinished: false, finishedSent: false, nextDelivery: 0, bytes: 0 };
    this.update({ phase: 'generating', sentence: null, error: null });
  }
  reset(error: string | null = null): void {
    this.turn = null;
    this.emit({ kind: 'reset' });
    this.update({ phase: error ? 'error' : 'idle', sentence: null, error });
  }
  receive(message: ProtocolMessage): void {
    const turn = this.turn;
    if (!turn || message.turn_id !== turn.turnId) return;
    if (message.kind === 'response.delta') {
      turn.pending.push(...turn.chunker.push(message.payload.text));
      this.pump(turn);
    } else if (message.kind === 'response.completed') {
      turn.pending.push(...turn.chunker.finish());
      turn.textFinished = true;
      this.pump(turn);
    } else if (message.kind === 'speech.chunk') {
      const sentence = turn.sentences[message.payload.sentence_index];
      if (!sentence || sentence.id !== message.payload.sentence_id || sentence.requestId !== message.request_id
        || sentence.ready || message.payload.codec !== 'wav') throw new Error('speech_protocol_error');
      const data = Buffer.from(message.payload.audio_base64, 'base64');
      sentence.bytes += data.length; turn.bytes += data.length;
      if (sentence.bytes > 4 * 1024 * 1024 || turn.bytes > 8 * 1024 * 1024) throw new Error('speech_audio_limit');
      sentence.chunks.push(data);
      if (message.payload.final) {
        sentence.ready = true; turn.inFlight--;
        this.deliverReady(turn);
        this.pump(turn);
      }
    } else if (message.kind === 'turn.ended') {
      this.reset(message.payload.status === 'failed' ? (message.payload.error_code ?? 'speech_error') : null);
    }
  }
  report(value: unknown): CommandResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid;
    const report = value as Partial<PlaybackReport>;
    if (Object.keys(value).sort().join(',') !== 'playbackId,state' || typeof report.playbackId !== 'string') return invalid;
    const turn = this.turn;
    const sentence = turn?.sentences.find(item => item.playbackId === report.playbackId);
    if (!turn || !sentence || !sentence.delivered) return invalid;
    const next = report.state;
    const valid = (sentence.playback === 'idle' && next === 'queued')
      || (sentence.playback === 'queued' && (next === 'playing' || next === 'failed'))
      || (sentence.playback === 'playing' && (next === 'completed' || next === 'failed'));
    if (!valid || !next) return invalid;
    const result = this.send([this.message(turn, 'playback.state', { sentence_id: sentence.id, state: next },
      sentence.playbackRequestId, sentence.playbackSequence)]);
    if (!result.ok || this.turn !== turn) return result;
    sentence.playback = next; sentence.playbackSequence++;
    if (next === 'playing') this.update({ phase: 'playing', sentence: sentence.text, error: null });
    if (next === 'completed') this.update({ phase: 'generating', sentence: null, error: null });
    if (next === 'failed') this.update({ phase: 'error', sentence: null, error: 'playback_failed' });
    return ok;
  }
  private message(turn: SpeechTurn, kind: string, payload: unknown, requestId: string = randomUUID(), sequence = 0): ProtocolMessage {
    return parseMessage({ protocol: 'kirian.rearchitecture.v1', scope: turn.scope, turn_id: turn.turnId,
      intent_id: turn.intentId, message_id: randomUUID(), request_id: requestId, sequence, kind, payload });
  }
  private pump(turn: SpeechTurn): void {
    while (this.turn === turn && turn.pending.length && turn.inFlight < 2) {
      const text = turn.pending.shift()!;
      if (!/[\p{L}\p{N}]/u.test(text.normalize('NFKC'))) {
        // Preserve decorations with the next phrase. Only a final decoration-only tail is omitted;
        // Brain independently verifies that no letters/numbers (including compatibility forms) were skipped.
        if (turn.pending.length) { turn.pending[0] = text + turn.pending[0]; continue; }
        else if (!turn.textFinished) turn.pending.unshift(text);
        break;
      }
      if (turn.sentences.length >= 128) throw new Error('speech_sentence_limit');
      const sentence: Sentence = { id: randomUUID(), index: turn.sentences.length, requestId: randomUUID(), playbackId: randomUUID(),
        playbackRequestId: randomUUID(), text, chunks: [], bytes: 0, ready: false, delivered: false, playback: 'idle', playbackSequence: 0 };
      turn.sentences.push(sentence); turn.inFlight++;
      if (!this.send([this.message(turn, 'speech.request', { sentence_id: sentence.id, sentence_index: sentence.index,
        text: sentence.text, model: turn.model }, sentence.requestId)]).ok) return;
    }
    if (this.turn === turn && turn.textFinished && !turn.pending.length && !turn.finishedSent) {
      turn.finishedSent = true;
      this.send([this.message(turn, 'speech.finished', { sentence_count: turn.sentences.length })]);
    }
  }
  private deliverReady(turn: SpeechTurn): void {
    for (;;) {
      const sentence = turn.sentences[turn.nextDelivery];
      if (!sentence?.ready) return;
      sentence.delivered = true; turn.nextDelivery++;
      const data = Buffer.concat(sentence.chunks);
      sentence.chunks = []; turn.bytes -= sentence.bytes;
      this.emit({ kind: 'audio', playbackId: sentence.playbackId, sentence: sentence.text, data });
    }
  }
}
