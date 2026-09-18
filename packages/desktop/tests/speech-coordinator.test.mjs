import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseMessage, SessionLifecycle } from '@kirian/contracts';
import { SpeechCoordinator } from '../dist-electron/main/speech-coordinator.js';
import { createTtsChunker } from '../dist-electron/vendor/airi-audio/tts-chunker.js';

const scope = { instance_id: 'instance', mode: 'personal', principal_id: 'owner',
  session_id: 'session', connection_id: 'connection', connection_epoch: 0 };
const model = { provider_id: 'ollama', model_id: 'model-a', endpoint_id: 'local' };
const speechModel = { provider_id: 'local-tts', model_id: 'configured-voice', endpoint_id: 'voice' };
const turnId = 'turn-1', intentId = 'intent-1';

function wire(kind, payload, options = {}) {
  return parseMessage({ protocol: 'kirian.rearchitecture.v1', scope, message_id: randomUUID(),
    request_id: randomUUID(), turn_id: turnId, intent_id: intentId, sequence: 0, kind, payload, ...options });
}
function harness() {
  const guard = new SessionLifecycle(scope), sent = [], audio = [], states = [];
  guard.receive(wire('session.ready', { client_kind: 'electron', resume: 'new_session', capabilities: ['text', 'audio_output'] },
    { turn_id: null, intent_id: null }));
  guard.receive(wire('input.finished', { input_id: 'input-1', kind: 'text', text: '질문' }));
  guard.receive(wire('turn.start', { selection: { model, source: 'initial_local' }, context: [], speech: true },
    { request_id: 'llm-1' }));
  const coordinator = new SpeechCoordinator(messages => {
    for (const message of messages) {
      assert.equal(guard.receive(parseMessage(message)).kind, 'accepted');
      sent.push(structuredClone(message));
    }
    return { ok: true };
  }, event => audio.push(event), state => states.push(state));
  coordinator.begin(scope, turnId, intentId, speechModel);
  let responseSequence = 0;
  const receive = message => {
    const result = guard.receive(message);
    if (result.kind === 'accepted') coordinator.receive(message);
    return result;
  };
  return { guard, sent, audio, states, coordinator, receive,
    requests: () => sent.filter(message => message.kind === 'speech.request'),
    packets: () => audio.filter(event => event.kind === 'audio'),
    delta: text => receive(wire('response.delta', { text, actual_model: model }, { request_id: 'llm-1', sequence: ++responseSequence })),
    complete: () => receive(wire('response.completed', { actual_model: model }, { request_id: 'llm-1', sequence: ++responseSequence })),
    chunk: (request, data = Buffer.from('RIFF'), options = {}) => receive(wire('speech.chunk', {
      sentence_id: request.payload.sentence_id, sentence_index: request.payload.sentence_index,
      codec: 'wav', sample_rate_hz: 24000, audio_base64: data.toString('base64'), final: true,
    }, { request_id: request.request_id, sequence: 1, ...options })),
  };
}

test('speech submits at most two jobs, orders reversed synthesis, and closes submission exactly once', () => {
  const h = harness();
  const text = '첫 문장. 두 번째 문장. 세 번째 문장.';
  h.delta(text); h.complete();
  assert.equal(h.requests().length, 2);
  assert.equal(h.sent.some(message => message.kind === 'speech.finished'), false);
  h.chunk(h.requests()[1], Buffer.from('SECOND'));
  assert.equal(h.packets().length, 0, 'later sentence must wait for the first audio');
  assert.equal(h.requests().length, 3, 'finished synthesis frees one bounded request slot');
  assert.equal(h.sent.filter(message => message.kind === 'speech.finished').length, 1);
  assert.deepEqual(h.sent.find(message => message.kind === 'speech.finished').payload, { sentence_count: 3 });
  h.chunk(h.requests()[0], Buffer.from('FIRST'));
  h.chunk(h.requests()[2], Buffer.from('THIRD'));
  assert.deepEqual(h.packets().map(packet => Buffer.from(packet.data).toString()), ['FIRST', 'SECOND', 'THIRD']);
  assert.equal(h.requests().map(request => request.payload.text).join(''), text);
  for (const request of h.requests()) {
    assert.deepEqual(request.payload.model, speechModel);
    assert.equal(request.turn_id, turnId); assert.equal(request.intent_id, intentId);
  }
  const finished = h.sent.find(message => message.kind === 'speech.finished');
  assert.equal(finished.sequence, 0);
  assert(!h.requests().some(request => request.request_id === finished.request_id));
});

