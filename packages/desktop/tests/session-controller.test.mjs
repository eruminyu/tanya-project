import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionController } from '../dist-electron/main/session-controller.js';

const identity = {
  instance_id: 'private-instance',
  mode: 'personal',
  principal_id: 'owner',
};
const scope = {
  ...identity,
  session_id: 'session-1',
  connection_id: 'connection-1',
  connection_epoch: 0,
};
const model = {
  provider_id: 'ollama',
  model_id: 'local-model',
  endpoint_id: 'private-model',
};
let number = 0;

function event(kind, payload, overrides = {}) {
  const sessionEvent = [
    'session.ready',
    'session.closed',
    'action.receipt',
    'model.default_changed',
    'context.invalidated',
  ].includes(kind);
  return {
    protocol: 'kirian.rearchitecture.v1',
    message_id: `message-${++number}`,
    request_id: `request-${number}`,
    scope: { ...scope },
    kind,
    turn_id: sessionEvent ? null : 'turn-1',
    intent_id: sessionEvent ? null : 'intent-1',
    sequence: 0,
    payload,
    ...overrides,
  };
}

function ready(currentScope = scope, resume = 'new_session') {
  return event(
    'session.ready',
    { client_kind: 'electron', resume, capabilities: ['text'] },
    { scope: currentScope }
  );
}

function start(overrides = {}) {
  return event(
    'turn.start',
    {
      selection: { model: { ...model }, source: 'saved_default' },
      context: [],
    },
    { request_id: 'response-1', ...overrides }
  );
}

function response(text = '안녕하세요', sequence = 1, overrides = {}) {
  return event(
    'response.delta',
    { text, actual_model: { ...model } },
    { request_id: 'response-1', sequence, ...overrides }
  );
}

function session(limits) {
  const controller = new SessionController(limits);
  const binding = controller.connect(scope);
  assert.equal(binding.ingest(ready()).kind, 'accepted');
  return { controller, binding };
}

test('connection requires authenticated readiness and does not invent dialogue or actual model', () => {
  const controller = new SessionController();
  assert.equal(controller.snapshot().connection.phase, 'disconnected');
  const authenticated = { ...scope };
  const binding = controller.connect(authenticated);
  authenticated.principal_id = 'changed-after-connect';
  assert.equal(controller.snapshot().connection.phase, 'connecting');
  assert.equal(controller.snapshot().actualModel, null);
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(binding.ingest(ready()).kind, 'accepted');
  assert.equal(controller.snapshot().connection.phase, 'ready');
  assert.deepEqual(controller.snapshot().messages, []);
});

test('only validated response evidence sets actual model and only view fields reach snapshots', () => {
  const { controller, binding } = session();
  binding.ingest(
    event('input.finished', { input_id: 'input-1', kind: 'text', text: '안녕' })
  );
  binding.ingest(start());
  assert.equal(controller.snapshot().actualModel, null);
  binding.ingest(response('반가워요'));
  const complete = event(
    'response.completed',
    { actual_model: model },
    { request_id: 'response-1', sequence: 2 }
  );
  assert.equal(binding.ingest(complete).kind, 'accepted');
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.actualModel, {
    providerId: 'ollama',
    modelId: 'local-model',
    endpointId: 'private-model',
  });
  assert.deepEqual(
    snapshot.messages.map((row) => [row.role, row.text, row.status]),
    [
      ['user', '안녕', 'completed'],
      ['assistant', '반가워요', 'completed'],
    ]
  );
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'activeTurnId',
    'actualModel',
    'connection',
    'messages',
    'revision',
    'routingReason',
  ]);
  assert.deepEqual(Object.keys(snapshot.messages[1]).sort(), [
    'actualModel',
    'id',
    'role',
    'routingReason',
    'status',
    'text',
    'turnId',
  ]);
  assert.equal(JSON.stringify(snapshot).includes('principal_id'), false);
  assert.equal(JSON.stringify(snapshot).includes('payload'), false);
});

