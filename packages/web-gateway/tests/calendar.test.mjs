import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGateway } from '../dist/web-gateway/src/server.js';
import { DEFAULT_LIMITS } from '../dist/web-gateway/src/config.js';
import { buildHandoff } from '../dist/web-gateway/src/handoff.js';
import { repairDraftArguments, repairRelativeStart } from '../dist/web-gateway/src/demo-calendar.js';
import { DemoProactive, CALENDAR_CARD_TEXT } from '../dist/web-gateway/src/demo-proactive.js';
import { normalizeFields } from '../dist/desktop/src/main/external/google-calendar.js';
import { startMockBrain, TOKEN, CALENDAR_ARGUMENTS } from './mock-brain.mjs';

async function startGateway(brain, overrides = {}, limits = {}) {
  const gateway = createGateway({ host: '127.0.0.1', port: 0, brainUrl: brain.url, brainToken: TOKEN, staticDir: null, trustProxy: false,
    calendarLabel: '내 캘린더', calendarTimeZone: 'Asia/Seoul', limits: { ...DEFAULT_LIMITS, ...limits }, ...overrides });
  const address = await gateway.listen();
  return { gateway, base: `http://127.0.0.1:${address.port}` };
}
const issue = async base => (await (await fetch(base + '/demo/session', { method: 'POST' })).json());
function connect(base, token) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/demo/ws?token=${token}`);
  const received = [], waiters = [];
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    received.push(value);
    for (const waiter of [...waiters]) if (waiter.match(value)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
  });
  const opened = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 1;
  const client = {
    socket, received, opened: () => opened,
    waitFor: (match, timeoutMs = 5000) => {
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout; last=' + JSON.stringify(received.at(-1)).slice(0, 400))), timeoutMs);
        waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
      });
    },
    command: async value => { const id = nextId++; socket.send(JSON.stringify({ id, ...value })); return (await client.waitFor(item => item.kind === 'result' && item.id === id)).result; },
  };
  return client;
}
const ready = client => client.waitFor(item => item.kind === 'snapshot' && item.snapshot.brain.phase === 'ready');
const phase = (client, name) => client.waitFor(item => item.kind === 'snapshot' && item.snapshot.tools.phase === name);
const turnDone = client => client.waitFor(item => item.kind === 'snapshot' && item.snapshot.session.activeTurnId === null && item.snapshot.session.messages.some(row => row.role === 'assistant' && row.status !== 'streaming'));

test('a timed draft with a missing or non-positive end gets a one-hour end, other drafts are untouched', () => {
  const start = { dateTime: '2026-09-20T19:00:00+09:00' };
  assert.deepEqual(repairDraftArguments({ summary: 'a', start, end: { dateTime: '2026-09-20T19:00:00+09:00' } }).end, { dateTime: '2026-09-20T20:00:00+09:00' });
  assert.deepEqual(repairDraftArguments({ summary: 'a', start }).end, { dateTime: '2026-09-20T20:00:00+09:00' });
  assert.deepEqual(repairDraftArguments({ summary: 'a', start: { dateTime: '2026-12-31T23:30:00+09:00' } }).end, { dateTime: '2027-01-01T00:30:00+09:00' });
  const fine = { summary: 'a', start, end: { dateTime: '2026-09-20T21:00:00+09:00' } };
  assert.equal(repairDraftArguments(fine), fine);
  const allDay = { summary: 'a', start: { date: '2026-09-20' }, end: { date: '2026-09-20' } };
  assert.equal(repairDraftArguments(allDay), allDay);
  assert.throws(() => normalizeFields(repairDraftArguments(allDay)));
});

test('a relative request snaps a mistimed draft to now + offset, keeping duration and offset text', () => {
  const now = Date.parse('2026-09-18T15:48:00+09:00');
  const draft = { summary: 's', start: { dateTime: '2026-09-18T16:58:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-09-18T17:18:00+09:00' } };
  const fixed = repairRelativeStart('10분 뒤에 스트레칭 일정 추가해 줘.', draft, now);
  assert.deepEqual(fixed.start, { dateTime: '2026-09-18T15:58:00+09:00', timeZone: 'Asia/Seoul' });
  assert.deepEqual(fixed.end, { dateTime: '2026-09-18T16:18:00+09:00' });
  assert.deepEqual(repairRelativeStart('2시간 후 회의', { ...draft, start: { dateTime: '2026-09-18T06:00:00Z' }, end: { dateTime: '2026-09-18T07:00:00Z' } }, now).start, { dateTime: '2026-09-18T08:48:00Z' });
  // Close enough, no relative words, or all-day: untouched.
  const near = { ...draft, start: { dateTime: '2026-09-18T15:59:00+09:00' } };
  assert.equal(repairRelativeStart('10분 뒤 스트레칭', near, now), near);
  assert.equal(repairRelativeStart('내일 오후 3시 운동', draft, now), draft);
  const allDay = { summary: 's', start: { date: '2026-09-19' }, end: { date: '2026-09-20' } };
  assert.equal(repairRelativeStart('10분 뒤', allDay, now), allDay);
});

test('the hand-off builds a prefilled Google Calendar link and a valid ics', () => {
  const result = buildHandoff(CALENDAR_ARGUMENTS, 'draft-1', 'Asia/Seoul', new Date('2026-09-17T09:00:00Z'));
  const url = new URL(result.googleCalendarUrl);
  assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), '치과 예약');
  assert.equal(url.searchParams.get('dates'), '20260918T060000Z/20260918T070000Z');
  assert.equal(url.searchParams.get('ctz'), 'Asia/Seoul');
  assert.match(result.icsText, /BEGIN:VCALENDAR\r\n/);
  assert.match(result.icsText, /DTSTART:20260918T060000Z\r\nDTEND:20260918T070000Z\r\nSUMMARY:치과 예약\r\n/);
  assert.match(result.icsText, /UID:draft-1@tanya-demo/);
  assert.equal(result.icsFileName, '치과 예약.ics');
  const allDay = buildHandoff({ summary: 'a; b, c', start: { date: '2026-10-01' }, end: { date: '2026-10-02' }, description: 'line1\nline2', location: '' }, 'd', 'Asia/Seoul');
  assert.equal(new URL(allDay.googleCalendarUrl).searchParams.get('dates'), '20261001/20261002');
  assert.match(allDay.icsText, /DTSTART;VALUE=DATE:20261001\r\n/);
  assert.match(allDay.icsText, /SUMMARY:a\\; b\\, c\r\nDESCRIPTION:line1\\nline2\r\n/);
});

test('a calendar request becomes an exact draft, approval hands it off and the Brain summarises', async () => {
  const brain = await startMockBrain({ speech: false, tools: true });
  const { gateway, base } = await startGateway(brain);
  try {
    const session = await issue(base);
    assert.deepEqual(session.demo.calendar, { kind: 'handoff', label: '내 캘린더', timeZone: 'Asia/Seoul' });
    const client = connect(base, session.token);
    await client.opened();
    const first = await ready(client);
    assert.equal(first.snapshot.tools.phase, 'ready');
    assert.equal(brain.state.conversations.size, 1);
    // A plain question still answers normally through the tool turn.
    assert.deepEqual(await client.command({ kind: 'send', text: '안녕?' }), { ok: true });
    await turnDone(client);
    assert.equal(brain.state.turns.filter(item => item.kind === 'tool.offers').length, 1);
    assert.equal(brain.state.turns.find(item => item.kind === 'turn.start').payload.external_tools, true);
    const offer = brain.state.turns.find(item => item.kind === 'tool.offers').payload.offers[0];
    assert.equal(offer.provider_kind, 'google_calendar');
    assert.match(offer.display_name, /일정 만들기/);
    assert.match(offer.description, /Asia\/Seoul/);
    // The calendar request yields a draft; nothing is executed before approval.
    assert.deepEqual(await client.command({ kind: 'send', text: '내일 3시에 치과 예약 잡아 줘' }), { ok: true });
    const awaiting = await phase(client, 'awaiting_approval');
    const draft = awaiting.snapshot.tools.draft;
    // Fields are normalised (instants in UTC); the draft is the exact event that will be handed off.
    assert.equal(draft.event.summary, CALENDAR_ARGUMENTS.summary);
    assert.equal(Date.parse(draft.event.start.dateTime), Date.parse(CALENDAR_ARGUMENTS.start.dateTime));
    assert.equal(Date.parse(draft.event.end.dateTime), Date.parse(CALENDAR_ARGUMENTS.end.dateTime));
    assert.equal(draft.event.start.timeZone, 'Asia/Seoul');
    assert.equal(draft.calendarLabel, '내 캘린더');
    assert.ok(draft.expiresAt > Date.now());
    assert.equal(brain.state.registrations.length, 0);
    assert.deepEqual(await client.command({ kind: 'approve', draftId: 'wrong' }), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await client.command({ kind: 'approve', draftId: draft.draftId }), { ok: true });
    const finished = await phase(client, 'finished');
    const receipt = finished.snapshot.tools.receipt;
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.executorKind, 'handoff');
    assert.match(receipt.handoff.googleCalendarUrl, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    assert.match(receipt.handoff.icsText, /SUMMARY:치과 예약/);
    assert.equal(receipt.created, null);
    assert.equal(brain.state.registrations.length, 1);
    const registration = brain.state.registrations[0];
    assert.equal(registration.provenance.offeredMetadata[0].toolName, 'calendar.create');
    assert.equal(registration.provenance.boundary, 'local');
    assert.match(registration.canonicalResultJson, /"kind":"calendar_handoff"/);
    assert.doesNotMatch(registration.canonicalResultJson, /BEGIN:VCALENDAR/);
    const resolved = brain.state.turns.filter(item => item.kind === 'tool.resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].payload.state, 'succeeded');
    const rows = finished.snapshot.session.messages;
    assert.equal(rows.at(-1).text, '일정을 준비했어요.캘린더에 담아 주세요.');
    client.socket.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(brain.state.deleted.length, 1);
    assert.equal(brain.state.conversations.size, 0);
  } finally { await gateway.close(); await brain.close(); }
});

test('rejecting or an invalid proposal never executes and returns the turn to the Brain', async () => {
  const brain = await startMockBrain({ speech: false, tools: true });
  const { gateway, base } = await startGateway(brain, {}, { concurrentPerClient: 5 });
  try {
    const client = connect(base, (await issue(base)).token);
    await client.opened();
    await ready(client);
    assert.deepEqual(await client.command({ kind: 'send', text: '일정 하나 잡아 줘' }), { ok: true });
    const draft = (await phase(client, 'awaiting_approval')).snapshot.tools.draft;
    assert.deepEqual(await client.command({ kind: 'reject', draftId: draft.draftId }), { ok: true });
    await turnDone(client);
    assert.equal(brain.state.turns.filter(item => item.kind === 'tool.resolved').at(-1).payload.state, 'unavailable');
    assert.equal(brain.state.registrations.length, 0);
    assert.deepEqual(await client.command({ kind: 'reject', draftId: draft.draftId }), { ok: false, code: 'invalid_request' });
    client.socket.close();
  } finally { await gateway.close(); await brain.close(); }

  const bad = await startMockBrain({ speech: false, tools: true, badArguments: true });
  const { gateway: gateway2, base: base2 } = await startGateway(bad);
  try {
    const client = connect(base2, (await issue(base2)).token);
    await client.opened();
    await ready(client);
    assert.deepEqual(await client.command({ kind: 'send', text: '일정 잡아 줘' }), { ok: true });
    const unavailable = await phase(client, 'unavailable');
    assert.equal(unavailable.snapshot.tools.errorCode, 'external_proposal_invalid');
    await turnDone(client);
    assert.equal(bad.state.turns.filter(item => item.kind === 'tool.resolved').at(-1).payload.state, 'unavailable');
    assert.equal(bad.state.registrations.length, 0);
    client.socket.close();
  } finally { await gateway2.close(); await bad.close(); }
});

test('proactive cards: an approved event that starts soon yields one card, withdrawn when it starts', () => {
  let now = Date.parse('2026-09-18T10:00:00+09:00');
  let changes = 0;
  const proactive = new DemoProactive({ changed: () => { changes += 1; }, now: () => now, tickMs: 60 * 60 * 1000, calendarLabel: '내 캘린더' });
  const receipt = { status: 'succeeded', draftId: 'draft-1', created: null };
  const event = at => ({ summary: '스트레칭', start: { dateTime: at, timeZone: 'Asia/Seoul' }, end: { dateTime: at, timeZone: 'Asia/Seoul' }, description: '', location: '' });
  // Too far ahead: watched, no card yet. Past or failed or all-day: ignored.
  proactive.record(receipt, event('2026-09-18T11:00:00+09:00'));
  proactive.record({ ...receipt, status: 'failed' }, event('2026-09-18T10:05:00+09:00'));
  proactive.record(receipt, { ...event('2026-09-18T09:00:00+09:00') });
  proactive.record(receipt, { ...event('2026-09-18T10:05:00+09:00'), start: { date: '2026-09-18' } });
  assert.deepEqual(proactive.snapshot(), { available: true, watching: 1, cards: [] });
  assert.equal(changes, 0);
  // Within the lead window: one card, once.
  proactive.record({ ...receipt, draftId: 'draft-2' }, event('2026-09-18T10:10:00+09:00'));
  let cards = proactive.snapshot().cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].text, CALENDAR_CARD_TEXT);
  assert.equal(cards[0].quote, '스트레칭');
  assert.equal(cards[0].title, '내 캘린더 · 오전 10:10');
  assert.equal(cards[0].expiresAt, Date.parse('2026-09-18T10:10:00+09:00'));
  assert.equal(changes, 1);
  proactive.record({ ...receipt, draftId: 'draft-2' }, event('2026-09-18T10:10:00+09:00'));
  assert.equal(proactive.snapshot().cards.length, 1);
  // Dismiss removes it and it does not come back; the far event becomes a card once time moves on.
  assert.deepEqual(proactive.dismiss('nope'), { ok: false, code: 'invalid_request' });
  assert.deepEqual(proactive.dismiss(cards[0].id), { ok: true });
  assert.equal(proactive.snapshot().cards.length, 0);
  now = Date.parse('2026-09-18T10:50:00+09:00');
  proactive.record({ ...receipt, draftId: 'draft-3' }, event('2026-09-18T12:00:00+09:00'));
  cards = proactive.snapshot().cards;
  assert.deepEqual(cards.map(card => card.quote + '@' + card.title), ['스트레칭@내 캘린더 · 오전 11:00']);
  // The card is withdrawn when the event starts, and the event is no longer watched.
  now = Date.parse('2026-09-18T11:00:00+09:00');
  proactive.record({ ...receipt, draftId: 'draft-4' }, event('2026-09-18T11:05:00+09:00'));
  cards = proactive.snapshot().cards;
  assert.deepEqual(cards.map(card => card.quote + '@' + card.title), ['스트레칭@내 캘린더 · 오전 11:05']);
  assert.equal(proactive.snapshot().watching, 2);
  proactive.dispose();
  assert.deepEqual(proactive.snapshot().cards, []);
});

test('proactive cards reach the browser after an approval and can be dismissed', async () => {
  const soon = new Date(Date.now() + 5 * 60_000);
  const iso = offset => { const d = new Date(soon.getTime() + offset); d.setMilliseconds(0); return d.toISOString().replace(/\.000Z$/, '+00:00'); };
  const brain = await startMockBrain({ speech: false, tools: true,
    calendarArguments: { summary: '스트레칭', start: { dateTime: iso(0) }, end: { dateTime: iso(60_000 * 30) }, description: '', location: '' } });
  const { gateway, base } = await startGateway(brain);
  try {
    const session = await issue(base);
    const client = connect(base, session.token);
    await client.opened();
    const first = await ready(client);
    assert.deepEqual(first.snapshot.proactive, { available: true, watching: 0, cards: [] });
    assert.deepEqual(await client.command({ kind: 'send', text: '5분 뒤 스트레칭 일정 추가해 줘' }), { ok: true });
    const awaiting = await phase(client, 'awaiting_approval');
    assert.deepEqual(await client.command({ kind: 'approve', draftId: awaiting.snapshot.tools.draft.draftId }), { ok: true });
    const withCard = await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.proactive.cards.length === 1);
    const card = withCard.snapshot.proactive.cards[0];
    assert.equal(card.kind, 'calendar');
    assert.equal(card.quote, '스트레칭');
    assert.equal(card.text, CALENDAR_CARD_TEXT);
    assert.equal(withCard.snapshot.proactive.watching, 1);
    assert.deepEqual(await client.command({ kind: 'dismiss', cardId: 'nope' }), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await client.command({ kind: 'dismiss', cardId: card.id }), { ok: true });
    await client.waitFor(item => item.kind === 'snapshot' && item.snapshot.proactive.cards.length === 0 && item.snapshot.proactive.watching === 1);
    client.socket.close();
  } finally { await gateway.close(); await brain.close(); }
});