test('renderer reports cannot invent IDs or skip playback stages; valid reports complete the shared lifecycle', () => {
  const h = harness(); h.delta('안녕하세요.'); h.complete(); h.chunk(h.requests()[0]);
  const packet = h.packets()[0];
  for (const report of [null, [], { playbackId: 'foreign', state: 'queued' },
    { playbackId: packet.playbackId, state: 'completed' },
    { playbackId: packet.playbackId, state: 'queued', request_id: 'forged' }]) {
    assert.deepEqual(h.coordinator.report(report), { ok: false, code: 'invalid_request' });
  }
  for (const state of ['queued', 'playing', 'completed']) {
    assert.deepEqual(h.coordinator.report({ playbackId: packet.playbackId, state }), { ok: true });
  }
  const reports = h.sent.filter(message => message.kind === 'playback.state');
  assert.deepEqual(reports.map(message => message.sequence), [0, 1, 2]);
  assert.equal(new Set(reports.map(message => message.request_id)).size, 1);
  assert.equal(reports[0].payload.sentence_id, h.requests()[0].payload.sentence_id);
  assert(reports.every(message => message.turn_id === turnId && message.intent_id === intentId));
  assert.equal(h.receive(wire('turn.ended', { status: 'completed' })).kind, 'accepted');
  assert.equal(h.guard.getTurn(turnId).status, 'completed');
  assert.equal(h.audio.at(-1).kind, 'reset');
  assert.deepEqual(h.coordinator.report({ playbackId: packet.playbackId, state: 'queued' }), { ok: false, code: 'invalid_request' });
});

test('same-turn foreign intent, replayed chunks, and stale renderer reports cannot create extra playback', () => {
  const h = harness(); h.delta('원래 문장.'); h.complete();
  const request = h.requests()[0];
  assert.throws(() => h.chunk(request, Buffer.from('BAD'), { intent_id: 'foreign-intent' }), /intent_mismatch/);
  assert.equal(h.packets().length, 0);
  const packet = wire('speech.chunk', { sentence_id: request.payload.sentence_id, sentence_index: 0,
    codec: 'wav', sample_rate_hz: 24000, audio_base64: Buffer.from('GOOD').toString('base64'), final: true },
    { request_id: request.request_id, sequence: 1 });
  h.receive(packet); assert.equal(h.receive(structuredClone(packet)).kind, 'duplicate');
  assert.equal(h.packets().length, 1);
  const playbackId = h.packets()[0].playbackId;
  h.guard.receive(wire('turn.cancel', { reason: 'user' })); h.coordinator.reset();
  assert.equal(h.receive({ ...packet, message_id: randomUUID() }).reason, 'terminal_turn');
  assert.equal(h.packets().length, 1);
  assert.deepEqual(h.coordinator.report({ playbackId, state: 'queued' }), { ok: false, code: 'invalid_request' });
  assert.equal(h.audio.at(-1).kind, 'reset');
});

