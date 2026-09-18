import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  BrainConnection,
  validateCatalog,
  validateConnection,
} from '../dist-electron/main/brain-connection.js';
import { SessionController } from '../dist-electron/main/session-controller.js';
import { BrainLifecycle } from '../dist-electron/main/brain-lifecycle.js';
import { DesktopRuntime } from '../dist-electron/main/runtime/desktop-runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = 'a'.repeat(48);
const identity = {
  instance_id: 'instance',
  mode: 'personal',
  principal_id: 'owner',
};
const model = {
  provider_id: 'ollama',
  model_id: 'model-a',
  endpoint_id: 'local',
};
const second = {
  provider_id: 'openai',
  model_id: 'model-b',
  endpoint_id: 'api',
};
const catalog = {
  identity,
  models: [
    { model, label: 'Local' },
    { model: second, label: 'API' },
  ],
  default_selection: { model, source: 'initial_local' },
};
async function fixture(
  t,
  { config = catalog, onMessage, onHttp, readyIdentity = identity, echo = true } = {}
) {
  const received = [];
  const sockets = [];
  const scopes = [];
  const headers = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    if (request.headers.authorization !== 'Bearer ' + token) {
      response.writeHead(401).end();
      return;
    }
    if (onHttp?.(request, response)) return;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(config));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== 'Bearer ' + token) {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(request, socket, head, (connection) => {
      sockets.push(connection);
      const old = new URL(request.url, 'http://127.0.0.1').searchParams.get(
        'session_id'
      );
      const scope = {
        ...readyIdentity,
        session_id: old ?? randomUUID(),
        connection_id: randomUUID(),
        connection_epoch: old ? scopes.length : 0,
      };
      scopes.push(scope);
      connection.send(
        JSON.stringify({
          protocol: 'kirian.rearchitecture.v1',
          message_id: randomUUID(),
          request_id: randomUUID(),
          kind: 'session.ready',
          scope,
          turn_id: null,
          intent_id: null,
          sequence: 0,
          payload: {
            client_kind: 'electron',
            resume: old ? 'turns_cancelled' : 'new_session',
            capabilities: ['text', ...(config.speech ? ['audio_output'] : [])],
          },
        })
      );
      connection.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        received.push(message);
        if (echo) connection.send(raw.toString());
        onMessage?.(message, connection, scope);
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    ws.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    received,
    sockets,
    scopes,
    headers,
  };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Condition did not become true');
}
function controller(t, limits, onAudio) {
  const session = new SessionController(limits);
  const brain = new BrainConnection(session, undefined, onAudio);
  t.after(() => brain.dispose());
  return { brain, session };
}
function response(start, kind, payload, sequence = 1) {
  return { ...start, kind, message_id: randomUUID(), sequence, payload };
}
test('connection settings reject unsafe URLs, malformed tokens and hidden extra fields', () => {
  assert.equal(
    validateConnection({ url: 'http://127.0.0.1:8766', token }).url,
    'http://127.0.0.1:8766/'
  );
  assert.equal(
    validateConnection({ url: 'https://brain.example/private', token }).url,
    'https://brain.example/private/'
  );
  for (const url of [
    'http://192.168.0.4',
    'http://example.com',
    'file:///tmp',
    'https://u:p@example.com',
    'https://example.com/?token=x',
  ]) {
    assert.throws(() => validateConnection({ url, token }));
  }
  for (const value of [
    { url: 'http://localhost', token: token + '\n' },
    { url: 'http://localhost', token: 'short' },
    { url: 'http://localhost', token, scope: identity },
  ])
    assert.throws(() => validateConnection(value));
});
test('bootstrap is bounded, strictly shaped and contains only an approved default', () => {
  assert.deepEqual(validateCatalog(catalog), catalog);
  for (const value of [
    { ...catalog, token },
    { ...catalog, models: [] },
    { ...catalog, models: [...catalog.models, catalog.models[0]] },
    { ...catalog, identity: { ...identity, mode: 'public_demo' } },
    {
      ...catalog,
      default_selection: {
        model: { ...model, model_id: 'unknown' },
        source: 'initial_local',
      },
    },
  ]) {
    assert.throws(() => validateCatalog(value));
  }
});
test('authenticated stream uses configured model, deduplicates echoes and marks actual completion', async (t) => {
  const fixtureServer = await fixture(t, {
    onMessage: (start, socket) => {
      if (start.kind !== 'turn.start') return;
      const actual_model = start.payload.selection.model;
      socket.send(
        JSON.stringify(
          response(start, 'response.delta', {
            text: '실제 transport 표본',
            actual_model,
          })
        )
      );
      socket.send(
        JSON.stringify(
          response(start, 'response.completed', { actual_model }, 2)
        )
      );
      socket.send(
        JSON.stringify({
          ...response(start, 'turn.ended', { status: 'completed' }, 0),
          request_id: randomUUID(),
        })
      );
    },
  });
  const { brain, session } = controller(t);
  assert.deepEqual(await brain.connect({ url: fixtureServer.url, token }), {
    ok: true,
  });
  assert.equal(brain.snapshot().phase, 'ready');
  assert.equal(brain.snapshot().speech.available, false);
  assert.equal(brain.snapshot().speech.enabled, false);
  assert.equal(JSON.stringify(brain.snapshot()).includes(token), false);
  assert.deepEqual(brain.sendText('안녕'), { ok: true });
  assert.deepEqual(brain.sendText('동시 요청'), { ok: false, code: 'busy' });
  await waitFor(() => session.snapshot().messages[1]?.status === 'completed');
  assert.deepEqual(
    session.snapshot().messages.map((item) => item.text),
    ['안녕', '실제 transport 표본']
  );
  assert.equal(session.snapshot().actualModel.modelId, 'model-a');
  assert.equal(fixtureServer.received.find(item => item.kind === 'turn.start').payload.speech, undefined);
  assert.equal(fixtureServer.received.some(item => item.kind === 'speech.request' || item.kind === 'speech.finished'), false);
  const api = brain.snapshot().models[1];
  assert.deepEqual(brain.selectModel(api.id), { ok: true });
  brain.sendText('API 선택 표본');
  await waitFor(
    () =>
      session.snapshot().messages.length === 4 &&
      session.snapshot().messages[3].status === 'completed'
  );
  assert.deepEqual(
    fixtureServer.received
      .filter((item) => item.kind === 'turn.start')
      .map((item) => item.payload.selection.source),
    ['initial_local', 'conversation']
  );
  assert.equal(session.snapshot().actualModel.modelId, 'model-b');
  assert.ok(
    fixtureServer.headers.every(
      (header) => header.authorization === 'Bearer ' + token
    )
  );
});
test('cancel immediately tombstones a turn and ignores the old provider result', async (t) => {
  let start;
  const f = await fixture(t, {
    onMessage: (message) => {
      if (message.kind === 'turn.start') start = message;
    },
  });
  const { brain, session } = controller(t);
  await brain.connect({ url: f.url, token });
  brain.sendText('취소할 질문');
  await waitFor(() => !!start);
  assert.deepEqual(brain.cancelTurn(), { ok: true });
  assert.equal(session.snapshot().activeTurnId, null);
  f.sockets[0].send(
    JSON.stringify(
      response(start, 'response.delta', {
        text: '늦은 결과',
        actual_model: model,
      })
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(session.snapshot().messages[1].status, 'cancelled');
  assert.equal(session.snapshot().messages[1].text, '');
});
test('reconnect cancels pending turn, preserves bounded view and never resends request', async (t) => {
  const f = await fixture(t);
  const { brain, session } = controller(t);
  await brain.connect({ url: f.url, token });
  brain.sendText('다시 보내면 안 됨');
  await waitFor(() => f.received.length === 2);
  assert.deepEqual(await brain.reconnect(), { ok: true });
  assert.equal(f.scopes[1].session_id, f.scopes[0].session_id);
  assert.ok(f.scopes[1].connection_epoch > f.scopes[0].connection_epoch);
  assert.equal(session.snapshot().messages[1].status, 'cancelled');
  assert.equal(f.received.length, 2);
  assert.equal(session.snapshot().actualModel, null);
});
test('failed turn safe error code reaches the view without inventing response content', async (t) => {
  const f = await fixture(t, {
    onMessage: (message, socket) => {
      if (message.kind === 'turn.start')
        socket.send(
          JSON.stringify({
            ...response(
              message,
              'turn.ended',
              { status: 'failed', error_code: 'provider_unavailable' },
              0
            ),
            request_id: randomUUID(),
          })
        );
    },
  });
  const { brain, session } = controller(t);
  await brain.connect({ url: f.url, token });
  brain.sendText('질문');
  await waitFor(() => session.snapshot().messages[1]?.status === 'failed');
  assert.equal(
    session.snapshot().messages[1].errorCode,
    'provider_unavailable'
  );
  assert.equal(session.snapshot().messages[1].text, '');
});
test('authenticated readiness with mismatched identity fails the connection', async (t) => {
  const wrong = await fixture(t, {
    readyIdentity: { ...identity, principal_id: 'stranger' },
  });
  const { brain } = controller(t);
  assert.deepEqual(await brain.connect({ url: wrong.url, token }), {
    ok: false,
    code: 'protocol_error',
  });
  assert.equal(brain.snapshot().phase, 'error');
});
test('bad authorization never opens a session or exposes credentials in view', async (t) => {
  const f = await fixture(t);
  const { brain } = controller(t);
  assert.deepEqual(await brain.connect({ url: f.url, token: 'b'.repeat(48) }), {
    ok: false,
    code: 'auth_failed',
  });
  assert.equal(f.sockets.length, 0);
  assert.equal(
    JSON.stringify(brain.snapshot()).includes('b'.repeat(48)),
    false
  );
});
test('redirects do not forward the authorization token to another server', async (t) => {
  let leaked = false;
  const destination = createServer((request, response) => {
    leaked = !!request.headers.authorization;
    response.end('{}');
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((_request, response) =>
    response
      .writeHead(302, {
        location: 'http://127.0.0.1:' + destination.address().port,
      })
      .end()
  );
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => redirect.close(resolve)),
      new Promise((resolve) => destination.close(resolve)),
    ]);
  });
  const { brain } = controller(t);
  assert.deepEqual(
    await brain.connect({
      url: 'http://127.0.0.1:' + redirect.address().port,
      token,
    }),
    { ok: false, code: 'connection_failed' }
  );
  assert.equal(leaked, false);
});