test('duplicates do not duplicate text or notifications', () => {
  const { controller, binding } = session();
  binding.ingest(start());
  let calls = 0;
  controller.subscribe(() => calls++);
  const delta = response();
  binding.ingest(delta);
  const revision = controller.snapshot().revision;
  const before = calls;
  assert.equal(binding.ingest(structuredClone(delta)).kind, 'duplicate');
  assert.equal(controller.snapshot().revision, revision);
  assert.equal(calls, before);
  assert.equal(controller.snapshot().messages[0].text, '안녕하세요');
});

test('cancelled turns reject late transcripts, LLM responses and TTS without reviving the view', () => {
  const { controller, binding } = session();
  binding.ingest(
    event(
      'input.finished',
      { input_id: 'input-1', kind: 'audio', text: '' },
      { request_id: 'input-request' }
    )
  );
  binding.ingest(event('turn.cancel', { reason: 'barge_in' }));
  const before = controller.snapshot();
  const late = [
    event(
      'input.transcript',
      { input_id: 'input-1', text: '늦은 전사', final: true },
      { request_id: 'input-request', sequence: 1 }
    ),
    start(),
    response(),
    event('speech.request', {
      sentence_id: 'sentence-1',
      sentence_index: 0,
      text: '늦은 발화',
      model,
    }),
  ];
  for (const message of late)
    assert.deepEqual(binding.ingest(message), {
      kind: 'discarded',
      reason: 'terminal_turn',
    });
  assert.deepEqual(controller.snapshot(), before);
  assert.equal(before.messages[0].status, 'cancelled');
  assert.equal(before.activeTurnId, null);
});

test('cancelling a newer overlapping input preserves the earlier still-streaming turn', () => {
  const { controller, binding } = session();
  binding.ingest(start());
  binding.ingest(response('계속 답변 중'));
  const second = { turn_id: 'turn-2', intent_id: 'intent-2' };
  binding.ingest(
    event(
      'input.finished',
      { input_id: 'input-2', kind: 'audio', text: '' },
      second
    )
  );
  assert.equal(controller.snapshot().activeTurnId, 'turn-2');
  binding.ingest(event('turn.cancel', { reason: 'user' }, second));
  assert.equal(controller.snapshot().activeTurnId, 'turn-1');
  assert.equal(
    controller.snapshot().messages.find((row) => row.turnId === 'turn-1')
      .status,
    'streaming'
  );
  binding.ingest(
    event(
      'response.completed',
      { actual_model: model },
      { request_id: 'response-1', sequence: 2 }
    )
  );
  assert.equal(controller.snapshot().activeTurnId, 'turn-1');
  binding.ingest(event('turn.ended', { status: 'completed' }));
  assert.equal(controller.snapshot().activeTurnId, null);
});

test('an active turn survives view eviction while newer turns finish', () => {
  const { controller, binding } = session();
  binding.ingest(start());
  binding.ingest(response('오래 걸리는 답변'));
  for (let index = 0; index < 100; index++) {
    const newer = {
      turn_id: `newer-${index}`,
      intent_id: `newer-intent-${index}`,
    };
    binding.ingest(
      event(
        'input.finished',
        { input_id: `newer-input-${index}`, kind: 'audio', text: '' },
        newer
      )
    );
    binding.ingest(event('turn.cancel', { reason: 'user' }, newer));
  }
  assert.equal(
    controller.snapshot().messages.some((row) => row.turnId === 'turn-1'),
    false
  );
  assert.equal(controller.snapshot().activeTurnId, 'turn-1');
  binding.ingest(event('turn.ended', { status: 'failed' }));
  assert.equal(controller.snapshot().activeTurnId, null);
});