test('playback failure is reported without completion and a failed terminal resets all audio', () => {
  const h = harness(); h.delta('실패할 재생.'); h.complete(); h.chunk(h.requests()[0]);
  const { playbackId } = h.packets()[0];
  assert.deepEqual(h.coordinator.report({ playbackId, state: 'queued' }), { ok: true });
  assert.deepEqual(h.coordinator.report({ playbackId, state: 'failed' }), { ok: true });
  assert.equal(h.states.at(-1).error, 'playback_failed');
  assert.equal(h.sent.some(message => message.kind === 'playback.state' && message.payload.state === 'completed'), false);
  h.receive(wire('turn.ended', { status: 'failed', error_code: 'playback_failed' }));
  assert.equal(h.guard.getTurn(turnId).status, 'failed');
  assert.equal(h.audio.at(-1).kind, 'reset');
  assert.equal(h.states.at(-1).phase, 'error');
  assert.deepEqual(h.coordinator.report({ playbackId, state: 'completed' }), { ok: false, code: 'invalid_request' });
});

test('multiple wire audio chunks are assembled once and sentence byte limits fail before delivery', () => {
  const h = harness(); h.delta('합칠 음성.'); h.complete();
  const request = h.requests()[0];
  const receiveChunk = (data, sequence, final) => h.receive(wire('speech.chunk', {
    sentence_id: request.payload.sentence_id, sentence_index: 0, codec: 'wav', sample_rate_hz: 24000,
    audio_base64: data.toString('base64'), final,
  }, { request_id: request.request_id, sequence }));
  receiveChunk(Buffer.from('RIFF'), 1, false); assert.equal(h.packets().length, 0);
  receiveChunk(Buffer.from('DATA'), 2, true); assert.equal(Buffer.from(h.packets()[0].data).toString(), 'RIFFDATA');
  const limited = harness(); limited.delta('상한 검증.'); limited.complete();
  const limitRequest = limited.requests()[0], oneMiB = Buffer.alloc(1024 * 1024);
  for (let sequence = 1; sequence <= 4; sequence++) {
    limited.chunk(limitRequest, oneMiB, { sequence, payload: { sentence_id: limitRequest.payload.sentence_id,
      sentence_index: 0, codec: 'wav', sample_rate_hz: 24000, audio_base64: oneMiB.toString('base64'), final: false } });
  }
  assert.throws(() => limited.chunk(limitRequest, Buffer.from('OVER'), { sequence: 5 }), /speech_audio_limit/);
  assert.equal(limited.packets().length, 0);
});

test('speech never submits more than the 128-sentence completion contract permits', () => {
  const h = harness(); h.delta('문장. '.repeat(129)); h.complete();
  let processed = 0;
  assert.throws(() => {
    while (processed < h.requests().length) h.chunk(h.requests()[processed++]);
  }, /speech_sentence_limit/);
  assert.equal(h.requests().length, 128);
  assert.equal(h.sent.some(message => message.kind === 'speech.finished'), false);
});

test('punctuation and emoji-only responses finish with zero synthesis jobs', () => {
  for (const text of [')', '🙂', '...🙂)']) {
    const h = harness(); h.delta(text); h.complete();
    assert.deepEqual(h.requests(), [], 'decorations alone must not reach a TTS provider');
    const finished = h.sent.filter(message => message.kind === 'speech.finished');
    assert.equal(finished.length, 1);
    assert.deepEqual(finished[0].payload, { sentence_count: 0 });
    assert.equal(h.receive(wire('turn.ended', { status: 'completed' })).kind, 'accepted');
    assert.equal(h.guard.getTurn(turnId).status, 'completed');
  }
});

test('a streamed decoration chunk waits for the next spoken body and preserves the response prefix', () => {
  const h = harness(), before = '안녕. )🙂! ', after = '다음 본문.';
  h.delta(before);
  assert.equal(h.requests().length, 1);
  assert.equal(h.requests()[0].payload.text, '안녕. ');
  h.delta(after);
  assert.equal(h.requests().length, 1, 'a separately emitted decoration must wait for the following body');
  h.complete();
  assert.equal(h.requests().length, 2);
  assert.equal(h.requests()[1].payload.text, ')🙂! 다음 본문.');
  assert.equal(h.requests().map(request => request.payload.text).join(''), before + after);
  assert.deepEqual(h.sent.find(message => message.kind === 'speech.finished').payload, { sentence_count: 2 });
});