test('ready-message exhaustion recovers through a fresh explicit reconnect', async (t) => {
  const f = await fixture(t);
  const { brain, session } = controller(t, { maxEvents: 1 });
  assert.deepEqual(await brain.connect({ url: f.url, token }), { ok: true });
  assert.equal((await brain.reconnect()).ok, false);
  await waitFor(() => f.sockets[1].readyState === 3);
  assert.equal(f.scopes[1].session_id, f.scopes[0].session_id);
  assert.equal(session.snapshot().connection.reason, 'session_limit_exceeded');
  assert.equal(
    f.sockets.length,
    2,
    'failure must not start an automatic reconnect'
  );
  assert.deepEqual(await brain.reconnect(), { ok: true });
  assert.notEqual(f.scopes[2].session_id, f.scopes[0].session_id);
  assert.equal(session.snapshot().connection.phase, 'ready');
  assert.deepEqual(
    f.received,
    [],
    'opening a fresh session must not send application requests'
  );
});

test('outbound exhaustion abandons a partially submitted turn instead of replaying it', async (t) => {
  const f = await fixture(t, { echo: false });
  const { brain, session } = controller(t, { maxEvents: 2 });
  await brain.connect({ url: f.url, token });
  assert.equal(brain.sendText('이 요청을 다시 보내면 안 됨').ok, false);
  await waitFor(() => f.sockets[0].readyState === 3);
  assert.equal(session.snapshot().connection.reason, 'session_limit_exceeded');
  const receivedBeforeReconnect = structuredClone(f.received);
  assert.equal(
    f.sockets.length,
    1,
    'send failure must not reconnect automatically'
  );
  assert.deepEqual(await brain.reconnect(), { ok: true });
  assert.notEqual(f.scopes[1].session_id, f.scopes[0].session_id);
  assert.equal(session.snapshot().activeTurnId, null);
  assert.deepEqual(session.snapshot().messages, []);
  assert.deepEqual(
    f.received,
    receivedBeforeReconnect,
    'neither the input nor start may be replayed'
  );
});

