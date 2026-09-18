import type { ActionDraft, ActionPayload, Approval, ExecutionReceipt, Identity } from './protocol.generated.js';
import { assertDefinition, ContractError } from './validation.js';
import { sameIdentity } from './policy.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
}
function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function validTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new ContractError('invalid_time');
}
// Hash the exact argument text that was reviewed; no cross-language JSON-number normalization.
export async function digestAction(action: ActionPayload): Promise<string> {
  assertDefinition('ActionPayload', action);
  let argumentsValue: unknown;
  try { argumentsValue = JSON.parse(action.arguments_json); } catch { throw new ContractError('invalid_action_arguments'); }
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue))
    throw new ContractError('invalid_action_arguments');
  const bytes = new TextEncoder().encode(JSON.stringify([action.tool_id, action.operation, action.account_id, action.target, action.arguments_json]));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export interface ExecutionClaim {
  approval: Approval;
  state: 'running' | 'succeeded' | 'failed' | 'unknown';
  receipt: ExecutionReceipt | null;
}
export interface ExecutionSnapshot {
  identity: Identity;
  executor_id: string;
  claims: ExecutionClaim[];
}
function receiptMatches(receipt: ExecutionReceipt, approval: Approval): boolean {
  return receipt.execution_id === approval.execution_id && receipt.draft_id === approval.draft_id
    && receipt.draft_revision === approval.draft_revision && receipt.executor_id === approval.executor_id
    && receipt.payload_sha256 === approval.payload_sha256 && sameIdentity(receipt.identity, approval.identity);
}
// Reference state machine, not an OAuth executor. Host must authenticate user consent,
// authorize the device, and transactionally persist a claim BEFORE external I/O.
export class ApprovalLedger {
  private readonly identity: Identity;
  private readonly executorId: string;
  private readonly drafts = new Map<string, ActionDraft>();
  private readonly approvals = new Map<string, Approval>();
  private readonly claims = new Map<string, ExecutionClaim>();
  private readonly consumedApprovals = new Set<string>();
  constructor(identity: Identity, executorId: string, localActionsGranted: boolean, recovered?: ExecutionSnapshot) {
    assertDefinition('Identity', identity);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executorId)) throw new ContractError('invalid_executor');
    if (identity.mode !== 'personal' || !localActionsGranted) throw new ContractError('local_execution_not_granted');
    this.identity = structuredClone(identity);
    this.executorId = executorId;
    if (recovered) {
      if (!sameIdentity(identity, recovered.identity) || executorId !== recovered.executor_id || !Array.isArray(recovered.claims))
        throw new ContractError('foreign_execution_snapshot');
      for (const claim of recovered.claims) {
        assertDefinition('Approval', claim.approval);
        const approval = claim.approval;
        this.checkOwner(approval.identity, approval.executor_id);
        if (!['running','succeeded','failed','unknown'].includes(claim.state)
          || this.claims.has(approval.execution_id) || this.consumedApprovals.has(approval.approval_id))
          throw new ContractError('invalid_execution_snapshot');
        if (claim.receipt !== null) {
          assertDefinition('ExecutionReceipt', claim.receipt);
          if (!receiptMatches(claim.receipt, approval) || claim.receipt.status !== claim.state)
            throw new ContractError('invalid_execution_snapshot');
        } else if (claim.state === 'succeeded' || claim.state === 'failed') throw new ContractError('missing_execution_evidence');
        this.claims.set(approval.execution_id, structuredClone({...claim, state: claim.state === 'running' ? 'unknown' : claim.state}));
        this.consumedApprovals.add(approval.approval_id);
      }
    }
  }
  private checkOwner(identity: Identity, executorId: string): void {
    if (!sameIdentity(this.identity, identity) || this.executorId !== executorId) throw new ContractError('foreign_executor');
  }
  async registerDraft(value: ActionDraft): Promise<void> {
    assertDefinition('ActionDraft', value);
    const draft = structuredClone(value);
    this.checkOwner(draft.identity, draft.executor_id);
    if (await digestAction(draft.action) !== draft.payload_sha256) throw new ContractError('payload_digest_mismatch');
    const previous = this.drafts.get(draft.draft_id);
    if (previous && draft.revision <= previous.revision) {
      if (equal(previous, draft)) return;
      throw new ContractError('draft_revision_conflict');
    }
    this.drafts.set(draft.draft_id, draft);
  }
  // Called only by the trusted consent UI after presenting the registered exact payload.
  approve(draftId: string, revision: number, approvalId: string, executionId: string, now: number): Approval {
    validTime(now);
    const draft = this.drafts.get(draftId);
    if (!draft || revision !== draft.revision) throw new ContractError('stale_draft');
    if (draft.expires_at_ms <= now) throw new ContractError('approval_expired');
    if (this.approvals.has(approvalId) || this.consumedApprovals.has(approvalId) || this.claims.has(executionId))
      throw new ContractError('approval_reused');
    const approval: Approval = {approval_id: approvalId, draft_id: draftId, draft_revision: revision,
      identity: structuredClone(this.identity), executor_id: this.executorId, payload_sha256: draft.payload_sha256,
      execution_id: executionId, expires_at_ms: draft.expires_at_ms};
    assertDefinition('Approval', approval);
    this.approvals.set(approvalId, approval);
    return structuredClone(approval);
  }
  claim(value: Approval, now: number): ExecutionClaim {
    validTime(now);
    assertDefinition('Approval', value);
    this.checkOwner(value.identity, value.executor_id);
    const approval = this.approvals.get(value.approval_id);
    if (!approval || value.draft_id !== approval.draft_id || value.draft_revision !== approval.draft_revision
      || value.payload_sha256 !== approval.payload_sha256 || value.execution_id !== approval.execution_id
      || value.expires_at_ms !== approval.expires_at_ms) throw new ContractError('unrecognized_approval');
    const draft = this.drafts.get(approval.draft_id);
    if (!draft || draft.revision !== approval.draft_revision || draft.payload_sha256 !== approval.payload_sha256)
      throw new ContractError('stale_draft');
    if (approval.expires_at_ms <= now) throw new ContractError('approval_expired');
    if (this.consumedApprovals.has(approval.approval_id) || this.claims.has(approval.execution_id))
      throw new ContractError('execution_already_claimed');
    const claim: ExecutionClaim = {approval: structuredClone(approval), state: 'running', receipt: null};
    this.claims.set(approval.execution_id, claim);
    this.consumedApprovals.add(approval.approval_id);
    return structuredClone(claim);
  }
  // Called with a receipt from the authenticated executor, never an LLM success message.
  recordReceipt(value: ExecutionReceipt, authenticatedExecutorId: string): ExecutionClaim {
    assertDefinition('ExecutionReceipt', value);
    this.checkOwner(value.identity, authenticatedExecutorId);
    const claim = this.claims.get(value.execution_id);
    if (!claim || !receiptMatches(value, claim.approval)) throw new ContractError('unrecognized_receipt');
    if (claim.state === 'succeeded' || claim.state === 'failed') {
      if (claim.receipt && equal(claim.receipt, value)) return structuredClone(claim);
      throw new ContractError('terminal_receipt_conflict');
    }
    claim.state = value.status;
    claim.receipt = structuredClone(value);
    return structuredClone(claim);
  }
  get(executionId: string): ExecutionClaim | undefined {
    const claim = this.claims.get(executionId);
    return claim ? structuredClone(claim) : undefined;
  }
  snapshot(): ExecutionSnapshot {
    return {identity: structuredClone(this.identity), executor_id: this.executorId, claims: structuredClone([...this.claims.values()])};
  }
}
