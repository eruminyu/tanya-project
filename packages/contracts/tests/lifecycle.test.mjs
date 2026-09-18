import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionLifecycle } from '../dist/lifecycle.js';

const identity = { instance_id: 'private-instance', mode: 'personal', principal_id: 'owner' };
const scope = { ...identity, session_id: 'session-1', connection_id: 'socket-1', connection_epoch: 0 };
const model = { provider_id: 'ollama', model_id: 'local-model', endpoint_id: 'lan-model' };
let messageNumber = 0;

function event(kind, payload, options = {}) {
  const sessionEvent = ['session.ready', 'session.closed', 'model.default_changed', 'context.invalidated', 'action.receipt'].includes(kind);
  return {
    protocol: 'kirian.rearchitecture.v1', message_id: 'message-' + ++messageNumber,
    request_id: 'request-' + messageNumber, scope: { ...scope }, kind,
    turn_id: sessionEvent ? null : 'turn-1', intent_id: sessionEvent ? null : 'intent-1',
    sequence: 0, payload, ...options,
  };
}

function ready(guard, currentScope = scope, resume = 'new_session') {
  return guard.receive(event('session.ready', { client_kind: 'electron', resume, capabilities: ['text', 'audio_input', 'audio_output'] }, {
    scope: currentScope, request_id: 'ready-' + currentScope.connection_epoch,
  }));
}

function session() {
  const guard = new SessionLifecycle(scope);
  ready(guard);
  return guard;
}

function start(guard, options = {}) {
  return guard.receive(event('turn.start', { selection: { model, source: 'saved_default' }, context: [] }, {
    request_id: 'llm-1', ...options,
  }));
}

function response(kind = 'response.delta', sequence = 1, options = {}) {
  return event(kind, kind === 'response.delta' ? { text: '안녕하세요', actual_model: model } : { actual_model: model }, {
    request_id: 'llm-1', sequence, ...options,
  });
}

function speechRequest(index = 0, options = {}) {
  return event('speech.request', { sentence_id: 'sentence-' + index, sentence_index: index, text: '안녕하세요', model }, {
    request_id: 'tts-' + index, ...options,
  });
}

function speechChunk(index = 0, sequence = 1, final = true, options = {}) {
  return event('speech.chunk', {
    sentence_id: 'sentence-' + index, sentence_index: index, codec: 'pcm_s16le',
    sample_rate_hz: 24000, audio_base64: 'AAAA', final,
  }, { request_id: 'tts-' + index, sequence, ...options });
}

function playback(state, sequence, index = 0, options = {}) {
  return event('playback.state', { sentence_id: 'sentence-' + index, state }, {
    request_id: 'playback-' + index, sequence, ...options,
  });
}

function expectError(code, run) {
  assert.throws(run, error => error?.code === code);
}

function startSpeaking(guard) {
  return start(guard, { payload: { selection: { model, source: 'saved_default' }, context: [], speech: true } });
}

test('automatic response requires candidates, stable reason and stable actual model', () => {
  const other = { ...model, model_id: 'other' };
  const guard = session();
  start(guard, {payload: {selection: {model, source: 'saved_default'}, context: [], routing_candidates: [model, other]}});
  guard.receive(response('response.delta', 1, {payload: {text: '자동', actual_model: other, routing_reason: 'automatic_budget'}}));
  expectError('routing_reason_changed', () => guard.receive(response('response.completed', 2, {payload: {actual_model: other, routing_reason: 'saved_default'}})));
  guard.receive(response('response.completed', 2, {payload: {actual_model: other, routing_reason: 'automatic_budget'}}));
});

test('candidate list cannot override fixed selections or authorize an unrelated actual model', () => {
  const guard = session();
  expectError('fixed_model_routing', () => start(guard, {payload: {selection: {model, source: 'request'}, context: [], routing_candidates: [model]}}));
  start(guard, {payload: {selection: {model, source: 'saved_default'}, context: [], routing_candidates: [model]}});
  expectError('actual_model_mismatch', () => guard.receive(response('response.delta', 1, {payload: {text:'invalid',actual_model: {...model, model_id:'forged'},routing_reason:'automatic_budget'}})));
  expectError('routing_reason_missing', () => guard.receive(response()));
});