test('inbound response exhaustion permits a fresh session without resubmitting the question', async (t) => {
  const f = await fixture(t, {
    echo: false,
    onMessage: (message, socket) => {
      if (message.kind === 'turn.start')
        socket.send(
          JSON.stringify(
            response(message, 'response.delta', {
              text: '예산을 초과한 응답',
              actual_model: model,
            })
          )
        );
    },
  });
  const { brain, session } = controller(t, { maxEvents: 3 });
  await brain.connect({ url: f.url, token });
  assert.deepEqual(brain.sendText('단 한 번 보낼 질문'), { ok: true });
  await waitFor(
    () => brain.snapshot().phase === 'error' && f.sockets[0].readyState === 3
  );
  assert.deepEqual(
    f.received.map((message) => message.kind),
    ['input.finished', 'turn.start']
  );
  assert.equal(session.snapshot().connection.reason, 'session_limit_exceeded');
  assert.equal(session.snapshot().messages[1].text, '');
  assert.deepEqual(await brain.reconnect(), { ok: true });
  assert.notEqual(f.scopes[1].session_id, f.scopes[0].session_id);
  assert.equal(f.received.length, 2);
  assert.deepEqual(session.snapshot().messages, []);
});

test('backend fresh-session close reason ends the turn and reconnects without replay', async (t) => {
  const f = await fixture(t, { echo: false });
  const { brain, session } = controller(t);
  await brain.connect({ url: f.url, token });
  brain.sendText('서버 한도에서 중단될 질문');
  await waitFor(() => f.received.length === 2);
  f.sockets[0].close(1008, 'fresh_session_required');
  await waitFor(
    () => brain.snapshot().phase === 'error' && f.sockets[0].readyState === 3
  );
  assert.equal(session.snapshot().activeTurnId, null);
  assert.equal(session.snapshot().messages[1].status, 'cancelled');
  assert.equal(
    f.sockets.length,
    1,
    'backend limit must not trigger an automatic request replay'
  );
  assert.deepEqual(await brain.reconnect(), { ok: true });
  assert.notEqual(f.scopes[1].session_id, f.scopes[0].session_id);
  assert.equal(
    f.received.length,
    2,
    'previous input/start must not be replayed'
  );
  assert.deepEqual(session.snapshot().messages, []);
});

