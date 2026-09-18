// Host side of Kirian's calendar tool for one visitor turn: offers the calendar tool to the Brain, turns the
// model's proposal into an exact draft, waits for the visitor's approval, runs the configured executor and
// registers the result so the Brain can summarise. The model never executes anything; the executor does,
// and only after an explicit approval of this exact draft.
import { createHash, randomUUID } from 'node:crypto';
import { parseMessage, type ProtocolMessage } from '@kirian/contracts';
import { calendarProposal } from '../../desktop/src/main/external/calendar-proposals.js';
import { canonicalJson } from '../../desktop/src/main/external/external-executor.js';
import { normalizeFields, type GoogleEventFields } from '../../desktop/src/main/external/google-calendar.js';
import type { CalendarView } from '../../desktop/src/shared/external.js';
import type { CommandResult } from '../../desktop/src/shared/bridge.js';
import { buildHandoff, type HandoffResult } from './handoff.js';

type Start = Extract<ProtocolMessage, { kind: 'turn.start' }>;
type Proposed = Extract<ProtocolMessage, { kind: 'tool.proposed' }>;

export interface DemoDraft {
  draftId: string;
  proposalId: string;
  event: GoogleEventFields;
  calendarLabel: string;
  timeZone: string;
  expiresAt: number;
}

export interface DemoReceipt {
  status: 'succeeded' | 'failed';
  executorKind: string;
  draftId: string;
  executionId: string;
  providerOperationId: string | null;
  recordedAt: number;
  errorCode: string | null;
  /** What the visitor can act on or verify: a hand-off, or a created event with its read-back. */
  handoff: HandoffResult | null;
  created: { eventId: string; htmlLink: string | null; calendarLabel: string; readBack: boolean } | null;
}

export interface DemoToolsState {
  available: boolean;
  phase: 'off' | 'ready' | 'preparing' | 'awaiting_approval' | 'running' | 'summarizing' | 'finished' | 'unavailable';
  draft: DemoDraft | null;
  receipt: DemoReceipt | null;
  errorCode: string | null;
}

export interface ExecutionOutcome {
  providerOperationId: string;
  /** Registered with the Brain as the tool result (bounded JSON, no secrets, no ICS text). */
  result: Record<string, unknown>;
  handoff: HandoffResult | null;
  created: DemoReceipt['created'];
}

export interface CalendarExecutor {
  kind: 'handoff' | 'google_demo';
  accountId: string;
  calendar: CalendarView;
  /** Boundary of the executed result: 'local' for a hand-off, 'cloud' when a Google account was written. */
  boundary: 'local' | 'cloud';
  execute(event: GoogleEventFields, draftId: string): Promise<ExecutionOutcome>;
  /** Adjusts the proposed fields before the visitor sees them (e.g. a public prefix); the approved draft is what runs. */
  decorate?(event: GoogleEventFields): GoogleEventFields;
  /** Upcoming events of the calendar for a public view. */
  listUpcoming?(): Promise<{ id: string; summary: string; start: GoogleEventFields['start']; end: GoogleEventFields['end'] }[]>;
  /** Removes expired demo events; returns how many were deleted. */
  sweep?(initial?: boolean): Promise<number>;
  /** Deletes the given events this executor created (a visitor ending the demo early); returns how many were deleted. */
  deleteCreated?(eventIds: string[]): Promise<number>;
}

export interface DemoCalendarDependencies {
  identity: { instance_id: string; mode: string; principal_id: string };
  request(path: string, method?: string, body?: unknown): Promise<unknown>;
  send(messages: ProtocolMessage[]): CommandResult;
  changed(): void;
  executor: CalendarExecutor;
  approvalMs?: number;
  now?: () => number;
  /** Observes every execution outcome with the approved draft (used for proactive cards). */
  executed?(receipt: DemoReceipt, event: GoogleEventFields): void;
}

interface ActiveTurn {
  start: Start;
  /** The visitor's message for this turn (relative-time repair only). */
  text: string;
  contextId: string | null;
  sourceRefs: { source_id: string; revision: number }[];
  offer: { offer_id: string; display_name: string; description: string; input_schema_json: string; provider_kind: 'google_calendar' };
  proposed: Proposed | null;
  draft: DemoDraft | null;
  timer: ReturnType<typeof setTimeout> | null;
  resolved: boolean;
}

const TOOL_NAME = 'calendar.create';
const CONNECTION_ID = 'demo-calendar';
const CONNECTION_GENERATION = 'demo-1';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const ok: CommandResult = { ok: true };
const failure = (code: Extract<CommandResult, { ok: false }>['code']): CommandResult => ({ ok: false, code });