function speechFinished(sentenceCount, options = {}) {
  return event('speech.finished', { sentence_count: sentenceCount }, options);
}

test('opt-in speech waits for a zero-sentence handshake after LLM completion', () => {
  const guard = session();
  startSpeaking(guard);
  assert.equal(guard.getTurn('turn-1').speechExpected, true);
  const finished = speechFinished(0);
  expectError('generation_incomplete', () => guard.receive(finished));
  guard.receive(response('response.completed'));
  expectError('turn_incomplete', () => guard.receive(event('turn.ended', { status: 'completed' })));
  assert.equal(guard.receive(finished).kind, 'accepted');
  assert.equal(guard.getTurn('turn-1').speechFinished, true);
  assert.equal(guard.receive(event('turn.ended', { status: 'completed' })).kind, 'accepted');
});

test('speech.finished verifies the exact submission count and cannot substitute for actual playback', () => {
  const guard = session();
  startSpeaking(guard);
  guard.receive(speechRequest());
  guard.receive(response('response.completed'));
  expectError('sentence_count_mismatch', () => guard.receive(speechFinished(0)));
  expectError('sentence_count_mismatch', () => guard.receive(speechFinished(2)));
  assert.equal(guard.getTurn('turn-1').speechFinished, false);
  assert.equal(guard.receive(speechFinished(1)).kind, 'accepted');
  expectError('turn_incomplete', () => guard.receive(event('turn.ended', { status: 'completed' })));
  guard.receive(speechChunk());
  guard.receive(playback('queued', 0));
  guard.receive(playback('playing', 1));
  expectError('turn_incomplete', () => guard.receive(event('turn.ended', { status: 'completed' })));
  guard.receive(playback('completed', 2));
  assert.equal(guard.receive(event('turn.ended', { status: 'completed' })).kind, 'accepted');
});

test('speech submission closes once, uses its own request ID, and rejects later sentences', () => {
  const guard = session();
  startSpeaking(guard);
  guard.receive(response('response.completed'));
  expectError('request_binding_mismatch', () => guard.receive(speechFinished(0, { request_id: 'llm-1' })));
  assert.equal(guard.getTurn('turn-1').speechFinished, false);
  const finished = speechFinished(0);
  assert.equal(guard.receive(finished).kind, 'accepted');
  assert.equal(guard.receive(structuredClone(finished)).kind, 'duplicate');
  expectError('speech_already_finished', () => guard.receive(speechFinished(0)));
  expectError('speech_already_finished', () => guard.receive(speechRequest()));
  assert.equal(guard.getTurn('turn-1').speech.length, 0);
});

test('completed playback still cannot end an opt-in speech turn before submission closes', () => {
  const guard = session();
  startSpeaking(guard);
  guard.receive(speechRequest());
  guard.receive(speechChunk());
  guard.receive(playback('queued', 0));
  guard.receive(playback('playing', 1));
  guard.receive(playback('completed', 2));
  guard.receive(response('response.completed'));
  expectError('turn_incomplete', () => guard.receive(event('turn.ended', { status: 'completed' })));
  guard.receive(speechFinished(1));
  assert.equal(guard.receive(event('turn.ended', { status: 'completed' })).kind, 'accepted');
});

test('speech opt-in does not require a handshake to cancel or fail and late completion cannot revive it', () => {
  for (const status of ['cancelled', 'failed']) {
    const guard = session();
    startSpeaking(guard);
    guard.receive(speechRequest());
    guard.receive(event('turn.ended', { status, ...(status === 'failed' ? { error_code: 'speech_error' } : {}) }));
    assert.equal(guard.getTurn('turn-1').status, status);
    assert.equal(guard.receive(speechFinished(1)).reason, 'terminal_turn');
    assert.equal(guard.getTurn('turn-1').speechFinished, false);
  }
});