const speechModel = { provider_id: 'local-tts', model_id: 'configured-voice', endpoint_id: 'speech' };
const voiceCatalog = { ...catalog, speech: { model: speechModel, label: '내 음성 서비스' }, transcription: { label: '내 받아쓰기' } };
function speechChunk(request, text = 'RIFF') {
  return { ...request, kind: 'speech.chunk', message_id: randomUUID(), sequence: 1,
    payload: { sentence_id: request.payload.sentence_id, sentence_index: request.payload.sentence_index,
      codec: 'wav', sample_rate_hz: 24000, audio_base64: Buffer.from(text).toString('base64'), final: true } };
}

test('voice and transcription catalog entries are optional, independent, strict and returned by value', () => {
  for (const valid of [voiceCatalog, { ...catalog, speech: voiceCatalog.speech }, { ...catalog, transcription: voiceCatalog.transcription }]) {
    assert.deepEqual(validateCatalog(valid), valid);
  }
  const snapshot = validateCatalog(voiceCatalog); snapshot.speech.model.model_id = 'changed';
  assert.equal(voiceCatalog.speech.model.model_id, 'configured-voice');
  for (const extra of [
    { speech: null }, { speech: [] }, { speech: {} },
    { speech: { ...voiceCatalog.speech, label: '' } },
    { speech: { ...voiceCatalog.speech, label: 'a'.repeat(161) } },
    { speech: { ...voiceCatalog.speech, model: { ...speechModel, endpoint_id: '' } } },
    { speech: { ...voiceCatalog.speech, reference_audio: '/private.wav' } },
    { transcription: null }, { transcription: { label: '  ' } },
    { transcription: { label: 'a'.repeat(161) } }, { transcription: { label: 'ASR', token } },
  ]) assert.throws(() => validateCatalog({ ...catalog, ...extra }));
});

