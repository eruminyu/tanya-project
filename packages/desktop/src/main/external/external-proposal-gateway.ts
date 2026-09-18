import { createHash } from 'node:crypto';
import {
  assertDefinition, digestAction, sameIdentity, sameModel,
  type Scope, type Identity, type ModelRef, type RoutingReason,
  type SourceRef, type SourceRecord, type ExecutionReceipt,
} from '@kirian/contracts';
import { calendarOperation } from './calendar-proposals.js';
import { normalizeFields } from './google-calendar.js';
import type { CalendarView, ExternalActionView } from '../../shared/external.js';
import { canonicalJson } from './external-executor.js';

/** An unconnected main-process seam. This is not a wire/provider parser or an approval adapter.
 * Candidates, completed-call evidence and effective source availability must come from trusted
 * host adapters. Descriptions, schemas, arguments and results remain untrusted data.
 */
export const proposalLimits = Object.freeze({ offers: 16, offerBytes: 32768, schemaBytes: 8192,
  argumentBytes: 16384, resultBytes: 65536, contextBytes: 32768, sources: 128,
  records: 256, ttlMs: 600000, envelopeBytes: 131072 });
type Boundary = 'local' | 'private_lan' | 'cloud';
export interface HostCompletedCallEvidence {
  kind: 'single_mcp_tool_call' | 'single_google_calendar_call'; explicitlySupported: true;
  requestId: string; proposalId: string; offerId: string; canonicalArgumentsSha256: string;
  observedModel: ModelRef;
}
export interface HostTurnEvidence {
  scope: Scope; turnId: string; intentId: string; epoch: number; sourceEpoch: number;
  active: boolean; toolsEnabled: boolean; brainDestination: 'loopback' | 'remote';
  /** The resolved, authorized decision for this turn; never the latest UI model.
   * modelAuthorized includes the approved endpoint/provider and allowed-model checks. */
  expectedModel: ModelRef; modelAuthorized: boolean; modelBoundary: Boundary;
  routingReason?: RoutingReason;
  /** Complete actually-used provenance, including history and retrieved sources. */
  sourceRefs: SourceRef[];
  completedCall: HostCompletedCallEvidence | null;
}
export interface HostToolCandidate {
  kind: 'mcp' | 'google_calendar'; calendar?: CalendarView; connectionId: string; generation: string; accountId: string;
  toolName: string; fingerprint: string; target: string; accountLabel: string;
  /** Explicit host policy, never inferred from stdio, URL, description or hints. */
  approvedArgumentBoundary: Boundary | null;
  metadataBoundary: Boundary; resultBoundary: Boundary;
  displayName: string; description: string; inputSchemaJson: string;
}
export interface ToolOffer {
  provider_kind?: 'mcp' | 'google_calendar'; offer_id: string; display_name: string; description: string; input_schema_json: string;
}
/** Already-normalized, completed single-call data from a future authenticated main adapter.
 * No raw text, fragments, or implicit tool-support fallback are accepted here. */