for (const close of ['disconnect', 'session.closed', 'error', 'reconnect']) {
  test(`${close} clears overlapping active turns before the next connection`, () => {
    const { controller, binding } = session();
    binding.ingest(start());
    binding.ingest(
      event(
        'input.finished',
        { input_id: 'second-input', kind: 'audio', text: '' },
        {
          turn_id: 'turn-2',
          intent_id: 'intent-2',
        }
      )
    );
    if (close === 'disconnect') controller.disconnect();
    if (close === 'session.closed')
      binding.ingest(event('session.closed', { reason: 'shutdown' }));
    if (close === 'error') binding.ingest({ protocol: 'invalid' });
    const nextScope = {
      ...scope,
      connection_id: 'connection-2',
      connection_epoch: 1,
    };
    const next = controller.connect(nextScope);
    assert.equal(controller.snapshot().activeTurnId, null);
    next.ingest(ready(nextScope, 'turns_cancelled'));
    next.ingest(
      start({
        scope: nextScope,
        turn_id: 'turn-3',
        intent_id: 'intent-3',
        request_id: 'response-3',
      })
    );
    next.ingest(
      event(
        'turn.cancel',
        { reason: 'user' },
        { scope: nextScope, turn_id: 'turn-3', intent_id: 'intent-3' }
      )
    );
    assert.equal(controller.snapshot().activeTurnId, null);
    assert.equal(controller.snapshot().connection.phase, 'ready');
  });
}

test('old transport callbacks and close cannot touch a reconnected session', () => {
  const { controller, binding: oldBinding } = session();
  oldBinding.ingest(start());
  oldBinding.ingest(response('처음'));
  const nextScope = {
    ...scope,
    connection_id: 'connection-2',
    connection_epoch: 1,
  };
  const current = controller.connect(nextScope);
  assert.equal(controller.snapshot().messages[0].status, 'cancelled');
  assert.equal(
    current.ingest(ready(nextScope, 'turns_cancelled')).kind,
    'accepted'
  );
  const before = controller.snapshot();
  assert.deepEqual(oldBinding.ingest(response('오래된 결과', 2)), {
    kind: 'discarded',
    reason: 'stale_connection',
  });
  oldBinding.disconnect();
  assert.deepEqual(controller.snapshot(), before);
  assert.deepEqual(current.ingest(start({ scope: nextScope })), {
    kind: 'discarded',
    reason: 'terminal_turn',
  });
});

test('different authenticated sessions clear private view data and isolate old bindings', () => {
  const { controller, binding } = session();
  binding.ingest(start());
  binding.ingest(response('개인 대화'));
  const otherScope = {
    ...scope,
    principal_id: 'other-owner',
    session_id: 'other-session',
  };
  const other = controller.connect(otherScope);
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().actualModel, null);
  other.ingest(ready(otherScope));
  assert.equal(
    binding.ingest(response('이전 사용자의 결과', 2)).kind,
    'discarded'
  );
  assert.deepEqual(controller.snapshot().messages, []);
});

test('invalid protocol or model mismatch fails closed without accepting text', () => {
  const { controller, binding } = session();
  binding.ingest(start());
  const bad = response('나가면 안 되는 본문');
  bad.payload.actual_model.model_id = 'different-model';
  assert.equal(binding.ingest(bad).kind, 'rejected');
  assert.equal(controller.snapshot().connection.phase, 'error');
  assert.equal(controller.snapshot().messages[0].text, '');
  assert.equal(controller.snapshot().actualModel, null);
  assert.equal(binding.ingest(response()).kind, 'discarded');
  const separate = session();
  assert.equal(
    separate.binding.ingest({ protocol: 'legacy' }).kind,
    'rejected'
  );
  assert.equal(
    separate.controller.snapshot().connection.reason,
    'invalid_message'
  );
});