test('an explicit false speech flag preserves text-only completion without the handshake', () => {
  const guard = session();
  start(guard, { payload: { selection: { model, source: 'saved_default' }, context: [], speech: false } });
  guard.receive(response('response.completed'));
  assert.equal(guard.getTurn('turn-1').speechExpected, false);
  assert.equal(guard.receive(event('turn.ended', { status: 'completed' })).kind, 'accepted');
});

test('only authenticated scope can initialize a ready session', () => {
  const guard = new SessionLifecycle(scope);
  expectError('session_not_ready', () => start(guard));
  expectError('identity_mismatch', () => ready(guard, { ...scope, mode: 'public_demo' }));
  expectError('invalid_resume', () => ready(guard, scope, 'turns_cancelled'));
  assert.equal(ready(guard).kind, 'accepted');
  expectError('session_already_ready', () => ready(guard));
});

test('request sequences are contiguous, exact retransmissions are duplicate, errors do not consume a sequence', () => {
  const guard = session();
  start(guard);
  const first = response();
  assert.equal(guard.receive(first).kind, 'accepted');
  assert.equal(guard.receive(structuredClone(first)).kind, 'duplicate');
  expectError('sequence_mismatch', () => guard.receive(response('response.delta', 1)));
  expectError('sequence_mismatch', () => guard.receive(response('response.delta', 3)));
  assert.equal(guard.receive(response('response.delta', 2)).kind, 'accepted');
  expectError('message_id_conflict', () => guard.receive({ ...first, payload: { ...first.payload, text: '변조' } }));
  assert.equal(guard.receive(response('response.completed', 3)).kind, 'accepted');
  expectError('generation_terminated', () => guard.receive(response('response.delta', 4)));
});

test('input, intent and response requests stay bound to their original turn', () => {
  const guard = session();
  start(guard);
  expectError('intent_mismatch', () => guard.receive(response('response.delta', 1, { intent_id: 'another-intent' })));
  expectError('response_binding_mismatch', () => guard.receive(response('response.delta', 1, { request_id: 'other-llm' })));
  expectError('request_binding_mismatch', () => start(guard, { turn_id: 'turn-2', intent_id: 'intent-2' }));
  assert.equal(guard.getTurn('turn-2'), undefined);
  assert.equal(guard.receive(response()).kind, 'accepted');
  expectError('scope_mismatch', () => guard.receive(response('response.delta', 2, { scope: { ...scope, session_id: 'another-session' } })));
});

test('normal recording completion enters transcription; cancellation does not submit a late transcript', () => {
  const guard = session();
  const input = event('input.finished', { input_id: 'input-1', kind: 'audio', text: '' }, { request_id: 'stt-1' });
  guard.receive(input);
  assert.equal(guard.getTurn('turn-1').input, 'transcribing');
  assert.equal(guard.getTurn('turn-1').status, 'active');
  expectError('invalid_turn_start', () => start(guard));
  expectError('input_binding_mismatch', () => guard.receive(event('input.transcript', { input_id: 'wrong', text: '늦은 결과', final: true }, { request_id: 'stt-1', sequence: 1 })));
  guard.receive(event('input.transcript', { input_id: 'input-1', text: '부분 결과', final: false }, { request_id: 'stt-1', sequence: 1 }));
  guard.receive(event('turn.cancel', { reason: 'user' }));
  assert.equal(guard.getTurn('turn-1').input, 'cancelled');
  assert.equal(guard.receive(event('input.transcript', { input_id: 'input-1', text: '최종 결과', final: true }, { request_id: 'stt-1', sequence: 2 })).reason, 'terminal_turn');
  assert.equal(start(guard).reason, 'terminal_turn');
});

