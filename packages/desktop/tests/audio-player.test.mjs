import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTask } from 'node:timers/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  stdin: { contents: `export { SpeechPlayer } from './src/renderer/audio/speech-player.ts'; export { MicrophoneCapture } from './src/renderer/audio/microphone.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
});
const { SpeechPlayer, MicrophoneCapture } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await nextTask(); }
  assert.fail('Expected asynchronous state was not reached');
}
async function settle() { for (let i = 0; i < 4; i++) await nextTask(); }
const decoded = { length: 4800, duration: 0.1 };
const packet = (id, size = 16) => ({ kind: 'audio', playbackId: id, sentence: 'synthetic lifecycle fixture', data: new Uint8Array(size) });

class Context {
  state = 'running'; destination = {}; sources = []; decodedCalls = 0; closed = 0;
  constructor(decode = async () => decoded) { this.decode = decode; }
  async resume() { this.state = 'running'; }
  decodeAudioData(bytes) { this.decodedCalls++; return this.decode(bytes); }
  createBufferSource() {
    const source = {
      onended: null, started: false, stopped: 0, disconnected: false,
      connect() {}, start() { this.started = true; },
      stop() { this.stopped++; queueMicrotask(() => this.onended?.()); },
      end() { this.onended?.(); }, disconnect() { this.disconnected = true; },
    };
    this.sources.push(source);
    return source;
  }
  createAnalyser() {
    return { frequencyBinCount: 128, connect() {}, disconnect() {}, getByteTimeDomainData(samples) { samples.fill(160); } };
  }
  async close() { this.closed++; this.state = 'closed'; }
}
function playback(t, context = new Context(), acknowledge = async () => ({ ok: true })) {
  const reports = [], levels = [], errors = [];
  const player = new SpeechPlayer({ reportPlayback: async report => { reports.push({ ...report }); return acknowledge(report); } },
    (level, speaking) => levels.push({ level, speaking }), () => errors.push('error'), () => context);
  t.after(() => player.dispose());
  return { player, context, reports, levels, errors };
}

test('playback completes only on AudioBufferSource ended, after actual source start', async t => {
  const { player, context, reports, levels } = playback(t);
  player.accept(packet('current'));
  await until(() => reports.some(report => report.state === 'playing'));
  assert.equal(context.sources[0].started, true);
  assert.equal(reports.some(report => report.state === 'completed'), false);
  context.sources[0].end();
  await until(() => reports.some(report => report.state === 'completed'));
  await settle();
  assert.deepEqual(reports.map(report => report.state), ['queued', 'playing', 'completed']);
  assert.deepEqual(levels.at(-1), { level: 0, speaking: false });
});

test('cancel during decode cannot start old audio or clear a newer intent mouth state', async t => {
  const oldDecode = deferred();
  let call = 0;
  const context = new Context(() => ++call === 1 ? oldDecode.promise : Promise.resolve(decoded));
  const { player, reports, levels } = playback(t, context);
  player.accept(packet('old'));
  await until(() => context.decodedCalls === 1);
  player.reset();
  player.accept(packet('new'));
  await until(() => reports.some(report => report.playbackId === 'new' && report.state === 'playing'));
  await settle();
  oldDecode.resolve(decoded);
  await settle();
  assert.deepEqual(reports.filter(report => report.playbackId === 'old').map(report => report.state), ['queued']);
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].stopped, 0);
  assert.equal(levels.at(-1).speaking, true);
  context.sources[0].end();
});

test('decode failure reports failure without starting or completing audio', async t => {
  const { player, context, reports, errors } = playback(t, new Context(async () => { throw new Error('synthetic decode failure'); }));
  player.accept(packet('bad-decode'));
  await until(() => errors.length === 1);
  assert.equal(context.sources.length, 0);
  assert.deepEqual(reports.map(report => report.state), ['queued', 'failed']);
});