test('receipts are explicitly unverified without an approval ledger, even after turn cancellation', () => {
  const { controller, binding } = session();
  binding.ingest(event('turn.cancel', { reason: 'user' }));
  const before = controller.snapshot();
  const receipt = event('action.receipt', {
    receipt: {
      execution_id: 'execution-1',
      draft_id: 'draft-1',
      draft_revision: 1,
      identity,
      executor_id: 'pc-1',
      payload_sha256: 'a'.repeat(64),
      status: 'succeeded',
      provider_id: 'google',
      provider_operation_id: 'event-1',
      error_code: null,
      recorded_at_ms: 1,
    },
  });
  assert.deepEqual(binding.ingest(receipt), {
    kind: 'approval-ledger-unavailable',
    action: 'action.receipt',
  });
  assert.deepEqual(controller.snapshot(), before);
  assert.equal(
    JSON.stringify(controller.snapshot()).includes('succeeded'),
    false
  );
});

test('subscriptions and snapshots cannot mutate controller state and disposal releases listeners', () => {
  const { controller, binding } = session();
  let notifications = 0;
  const stop = controller.subscribe((value) => {
    notifications++;
    value.messages.push({ text: 'mutated' });
  });
  const snapshot = controller.snapshot();
  snapshot.connection.phase = 'error';
  snapshot.messages.push({ text: 'mutated again' });
  assert.equal(controller.snapshot().connection.phase, 'ready');
  assert.deepEqual(controller.snapshot().messages, []);
  controller.subscribe(() => {
    throw new Error('closed view');
  });
  binding.ingest(start());
  assert.equal(notifications, 2);
  stop();
  binding.ingest(response());
  assert.equal(notifications, 2);
  controller.dispose();
  assert.equal(binding.ingest(response('late', 2)).kind, 'discarded');
  controller.subscribe(() => notifications++);
  assert.equal(notifications, 2);
  assert.throws(() => controller.connect(scope), /disposed/);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('view retains only the latest 100 messages', () => {
  const { controller, binding } = session();
  for (let index = 0; index < 105; index++) {
    binding.ingest(
      event(
        'input.finished',
        { input_id: `input-${index}`, kind: 'text', text: `메시지 ${index}` },
        {
          turn_id: `turn-${index}`,
          intent_id: `intent-${index}`,
        }
      )
    );
  }
  const rows = controller.snapshot().messages;
  assert.equal(rows.length, 100);
  assert.equal(rows[0].text, '메시지 5');
  assert.equal(rows.at(-1).text, '메시지 104');
});

test('response accumulation has a hard view limit and cannot claim completion after overflow', () => {
  const { controller, binding } = session({ maxResponseCharacters: 4 });
  binding.ingest(start());
  binding.ingest(response('가나다라'));
  assert.deepEqual(binding.ingest(response('마', 2)), {
    kind: 'rejected',
    code: 'response_limit_exceeded',
  });
  const snapshot = controller.snapshot();
  assert.equal(snapshot.connection.phase, 'error');
  assert.equal(snapshot.messages[0].text, '가나다라');
  assert.equal(snapshot.messages[0].status, 'failed');
});

test('streamed Unicode response uses the same code point budget as restored history', () => {
  const { controller, binding } = session({ maxResponseCharacters: 4 });
  binding.ingest(start());
  assert.equal(binding.ingest(response('🙂🙂')).kind, 'accepted');
  assert.equal(binding.ingest(response('🙂🙂', 2)).kind, 'accepted');
  assert.equal(controller.snapshot().messages[0].text, '🙂🙂🙂🙂');
  assert.deepEqual(binding.ingest(response('🙂', 3)), { kind: 'rejected', code: 'response_limit_exceeded' });
  assert.equal(controller.snapshot().messages[0].status, 'failed');
});

test('evicting an old response does not revive its row or reset its cumulative text limit', () => {
  const { controller, binding } = session({ maxResponseCharacters: 4 });
  binding.ingest(start());
  binding.ingest(response('가나다'));
  for (let index = 0; index < 100; index++) {
    binding.ingest(
      event(
        'input.finished',
        { input_id: `later-input-${index}`, kind: 'text', text: '최근 메시지' },
        {
          turn_id: `later-turn-${index}`,
          intent_id: `later-intent-${index}`,
        }
      )
    );
  }
  const rows = controller.snapshot().messages;
  assert.equal(
    rows.some((row) => row.turnId === 'turn-1'),
    false
  );
  assert.equal(binding.ingest(response('라', 2)).kind, 'accepted');
  assert.deepEqual(controller.snapshot().messages, rows);
  assert.deepEqual(binding.ingest(response('마', 3)), {
    kind: 'rejected',
    code: 'response_limit_exceeded',
  });
});

test('event budget survives reconnect and only a fresh authenticated session resets the guard', () => {
  const { controller, binding } = session({ maxEvents: 3 });
  binding.ingest(start());
  const nextScope = {
    ...scope,
    connection_id: 'connection-2',
    connection_epoch: 1,
  };
  const next = controller.connect(nextScope);
  next.ingest(ready(nextScope, 'turns_cancelled'));
  assert.deepEqual(
    next.ingest(
      start({
        scope: nextScope,
        turn_id: 'turn-2',
        intent_id: 'intent-2',
        request_id: 'response-2',
      })
    ),
    { kind: 'rejected', code: 'fresh_session_required' }
  );
  assert.equal(
    controller.snapshot().connection.reason,
    'session_limit_exceeded'
  );
  controller.disconnect();
  assert.equal(controller.snapshot().connection.phase, 'error');
  assert.throws(
    () =>
      controller.connect({
        ...nextScope,
        connection_id: 'connection-3',
        connection_epoch: 2,
      }),
    /fresh_session_required/
  );
  const freshScope = {
    ...nextScope,
    session_id: 'session-2',
    connection_id: 'connection-3',
    connection_epoch: 0,
  };
  const fresh = controller.connect(freshScope);
  assert.equal(fresh.ingest(ready(freshScope)).kind, 'accepted');
  assert.equal(controller.snapshot().connection.phase, 'ready');
});

test('byte budget measures UTF-8 message bytes and rejects before a fingerprint is retained', () => {
  const initial = ready();
  const bytes = Buffer.byteLength(JSON.stringify(initial), 'utf8');
  const controller = new SessionController({ maxBytes: bytes });
  const binding = controller.connect(scope);
  assert.equal(binding.ingest(initial).kind, 'accepted');
  assert.deepEqual(binding.ingest(start()), {
    kind: 'rejected',
    code: 'fresh_session_required',
  });
  assert.equal(
    controller.snapshot().connection.reason,
    'session_limit_exceeded'
  );
});

test('streamed speech chunks do not consume the session budget while other messages still do', () => {
  const initial = ready(), first = start(), delta = response('안녕하세요', 1);
  const request = event('speech.request', { sentence_id: 'sentence-1', sentence_index: 0, text: '안녕하세요', model }, { request_id: 'speech-1' });
  const bytes = [initial, first, delta, request].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0) + 64;
  const controller = new SessionController({ maxBytes: bytes, maxEvents: 6 });
  const binding = controller.connect(scope);
  for (const item of [initial, first, delta, request]) assert.equal(binding.ingest(item).kind, 'accepted', item.kind);
  for (let index = 1; index <= 40; index++) {
    const chunk = event('speech.chunk', { sentence_id: 'sentence-1', sentence_index: 0, codec: 'wav', sample_rate_hz: 32000,
      audio_base64: Buffer.alloc(48 * 1024, 1).toString('base64'), final: index === 40 }, { request_id: 'speech-1', sequence: index });
    const result = binding.ingest(chunk);
    assert.equal(result.kind, 'accepted', 'chunk ' + index + ' ' + JSON.stringify(result));
  }
  assert.equal(controller.snapshot().connection.phase, 'ready');
  assert.deepEqual(binding.ingest(response('이 응답은 예산을 넘긴다', 2)), { kind: 'rejected', code: 'fresh_session_required' });
  assert.equal(controller.snapshot().connection.reason, 'session_limit_exceeded');
});