test('final transcript terminates STT independently and a later LLM request can start', () => {
  const guard = session();
  guard.receive(event('input.finished', { input_id: 'input-1', kind: 'audio', text: '' }, { request_id: 'stt-1' }));
  guard.receive(event('input.transcript', { input_id: 'input-1', text: '최종 결과', final: true }, { request_id: 'stt-1', sequence: 1 }));
  assert.equal(guard.getTurn('turn-1').input, 'ready');
  start(guard);
  expectError('input_terminated', () => guard.receive(event('input.transcript', { input_id: 'input-1', text: '또 다른 결과', final: true }, { request_id: 'stt-1', sequence: 2 })));
  expectError('input_id_reused', () => guard.receive(event('input.finished', { input_id: 'input-1', kind: 'text', text: '다음' }, { turn_id: 'turn-2', intent_id: 'intent-2' })));
});

test('a cancellation arriving before input/start creates a tombstone; late STT, LLM and TTS never revive it', () => {
  const guard = session();
  guard.receive(event('turn.cancel', { reason: 'barge_in' }));
  const late = [
    event('input.finished', { input_id: 'input-1', kind: 'audio', text: '' }),
    event('input.transcript', { input_id: 'input-1', text: '늦은 전사', final: true }),
    response(), speechRequest(), speechChunk(), playback('playing', 1),
  ];
  for (const message of late) assert.equal(guard.receive(message).reason, 'terminal_turn');
  assert.equal(start(guard).reason, 'terminal_turn');
  assert.equal(guard.getTurn('turn-1').status, 'cancelled');
  assert.equal(guard.receive(event('turn.ended', { status: 'cancelled' })).kind, 'accepted');
  assert.equal(guard.getTurn('turn-1').ended, true);
});

test('barge-in cancels pending TTS and playing audio while preserving already completed generation', () => {
  const guard = session();
  start(guard);
  guard.receive(response('response.completed'));
  guard.receive(speechRequest());
  guard.receive(speechChunk(0, 1, false));
  guard.receive(playback('queued', 0));
  guard.receive(playback('playing', 1));
  guard.receive(event('turn.cancel', { reason: 'barge_in' }));
  const turn = guard.getTurn('turn-1');
  assert.equal(turn.generation, 'completed');
  assert.equal(turn.speech[0].generation, 'cancelled');
  assert.equal(turn.speech[0].playback, 'cancelled');
  assert.equal(guard.receive(speechChunk(0, 2, true)).reason, 'terminal_turn');
});

test('LLM completion, TTS generation and actual playback have independent completion states', () => {
  const guard = session();
  start(guard);
  guard.receive(speechRequest());
  guard.receive(speechChunk(0, 1, false));
  guard.receive(playback('queued', 0));
  guard.receive(playback('playing', 1));
  guard.receive(response('response.completed'));
  let turn = guard.getTurn('turn-1');
  assert.equal(turn.generation, 'completed');
  assert.equal(turn.speech[0].generation, 'running');
  assert.equal(turn.speech[0].playback, 'playing');
  expectError('speech_incomplete', () => guard.receive(playback('completed', 2)));
  expectError('turn_incomplete', () => guard.receive(event('turn.ended', { status: 'completed' })));
  guard.receive(speechChunk(0, 2, true));
  turn = guard.getTurn('turn-1');
  assert.equal(turn.speech[0].generation, 'completed');
  assert.equal(turn.speech[0].playback, 'playing');
  expectError('turn_incomplete', () => guard.receive(event('turn.ended', { status: 'completed' })));
  guard.receive(playback('completed', 2));
  guard.receive(event('turn.ended', { status: 'completed' }));
  assert.equal(guard.getTurn('turn-1').status, 'completed');
  assert.equal(guard.receive(speechRequest(1)).reason, 'terminal_turn');
});

test('text-only turns can finish after the LLM, without inventing playback', () => {
  const guard = session();
  guard.receive(event('input.finished', { input_id: 'typed-1', kind: 'text', text: '안녕' }));
  start(guard);
  guard.receive(response('response.completed'));
  guard.receive(event('turn.ended', { status: 'completed' }));
  assert.deepEqual(guard.getTurn('turn-1').speech, []);
  assert.equal(guard.getTurn('turn-1').input, 'ready');
});

