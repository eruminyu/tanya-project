import { createHash } from 'node:crypto';
import { assertDefinition, sameIdentity, sameModel, type SourceRecord, type SourceRef } from '@kirian/contracts';
import { calendarOperation } from './calendar-proposals.js';
import type { CalendarEventInput } from '../../shared/external.js';
import { canonicalJson } from './external-executor.js';
import { ExternalManager, type ToolProposalSelection } from './external-manager.js';
import type { HostToolCandidate, HostProposalOrigin, HostTurnEvidence } from './external-proposal-gateway.js';

export type { ToolProposalSelection } from './external-manager.js';
export interface ExternalProposalAdapterDependencies {
  currentTurn(): HostTurnEvidence | null;
  selections(): readonly ToolProposalSelection[];
  resolveSources(refs: readonly SourceRef[], guard: () => void): Promise<readonly SourceRecord[]>;
  now?(): number;
}
type Boundary = 'local' | 'private_lan' | 'cloud';
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const allowed = (source: Boundary, destination: Boundary) => source === 'cloud'
  || source === destination || source === 'private_lan' && destination === 'local';
function fail(): never { throw new Error('external_proposal_revoked'); }
function normalizedRefs(refs: readonly SourceRef[]): SourceRef[] {
  if (!Array.isArray(refs) || refs.length > 128) return fail();
  const ids = new Set<string>();
  for (const ref of refs) {
    assertDefinition('SourceRef', ref);
    if (ids.has(ref.source_id)) return fail();
    ids.add(ref.source_id);
  }
  return structuredClone([...refs]).sort((a, b) => a.source_id.localeCompare(b.source_id));
}

/** Authenticated host seam. A model proposal never calls approve. Each preview retains its
 * origin and resolver closure in the executor's memory only; restart dismisses unclaimed drafts.
 * The synchronous gateway guard checks the entire offered metadata lease at every boundary. */
export class ExternalProposalAdapter {
  readonly executorId: string;
  constructor(private readonly manager: ExternalManager, private readonly deps: ExternalProposalAdapterDependencies) {
    this.executorId = manager.executorId;
  }
  toolCandidates(): HostToolCandidate[] { return this.manager.proposalCandidates(this.deps.selections()); }
  isCandidateCurrent(candidate: HostToolCandidate): boolean {
    try { return this.manager.isProposalCandidateCurrent(candidate)
      && this.toolCandidates().some(current => equal(current, candidate)); } catch { return false; }
  }
  lookupReceipt(draftId: string) { return Promise.resolve(this.manager.lookupReceipt(draftId)); }
  async cancelDraft(draftId: string): Promise<void> { this.manager.cancel(draftId); }

  async previewTool(input: { kind: 'mcp' | 'google_calendar'; connectionId: string; toolName: string; argumentsJson: string },
    originInput: HostProposalOrigin, gatewayGuard: () => void) {
    const origin = structuredClone(originInput), ownedInput = structuredClone(input);
    assertDefinition('Scope', origin.scope); assertDefinition('ModelRef', origin.expectedModel);
    origin.sourceRefs = normalizedRefs(origin.sourceRefs);
    if (!['mcp','google_calendar'].includes(ownedInput.kind) || canonicalJson(JSON.parse(ownedInput.argumentsJson)) !== ownedInput.argumentsJson) fail();
    const argumentsHash = createHash('sha256').update(ownedInput.argumentsJson, 'utf8').digest('hex');
    const candidate = this.toolCandidates().find(value => value.connectionId === ownedInput.connectionId && value.toolName === ownedInput.toolName);
    if (!candidate || candidate.kind !== ownedInput.kind || candidate.approvedArgumentBoundary === null) return fail();
    let initialSources: string | undefined;
    const guard = () => {
      gatewayGuard();
      const now = (this.deps.now ?? Date.now)(), turn = this.deps.currentTurn();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(origin.expiresAtMs) || now >= origin.expiresAtMs
        || !turn || !turn.active || !turn.toolsEnabled || !turn.modelAuthorized || turn.brainDestination !== 'loopback'
        || turn.scope.mode !== 'personal' || !equal(turn.scope, origin.scope)
        || turn.turnId !== origin.turnId || turn.intentId !== origin.intentId || turn.epoch !== origin.epoch
        || turn.sourceEpoch !== origin.sourceEpoch || !sameModel(turn.expectedModel, origin.expectedModel)
        || !equal(turn.routingReason ?? null, origin.routingReason ?? null)
        || !equal(normalizedRefs(turn.sourceRefs), origin.sourceRefs) || !this.isCandidateCurrent(candidate)) fail();
      const call = turn.completedCall;
      if (!call || call.kind !== (candidate.kind==='mcp'?'single_mcp_tool_call':'single_google_calendar_call') || call.explicitlySupported !== true
        || call.requestId !== origin.requestId || call.proposalId !== origin.proposalId || call.offerId !== origin.offerId
        || call.canonicalArgumentsSha256 !== argumentsHash || !sameModel(call.observedModel, origin.expectedModel)) fail();
    };
    const revalidate = async () => {
      guard();
      const records = structuredClone(await this.deps.resolveSources(structuredClone(origin.sourceRefs), guard));
      guard();
      const turn = this.deps.currentTurn()!;
      if (!Array.isArray(records) || records.length !== origin.sourceRefs.length) fail();
      const byId = new Map<string, SourceRecord>();
      for (const record of records) {
        assertDefinition('SourceRecord', record);
        const ref = origin.sourceRefs.find(value => value.source_id === record.source_id);
        if (!ref || ref.revision !== record.revision || byId.has(record.source_id)
          || record.deleted || !sameIdentity(record.identity, origin.scope)) fail();
        const boundary = record.kind === 'screen' && record.boundary === 'cloud' ? 'private_lan' : record.boundary;
        if (!allowed(boundary, turn.modelBoundary) || !allowed(boundary, candidate.approvedArgumentBoundary!)) fail();
        byId.set(record.source_id, record);
      }
      const heights = new Map<string, number>();
      const visit = (record: SourceRecord, path: Set<string>): number => {
        if (path.has(record.source_id) || path.size >= 64) return fail();
        const known = heights.get(record.source_id);
        if (known !== undefined) { if (known + path.size > 64) fail(); return known; }
        const next = new Set(path).add(record.source_id), parents = new Set<string>();
        let height = 1;
        for (const ref of record.parents) {
          const parent = byId.get(ref.source_id);
          if (!parent || parent.revision !== ref.revision || parents.has(ref.source_id)) return fail();
          parents.add(ref.source_id); height = Math.max(height, 1 + visit(parent, next));
        }
        heights.set(record.source_id, height); return height;
      };
      for (const record of records) visit(record, new Set());
      // Even a permission change that would still permit this destination retires this proposal.
      const snapshot = canonicalJson([...records].sort((a, b) => a.source_id.localeCompare(b.source_id)));
      if (initialSources !== undefined && initialSources !== snapshot) fail();
      initialSources = snapshot;
      guard();
    };
    await revalidate();
    const preview = candidate.kind==='mcp' ? {...ownedInput,kind:'mcp' as const} : {kind:'google' as const,connectionId:candidate.connectionId,calendarId:candidate.target,operation:calendarOperation(candidate.toolName),event:JSON.parse(ownedInput.argumentsJson) as CalendarEventInput};
    return this.manager.preview(preview, () => { guard(); return true; }, { expiresAtMs: origin.expiresAtMs, guard, revalidate });
  }
}
