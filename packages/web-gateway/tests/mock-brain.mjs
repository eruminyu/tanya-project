// A loopback stand-in for a public_demo Brain: /v1/config with bearer auth and no Origin, and a /v1/chat
// socket that echoes accepted client messages, streams a scripted answer, synthesises one WAV chunk per
// speech.request and ends the turn once every sentence was played. Enough protocol to drive the gateway.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

export const TOKEN = 'mock-brain-token-with-at-least-32-characters';
export const MODEL = { provider_id: 'ollama', model_id: 'mock-gemma', endpoint_id: 'server-ollama' };
export const IDENTITY = { instance_id: 'public-demo-v1', mode: 'public_demo', principal_id: 'visitor' };
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(20), Buffer.from('data'), Buffer.alloc(4), Buffer.alloc(64)]).toString('base64');

export const CALENDAR_ARGUMENTS = { summary: '치과 예약', start: { dateTime: '2026-09-18T15:00:00+09:00', timeZone: 'Asia/Seoul' },
  end: { dateTime: '2026-09-18T16:00:00+09:00', timeZone: 'Asia/Seoul' }, description: '', location: '' };

/** tools: when true, turns with external_tools run the tool handshake and "일정" in the text yields a calendar proposal. */
export async function startMockBrain({ answer = '안녕하세요. 공개 데모예요.', speech = true, delayMs = 5, tools = false, badArguments = false, calendarArguments = CALENDAR_ARGUMENTS } = {}) {
  const state = { sessions: 0, turns: [], closeAll: () => {}, personal: false, conversations: new Set(), deleted: [], registrations: [], observations: 0 };
  const config = () => ({ identity: state.personal ? { ...IDENTITY, mode: 'personal' } : IDENTITY,
    models: [{ model: MODEL, label: 'Mock Gemma', supports_images: false, supports_text: true, supports_tools: tools, automatic_allowed: false, budget_units: null, boundary: 'local' }],
    ...(tools ? { persistence: true } : {}),
    default_selection: { model: MODEL, source: 'initial_local' },
    ...(speech ? { speech: { model: { provider_id: 'gpt-sovits', model_id: 'voice', endpoint_id: 'tts' }, label: 'Mock voice' } } : {}) });
  const authenticated = request => request.headers.authorization === 'Bearer ' + TOKEN && !('origin' in request.headers);
  const pendingContexts = new Map();
  const server = createServer((request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (!authenticated(request)) { reply(401, { detail: 'unauthorized' }); return; }
    if (request.url === '/v1/config') { reply(200, config()); return; }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/v1/conversations') {
        const id = 'conversation-' + randomUUID();
        state.conversations.add(id);
        reply(200, { conversation: { id, title: '', updated_at: 0, model: null }, messages: [] });
      } else if (request.method === 'DELETE' && request.url.startsWith('/v1/conversations/')) {
        const id = request.url.slice('/v1/conversations/'.length);
        state.deleted.push(id);
        reply(state.conversations.delete(id) ? 200 : 404, { ok: true });
      } else if (request.method === 'GET' && request.url.startsWith('/v1/external-tools/turns/')) {
        const context = pendingContexts.get(request.url.slice('/v1/external-tools/turns/'.length));
        state.observations += 1;
        if (!context) { reply(404, { detail: 'not_found' }); return; }
        reply(200, { context_id: context.contextId, scope: context.scope, turn_id: context.turn.turn_id, intent_id: context.turn.intent_id, request_id: context.requestId,
          expected_model: MODEL, model_boundary: 'local', routing_reason: null, source_refs: [], active: true, state: context.state, explicitly_supported: true, completed_call: null });
      } else if (request.method === 'POST' && request.url === '/v1/external-tools/results') {
        const body = JSON.parse(raw);
        state.registrations.push(body);
        const p = body.provenance;
        const consistent = p.identity.mode === 'public_demo' && p.providerKind === 'google_calendar' && body.receipt.provider_id === 'google_calendar'
          && body.receipt.status === 'succeeded' && body.receipt.payload_sha256 === p.payloadSha256 && p.offeredMetadata.length === 1
          && p.offeredMetadata[0].offerId === p.offerId && typeof body.canonicalResultJson === 'string';
        if (!consistent) { reply(400, { detail: 'invalid_request' }); return; }
        reply(200, { sourceRef: { source_id: 'tool-result-' + randomUUID(), revision: 1 }, kind: 'tool_result', text: body.canonicalResultJson });
      } else reply(404, { detail: 'not_found' });
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  const clients = new Set();
  state.closeAll = () => { for (const client of clients) client.close(1001, 'expired'); };
  server.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith('/v1/chat') || !authenticated(request)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      clients.add(ws);
      state.sessions += 1;
      const scope = { ...IDENTITY, session_id: 'session-' + randomUUID(), connection_id: 'connection-' + randomUUID(), connection_epoch: 0 };
      const message = (kind, payload, turn = null, requestId = null, sequence = 0) => ({ protocol: 'kirian.rearchitecture.v1', message_id: 'server-' + randomUUID(),
        request_id: requestId ?? 'server-request-' + randomUUID(), scope, kind, turn_id: turn?.turn_id ?? null, intent_id: turn?.intent_id ?? null, sequence, payload });
      const send = value => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value)); };
      send(message('session.ready', { client_kind: 'web', resume: 'new_session', capabilities: ['text', ...(speech ? ['audio_output'] : [])] }));
      const turns = new Map();
      const sleep = () => new Promise(resolve => setTimeout(resolve, delayMs));
      const maybeEnd = turn => {
        if (turn.ended || !turn.completed) return;
        if (turn.speech && (!turn.speechFinished || [...turn.sentences.values()].some(row => row.playback !== 'completed'))) return;
        turn.ended = true;
        send(message('turn.ended', { status: 'completed' }, turn));
      };
      ws.on('message', async data => {
        const incoming = JSON.parse(data.toString());
        state.turns.push(incoming);
        send(incoming);
        const key = incoming.turn_id;
        if (incoming.kind === 'input.finished') turns.set(key, { turn_id: key, intent_id: incoming.intent_id, text: incoming.payload.text, sentences: new Map(), completed: false, ended: false, speech: false, speechFinished: false, cancelled: false });
        const turn = turns.get(key);
        if (!turn) return;
        const generate = async text => {
          for (const piece of text.split(/(?<=\.)\s*/).filter(Boolean)) {
            send(message('response.delta', { text: piece, actual_model: MODEL }, turn, turn.requestId, turn.nextSequence++));
            await sleep();
            if (turn.cancelled) return;
          }
          send(message('response.completed', { actual_model: MODEL }, turn, turn.requestId, turn.nextSequence++));
          turn.completed = true;
          maybeEnd(turn);
        };
        if (incoming.kind === 'turn.start') {
          // Like the Brain: generation messages continue the turn.start request with sequence 1, 2, ...
          turn.speech = incoming.payload.speech === true;
          turn.requestId = incoming.request_id;
          turn.nextSequence = 1;
          await sleep();
          if (turn.cancelled) return;
          if (tools && incoming.payload.external_tools === true) {
            turn.contextId = 'context-' + randomUUID();
            pendingContexts.set(turn.contextId, { contextId: turn.contextId, scope, turn, requestId: incoming.request_id, state: 'awaiting_offers' });
            send(message('tool.context', { context_id: turn.contextId }, turn));
            return;
          }
          await generate(answer);
        } else if (incoming.kind === 'tool.offers') {
          const context = pendingContexts.get(incoming.payload.context_id);
          if (!context || context.turn !== turn) return;
          context.offers = incoming.payload.offers;
          await sleep();
          if (turn.cancelled) return;
          if (/일정|예약/.test(turn.text)) {
            context.state = 'awaiting_result';
            const args = badArguments ? { summary: '치과', start: '내일 3시', end: '내일 4시' } : calendarArguments;
            turn.proposalId = 'proposal-' + randomUUID();
            send(message('tool.proposed', { provider_kind: 'google_calendar', proposal_id: turn.proposalId, offer_id: context.offers[0].offer_id,
              arguments_json: JSON.stringify(args), actual_model: MODEL, source_refs: [] }, turn));
            return;
          }
          pendingContexts.delete(context.contextId);
          await generate(answer);
        } else if (incoming.kind === 'tool.resolved') {
          if (incoming.payload.proposal_id !== turn.proposalId) return;
          pendingContexts.delete(turn.contextId);
          await sleep();
          if (turn.cancelled) return;
          if (incoming.payload.state === 'succeeded') await generate('일정을 준비했어요. 캘린더에 담아 주세요.');
          else await generate({ failed: '외부 도구 실행이 실패했습니다.', unknown: '외부 도구의 실행 결과를 확인하지 못했습니다.', unavailable: '이번 초안은 실행하지 않았어요. 필요하면 다시 말씀해 주세요.' }[incoming.payload.state]);
        } else if (incoming.kind === 'turn.cancel') {
          turn.cancelled = true;
          turn.ended = true;
          send(message('turn.ended', { status: 'cancelled' }, turn));
        } else if (incoming.kind === 'speech.request') {
          turn.sentences.set(incoming.payload.sentence_id, { playback: 'idle', index: incoming.payload.sentence_index });
          await sleep();
          send(message('speech.chunk', { sentence_id: incoming.payload.sentence_id, sentence_index: incoming.payload.sentence_index, codec: 'wav',
            sample_rate_hz: 32000, audio_base64: WAV, final: true }, turn, incoming.request_id, 1));
        } else if (incoming.kind === 'speech.finished') {
          turn.speechFinished = true;
          maybeEnd(turn);
        } else if (incoming.kind === 'playback.state') {
          const row = turn.sentences.get(incoming.payload.sentence_id);
          if (row) row.playback = incoming.payload.state;
          maybeEnd(turn);
        }
      });
      ws.on('close', () => clients.delete(ws));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, state,
    close: async () => { for (const client of clients) client.terminate(); await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