test('a closing parenthesis after a spoken sentence does not become a failing standalone synthesis job', () => {
  const h = harness(); h.delta('(반갑습니다.)'); h.complete();
  assert.deepEqual(h.requests().map(request => request.payload.text), ['(반갑습니다.']);
  assert.deepEqual(h.sent.find(message => message.kind === 'speech.finished').payload, { sentence_count: 1 });
  h.chunk(h.requests()[0]);
  for (const state of ['queued', 'playing', 'completed']) {
    assert.deepEqual(h.coordinator.report({ playbackId: h.packets()[0].playbackId, state }), { ok: true });
  }
  assert.equal(h.receive(wire('turn.ended', { status: 'completed' })).kind, 'accepted');
});

test('compatibility symbols that normalize to letters or numbers remain spoken in their original form', () => {
  for (const text of ['ⓐ', '①', '㍿', '℉']) {
    const h = harness(); h.delta(text); h.complete();
    assert.deepEqual(h.requests().map(request => request.payload.text), [text]);
    assert.deepEqual(h.sent.find(message => message.kind === 'speech.finished').payload, { sentence_count: 1 });
  }
});

test('AIRI chunker is lossless and preserves grapheme boundaries across every UTF-16 split', () => {
  const samples = ['안녕하세요. 다음 문장!  마지막 공백  ', '한글 ᄒ\u0301 👩🏽‍🚀 👨‍👩‍👧‍👦 🇰🇷 e\u0301 ❤️ 끝.',
    '값 3.14159와 1,234.50... 그대로… 유지⋯', 'const x = 3.14; <T> [기록] **원문**\u200B\u2063\n\t끝'];
  for (const text of samples) {
    const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(item => item.index));
    boundaries.add(text.length);
    for (const maxCharacters of [1, 7, 300]) for (let split = 0; split <= text.length; split++) {
      const c = createTtsChunker({ maxCharacters });
      const chunks = [...c.push(text.slice(0, split)), ...c.push(text.slice(split)), ...c.finish()];
      assert.equal(chunks.join(''), text);
      let end = 0;
      for (const chunk of chunks) { end += chunk.length; assert(boundaries.has(end), 'partial grapheme emitted'); }
    }
  }
});

test('AIRI chunker retains decimal lookahead, original ellipsis, initial latency boost, and bounded flush', () => {
  const decimal = createTtsChunker(); assert.deepEqual(decimal.push('3.'), []);
  assert.deepEqual(decimal.push('14'), []); assert.deepEqual(decimal.finish(), ['3.14']);
  const ellipsis = createTtsChunker(); assert.deepEqual(ellipsis.push('잠깐..'), []);
  assert.deepEqual(ellipsis.push('.'), []); assert.deepEqual(ellipsis.finish(), ['잠깐...']);
  const boost = createTtsChunker();
  const early = boost.push('첫 항목, 다음 항목, 셋째 항목, 이어집니다');
  assert.equal(early.length, 2); assert.equal([...early, ...boost.finish()].join(''), '첫 항목, 다음 항목, 셋째 항목, 이어집니다');
  const bounded = createTtsChunker(), text = '가'.repeat(901);
  const chunks = [...bounded.push(text), ...bounded.finish()];
  assert.equal(chunks.join(''), text); assert(chunks.every(chunk => chunk.length <= 300));
  assert.deepEqual(bounded.finish(), []); assert.throws(() => bounded.push('late'));
  for (const maxCharacters of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => createTtsChunker({ maxCharacters }));
});

test('character-limit flush moves before a normal decimal rather than splitting its pronunciation', () => {
  const text = '가'.repeat(298) + '3.14 마무리.';
  const c = createTtsChunker();
  const chunks = [...c.push(text), ...c.finish()];
  assert.equal(chunks.join(''), text);
  assert(chunks.some(chunk => chunk.includes('3.14')), 'one ordinary decimal must stay in one spoken sentence');
  assert(chunks.every(chunk => chunk.length <= 300));
});