test('TTS streams bind sentence/id/index/format and reject chunks after final', () => {
  const guard = session();
  start(guard);
  expectError('sentence_order_mismatch', () => guard.receive(speechRequest(1)));
  guard.receive(speechRequest());
  expectError('speech_binding_mismatch', () => guard.receive(speechChunk(0, 1, false, { request_id: 'unknown' })));
  guard.receive(speechChunk(0, 1, false));
  const changed = speechChunk(0, 2, false);
  changed.payload.sample_rate_hz = 48000;
  expectError('audio_format_changed', () => guard.receive(changed));
  guard.receive(speechChunk(0, 2, true));
  expectError('speech_terminated', () => guard.receive(speechChunk(0, 3, true)));
  assert.equal(guard.getTurn('turn-1').speech[0].chunks, 2);
});

test('TTS generation may finish out of order, but playback must follow sentence order', () => {
  const guard = session();
  start(guard);
  guard.receive(speechRequest(0));
  guard.receive(speechRequest(1));
  guard.receive(speechChunk(1));
  guard.receive(playback('queued', 0, 1));
  expectError('playback_order_mismatch', () => guard.receive(playback('playing', 1, 1)));
  guard.receive(playback('queued', 0));
  expectError('audio_not_ready', () => guard.receive(playback('playing', 1)));
  guard.receive(speechChunk());
  guard.receive(playback('playing', 1));
  expectError('playback_binding_mismatch', () => guard.receive(playback('completed', 2, 0, { request_id: 'wrong-playback' })));
  guard.receive(playback('completed', 2));
  assert.equal(guard.receive(playback('playing', 1, 1)).kind, 'accepted');
  expectError('invalid_playback_transition', () => guard.receive(playback('queued', 3)));
});

test('a new input can transcribe while another turn plays, until an explicit cancellation', () => {
  const guard = session();
  start(guard);
  guard.receive(speechRequest());
  guard.receive(speechChunk());
  guard.receive(playback('queued', 0));
  guard.receive(playback('playing', 1));
  guard.receive(event('input.finished', { input_id: 'input-2', kind: 'audio', text: '' }, { turn_id: 'turn-2', intent_id: 'intent-2' }));
  assert.equal(guard.getTurn('turn-1').speech[0].playback, 'playing');
  assert.equal(guard.getTurn('turn-2').input, 'transcribing');
});

test('the first response must match the selected provider, model and endpoint, including completion without deltas', () => {
  for (const kind of ['response.delta', 'response.completed']) {
    for (const field of ['provider_id', 'model_id', 'endpoint_id']) {
      const guard = session();
      start(guard);
      const changed = response(kind);
      changed.payload.actual_model = { ...model, [field]: 'unapproved-alternative' };
      expectError('unapproved_model_change', () => guard.receive(changed));
      assert.equal(guard.getTurn('turn-1').generation, 'running');
      assert.equal(guard.receive(response(kind)).kind, 'accepted', 'rejection must not consume the expected sequence');
    }
  }
});

test('actual model is stable throughout an LLM stream', () => {
  const guard = session();
  start(guard);
  guard.receive(response());
  const changed = response('response.completed', 2);
  changed.payload.actual_model = { ...model, model_id: 'another-model' };
  expectError('actual_model_changed', () => guard.receive(changed));
  guard.receive(response('response.completed', 2));
});

test('mutating returned turn selection and response model cannot alter the stored model binding', () => {
  const guard = session();
  const started = start(guard);
  started.message.payload.selection.model.model_id = 'tampered-selection';
  const wrongFirst = response();
  wrongFirst.payload.actual_model = { ...model, model_id: 'tampered-selection' };
  expectError('unapproved_model_change', () => guard.receive(wrongFirst));

  const delta = guard.receive(response());
  delta.message.payload.actual_model.model_id = 'tampered-response';
  const wrongNext = response('response.completed', 2);
  wrongNext.payload.actual_model = { ...model, model_id: 'tampered-response' };
  expectError('actual_model_changed', () => guard.receive(wrongNext));
  assert.equal(guard.receive(response('response.completed', 2)).kind, 'accepted');
});

