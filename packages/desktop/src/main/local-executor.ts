import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ApprovalLedger, assertDefinition, digestAction, sameIdentity,
  type ActionDraft, type ExecutionClaim, type ExecutionReceipt, type ExecutionSnapshot, type Identity } from '@kirian/contracts';
import type { ActionApprovalInput, ActionView, NoteDraftInput } from '../shared/actions.js';
import { atomicWriteJsonSync, readJsonSync } from './persistence/atomic-json.js';

export type LocalExecutorFaultPoint = 'before_draft_persist' | 'before_claim_persist' | 'after_claim_persist'
  | 'before_note_open' | 'after_note_open' | 'after_note_write' | 'before_receipt_persist' | 'before_dismiss_persist';
export interface LocalExecutorOptions { now?: () => number; fault?: (point: LocalExecutorFaultPoint) => void; }
/** Main supplies a synchronous check of the captured renderer, identity and connection. */
export type LocalExecutionContextGuard = () => boolean;
interface StoredRecord {
  draft: ActionDraft;
  disposition: 'pending' | 'dismissed';
  evidence?: { sha256: string; bytes: number };
}
interface StoredState { version: 1; revision: number; records: StoredRecord[]; ledger: ExecutionSnapshot; }
const executorId = 'kirian-local-notes-v1';
const maxRecords = 500, storeLimit = 32 * 1024 * 1024, draftLifetime = 10 * 60 * 1000;
const targetPattern = /^notes\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.md(?![\s\S])/;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function noteInput(value: unknown): NoteDraftInput {
  if (!object(value) || !keys(value, ['title', 'body']) || typeof value.title !== 'string' || typeof value.body !== 'string'
    || !value.title.trim() || value.title.length > 120 || /[\u0000-\u001f\u007f]/u.test(value.title)
    || !value.body.trim() || value.body.length > 8192 || value.body.includes('\0')
    || Buffer.from(value.title, 'utf8').toString('utf8') !== value.title
    || Buffer.from(value.body, 'utf8').toString('utf8') !== value.body) throw new Error('invalid_note_draft');
  return { title: value.title, body: value.body };
}
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Device-owned consent and durable execution. No wire message can call approve(). */
export class DurableLocalExecutor {
  private readonly identity: Identity;
  private readonly directory: string;
  private readonly notes: string;
  private readonly store: string;
  private readonly root: string;
  private readonly options: LocalExecutorOptions;
  private ledger: ApprovalLedger;
  private records: StoredRecord[] = [];
  private revision = 0;
  private persistedDigest: string | null = null;
  private initialized = false;
  private blocked = false;
  private readonly uncertain = new Set<string>();
  private readonly executions = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string, identity: Identity, options: LocalExecutorOptions = {}) {
    assertDefinition('Identity', identity);
    if (identity.mode !== 'personal' || !isAbsolute(rootDir)) throw new Error('local_execution_not_granted');
    this.identity = structuredClone(identity); this.options = { ...options };
    this.root = resolve(rootDir);
    const owner = sha256(JSON.stringify([identity.instance_id, identity.mode, identity.principal_id]));
    this.directory = join(this.root, owner); this.notes = join(this.directory, 'notes'); this.store = join(this.directory, 'actions.json');
    this.ledger = new ApprovalLedger(this.identity, executorId, true);
  }

  initialize(): Promise<void> {
    return this.serial(async () => {
      if (this.initialized) return;
      if (this.blocked) throw new Error('action_store_unavailable');
      try {
        mkdirSync(this.root, { recursive: true });
        this.ensureDirectories(true);
        const saved = readJsonSync(this.store, storeLimit);
        if (saved !== undefined) await this.restore(saved);
        this.initialized = true;
        if (saved === undefined || this.ledger.snapshot().claims.some(claim => this.uncertain.has(claim.approval.draft_id))) this.persist();
      } catch (error) { this.blocked = true; this.initialized = false; throw error; }
    });
  }

  createDraft(value: NoteDraftInput, context?: LocalExecutionContextGuard): Promise<ActionView> {
    // Capture mutable caller input before waiting behind another command.
    const input = noteInput(value);
    return this.serial(async () => {
      this.ready();
      this.checkContext(context);
      if (this.records.length >= maxRecords) throw new Error('action_record_limit');
      const action = { tool_id: 'local_notes', operation: 'create', account_id: this.identity.principal_id,
        target: 'notes/' + randomUUID() + '.md', arguments_json: JSON.stringify(input) };
      const draft: ActionDraft = { draft_id: randomUUID(), revision: 1, identity: this.identity, executor_id: executorId,
        action, payload_sha256: await digestAction(action), expires_at_ms: this.now() + draftLifetime };
      this.checkContext(context);
      await this.ledger.registerDraft(draft);
      this.checkContext(context);
      const record: StoredRecord = { draft: structuredClone(draft), disposition: 'pending' };
      this.records.push(record);
      this.persist('before_draft_persist');
      return this.view(record);
    });
  }

  approve(value: ActionApprovalInput, context?: LocalExecutionContextGuard): Promise<ActionView> {
    if (!object(value) || !keys(value, ['draftId', 'revision', 'payloadSha256']) || typeof value.draftId !== 'string'
      || !Number.isSafeInteger(value.revision) || typeof value.payloadSha256 !== 'string') return Promise.reject(new Error('invalid_approval'));
    const input = structuredClone(value);
    return this.serial(async () => {
      this.ready();
      const record = this.find(input.draftId);
      if (record.disposition !== 'pending' || this.claimFor(record)) throw new Error('action_already_decided');
      if (record.draft.revision !== input.revision || record.draft.payload_sha256 !== input.payloadSha256) throw new Error('stale_draft');
      // Queueing is not authorization to execute later in a different context.
      // No await occurs between this guard, the durable claim, and note I/O.
      this.checkContext(context);
      const approval = this.ledger.approve(input.draftId, input.revision, randomUUID(), randomUUID(), this.now());
      this.ledger.claim(approval, this.now());
      this.executions.set(input.draftId, approval.execution_id);
      // This synchronous commit is the barrier before ANY note filesystem I/O.
      try { this.persist('before_claim_persist'); this.options.fault?.('after_claim_persist'); }
      catch (error) { this.uncertain.add(input.draftId); this.blocked = true; throw error; }
      const path = this.target(record), inputNote = noteInput(JSON.parse(record.draft.action.arguments_json));
      const contents = Buffer.from('# ' + inputNote.title + '\n\n' + inputNote.body + '\n', 'utf8');
      let descriptor: number | undefined, created = false, attempted = false;
      let status: 'succeeded' | 'failed' | 'unknown' = 'succeeded', errorCode: string | null = null;
      try {
        this.ensureDirectories(); this.options.fault?.('before_note_open');
        attempted = true; descriptor = openSync(path, 'wx', 0o600); created = true;
        this.options.fault?.('after_note_open');
        writeFileSync(descriptor, contents); fsyncSync(descriptor);
        closeSync(descriptor); descriptor = undefined;
        this.options.fault?.('after_note_write');
        this.ensureDirectories();
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== contents.length) throw new Error('note_evidence_mismatch');
        const actual = readFileSync(path);
        if (!actual.equals(contents)) throw new Error('note_evidence_mismatch');
        record.evidence = { sha256: sha256(actual), bytes: actual.length };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const noEffect = !created && (!attempted || ['EEXIST', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR'].includes(code ?? ''));
        status = noEffect ? 'failed' : 'unknown'; errorCode = noEffect ? 'note_write_failed' : 'note_write_unknown';
      } finally {
        if (descriptor !== undefined) { try { closeSync(descriptor); } catch { status = 'unknown'; errorCode = 'note_write_unknown'; } }
      }
      const base = { execution_id: approval.execution_id, draft_id: approval.draft_id, draft_revision: approval.draft_revision,
        identity: this.identity, executor_id: executorId, payload_sha256: approval.payload_sha256, provider_id: 'local_notes',
        provider_operation_id: created ? record.draft.action.target.slice(6, -3) : null, recorded_at_ms: this.now() };
      const receipt: ExecutionReceipt = status === 'succeeded'
        ? { ...base, status, provider_operation_id: record.draft.action.target.slice(6, -3), error_code: null }
        : { ...base, status, error_code: errorCode };
      this.ledger.recordReceipt(receipt, executorId);
      try { this.persist('before_receipt_persist'); }
      catch (error) { this.uncertain.add(input.draftId); this.blocked = true; throw error; }
      return this.view(record);
    });
  }

  dismiss(draftId: string, context?: LocalExecutionContextGuard): Promise<ActionView> {
    return this.serial(async () => {
      this.ready(); const record = this.find(draftId);
      if (record.disposition !== 'pending' || this.claimFor(record)) throw new Error('action_already_decided');
      this.checkContext(context);
      record.disposition = 'dismissed'; this.persist('before_dismiss_persist'); return this.view(record);
    });
  }
  list(): ActionView[] {
    if (!this.initialized) throw new Error('executor_not_initialized');
    return this.records.map(record => this.view(record));
  }
  noteDirectory(): string { this.ready(); this.ensureDirectories(); return this.notes; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;
  }
  private ready(): void {
    if (!this.initialized) throw new Error('executor_not_initialized');
    if (this.blocked) throw new Error('action_store_unavailable');
  }
  private checkContext(context?: LocalExecutionContextGuard): void {
    if (context && context() !== true) throw new Error('context_changed');
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - draftLifetime) throw new Error('invalid_time');
    return now;
  }
  private ensureDirectories(create = false): void {
    const root = lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe_action_directory');
    const canonicalRoot = realpathSync(this.root);
    for (const directory of [this.directory, this.notes]) {
      if (create) { try { mkdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || !samePath(realpathSync(directory), join(canonicalRoot, directory.slice(this.root.length + 1)))) throw new Error('unsafe_action_directory');
    }
  }
  private find(id: string): StoredRecord {
    const record = this.records.find(item => item.draft.draft_id === id);
    if (!record) throw new Error('unknown_draft'); return record;
  }
  private claimFor(record: StoredRecord): ExecutionClaim | undefined {
    const executionId = this.executions.get(record.draft.draft_id);
    return executionId === undefined ? undefined : this.ledger.get(executionId);
  }
  private target(record: StoredRecord): string { return join(this.directory, record.draft.action.target); }
  private view(record: StoredRecord): ActionView {
    const input = noteInput(JSON.parse(record.draft.action.arguments_json)), claim = this.claimFor(record);
    const uncertain = this.uncertain.has(record.draft.draft_id), receipt = uncertain ? null : claim?.receipt;
    return { draftId: record.draft.draft_id, revision: record.draft.revision, payloadSha256: record.draft.payload_sha256,
      ...input, target: this.target(record), expiresAt: record.draft.expires_at_ms,
      status: uncertain ? 'unknown' : claim?.state ?? record.disposition,
      ...(receipt ? { receipt: { executionId: receipt.execution_id, providerId: receipt.provider_id,
        operationId: receipt.provider_operation_id, status: receipt.status, errorCode: receipt.error_code, recordedAt: receipt.recorded_at_ms } } : {}) };
  }
  private persist(point?: LocalExecutorFaultPoint): void {
    try {
      this.ensureDirectories();
      const current = readJsonSync(this.store, storeLimit);
      if ((current === undefined ? 0 : object(current) ? current.revision : -1) !== this.revision
        || (current === undefined ? null : sha256(JSON.stringify(current))) !== this.persistedDigest) throw new Error('action_store_changed');
      if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error('action_revision_exhausted');
      const value: StoredState = { version: 1, revision: this.revision + 1, records: this.records, ledger: this.ledger.snapshot() };
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > storeLimit) throw new Error('action_store_limit');
      if (point) this.options.fault?.(point);
      atomicWriteJsonSync(this.store, value); this.revision++; this.persistedDigest = sha256(JSON.stringify(value));
    } catch (error) { this.blocked = true; throw error; }
  }
  private async restore(value: unknown): Promise<void> {
    if (!object(value) || !keys(value, ['version', 'revision', 'records', 'ledger']) || value.version !== 1
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !Array.isArray(value.records)
      || value.records.length > maxRecords || !object(value.ledger) || !keys(value.ledger, ['identity', 'executor_id', 'claims'])
      || !Array.isArray(value.ledger.claims) || value.ledger.claims.length > maxRecords)
      throw new Error('invalid_action_store');
    assertDefinition('Identity', value.ledger.identity);
    for (const claim of value.ledger.claims) {
      if (!object(claim) || !keys(claim, ['approval', 'state', 'receipt'])) throw new Error('invalid_action_store');
    }
    const ledger = new ApprovalLedger(this.identity, executorId, true, value.ledger as unknown as ExecutionSnapshot);
    const records: StoredRecord[] = [], ids = new Set<string>(), targets = new Set<string>();
    for (const item of value.records) {
      if (!object(item) || !keys(item, ['draft', 'disposition', ...('evidence' in item ? ['evidence'] : [])])
        || !['pending', 'dismissed'].includes(String(item.disposition))) throw new Error('invalid_action_store');
      assertDefinition('ActionDraft', item.draft);
      const draft = item.draft as ActionDraft;
      if (!sameIdentity(draft.identity, this.identity) || draft.executor_id !== executorId
        || draft.action.tool_id !== 'local_notes' || draft.action.operation !== 'create' || draft.action.account_id !== this.identity.principal_id
        || !targetPattern.test(draft.action.target) || ids.has(draft.draft_id) || targets.has(draft.action.target)) throw new Error('invalid_action_store');
      const input = noteInput(JSON.parse(draft.action.arguments_json));
      if (JSON.stringify(input) !== draft.action.arguments_json) throw new Error('invalid_action_store');
      const expectedContents = Buffer.from('# ' + input.title + '\n\n' + input.body + '\n', 'utf8');
      if (item.evidence !== undefined && (!object(item.evidence) || !keys(item.evidence, ['sha256', 'bytes'])
        || item.evidence.sha256 !== sha256(expectedContents) || item.evidence.bytes !== expectedContents.length)) throw new Error('invalid_action_store');
      await ledger.registerDraft(draft); ids.add(draft.draft_id); targets.add(draft.action.target);
      records.push(structuredClone(item) as unknown as StoredRecord);
    }
    const claimDrafts = new Set<string>();
    for (const claim of ledger.snapshot().claims) {
      const record = records.find(item => item.draft.draft_id === claim.approval.draft_id);
      if (!record || record.disposition !== 'pending' || claimDrafts.has(record.draft.draft_id)
        || record.draft.payload_sha256 !== claim.approval.payload_sha256 || record.draft.revision !== claim.approval.draft_revision
        || record.draft.expires_at_ms !== claim.approval.expires_at_ms
        || (claim.state === 'succeeded' && !record.evidence)
        || (claim.receipt && (claim.receipt.provider_id !== 'local_notes'
          || (claim.receipt.provider_operation_id !== null && claim.receipt.provider_operation_id !== record.draft.action.target.slice(6, -3))))
        || (claim.state === 'succeeded' && claim.receipt?.provider_operation_id === null)) throw new Error('invalid_action_store');
      claimDrafts.add(record.draft.draft_id);
      this.executions.set(record.draft.draft_id, claim.approval.execution_id);
      if ((value.ledger.claims as ExecutionClaim[]).some(saved => saved.approval.execution_id === claim.approval.execution_id && saved.state === 'running'))
        this.uncertain.add(record.draft.draft_id);
    }
    this.ledger = ledger; this.records = records; this.revision = value.revision as number;
    this.persistedDigest = sha256(JSON.stringify(value));
  }
}