/** The hand-off executor: writes nothing, prepares a Google Calendar link and an .ics for the visitor. */
// Gemma occasionally sends a timed draft whose end is missing or equal to its start although the tool description
// asks for "one hour after the start". The demo repairs only that case before validation; anything else still fails.
export function repairDraftArguments(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  const start = data.start as Record<string, unknown> | undefined;
  if (!start || typeof start !== 'object' || typeof start.dateTime !== 'string') return value;
  const startMs = Date.parse(start.dateTime);
  const end = data.end as Record<string, unknown> | undefined;
  const endMs = end && typeof end === 'object' && typeof end.dateTime === 'string' ? Date.parse(end.dateTime) : NaN;
  if (!Number.isFinite(startMs) || (Number.isFinite(endMs) && endMs > startMs)) return value;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(start.dateTime);
  if (!match) return value;
  // Shift the wall-clock time by one hour keeping the same offset text.
  const [, local, offset] = match;
  const shifted = new Date(Date.parse(local + 'Z') + 3_600_000).toISOString().slice(0, 19);
  return { ...data, end: { ...(end && typeof end === 'object' ? end : {}), dateTime: shifted + offset } };
}

// "10분 뒤" / "2시간 후": the model computes the clock time from the prompt and is off by ten minutes or an hour
// often enough to break the demo's "starts soon" step. When the visitor's own words fix the offset, the draft's
// start is snapped to now + offset (duration kept); anything else is left to the model.
export function repairRelativeStart(text: string, value: unknown, now: number): unknown {
  const match = /(\d{1,3})\s*(분|시간)\s*(뒤|후)/.exec(text);
  if (!match || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  const start = data.start as Record<string, unknown> | undefined, end = data.end as Record<string, unknown> | undefined;
  if (!start || typeof start !== 'object' || typeof start.dateTime !== 'string') return value;
  const startMs = Date.parse(start.dateTime);
  if (!Number.isFinite(startMs)) return value;
  const offsetMs = Number(match[1]) * (match[2] === '시간' ? 3_600_000 : 60_000);
  const target = Math.round((now + offsetMs) / 60_000) * 60_000;
  const delta = target - startMs;
  if (Math.abs(delta) <= 2 * 60_000) return value;
  const shift = (time: Record<string, unknown> | undefined) => {
    if (!time || typeof time !== 'object' || typeof time.dateTime !== 'string') return time;
    const parsed = /^(.*T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(time.dateTime);
    if (!parsed) return time;
    const offsetMinutes = parsed[2] === 'Z' ? 0 : (parsed[2]!.startsWith('-') ? -1 : 1) * (Number(parsed[2]!.slice(1, 3)) * 60 + Number(parsed[2]!.slice(4, 6)));
    const local = new Date(Date.parse(time.dateTime) + delta + offsetMinutes * 60_000).toISOString().slice(0, 19);
    return { ...time, dateTime: local + parsed[2] };
  };
  return { ...data, start: shift(start), end: shift(end) };
}

export function handoffExecutor(calendar: CalendarView, now: () => number = Date.now): CalendarExecutor {
  return {
    kind: 'handoff', accountId: 'visitor-own-calendar', calendar, boundary: 'local',
    async execute(event, draftId) {
      const handoff = buildHandoff(event, draftId, calendar.timeZone, new Date(now()));
      return {
        providerOperationId: 'handoff:' + draftId,
        // The summary turn sees this as data; a plain Korean status keeps a small model from re-asking.
        result: { kind: 'calendar_handoff', status: 'ready_for_user_to_save', summary: event.summary, start: event.start, end: event.end,
          location: event.location, timeZone: calendar.timeZone, icsFileName: handoff.icsFileName,
          status_message: '승인하신 일정을 화면의 "Google 캘린더에서 저장"과 ".ics 받기" 버튼으로 준비했어요. 저장은 버튼을 눌러 본인 캘린더에서 직접 하시면 되고, 서버가 캘린더에 쓴 것은 없어요.' },
        handoff, created: null,
      };
    },
  };
}

export class DemoCalendarTools {
  private state: DemoToolsState = { available: true, phase: 'ready', draft: null, receipt: null, errorCode: null };
  private active: ActiveTurn | null = null;
  private readonly now: () => number;
  constructor(private readonly deps: DemoCalendarDependencies) { this.now = deps.now ?? Date.now; }

  snapshot(): DemoToolsState { return structuredClone(this.state); }

  /** Called with the turn.start the session is about to send with external_tools on. */
  begin(start: Start, text = ''): void {
    this.clear();
    const proposal = calendarProposal(TOOL_NAME, this.deps.executor.calendar);
    this.active = { start: structuredClone(start), text, contextId: null, sourceRefs: [], proposed: null, draft: null, timer: null, resolved: false,
      offer: { offer_id: 'demo-offer-' + randomUUID(), display_name: proposal.displayName, description: proposal.description,
        input_schema_json: proposal.inputSchemaJson, provider_kind: 'google_calendar' } };
    this.state = { ...this.state, phase: 'preparing', draft: null, receipt: this.state.receipt, errorCode: null };
    this.deps.changed();
  }

  /** Every accepted Brain message for the session passes through here. */
  receive(message: ProtocolMessage): void {
    const active = this.active;
    if (!active || message.turn_id !== active.start.turn_id) return;
    if (message.kind === 'turn.ended' || message.kind === 'turn.cancel') {
      const completed = message.kind === 'turn.ended' && message.payload.status === 'completed';
      const receipt = this.state.receipt;
      this.clear();
      this.state = { ...this.state, phase: completed && receipt ? 'finished' : 'ready', draft: null, receipt, errorCode: this.state.errorCode };
      this.deps.changed();
      return;
    }
    if (message.kind === 'tool.context') {
      if (active.contextId) return;
      active.contextId = message.payload.context_id;
      void this.offer(active).catch(() => this.fail(active, 'external_context_unavailable'));
    } else if (message.kind === 'tool.proposed') {
      if (active.proposed) return;
      active.proposed = structuredClone(message);
      this.propose(active, message);
    }
  }

  approve(draftId: unknown): Promise<CommandResult> {
    const active = this.active;
    if (!active?.draft || active.resolved || active.draft.draftId !== draftId) return Promise.resolve(failure('invalid_request'));
    if (this.now() >= active.draft.expiresAt) return Promise.resolve(failure('source_changed'));
    active.resolved = true;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    this.state = { ...this.state, phase: 'running' };
    this.deps.changed();
    return this.execute(active).then(() => ok);
  }

  reject(draftId: unknown): CommandResult {
    const active = this.active;
    if (!active?.draft || active.resolved || active.draft.draftId !== draftId || !active.proposed) return failure('invalid_request');
    active.resolved = true;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    this.resolve(active, { proposal_id: active.proposed.payload.proposal_id, state: 'unavailable' });
    this.state = { ...this.state, phase: 'summarizing', draft: null };
    this.deps.changed();
    return ok;
  }

  dispose(): void { this.clear(); this.state = { ...this.state, phase: 'off', draft: null }; }

  private clear(): void {
    if (this.active?.timer) clearTimeout(this.active.timer);
    this.active = null;
  }

  private async offer(active: ActiveTurn): Promise<void> {
    const observed = await this.deps.request('v1/external-tools/turns/' + active.contextId) as Record<string, unknown>;
    if (this.active !== active) return;
    if (observed.state !== 'awaiting_offers' || !Array.isArray(observed.source_refs)) throw new Error('external_observation_mismatch');
    active.sourceRefs = structuredClone(observed.source_refs) as ActiveTurn['sourceRefs'];
    this.sendMessage(active, 'tool.offers', { context_id: active.contextId, offers: [active.offer] });
  }

  private propose(active: ActiveTurn, message: Proposed): void {
    let event: GoogleEventFields;
    try {
      if (message.payload.offer_id !== active.offer.offer_id || message.payload.provider_kind !== 'google_calendar') throw new Error('offer_mismatch');
      const raw = message.payload.arguments_json;
      if (raw.length > 8192) throw new Error('arguments_too_large');
      event = normalizeFields(repairRelativeStart(active.text, repairDraftArguments(JSON.parse(raw)), this.now()));
      if (this.deps.executor.decorate) event = normalizeFields(this.deps.executor.decorate(event));
    } catch {
      this.fail(active, 'external_proposal_invalid');
      return;
    }
    const approvalMs = this.deps.approvalMs ?? 120_000;
    active.draft = { draftId: randomUUID(), proposalId: message.payload.proposal_id, event, calendarLabel: this.deps.executor.calendar.label,
      timeZone: this.deps.executor.calendar.timeZone, expiresAt: this.now() + approvalMs };
    active.timer = setTimeout(() => {
      if (this.active !== active || active.resolved) return;
      active.resolved = true;
      this.resolve(active, { proposal_id: message.payload.proposal_id, state: 'unavailable' });
      this.state = { ...this.state, phase: 'summarizing', draft: null, errorCode: 'external_proposal_expired' };
      this.deps.changed();
    }, approvalMs);
    this.state = { ...this.state, phase: 'awaiting_approval', draft: structuredClone(active.draft), errorCode: null };
    this.deps.changed();
  }

  private async execute(active: ActiveTurn): Promise<void> {
    const draft = active.draft!, proposed = active.proposed!;
    const executionId = randomUUID();
    const plan = { provider: 'google_calendar', accountId: this.deps.executor.accountId, calendarId: this.deps.executor.calendar.id,
      operation: 'create', event: draft.event };
    const payloadSha256 = sha(canonicalJson(plan));
    let receipt: DemoReceipt;
    let registration: { sourceRef: { source_id: string; revision: number } } | null = null;
    try {
      const outcome = await this.deps.executor.execute(draft.event, draft.draftId);
      if (this.active !== active) return;
      const resultJson = canonicalJson(outcome.result);
      const metadata = { offerId: active.offer.offer_id, connectionId: CONNECTION_ID, connectionGeneration: CONNECTION_GENERATION,
        accountId: this.deps.executor.accountId, toolName: TOOL_NAME, toolFingerprint: sha(canonicalJson(active.offer)),
        boundary: this.deps.executor.boundary, providerKind: 'google_calendar' as const };
      const recordedAt = this.now();
      const body = {
        provenance: { identity: this.deps.identity, scope: proposed.scope, turnId: proposed.turn_id, intentId: proposed.intent_id,
          proposalId: proposed.payload.proposal_id, draftId: draft.draftId, draftRevision: 1, payloadSha256, executionId,
          providerOperationId: outcome.providerOperationId, parents: active.sourceRefs, offeredMetadata: [metadata],
          rawResultSha256: sha(resultJson), canonicalResultSha256: sha(resultJson), ...metadata },
        receipt: { execution_id: executionId, draft_id: draft.draftId, draft_revision: 1, identity: this.deps.identity, executor_id: 'kirian-external-v1',
          payload_sha256: payloadSha256, status: 'succeeded', provider_id: 'google_calendar', provider_operation_id: outcome.providerOperationId,
          error_code: null, recorded_at_ms: recordedAt },
        rawResultJson: resultJson, canonicalResultJson: resultJson,
      };
      registration = await this.deps.request('v1/external-tools/results', 'POST', body) as typeof registration;
      if (this.active !== active) return;
      receipt = { status: 'succeeded', executorKind: this.deps.executor.kind, draftId: draft.draftId, executionId, providerOperationId: outcome.providerOperationId,
        recordedAt, errorCode: null, handoff: outcome.handoff, created: outcome.created };
    } catch (error) {
      if (this.active !== active) return;
      receipt = { status: 'failed', executorKind: this.deps.executor.kind, draftId: draft.draftId, executionId, providerOperationId: null,
        recordedAt: this.now(), errorCode: error instanceof Error && error.message ? error.message.slice(0, 64) : 'execution_failed', handoff: null, created: null };
    }
    const succeeded = receipt.status === 'succeeded' && registration !== null;
    if (succeeded) this.deps.executed?.(receipt, draft.event);
    this.resolve(active, { proposal_id: proposed.payload.proposal_id, state: succeeded ? 'succeeded' : 'failed',
      ...(succeeded ? { source_ref: registration!.sourceRef } : {}) });
    this.state = { ...this.state, phase: 'summarizing', draft: null, receipt, errorCode: succeeded ? null : receipt.errorCode };
    this.deps.changed();
  }

  private resolve(active: ActiveTurn, payload: Record<string, unknown>): void {
    this.sendMessage(active, 'tool.resolved', payload);
  }

  private sendMessage(active: ActiveTurn, kind: string, payload: unknown): void {
    const message = parseMessage({ protocol: 'kirian.rearchitecture.v1', scope: active.start.scope, turn_id: active.start.turn_id,
      intent_id: active.start.intent_id, message_id: randomUUID(), request_id: randomUUID(), sequence: 0, kind, payload });
    const result = this.deps.send([message]);
    if (!result.ok) this.fail(active, 'external_send_failed');
  }

  private fail(active: ActiveTurn, code: string): void {
    if (this.active !== active) return;
    // The turn keeps running as plain text on the Brain side; the host just stops offering anything.
    if (active.proposed && !active.resolved) {
      active.resolved = true;
      try { this.resolve(active, { proposal_id: active.proposed.payload.proposal_id, state: 'unavailable' }); } catch { /* already failed */ }
    }
    this.clear();
    this.state = { ...this.state, phase: 'unavailable', draft: null, errorCode: code };
    this.deps.changed();
  }
}