test('configured voice opts in to the handshake and reordered synthesis reaches renderer in sentence order', async (t) => {
  const requests = [], packets = []; let start, finished = false, reports = 0;
  const f = await fixture(t, { config: voiceCatalog, onMessage: (message, socket) => {
    if (message.kind === 'turn.start') {
      start = message;
      socket.send(JSON.stringify(response(start, 'response.delta', { text: '첫 문장. 둘 문장.', actual_model: model })));
      socket.send(JSON.stringify(response(start, 'response.completed', { actual_model: model }, 2)));
    } else if (message.kind === 'speech.request') {
      requests.push(message);
      if (requests.length === 2) {
        socket.send(JSON.stringify(speechChunk(requests[1], 'SECOND')));
        socket.send(JSON.stringify(speechChunk(requests[0], 'FIRST')));
      }
    } else if (message.kind === 'speech.finished') finished = true;
    else if (message.kind === 'playback.state' && message.payload.state === 'completed') {
      reports++;
      if (reports === 2 && finished) socket.send(JSON.stringify({
        ...response(start, 'turn.ended', { status: 'completed' }, 0), request_id: randomUUID(),
      }));
    }
  } });
  const { brain, session } = controller(t, undefined, event => packets.push(event));
  assert.deepEqual(await brain.connect({ url: f.url, token }), { ok: true });
  assert.equal(brain.snapshot().speech.enabled, true);
  assert.equal(brain.snapshot().speech.label, voiceCatalog.speech.label);
  assert.deepEqual(brain.sendText('음성 질문'), { ok: true });
  await waitFor(() => packets.filter(event => event.kind === 'audio').length === 2 && finished);
  assert.equal(start.payload.speech, true);
  assert.equal(session.snapshot().activeTurnId, start.turn_id, 'LLM completion does not finish actual speech');
  assert.equal(requests.map(request => request.payload.text).join(''), '첫 문장. 둘 문장.');
  assert(requests.every(request => JSON.stringify(request.payload.model) === JSON.stringify(speechModel)));
  const audio = packets.filter(event => event.kind === 'audio');
  assert.deepEqual(audio.map(event => Buffer.from(event.data).toString()), ['FIRST', 'SECOND']);
  assert.deepEqual(brain.reportPlayback({ playbackId: 'forged', state: 'queued' }), { ok: false, code: 'invalid_request' });
  for (const packet of audio) for (const state of ['queued', 'playing', 'completed']) {
    assert.deepEqual(brain.reportPlayback({ playbackId: packet.playbackId, state }), { ok: true });
  }
  await waitFor(() => session.snapshot().activeTurnId === null);
  for (const request of requests) {
    const playback = f.received.filter(message => message.kind === 'playback.state' && message.payload.sentence_id === request.payload.sentence_id);
    assert.deepEqual(playback.map(message => message.sequence), [0, 1, 2]);
    assert.equal(new Set(playback.map(message => message.request_id)).size, 1);
    assert(playback.every(message => message.turn_id === start.turn_id && message.intent_id === start.intent_id));
  }
  assert.equal(brain.snapshot().speech.phase, 'idle');
  assert.equal(packets.at(-1).kind, 'reset');
});