test('a refused playing acknowledgement stops the source and never reports completion', async t => {
  const { player, context, reports, levels } = playback(t, new Context(), async report => ({ ok: report.state !== 'playing', code: 'invalid_request' }));
  player.accept(packet('rejected-playing'));
  await until(() => context.sources[0]?.stopped > 0);
  await settle();
  assert.equal(reports.some(report => report.state === 'completed'), false);
  assert.equal(levels.some(level => level.speaking), false);
  assert.equal(context.sources[0].disconnected, true);
});

test('an oversized discarded packet releases its byte reservation for subsequent valid playback', async t => {
  const { player, context, reports } = playback(t);
  player.accept(packet('too-large', 9 * 1024 * 1024));
  await until(() => reports.some(report => report.playbackId === 'too-large' && report.state === 'failed'));
  player.accept(packet('valid-after-rejection'));
  await settle();
  assert.equal(context.sources.length, 1, 'discarded bytes must not consume the next packet budget');
  assert.equal(reports.some(report => report.playbackId === 'valid-after-rejection' && report.state === 'failed'), false);
  context.sources[0].end();
});

test('refused queued acknowledgements do not consume subsequent playback capacity', async t => {
  const { player, context, reports } = playback(t, new Context(), async report => ({ ok: !report.playbackId.startsWith('refused'), code: 'invalid_request' }));
  for (let i = 0; i < 3; i++) {
    player.accept(packet('refused-' + i, 3 * 1024 * 1024));
    await until(() => reports.some(report => report.playbackId === 'refused-' + i));
  }
  player.accept(packet('accepted'));
  await settle();
  assert.equal(context.sources.length, 1, 'rejected queued ACKs must release their reservations');
  context.sources[0].end();
});

test('completion acknowledgement rejection is surfaced and does not leave a connected audio node', async t => {
  const { player, context, reports, errors } = playback(t, new Context(), async report => {
    if (report.state === 'completed') throw new Error('synthetic IPC rejection');
    return { ok: true };
  });
  player.accept(packet('ack-error'));
  await until(() => reports.some(report => report.state === 'playing'));
  context.sources[0].end();
  await until(() => errors.length === 1);
  await settle();
  assert.equal(reports.at(-1).state, 'failed');
  assert.equal(context.sources[0].disconnected, true);
});

test('a thrown queued acknowledgement releases capacity before a subsequent valid packet', async t => {
  const { player, context } = playback(t, new Context(), async report => {
    if (report.playbackId.startsWith('ipc-error')) throw new Error('synthetic IPC rejection');
    return { ok: true };
  });
  for (let i = 0; i < 3; i++) { player.accept(packet('ipc-error-' + i, 3 * 1024 * 1024)); await settle(); }
  player.accept(packet('valid-after-ipc-error'));
  await settle();
  assert.equal(context.sources.length, 1, 'IPC rejection must release the reserved bytes');
  context.sources[0].end();
});

test('a late failed acknowledgement cannot report an old error or alter new intent capacity', async t => {
  const failedAck = deferred();
  const { player, context, reports, errors } = playback(t, new Context(), async report => {
    if (report.playbackId === 'old-oversized' && report.state === 'failed') return failedAck.promise;
    return { ok: true };
  });
  player.accept(packet('old-oversized', 9 * 1024 * 1024));
  await until(() => reports.some(report => report.playbackId === 'old-oversized' && report.state === 'failed'));
  player.reset();
  player.accept(packet('new-active', 4 * 1024 * 1024));
  await until(() => reports.some(report => report.playbackId === 'new-active' && report.state === 'playing'));
  player.accept(packet('new-waiting', 4 * 1024 * 1024));
  await settle();
  failedAck.resolve({ ok: true });
  await settle();
  assert.equal(errors.length, 0, 'old failed ACK must not surface an error in the new intent');
  player.accept(packet('new-overflow', 1024 * 1024));
  await settle();
  assert.equal(reports.some(report => report.playbackId === 'new-overflow' && report.state === 'failed'), true);
  assert.equal(context.sources[0].stopped, 0);
});