test('reconnect cancels active turns, rejects old sockets, and cannot reopen their turn IDs', () => {
  const guard = session();
  start(guard);
  const newScope = { ...scope, connection_id: 'socket-2', connection_epoch: 1 };
  expectError('invalid_reconnect', () => guard.reconnect({ ...scope, connection_id: 'socket-2' }));
  guard.reconnect(newScope);
  assert.equal(guard.getTurn('turn-1').status, 'cancelled');
  assert.equal(guard.receive(response()).reason, 'stale_connection');
  expectError('session_not_ready', () => start(guard, { scope: newScope, turn_id: 'turn-2', intent_id: 'intent-2', request_id: 'llm-2' }));
  ready(guard, newScope, 'turns_cancelled');
  assert.equal(start(guard, { scope: newScope }).reason, 'terminal_turn');
  assert.equal(start(guard, { scope: newScope, turn_id: 'turn-2', intent_id: 'intent-2', request_id: 'llm-2' }).kind, 'accepted');
  expectError('request_binding_mismatch', () => start(guard, { scope: newScope, turn_id: 'turn-3', intent_id: 'intent-3', request_id: 'llm-1' }));
});

test('local disconnect and remote session close invalidate future conversational events', () => {
  for (const remote of [false, true]) {
    const guard = session();
    start(guard);
    if (remote) guard.receive(event('session.closed', { reason: 'disconnect' }));
    else guard.close();
    assert.equal(guard.getTurn('turn-1').status, 'cancelled');
    assert.equal(guard.receive(response()).reason, 'closed_session');
  }
});

test('failed turns terminate remaining stages and cannot later claim success', () => {
  const guard = session();
  start(guard);
  guard.receive(speechRequest());
  guard.receive(event('turn.ended', { status: 'failed' }));
  const turn = guard.getTurn('turn-1');
  assert.equal(turn.generation, 'failed');
  assert.equal(turn.speech[0].generation, 'failed');
  assert.equal(turn.speech[0].playback, 'failed');
  assert.equal(guard.receive(event('turn.ended', { status: 'completed' })).reason, 'terminal_turn');
});

test('external receipts bypass conversation/session/connection lifetime but never identity binding', () => {
  const guard = session();
  start(guard);
  guard.receive(event('turn.cancel', { reason: 'user' }));
  guard.close();
  const receipt = event('action.receipt', { receipt: {
    execution_id: 'execution-1', draft_id: 'draft-1', draft_revision: 1, identity: { ...identity }, executor_id: 'desktop-1',
    payload_sha256: 'a'.repeat(64), status: 'succeeded', provider_id: 'google', provider_operation_id: 'event-123', error_code: null, recorded_at_ms: 1,
  } }, { scope: { ...scope, session_id: 'older-session', connection_id: 'older-socket' } });
  assert.equal(guard.receive(receipt).kind, 'approval-ledger');
  assert.equal(guard.receive(receipt).kind, 'approval-ledger', 'execution deduplication belongs to the approval ledger');
  expectError('identity_mismatch', () => guard.receive({ ...receipt, scope: { ...receipt.scope, principal_id: 'intruder' } }));
  const forged = structuredClone(receipt);
  forged.payload.receipt.identity.principal_id = 'intruder';
  expectError('identity_mismatch', () => guard.receive(forged));
});

test('schema rejection and snapshot mutation cannot change lifecycle state', () => {
  const guard = session();
  start(guard);
  expectError('invalid_message', () => guard.receive(response('response.delta', 1.5)));
  expectError('invalid_message', () => guard.receive({ ...response(), protocol: 'legacy.v2' }));
  const snapshot = guard.getTurn('turn-1');
  snapshot.status = 'completed';
  snapshot.speech.push({ sentenceId: 'forged' });
  assert.equal(guard.getTurn('turn-1').status, 'active');
  assert.deepEqual(guard.getTurn('turn-1').speech, []);
  assert.equal(guard.receive(response()).kind, 'accepted');
});