test('explicit voice disable survives same-auth reconnect and sends a legacy text-only turn', async (t) => {
  const f = await fixture(t, { config: voiceCatalog });
  const { brain } = controller(t);
  assert.deepEqual(brain.setVoiceEnabled('false'), { ok: false, code: 'invalid_request' });
  assert.deepEqual(brain.setVoiceEnabled(false), { ok: true });
  await brain.connect({ url: f.url, token }); await brain.reconnect();
  assert.equal(brain.snapshot().speech.available, true); assert.equal(brain.snapshot().speech.enabled, false);
  brain.sendText('텍스트로만'); await waitFor(() => f.received.length === 2);
  assert.equal(f.received[1].payload.speech, undefined);
  assert.deepEqual(brain.setVoiceEnabled(true), { ok: false, code: 'busy' });
  assert.equal(f.received.some(message => message.kind === 'speech.request'), false);
});

test('same-auth reconnect resets delivered audio, aborts pending transcription, and rejects old packets without replay', async (t) => {
  const events = []; let heldResponse, transcriptionClosed = false, start, request;
  const f = await fixture(t, { config: voiceCatalog,
    onHttp: (incoming, response) => {
      if (incoming.url !== '/v1/transcriptions') return false;
      assert.equal(incoming.method, 'POST'); assert.equal(incoming.headers.authorization, 'Bearer ' + token);
      assert.equal(incoming.headers['content-type'], 'audio/wav');
      incoming.resume(); heldResponse = response; response.on('close', () => { transcriptionClosed = true; });
      return true;
    },
    onMessage: (message, socket) => {
      if (message.kind === 'turn.start') {
        start = message;
        socket.send(JSON.stringify(response(start, 'response.delta', { text: '재연결 전 음성.', actual_model: model })));
        socket.send(JSON.stringify(response(start, 'response.completed', { actual_model: model }, 2)));
      } else if (message.kind === 'speech.request') { request = message; socket.send(JSON.stringify(speechChunk(message))); }
    },
  });
  const { brain, session } = controller(t, undefined, event => events.push(event));
  await brain.connect({ url: f.url, token }); brain.sendText('재연결 질문');
  await waitFor(() => events.some(event => event.kind === 'audio'));
  const oldPacket = events.find(event => event.kind === 'audio');
  const pending = brain.transcribeAudio({ data: new Uint8Array(64), contentType: 'audio/wav' });
  await waitFor(() => heldResponse);
  const beforeReconnect = f.received.length;
  assert.deepEqual(await brain.reconnect(), { ok: true });
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  await waitFor(() => transcriptionClosed);
  assert.equal(f.scopes[0].session_id, f.scopes[1].session_id);
  assert.equal(session.snapshot().activeTurnId, null);
  assert.equal(session.snapshot().messages[1].status, 'completed', 'already generated text remains complete while speech is cancelled');
  assert.equal(f.received.length, beforeReconnect, 'neither text, TTS, nor transcription may be replayed');
  assert.equal(events.at(-1).kind, 'reset');
  assert.deepEqual(brain.reportPlayback({ playbackId: oldPacket.playbackId, state: 'queued' }), { ok: false, code: 'invalid_request' });
  f.sockets[1].send(JSON.stringify(speechChunk(request, 'STALE')));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(brain.snapshot().phase, 'ready');
  assert.equal(events.filter(event => event.kind === 'audio').length, 1);
});

test('transcription has bounded input, explicit cancellation, and no late result overwrites a newer attempt', async (t) => {
  let requests = 0, held;
  const f = await fixture(t, { config: voiceCatalog, onHttp: (request, response) => {
    if (request.url !== '/v1/transcriptions') return false;
    requests++; request.resume();
    if (requests === 1) held = response;
    else response.setHeader('content-type', 'application/json').end(JSON.stringify({ text: '  새 받아쓰기  ' }));
    return true;
  } });
  const { brain } = controller(t); await brain.connect({ url: f.url, token });
  for (const value of [null, { data: 'audio', contentType: 'audio/wav' },
    { data: new Uint8Array(31), contentType: 'audio/wav' },
    { data: new Uint8Array(4 * 1024 * 1024 + 1), contentType: 'audio/wav' },
    { data: new Uint8Array(64), contentType: 'audio/mp3' },
    { data: new Uint8Array(64), contentType: 'audio/wav', token }]) {
    assert.deepEqual(await brain.transcribeAudio(value), { ok: false, code: 'invalid_request' });
  }
  assert.equal(requests, 0);
  const input = { data: new Uint8Array(64), contentType: 'audio/wav' };
  const old = brain.transcribeAudio(input); await waitFor(() => held);
  assert.deepEqual(await brain.transcribeAudio(input), { ok: false, code: 'busy' });
  assert.deepEqual(brain.cancelTranscription(), { ok: true });
  const current = brain.transcribeAudio(input);
  assert.deepEqual(await old, { ok: false, code: 'cancelled' });
  assert.deepEqual(await current, { ok: true, text: '새 받아쓰기' });
  assert.equal(requests, 2);
  assert.equal(f.received.length, 0, 'transcription alone does not submit a conversation turn');
});