test('a late decode-failure acknowledgement cannot surface an error during a newer playback', async t => {
  const failedAck = deferred();
  let decodeCalls = 0;
  const context = new Context(async () => {
    if (++decodeCalls === 1) throw new Error('synthetic old decode failure');
    return decoded;
  });
  const { player, reports, errors, levels } = playback(t, context, async report => {
    if (report.playbackId === 'old-decode' && report.state === 'failed') return failedAck.promise;
    return { ok: true };
  });
  player.accept(packet('old-decode'));
  await until(() => reports.some(report => report.playbackId === 'old-decode' && report.state === 'failed'));
  player.reset();
  player.accept(packet('new-playing'));
  await until(() => reports.some(report => report.playbackId === 'new-playing' && report.state === 'playing'));
  failedAck.resolve({ ok: true });
  await settle();
  assert.deepEqual(errors, [], 'an old failure must not appear after cancellation and a new playback');
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].stopped, 0);
  assert.equal(levels.at(-1).speaking, true);
  assert.deepEqual(reports.filter(report => report.playbackId === 'old-decode').map(report => report.state), ['queued', 'failed']);
  context.sources[0].end();
  await until(() => reports.some(report => report.playbackId === 'new-playing' && report.state === 'completed'));
});

function media(t, getUserMedia) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  const recorders = [];
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; ondataavailable = null; onstop = null; onerror = null;
    constructor(stream) { this.stream = stream; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
    data() { this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) }); }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
    if (originalRecorder) Object.defineProperty(globalThis, 'MediaRecorder', originalRecorder); else delete globalThis.MediaRecorder;
  });
  return recorders;
}
function stream() {
  const track = { stopped: 0, stop() { this.stopped++; } };
  return { getTracks: () => [track], track };
}
function microphone(t, overrides = {}) {
  const states = [], texts = [], errors = [];
  const capture = new MicrophoneCapture({ armMicrophone: async () => ({ ok: true }), cancelTranscription: async () => ({ ok: true }), transcribeAudio: async () => ({ ok: true, text: 'fixture' }), ...overrides },
    state => states.push(state), async text => { texts.push(text); }, message => errors.push(message));
  t.after(() => capture.cancel());
  return { capture, states, texts, errors };
}

test('cancel while arming prevents a later microphone permission request', async t => {
  const armed = deferred();
  let requests = 0;
  media(t, async () => { requests++; return stream(); });
  const { capture, states } = microphone(t, { armMicrophone: () => armed.promise });
  const starting = capture.start();
  capture.cancel();
  armed.resolve({ ok: true });
  await starting;
  assert.equal(requests, 0, 'cancel must be rechecked after the arm acknowledgement');
  assert.equal(states.at(-1), 'idle');
});

test('late microphone permission completion stops only its old tracks, preserving a new capture', async t => {
  const firstPermission = deferred(), old = stream(), current = stream();
  let request = 0;
  media(t, () => ++request === 1 ? firstPermission.promise : Promise.resolve(current));
  const { capture, states } = microphone(t);
  const firstStart = capture.start();
  await until(() => request === 1);
  capture.cancel();
  await capture.start();
  firstPermission.resolve(old);
  await firstStart;
  assert.equal(old.track.stopped, 1);
  assert.equal(current.track.stopped, 0);
  assert.equal(states.at(-1), 'recording');
});

test('cancelled transcription cannot submit late text or reset a newer recording state', async t => {
  const result = deferred();
  let transcribing = false;
  const recorders = media(t, async () => stream());
  const { capture, states, texts } = microphone(t, { transcribeAudio: () => { transcribing = true; return result.promise; } });
  await capture.start();
  recorders[0].data();
  capture.finish();
  await until(() => transcribing);
  capture.cancel();
  await capture.start();
  result.resolve({ ok: true, text: 'late cancelled text' });
  await settle();
  assert.deepEqual(texts, []);
  assert.equal(states.at(-1), 'recording');
});