export interface NormalizedToolProposal {
  provider_kind: 'mcp' | 'google_calendar'; scope: Scope; turn_id: string; intent_id: string; request_id: string;
  proposal_id: string; offer_id: string; arguments_json: string;
  actual_model: ModelRef; routing_reason?: RoutingReason; source_refs: SourceRef[];
}
export interface HostProposalOrigin {
  scope: Scope; turnId: string; intentId: string; requestId: string;
  proposalId: string; offerId: string; epoch: number; sourceEpoch: number;
  sourceRefs: SourceRef[]; expectedModel: ModelRef; routingReason?: RoutingReason;
  expiresAtMs: number;
}
export interface HostOfferedMetadata {
  providerKind?: 'mcp' | 'google_calendar';
  offerId: string; connectionId: string; connectionGeneration: string; accountId: string;
  toolName: string; toolFingerprint: string; boundary: Boundary;
}
export interface HostResultProvenance {
  providerKind?: 'mcp' | 'google_calendar';
  identity: Identity; scope: Scope; turnId: string; intentId: string;
  proposalId: string; offerId: string; draftId: string; draftRevision: number;
  payloadSha256: string; executionId: string; providerOperationId: string;
  connectionId: string; connectionGeneration: string; accountId: string;
  toolName: string; toolFingerprint: string; boundary: Boundary; parents: SourceRef[];
  offeredMetadata: HostOfferedMetadata[];
  rawResultSha256: string; canonicalResultSha256: string;
}
/** Future host registration contract only. Common SourceRecord has no tool_result kind yet. */
export interface HostRegisteredToolResult {
  kind: 'tool_result'; sourceRef: SourceRef; identity: Identity;
  boundary: Boundary; parents: SourceRef[]; text: string;
  rawResultSha256: string; canonicalResultSha256: string;
}
export interface HostReceiptState { receipt: ExecutionReceipt | null; resultJson: string | null; }
export interface ReceiptView {
  state: 'pending' | 'succeeded' | 'failed' | 'unknown' | 'unavailable';
  receipt: ExecutionReceipt | null;
  /** A current snapshot, not permission to resume a conversation or execute anything. */
  attached: boolean;
  provenance: HostResultProvenance | null; registration: HostRegisteredToolResult | null;
  errorCode: string | null;
}
export interface GatewayDependencies {
  executorId: string;
  clock(): { wallMs: number; monotonicMs: number };
  newId(): string;
  currentTurn(): HostTurnEvidence | null;
  /** Only user-selected, connected candidates. This must not discover or select accounts. */
  toolCandidates(): readonly HostToolCandidate[];
  isCandidateCurrent(candidate: HostToolCandidate): boolean;
  /** Authenticated effective catalog records, including unavailable/deleted overlays. */
  resolveSources(refs: readonly SourceRef[], guard: () => void): Promise<readonly SourceRecord[]>;
  /** Future adapter must also enforce origin at approval time; this gateway cannot do so.
   * It must honor guard before committing and clamp the draft expiry to origin.expiresAtMs. */
  previewTool(input: { kind: 'mcp' | 'google_calendar'; connectionId: string; toolName: string; argumentsJson: string },
    origin: HostProposalOrigin, guard: () => void): Promise<ExternalActionView>;
  cancelDraft(draftId: string): Promise<void>;
  /** Local durable ledger lookup only. Never execute, reconcile, or retry a remote call. */
  lookupReceipt(draftId: string): Promise<HostReceiptState>;
  /** Optional and currently unconnected. Must honor guard before a source-store commit
   * and register canonicalResultJson verbatim as the source text, without summarizing. */
  registerResult?(input: { provenance: HostResultProvenance; rawResultJson: string; canonicalResultJson: string },
    guard: () => void): Promise<HostRegisteredToolResult>;
}
interface Lease {
  turn: HostTurnEvidence; deadline: number; expiresAtMs: number; alive: boolean;
  metadataBoundary: Boundary;
  offers: ToolOffer[]; candidates: Map<string, HostToolCandidate>; proposalId: string | null;
}
interface ProposalEntry {
  input: NormalizedToolProposal; fingerprint: string; lease: Lease; candidate: HostToolCandidate;
  origin: HostProposalOrigin; detached: boolean; action: ExternalActionView | null;
  createdDraftId?: string;
  promise: Promise<ExternalActionView>; cancelPromise?: Promise<void>;
  receiptPromise?: Promise<ReceiptView>; executionId?: string;
  terminal?: HostReceiptState; registrationAttempted: boolean;
  registration: HostRegisteredToolResult | null; registrationError: string | null;
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/;
const hashPattern = /^[a-f0-9]{64}$/;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const copy = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
class GatewayError extends Error { constructor(code: string) { super('external_' + code); } }
function fail(code: string): never { throw new GatewayError(code); }
function safeError(error: unknown): Error { return error instanceof GatewayError ? error : new GatewayError('gateway_dependency_failed'); }
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) fail('invalid_proposal');
}
function text(value: unknown, limit: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value, 'utf8') > limit
    || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) fail('proposal_limit');
}
function boundary(value: unknown): asserts value is Boundary {
  if (!['local', 'private_lan', 'cloud'].includes(String(value))) fail('unapproved_boundary');
}
function allowed(source: Boundary, destination: Boundary): boolean {
  return source === 'cloud' || source === destination || source === 'private_lan' && destination === 'local';
}
function strictest(levels: readonly Boundary[]): Boundary {
  return levels.includes('local') ? 'local' : levels.includes('private_lan') ? 'private_lan' : 'cloud';
}
function refs(value: unknown): SourceRef[] {
  if (!Array.isArray(value) || value.length > proposalLimits.sources) fail('invalid_sources');
  const seen = new Set<string>();
  for (const ref of value) {
    assertDefinition('SourceRef', ref);
    if (seen.has(ref.source_id)) fail('invalid_sources');
    seen.add(ref.source_id);
  }
  return copy(value).sort((a, b) => a.source_id.localeCompare(b.source_id));
}
function frozen<T>(value: T): T {
  const result = copy(value);
  const freeze = (item: unknown) => {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(result); return result;
}

export class ExternalProposalGateway {
  private lease: Lease | null = null;
  private monotonic = -1;
  private readonly entries = new Map<string, ProposalEntry>();
  private readonly issuedTurns = new Set<string>();
  private offersPending: { key: string; promise: Promise<readonly ToolOffer[]> } | null = null;
  constructor(private readonly deps: GatewayDependencies) { id(deps.executorId); }

  offers(): Promise<readonly ToolOffer[]> {
    try {
      const turn = this.turn();
      const key = canonicalJson([turn.scope, turn.turnId, turn.intentId, turn.epoch, turn.sourceEpoch,
        turn.expectedModel, turn.modelBoundary, turn.routingReason ?? null]);
      if (this.offersPending) {
        if (this.offersPending.key !== key) fail('offer_busy');
        return this.offersPending.promise;
      }
      const promise = this.issueOffers(); this.offersPending = { key, promise };
      void promise.finally(() => { if (this.offersPending?.promise === promise) this.offersPending = null; }).catch(() => {});
      return promise;
    } catch (error) { return Promise.reject(safeError(error)); }
  }

  private async issueOffers(): Promise<readonly ToolOffer[]> {
    try {
    const turn = this.turn(), clock = this.clock();
    if (this.lease && this.sameTurn(this.lease.turn, turn) && this.lease.alive) {
      this.checkLease(this.lease); return frozen(this.lease.offers);
    }
    const key = canonicalJson([turn.scope, turn.turnId, turn.intentId]);
    if (this.issuedTurns.has(key)) fail('retired_turn');
    if (this.issuedTurns.size >= proposalLimits.records) fail('proposal_limit');
    this.issuedTurns.add(key);
    if (this.lease) {
      this.lease.alive = false;
      const old = this.lease.proposalId && this.entries.get(this.lease.proposalId);
      if (old) await this.detach(old);
    }
    const candidates = copy(this.deps.toolCandidates());
    if (!Array.isArray(candidates) || candidates.length > proposalLimits.offers) fail('proposal_limit');
    const lease: Lease = { turn, deadline: clock.monotonicMs + proposalLimits.ttlMs,
      expiresAtMs: clock.wallMs + proposalLimits.ttlMs, alive: true, metadataBoundary: 'cloud',
      offers: [], candidates: new Map(), proposalId: null };
    const names = new Set<string>();
    for (const candidate of candidates) {
      if (!['mcp','google_calendar'].includes(candidate.kind)) fail('unsupported_tool');
      for (const value of [candidate.connectionId, candidate.generation, candidate.accountId]) id(value);
      text(candidate.toolName, 512); text(candidate.displayName, 640); text(candidate.description, 2048, true);
      text(candidate.target, 2048); text(candidate.accountLabel, 1200);
      text(candidate.inputSchemaJson, proposalLimits.schemaBytes);
      if ([...candidate.displayName].length > 160 || !hashPattern.test(candidate.fingerprint)) fail('invalid_offer');
      const schema = JSON.parse(candidate.inputSchemaJson);
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('invalid_offer');
      canonicalJson(schema); // Metadata only: no schema compilation or remote $ref resolution.
      boundary(candidate.metadataBoundary); boundary(candidate.resultBoundary);
      if (candidate.approvedArgumentBoundary !== null) boundary(candidate.approvedArgumentBoundary);
      if (!allowed(candidate.metadataBoundary, turn.modelBoundary)) fail('context_blocked');
      if (!this.deps.isCandidateCurrent(copy(candidate))) fail('stale_offer');
      const name = candidate.connectionId + '\0' + candidate.toolName;
      if (names.has(name)) fail('invalid_offer'); names.add(name);
      const offerId = this.deps.newId(); id(offerId);
      if (lease.candidates.has(offerId)) fail('invalid_offer');
      lease.candidates.set(offerId, candidate);
      lease.metadataBoundary = strictest([lease.metadataBoundary, candidate.metadataBoundary]);
      lease.offers.push({ ...(candidate.kind==='google_calendar'?{provider_kind:candidate.kind}:{}), offer_id: offerId, display_name: candidate.displayName,
        description: candidate.description, input_schema_json: candidate.inputSchemaJson });
    }
    if (Buffer.byteLength(canonicalJson(lease.offers)) > proposalLimits.offerBytes) fail('proposal_limit');
    this.checkLease(lease); this.lease = lease; return frozen(lease.offers);
    } catch (error) { throw safeError(error); }
  }

  preview(value: unknown): Promise<ExternalActionView> {
    try {
      const input = this.proposal(value), fingerprint = canonicalJson(input), previous = this.entries.get(input.proposal_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('proposal_conflict');
        this.guard(previous); return previous.promise;
      }
      const lease = this.lease, candidate = lease?.candidates.get(input.offer_id);
      if (!lease || !candidate) fail('unknown_offer');
      if(input.provider_kind!==candidate.kind) fail('unsupported_tool');
      this.checkLease(lease);
      if (!equal(input.scope, lease.turn.scope) || input.turn_id !== lease.turn.turnId || input.intent_id !== lease.turn.intentId) fail('stale_proposal');
      if (lease.proposalId !== null || this.entries.size >= proposalLimits.records) fail('proposal_limit');
      const turn = this.turn();
      const origin: HostProposalOrigin = { scope: copy(input.scope), turnId: input.turn_id, intentId: input.intent_id,
        requestId: input.request_id, proposalId: input.proposal_id, offerId: input.offer_id,
        epoch: turn.epoch, sourceEpoch: turn.sourceEpoch, sourceRefs: refs(turn.sourceRefs),
        expectedModel: copy(turn.expectedModel), ...(turn.routingReason === undefined ? {} : { routingReason: turn.routingReason }),
        expiresAtMs: lease.expiresAtMs };
      const entry: ProposalEntry = { input, fingerprint, lease, candidate, origin, detached: false, action: null,
        promise: undefined!, registrationAttempted: false, registration: null, registrationError: null };
      lease.proposalId = input.proposal_id; this.entries.set(input.proposal_id, entry);
      entry.promise = this.prepare(entry); return entry.promise;
    } catch (error) { return Promise.reject(safeError(error)); }
  }

  async cancel(proposalId: unknown): Promise<void> {
    try { await this.detach(this.entry(proposalId)); } catch (error) { throw safeError(error); }
  }

  receipt(proposalId: unknown): Promise<ReceiptView> {
    try {
      const entry = this.entry(proposalId);
      if (!entry.action) fail('receipt_unavailable');
      if (entry.receiptPromise) return entry.receiptPromise;
      const pending = this.collect(entry).catch(error => { throw safeError(error); });
      entry.receiptPromise = pending;
      void pending.finally(() => { if (entry.receiptPromise === pending) entry.receiptPromise = undefined; }).catch(() => {});
      return pending;
    } catch (error) { return Promise.reject(safeError(error)); }
  }

  private clock() {
    const value = this.deps.clock();
    if (!Number.isSafeInteger(value.wallMs) || value.wallMs < 0 || value.wallMs > Number.MAX_SAFE_INTEGER - proposalLimits.ttlMs
      || !Number.isFinite(value.monotonicMs) || value.monotonicMs < this.monotonic || value.monotonicMs < 0) fail('clock_changed');
    this.monotonic = value.monotonicMs; return { ...value };
  }
  private turn(): HostTurnEvidence {
    const raw = this.deps.currentTurn(); if (!raw) fail('stale_proposal');
    const turn = copy(raw); assertDefinition('Scope', turn.scope); assertDefinition('ModelRef', turn.expectedModel);
    id(turn.turnId); id(turn.intentId); boundary(turn.modelBoundary);
    if (turn.routingReason !== undefined) assertDefinition('RoutingReason', turn.routingReason);
    if (turn.scope.mode !== 'personal' || turn.brainDestination !== 'loopback') fail('local_brain_required');
    if (turn.active !== true || turn.toolsEnabled !== true || turn.modelAuthorized !== true) fail('tool_context_unavailable');
    if (![turn.epoch, turn.sourceEpoch].every(n => Number.isSafeInteger(n) && n >= 0)) fail('stale_proposal');
    turn.sourceRefs = refs(turn.sourceRefs); return turn;
  }
  private sameTurn(left: HostTurnEvidence, right: HostTurnEvidence): boolean {
    return equal(left.scope, right.scope) && left.turnId === right.turnId && left.intentId === right.intentId
      && left.epoch === right.epoch && left.sourceEpoch === right.sourceEpoch
      && sameModel(left.expectedModel, right.expectedModel) && left.modelBoundary === right.modelBoundary
      && equal(left.routingReason ?? null, right.routingReason ?? null);
  }
  private checkLease(lease: Lease): HostTurnEvidence {
    const turn = this.turn(), clock = this.clock();
    if (!lease.alive || !this.sameTurn(lease.turn, turn)) fail('stale_proposal');
    if (clock.monotonicMs >= lease.deadline || clock.wallMs >= lease.expiresAtMs) fail('proposal_expired');
    // The model saw every offered description/schema, not only the selected tool's metadata.
    for (const candidate of lease.candidates.values()) {
      if (!this.deps.isCandidateCurrent(copy(candidate))) fail('stale_offer');
    }
    return turn;
  }
  private guard(entry: ProposalEntry): void {
    if (entry.detached) fail('proposal_cancelled');
    const turn = this.checkLease(entry.lease);
    if (!equal(refs(turn.sourceRefs), entry.origin.sourceRefs)) fail('stale_proposal');
    const evidence = turn.completedCall;
    if (!evidence || evidence.kind !== (entry.candidate.kind==='mcp'?'single_mcp_tool_call':'single_google_calendar_call') || evidence.explicitlySupported !== true
      || evidence.requestId !== entry.input.request_id || evidence.proposalId !== entry.input.proposal_id
      || evidence.offerId !== entry.input.offer_id || evidence.canonicalArgumentsSha256 !== hash(entry.input.arguments_json)) fail('unverified_tool_call');
    assertDefinition('ModelRef', evidence.observedModel);
    if (!sameModel(turn.expectedModel, evidence.observedModel) || !sameModel(evidence.observedModel, entry.input.actual_model)
      || !equal(turn.routingReason ?? null, entry.input.routing_reason ?? null)) fail('model_mismatch');
    if (entry.candidate.approvedArgumentBoundary === null) fail('unapproved_boundary');
    if (!allowed(entry.lease.metadataBoundary, entry.candidate.approvedArgumentBoundary)) fail('context_blocked');
    if (entry.action && this.clock().wallMs >= entry.action.expiresAt) fail('proposal_expired');
  }
  private entry(value: unknown): ProposalEntry {
    id(value); const entry = this.entries.get(value); if (!entry) fail('unknown_proposal'); return entry;
  }
  private proposal(value: unknown): NormalizedToolProposal {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > proposalLimits.envelopeBytes) fail('proposal_limit');
    const input = JSON.parse(encoded) as NormalizedToolProposal;
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_proposal');
    if (!['mcp','google_calendar'].includes(input.provider_kind)) fail('unsupported_tool');
    const expected = ['provider_kind','scope','turn_id','intent_id','request_id','proposal_id','offer_id','arguments_json','actual_model','source_refs',
      ...(input.routing_reason === undefined ? [] : ['routing_reason'])].sort();
    if (Object.keys(input).sort().join() !== expected.join()) fail('invalid_proposal');
    for (const value of [input.turn_id,input.intent_id,input.request_id,input.proposal_id,input.offer_id]) id(value);
    assertDefinition('Scope', input.scope); assertDefinition('ModelRef', input.actual_model);
    if (input.routing_reason !== undefined) assertDefinition('RoutingReason', input.routing_reason);
    text(input.arguments_json, proposalLimits.argumentBytes);
    const args = JSON.parse(input.arguments_json);
    if (!args || typeof args !== 'object' || Array.isArray(args) || canonicalJson(args) !== input.arguments_json) fail('invalid_arguments');
    refs(input.source_refs); return input;
  }
  private async sources(entry: ProposalEntry): Promise<SourceRecord[]> {
    this.guard(entry);
    if (!equal(refs(entry.input.source_refs), entry.origin.sourceRefs)) fail('source_mismatch');
    const records = copy(await this.deps.resolveSources(copy(entry.origin.sourceRefs), () => this.guard(entry)));
    this.guard(entry);
    if (!Array.isArray(records) || records.length !== entry.origin.sourceRefs.length) fail('source_mismatch');
    const byId = new Map<string, SourceRecord>();
    for (const record of records) {
      assertDefinition('SourceRecord', record);
      const expected = entry.origin.sourceRefs.find(ref => ref.source_id === record.source_id);
      if (!expected || expected.revision !== record.revision || byId.has(record.source_id)
        || record.deleted || !sameIdentity(record.identity, entry.origin.scope)) fail('source_mismatch');
      const level = record.kind === 'screen' && record.boundary === 'cloud' ? 'private_lan' : record.boundary;
      if (!allowed(level, entry.lease.turn.modelBoundary) || entry.candidate.approvedArgumentBoundary === null
        || !allowed(level, entry.candidate.approvedArgumentBoundary)) fail('context_blocked');
      byId.set(record.source_id, record);
    }
    const heights = new Map<string, number>();
    const visit = (record: SourceRecord, path: Set<string>): number => {
      if (path.has(record.source_id) || path.size >= 64) fail('invalid_source_lineage');
      const known = heights.get(record.source_id);
      if (known !== undefined) {
        if (known + path.size > 64) fail('invalid_source_lineage');
        return known;
      }
      const next = new Set(path).add(record.source_id), parents = new Set<string>();
      let height = 1;
      for (const ref of record.parents) {
        const parent = byId.get(ref.source_id);
        if (!parent || parent.revision !== ref.revision || parents.has(ref.source_id)) fail('source_mismatch');
        parents.add(ref.source_id); height = Math.max(height, 1 + visit(parent, next));
      }
      heights.set(record.source_id, height); return height;
    };
    for (const record of records) visit(record, new Set());
    return records;
  }
  private async prepare(entry: ProposalEntry): Promise<ExternalActionView> {
    try {
      this.guard(entry);
      await this.sources(entry); this.guard(entry);
      const returned = await this.deps.previewTool({ kind: entry.candidate.kind, connectionId: entry.candidate.connectionId,
        toolName: entry.candidate.toolName, argumentsJson: entry.input.arguments_json }, copy(entry.origin), () => this.guard(entry));
      // Retain the ID before copying: even a malformed or late view must be cleaned up.
      const createdDraftId = returned.draftId; id(createdDraftId); entry.createdDraftId = createdDraftId;
      const result = copy(returned); entry.action = result;
      this.guard(entry);
      const operation=entry.candidate.kind==='mcp'?'tool-call':calendarOperation(entry.candidate.toolName), effect=entry.candidate.kind==='mcp'?'untrusted':'write';
      if (result.providerId !== entry.candidate.kind || result.connectionId !== entry.candidate.connectionId || result.status !== 'pending'
        || result.effect !== effect || result.operation !== operation || !hashPattern.test(result.payloadSha256)
        || !Number.isSafeInteger(result.revision) || result.revision < 1 || !Number.isSafeInteger(result.expiresAt)
        || result.expiresAt > entry.origin.expiresAtMs || result.expiresAt <= this.clock().wallMs
        || result.executionId !== null || result.resultJson !== null) fail('invalid_draft');
      text(result.argumentsJson, proposalLimits.envelopeBytes);
      const plan = JSON.parse(result.argumentsJson), candidate = entry.candidate;
      if (result.argumentsJson !== canonicalJson(plan) || result.accountLabel !== candidate.accountLabel || result.target !== candidate.target
        || plan.providerId !== candidate.kind || plan.connectionId !== candidate.connectionId || plan.generation !== candidate.generation
        || plan.fingerprint !== candidate.fingerprint || plan.accountId !== candidate.accountId || plan.label !== candidate.accountLabel
        || plan.target !== candidate.target || plan.operation !== operation || plan.effect !== effect
        || !plan.payload || result.argumentsJson.length > 32768) fail('invalid_draft');
      if(candidate.kind==='mcp'){
        if(plan.payload.name!==candidate.toolName || canonicalJson(plan.payload.arguments)!==entry.input.arguments_json
          || !equal(plan.payload.inputSchema,JSON.parse(candidate.inputSchemaJson)) || plan.payload.description!==candidate.description) fail('invalid_draft');
      }else{
        const calendar=plan.payload.calendarPlan,args=JSON.parse(entry.input.arguments_json);
        if(!candidate.calendar || !calendar || canonicalJson(plan.payload.proposalArguments)!==entry.input.arguments_json
          || calendar.provider!=='google_calendar' || calendar.accountId!==candidate.accountId || calendar.accountLabel!==candidate.accountLabel
          || calendar.calendarId!==candidate.target || calendar.calendarLabel!==candidate.calendar.label || calendar.calendarTimeZone!==candidate.calendar.timeZone
          || calendar.operation!==operation || (operation!=='create'&&calendar.eventId!==args.eventId)
          || !equal(calendar.event,operation==='delete'?null:normalizeFields(args))) fail('invalid_draft');
      }
      const digest = await digestAction({ tool_id: candidate.kind, operation, account_id: candidate.accountId,
        target: candidate.target, arguments_json: result.argumentsJson });
      this.guard(entry); if (result.payloadSha256 !== digest) fail('invalid_draft');
      return frozen(result);
    } catch (error) { await this.detach(entry); throw safeError(error); }
  }
  private async detach(entry: ProposalEntry): Promise<void> {
    entry.detached = true;
    if (entry.createdDraftId && !entry.cancelPromise) {
      // Keep the promise (including rejection): cancellation failure is not automatically retried.
      entry.cancelPromise = Promise.resolve().then(() => this.deps.cancelDraft(entry.createdDraftId!))
        .catch(() => fail('draft_cancel_failed'));
    }
    await entry.cancelPromise;
  }
  private attached(entry: ProposalEntry): boolean { try { this.guard(entry); return true; } catch { return false; } }
  private async collect(entry: ProposalEntry): Promise<ReceiptView> {
    const view: ReceiptView = { state: 'unavailable', receipt: null, attached: false, provenance: null, registration: null, errorCode: null };
    let state: HostReceiptState;
    const terminal = entry.terminal;
    // A durable success receipt is immutable even if its local result body is temporarily missing.
    // Only an explicit receipt lookup may retrieve that body again; no external work is retried.
    const needsBody = terminal?.receipt?.status === 'succeeded' && terminal.resultJson === null;
    try { state = copy(terminal && !needsBody ? terminal : await this.deps.lookupReceipt(entry.action!.draftId)); }
    catch { return frozen({ ...view, errorCode: 'external_receipt_unavailable' }); }
    if (needsBody && !equal(terminal!.receipt, state.receipt)) fail('receipt_mismatch');
    if (state.receipt === null) return frozen({ ...view, state: 'pending', attached: this.attached(entry) });
    const receipt = state.receipt, action = entry.action!;
    assertDefinition('ExecutionReceipt', receipt);
    if (!sameIdentity(receipt.identity, entry.origin.scope) || receipt.executor_id !== this.deps.executorId
      || receipt.provider_id !== entry.candidate.kind || receipt.draft_id !== action.draftId || receipt.draft_revision !== action.revision
      || receipt.payload_sha256 !== action.payloadSha256 || entry.executionId !== undefined && entry.executionId !== receipt.execution_id) fail('receipt_mismatch');
    entry.executionId = receipt.execution_id;
    if (receipt.status !== 'unknown') entry.terminal = state;
    Object.assign(view, { state: receipt.status, receipt, attached: this.attached(entry) });
    if (receipt.status !== 'succeeded' || !view.attached) return frozen(view);
    let records: SourceRecord[], raw: string, canonical: string;
    try {
      records = await this.sources(entry); this.guard(entry);
      raw = state.resultJson!; text(raw, proposalLimits.resultBytes);
      canonical = canonicalJson(JSON.parse(raw)); text(canonical, proposalLimits.resultBytes);
    } catch { return frozen({ ...view, attached: false, errorCode: 'external_result_unavailable' }); }
    const resultBoundary = strictest([entry.lease.metadataBoundary, entry.candidate.resultBoundary,
      ...records.map(record => record.kind === 'screen' && record.boundary === 'cloud' ? 'private_lan' : record.boundary)]);
    if (!allowed(resultBoundary, entry.lease.turn.modelBoundary)) return frozen({ ...view, errorCode: 'external_context_blocked' });
    const provenance: HostResultProvenance = { ...(entry.candidate.kind==='google_calendar'?{providerKind:entry.candidate.kind}:{}), identity: { instance_id: entry.origin.scope.instance_id,
      mode: entry.origin.scope.mode, principal_id: entry.origin.scope.principal_id }, scope: copy(entry.origin.scope),
      turnId: entry.origin.turnId, intentId: entry.origin.intentId, proposalId: entry.origin.proposalId, offerId: entry.origin.offerId,
      draftId: action.draftId, draftRevision: action.revision, payloadSha256: action.payloadSha256,
      executionId: receipt.execution_id, providerOperationId: receipt.provider_operation_id,
      connectionId: entry.candidate.connectionId, connectionGeneration: entry.candidate.generation, accountId: entry.candidate.accountId,
      toolName: entry.candidate.toolName, toolFingerprint: entry.candidate.fingerprint, boundary: resultBoundary,
      offeredMetadata: [...entry.lease.candidates].map(([offerId, candidate]) => ({ ...(candidate.kind==='google_calendar'?{providerKind:candidate.kind}:{}), offerId,
        connectionId: candidate.connectionId, connectionGeneration: candidate.generation, accountId: candidate.accountId,
        toolName: candidate.toolName, toolFingerprint: candidate.fingerprint, boundary: candidate.metadataBoundary })),
      parents: copy(entry.origin.sourceRefs), rawResultSha256: hash(raw), canonicalResultSha256: hash(canonical) };
    view.provenance = provenance;
    if (Buffer.byteLength(canonical, 'utf8') > proposalLimits.contextBytes || [...canonical].length > 8192) {
      return frozen({ ...view, errorCode: 'external_result_context_limit' });
    }
    if (this.deps.registerResult && !entry.registrationAttempted) {
      entry.registrationAttempted = true;
      try {
        this.guard(entry);
        const registered = copy(await this.deps.registerResult({ provenance: copy(provenance), rawResultJson: raw, canonicalResultJson: canonical }, () => this.guard(entry)));
        this.guard(entry); assertDefinition('SourceRef', registered.sourceRef);
        if (registered.kind !== 'tool_result' || !sameIdentity(registered.identity, provenance.identity)
          || registered.boundary !== provenance.boundary || !equal(refs(registered.parents), provenance.parents)
          || registered.rawResultSha256 !== provenance.rawResultSha256 || registered.canonicalResultSha256 !== provenance.canonicalResultSha256
          || registered.text !== canonical
          || provenance.parents.some(ref => ref.source_id === registered.sourceRef.source_id)) fail('invalid_result_registration');
        text(registered.text, proposalLimits.contextBytes);
        if ([...registered.text].length > 8192) fail('proposal_limit');
        entry.registration = registered;
      } catch { entry.registrationError = 'external_result_registration_failed'; }
    }
    if (!this.attached(entry)) return frozen({ ...view, attached: false, provenance: null });
    return frozen({ ...view, registration: entry.registration, errorCode: entry.registrationError });
  }
}