test('authenticated transcription rejects malformed or oversized JSON without submitting text', async (t) => {
  const replies = [{ text: 7 }, { text: '반환값', operation: 'unexpected' }, { text: 'x'.repeat(131072) }];
  let requests = 0;
  const f = await fixture(t, { config: voiceCatalog, onHttp: (request, response) => {
    if (request.url !== '/v1/transcriptions') return false;
    request.resume(); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(replies[requests++])); return true;
  } });
  const { brain } = controller(t); await brain.connect({ url: f.url, token });
  for (const _ of replies) {
    assert.deepEqual(await brain.transcribeAudio({ data: new Uint8Array(64), contentType: 'audio/wav' }),
      { ok: false, code: 'transcription_failed' });
  }
  assert.equal(requests, 3); assert.equal(f.received.length, 0); assert.equal(brain.snapshot().phase, 'ready');
});

test('외부 Brain 수명주기는 실제 HTTP/WS에서 설정·세션을 유지하고 중복 연결과 종료 경쟁을 차단한다', {timeout:5000}, async t => {
  let hold=false,held,spawned=0;
  const f=await fixture(t,{config:voiceCatalog,onHttp:(request,response)=>{
    if(!hold||request.url!=='/v1/config')return false;
    held=response;return true;
  }});
  const {brain,session}=controller(t),directory=mkdtempSync(join(tmpdir(),'kirian-external-lifecycle-'));
  const runtime=new DesktopRuntime({directory,available:true,executable:'unused.exe',version:'test',changed:()=>{},
    connect:options=>brain.connect(options),disconnect:()=>{brain.disconnect();},
    createProcess:()=>{spawned++;throw Error('외부 연결에서 내장 프로세스 시작 금지');}});
  const lifecycle=new BrainLifecycle(brain,runtime);
  t.after(async()=>{held?.destroy();await lifecycle.shutdown();rmSync(directory,{recursive:true,force:true});});
  assert.deepEqual(await lifecycle.connectExternal({url:f.url,token}),{ok:true});
  brain.setVoiceEnabled(false);
  assert.deepEqual(await lifecycle.disconnect(),{ok:true});assert.equal(brain.snapshot().phase,'disconnected');
  assert.deepEqual(await lifecycle.reconnect(),{ok:true});assert.equal(brain.snapshot().phase,'ready');
  assert.equal(brain.snapshot().speech.enabled,false);assert.equal(f.scopes[0].session_id,f.scopes[1].session_id);
  assert.deepEqual(f.received,[]);assert.equal(runtime.snapshot().phase,'stopped');
  hold=true;const pending=lifecycle.reconnect();await waitFor(()=>held);
  assert.deepEqual(await lifecycle.reconnect(),{ok:false,code:'busy'});
  assert.deepEqual(await lifecycle.connectExternal({url:f.url,token}),{ok:false,code:'busy'});
  assert.deepEqual(await lifecycle.disconnect(),{ok:false,code:'busy'});
  await lifecycle.shutdown();assert.equal((await pending).ok,false);
  assert.equal(brain.snapshot().phase,'disconnected');assert.equal(session.snapshot().activeTurnId,null);
  assert.equal((await lifecycle.reconnect()).ok,false);assert.equal(spawned,0);assert.deepEqual(f.received,[]);
});
