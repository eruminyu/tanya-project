import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ApprovalLedger, assertDefinition, digestAction, sameIdentity,
  type ActionDraft, type ExecutionClaim, type ExecutionReceipt, type ExecutionSnapshot, type Identity } from '@kirian/contracts';
import type { NoteEditApproval, NoteEditReview, NoteEditSummary } from '../../../shared/note-editing.js';
import { atomicWriteJsonSync, readJsonSync } from '../../persistence/atomic-json.js';

export interface NoteEditInput {
  folderId: string; folderLabel: string; path: string; target: string;
  grantRevision: number; rootIdentity: string; fileIdentity: string;
  before: Buffer; after: Buffer; kind: 'edit' | 'undo' | 'recovery'; sourceActionId?: string;
}
export interface NoteEditBinding {
  folderId: string; path: string; grantRevision: number; rootIdentity: string; fileIdentity: string;
  beforeSha256: string; afterSha256: string;
}
interface Meta extends NoteEditBinding { folderLabel: string; kind: NoteEditInput['kind']; sourceActionId: string | null; }
interface RecordEntry { draft: ActionDraft; disposition: 'pending' | 'dismissed'; createdAt: number;
  meta: Meta; before: string; after: string; resolvedBy: string | null; }
interface State { version: 1; revision: number; records: RecordEntry[]; ledger: ExecutionSnapshot; }
type Result = { status: 'succeeded' | 'failed' | 'unknown'; error: string | null };
type Writer = (input: { expectedSha256: string; expectedIdentity: string; bytes: Buffer }) => Promise<Result>;
const executorId = 'kirian-note-edit-v1', fileLimit = 256 * 1024, storeLimit = 64 * 1024 * 1024;
const maxRecords = 64, normalRecordLimit = 48, lifetime = 10 * 60 * 1000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).sort().join(',') === [...names].sort().join(',');
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function validString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function rawBytes(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length > fileLimit) throw new Error('invalid_note_bytes');
  return Buffer.from(value);
}
/** The editor shows BOM separately; only uniform original CRLF is normalized on input. */
export function decodeNoteBytes(value: Buffer): { text: string; encoding: string } {
  const bytes = rawBytes(value), bom = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  const body = bom ? bytes.subarray(3) : bytes, text = body.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(body)) throw new Error('invalid_note_encoding');
  const crlf = text.includes('\r\n'), otherBreak = /(?<!\r)\n|\r(?!\n)/u.test(text);
  return { text, encoding: `UTF-8${bom ? ' BOM' : ''} · ${crlf ? otherBreak ? 'mixed' : 'CRLF' : text.includes('\r') ? 'CR' : 'LF'}` };
}
export function encodeNoteText(text: string, before: Buffer): Buffer {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text)
    throw new Error('invalid_note_encoding');
  const original = decodeNoteBytes(before);
  const body = original.encoding.endsWith(' · CRLF') ? text.replace(/\r\n|\r|\n/gu, '\r\n') : text;
  const bytes = Buffer.from((original.encoding.startsWith('UTF-8 BOM') ? '\ufeff' : '') + body, 'utf8');
  rawBytes(bytes); return bytes;
}
function capture(input: NoteEditInput): NoteEditInput {
  if (!object(input) || !keys(input, ['folderId', 'folderLabel', 'path', 'target', 'grantRevision', 'rootIdentity', 'fileIdentity',
    'before', 'after', 'kind', ...('sourceActionId' in input ? ['sourceActionId'] : [])])
    || !validString(input.folderId, 128) || !validString(input.folderLabel, 240) || [...input.folderLabel].length > 120
    || !validString(input.path, 1024) || /[\\:]/u.test(input.path) || input.path.startsWith('/')
    || input.path.split('/').some(part => !part || part === '.' || part === '..') || !/\.md$/iu.test(input.path)
    || !validString(input.target, 2048) || !isAbsolute(input.target)
    || !Number.isSafeInteger(input.grantRevision) || input.grantRevision < 0
    || !validString(input.rootIdentity, 128) || !validString(input.fileIdentity, 128)
    || !['edit', 'undo', 'recovery'].includes(input.kind)
    || (input.kind === 'edit' ? input.sourceActionId !== undefined : !validString(input.sourceActionId, 128)))
    throw new Error('invalid_note_edit');
  const before = rawBytes(input.before), after = rawBytes(input.after);
  decodeNoteBytes(after);
  if (input.kind !== 'recovery') decodeNoteBytes(before);
  if (before.equals(after) && input.kind !== 'recovery') throw new Error('note_unchanged');
  return { ...input, before, after };
}

/** Main-process consent journal. The injected writer is the only external mutation boundary. */
export class NoteEditJournal {
  private readonly identity: Identity;
  private readonly root: string;
  private readonly directory: string;
  private readonly store: string;
  private ledger: ApprovalLedger;
  private records: RecordEntry[] = [];
  private revision = 0;
  private persistedDigest: string | null = null;
  private initialized = false;
  private blocked = false;
  private rootIdentity: string | null = null;
  private directoryIdentity: string | null = null;
  private readonly executions = new Map<string, string>();
  private readonly uncertain = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(rootDir: string, identity: Identity, private readonly options: { now?: () => number; fault?: (point: string) => void } = {}) {
    assertDefinition('Identity', identity);
    if (!isAbsolute(rootDir) || identity.mode !== 'personal') throw new Error('local_execution_not_granted');
    this.identity = structuredClone(identity); this.root = resolve(rootDir);
    this.directory = join(this.root, hash(JSON.stringify([identity.instance_id, identity.mode, identity.principal_id])));
    this.store = join(this.directory, 'note-edits.json');
    this.ledger = new ApprovalLedger(this.identity, executorId, true);
  }
  initialize(): Promise<void> {
    return this.serial(async () => {
      if (this.initialized) { this.ready(); return; }
      if (this.blocked) throw new Error('note_edit_store_unavailable');
      try {
        this.ensureDirectories(true);
        const saved = this.readStore();
        if (saved !== undefined) await this.restore(saved);
        this.initialized = true;
        if (saved === undefined || this.uncertain.size > 0) this.persist();
      } catch (error) { this.blocked = true; this.initialized = false; throw error; }
    });
  }
  create(value: NoteEditInput, context: () => boolean): Promise<NoteEditReview> {
    let input: NoteEditInput;
    try { input = capture(value); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      this.ready(); this.checkContext(context);
      // Unclaimed expired/dismissed standalone previews hold no execution evidence.
      // Preserve every executed backup and reserve capacity for undo/recovery.
      const capacity = input.kind === 'edit' ? normalRecordLimit : maxRecords;
      if (this.records.length >= capacity) {
        const discard = new Set(this.records.filter(record => record.meta.kind === 'edit' && !this.claim(record)
          && (record.disposition === 'dismissed' || record.draft.expires_at_ms <= this.now())).map(record => record.draft.draft_id));
        if (discard.size > 0) {
          const remaining = this.records.filter(record => !discard.has(record.draft.draft_id)), ledger = await this.rebuildLedger(remaining);
          this.checkContext(context); this.records = remaining; this.ledger = ledger;
        }
      }
      if (this.records.length >= capacity) throw new Error('note_edit_record_limit');
      if (this.hasUnresolved(input.folderId) && input.kind !== 'recovery') throw new Error('note_edit_unresolved');
      if (input.sourceActionId) this.validateSource(input);
      const meta: Meta = { folderId: input.folderId, folderLabel: input.folderLabel, path: input.path,
        grantRevision: input.grantRevision, rootIdentity: input.rootIdentity, fileIdentity: input.fileIdentity,
        beforeSha256: hash(input.before), afterSha256: hash(input.after), kind: input.kind, sourceActionId: input.sourceActionId ?? null };
      const createdAt = this.now(), action = { tool_id: 'note_files', operation: input.kind, account_id: this.identity.principal_id,
        target: input.target, arguments_json: JSON.stringify(meta) };
      const draft: ActionDraft = { draft_id: randomUUID(), revision: 1, identity: this.identity, executor_id: executorId,
        action, payload_sha256: await digestAction(action), expires_at_ms: createdAt + lifetime };
      this.checkContext(context); await this.ledger.registerDraft(draft); this.checkContext(context);
      const record: RecordEntry = { draft, disposition: 'pending', createdAt, meta,
        before: input.before.toString('base64'), after: input.after.toString('base64'), resolvedBy: null };
      this.records.push(record); this.persist('before_draft_persist'); return this.review(record);
    });
  }
  get(id: string): NoteEditReview { this.readable(); return this.review(this.find(id)); }
  list(): NoteEditSummary[] { this.readable(); return this.records.map(record => this.summary(record)); }
  hasUnresolved(folderId: string): boolean {
    this.readable();
    return this.records.some(record => record.meta.folderId === folderId && record.resolvedBy === null
      && ['running', 'unknown'].includes(this.status(record)));
  }
  binding(id: string): NoteEditBinding {
    this.readable(); const meta = this.find(id).meta;
    return { folderId: meta.folderId, path: meta.path, grantRevision: meta.grantRevision, rootIdentity: meta.rootIdentity,
      fileIdentity: meta.fileIdentity, beforeSha256: meta.beforeSha256, afterSha256: meta.afterSha256 };
  }
  original(id: string): Buffer {
    this.readable(); const record = this.find(id);
    return Buffer.from((this.status(record) === 'unknown' ? this.backup(record) : record).before, 'base64');
  }
  approve(value: NoteEditApproval, context: () => boolean, write: Writer): Promise<NoteEditReview> {
    if (!object(value) || !keys(value, ['draftId', 'revision', 'payloadSha256']) || !validString(value.draftId, 128)
      || !Number.isSafeInteger(value.revision) || typeof value.payloadSha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(value.payloadSha256) || typeof write !== 'function')
      return Promise.reject(new Error('invalid_approval'));
    const input = { ...value };
    return this.serial(async () => {
      this.ready(); const record = this.find(input.draftId);
      if (record.disposition !== 'pending' || this.claim(record)) throw new Error('action_already_decided');
      if (input.revision !== record.draft.revision || input.payloadSha256 !== record.draft.payload_sha256) throw new Error('stale_draft');
      if (record.meta.kind !== 'recovery' && this.hasUnresolved(record.meta.folderId)) throw new Error('note_edit_unresolved');
      if (record.meta.sourceActionId) this.validateSource(this.input(record));
      this.checkContext(context);
      const approval = this.ledger.approve(input.draftId, input.revision, randomUUID(), randomUUID(), this.now());
      this.ledger.claim(approval, this.now()); this.executions.set(input.draftId, approval.execution_id);
      try { this.persist('before_claim_persist'); this.options.fault?.('after_claim_persist'); }
      catch (error) { this.uncertain.add(input.draftId); this.blocked = true; throw error; }
      let result: Result, attempted = false;
      try {
        this.options.fault?.('before_write'); this.checkContext(context); this.verifyStore();
        attempted = true;
        const actual = await write({ expectedSha256: record.meta.beforeSha256, expectedIdentity: record.meta.fileIdentity,
          bytes: Buffer.from(record.after, 'base64') });
        if (!object(actual) || !keys(actual, ['status', 'error']) || !['succeeded', 'failed', 'unknown'].includes(String(actual.status))
          || (actual.status === 'succeeded' ? actual.error !== null : typeof actual.error !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/u.test(actual.error)))
          throw new Error('invalid_write_receipt');
        result = actual as Result; this.options.fault?.('after_write');
      } catch (error) {
        result = { status: attempted ? 'unknown' : 'failed', error: attempted ? 'note_write_unknown'
          : error instanceof Error && error.message === 'context_changed' ? 'context_changed' : 'note_write_failed' };
      }
      const base = { execution_id: approval.execution_id, draft_id: approval.draft_id, draft_revision: approval.draft_revision,
        identity: this.identity, executor_id: executorId, payload_sha256: approval.payload_sha256,
        provider_id: 'note_files', provider_operation_id: result.status === 'succeeded' ? input.draftId : null, recorded_at_ms: this.now() };
      const receipt: ExecutionReceipt = result.status === 'succeeded' ? { ...base, status: 'succeeded', provider_operation_id: input.draftId, error_code: null }
        : { ...base, status: result.status, error_code: result.error };
      this.ledger.recordReceipt(receipt, executorId);
      if (result.status === 'succeeded' && record.meta.sourceActionId) {
        const source = this.find(record.meta.sourceActionId);
        if (record.meta.kind === 'undo') source.resolvedBy = input.draftId;
        else for (const previous of this.records) {
          if (this.status(previous) === 'unknown' && this.backup(previous).draft.draft_id === this.backup(source).draft.draft_id)
            previous.resolvedBy = input.draftId;
        }
      }
      try { this.persist('before_receipt_persist'); }
      catch (error) { this.uncertain.add(input.draftId); this.blocked = true; throw error; }
      return this.review(record);
    });
  }
  dismiss(id: string, context: () => boolean): Promise<void> {
    return this.serial(async () => {
      this.ready(); const record = this.find(id);
      if (record.disposition !== 'pending' || this.claim(record)) throw new Error('action_already_decided');
      this.checkContext(context); record.disposition = 'dismissed'; this.persist('before_dismiss_persist');
    });
  }
  /** Explicit UI confirmation discards an entire linked history and its backups. */
  forget(id: string, context: () => boolean): Promise<void> {
    return this.serial(async () => {
      this.ready(); this.find(id); this.checkContext(context);
      const group = new Set([id]);
      for (;;) {
        const count = group.size;
        for (const record of this.records) {
          const source = record.meta.sourceActionId;
          if (source && (group.has(record.draft.draft_id) || group.has(source))) {
            group.add(record.draft.draft_id); group.add(source);
          }
        }
        if (count === group.size) break;
      }
      if (this.records.some(record => group.has(record.draft.draft_id)
        && (this.status(record) === 'running' || (this.status(record) === 'unknown' && record.resolvedBy === null))))
        throw new Error('note_edit_unresolved');
      const remaining = this.records.filter(record => !group.has(record.draft.draft_id));
      const ledger = await this.rebuildLedger(remaining);
      this.checkContext(context); this.records = remaining; this.ledger = ledger;
      for (const draftId of group) { this.executions.delete(draftId); this.uncertain.delete(draftId); }
      this.persist('before_forget_persist');
    });
  }
  private validateSource(input: NoteEditInput): void {
    const source = this.find(input.sourceActionId!), status = this.status(source);
    if (source.resolvedBy !== null || (input.kind === 'undo' ? status !== 'succeeded' : status !== 'unknown')
      || source.meta.folderId !== input.folderId || source.meta.path !== input.path || source.meta.rootIdentity !== input.rootIdentity
      || source.draft.action.target !== input.target
      || !Buffer.from((input.kind === 'undo' ? source : this.backup(source)).before, 'base64').equals(input.after))
      throw new Error('invalid_note_recovery');
  }
  private async rebuildLedger(records: RecordEntry[]): Promise<ApprovalLedger> {
    const ids = new Set(records.map(record => record.draft.draft_id)), snapshot = this.ledger.snapshot();
    snapshot.claims = snapshot.claims.filter(claim => ids.has(claim.approval.draft_id));
    const ledger = new ApprovalLedger(this.identity, executorId, true, snapshot);
    for (const record of records) await ledger.registerDraft(record.draft);
    return ledger;
  }
  /** Recovery attempts retain the original backup, even if a prior attempt saw truncated bytes. */
  private backup(record: RecordEntry): RecordEntry {
    let current = record; const seen = new Set<string>();
    while (current.meta.kind === 'recovery' && current.meta.sourceActionId) {
      if (seen.has(current.draft.draft_id)) throw new Error('invalid_note_recovery');
      seen.add(current.draft.draft_id); current = this.find(current.meta.sourceActionId);
    }
    return current;
  }
  private input(record: RecordEntry): NoteEditInput {
    return { folderId: record.meta.folderId, folderLabel: record.meta.folderLabel, path: record.meta.path, target: record.draft.action.target,
      grantRevision: record.meta.grantRevision, rootIdentity: record.meta.rootIdentity, fileIdentity: record.meta.fileIdentity,
      kind: record.meta.kind, ...(record.meta.sourceActionId ? { sourceActionId: record.meta.sourceActionId } : {}),
      before: Buffer.from(record.before, 'base64'), after: Buffer.from(record.after, 'base64') };
  }
  private summary(record: RecordEntry): NoteEditSummary {
    const status = this.status(record), claim = this.claim(record);
    let recoverable = true;
    try { decodeNoteBytes(Buffer.from((status === 'unknown' ? this.backup(record) : record).before, 'base64')); } catch { recoverable = false; }
    return { draftId: record.draft.draft_id, revision: record.draft.revision, payloadSha256: record.draft.payload_sha256,
      folderId: record.meta.folderId, folderLabel: record.meta.folderLabel, path: record.meta.path, target: record.draft.action.target,
      kind: record.meta.kind, status, createdAt: record.createdAt, expiresAt: record.draft.expires_at_ms,
      error: this.uncertain.has(record.draft.draft_id) ? 'note_write_unknown' : claim?.receipt?.error_code ?? (status === 'unknown' ? 'note_write_unknown' : null),
      canUndo: recoverable && record.resolvedBy === null && ['succeeded', 'unknown'].includes(status), resolvedBy: record.resolvedBy };
  }
  private review(record: RecordEntry): NoteEditReview {
    const before = Buffer.from(record.before, 'base64'), after = Buffer.from(record.after, 'base64'), decoded = decodeNoteBytes(after);
    let beforeText: string | null; try { beforeText = decodeNoteBytes(before).text; } catch { beforeText = null; }
    return { ...this.summary(record), beforeText, afterText: decoded.text, beforeSha256: record.meta.beforeSha256,
      afterSha256: record.meta.afterSha256, beforeBytes: before.length, afterBytes: after.length, encoding: decoded.encoding };
  }
  private status(record: RecordEntry): NoteEditSummary['status'] {
    return this.uncertain.has(record.draft.draft_id) ? 'unknown' : this.claim(record)?.state ?? record.disposition;
  }
  private claim(record: RecordEntry): ExecutionClaim | undefined {
    const id = this.executions.get(record.draft.draft_id); return id ? this.ledger.get(id) : undefined;
  }
  private find(id: string): RecordEntry {
    const record = this.records.find(item => item.draft.draft_id === id); if (!record) throw new Error('unknown_draft'); return record;
  }
  private checkContext(context: () => boolean): void { if (typeof context !== 'function' || context() !== true) throw new Error('context_changed'); }
  private readable(): void { if (!this.initialized) throw new Error('note_edit_not_initialized'); }
  private ready(): void { this.readable(); if (this.blocked) throw new Error('note_edit_store_unavailable'); }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - lifetime) throw new Error('invalid_time'); return now;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;
  }
  private ensureDirectories(create = false): void {
    const chain: string[] = []; let cursor = this.directory;
    for (;;) { chain.unshift(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
    for (const directory of chain) {
      let stat;
      try { stat = lstatSync(directory, { bigint: true }); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(directory); stat = lstatSync(directory, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(directory), directory)) throw new Error('unsafe_note_edit_directory');
      const identity = `${stat.dev}:${stat.ino}`;
      if (directory === this.root) {
        if (this.rootIdentity !== null && this.rootIdentity !== identity) throw new Error('unsafe_note_edit_directory');
        this.rootIdentity = identity;
      }
      if (directory === this.directory) {
        if (this.directoryIdentity !== null && this.directoryIdentity !== identity) throw new Error('unsafe_note_edit_directory');
        this.directoryIdentity = identity;
      }
    }
  }
  private readStore(): unknown | undefined {
    try { if (lstatSync(this.store).nlink !== 1) throw new Error('unsafe_note_edit_store'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return readJsonSync(this.store, storeLimit);
  }
  private verifyStore(): void {
    this.ensureDirectories(); const current = this.readStore();
    if ((current === undefined ? 0 : object(current) ? current.revision : -1) !== this.revision
      || (current === undefined ? null : hash(JSON.stringify(current))) !== this.persistedDigest) throw new Error('note_edit_store_changed');
  }
  private persist(point?: string): void {
    try {
      this.verifyStore(); if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error('note_edit_revision_exhausted');
      const state: State = { version: 1, revision: this.revision + 1, records: this.records, ledger: this.ledger.snapshot() };
      if (Buffer.byteLength(JSON.stringify(state), 'utf8') > storeLimit) throw new Error('note_edit_store_limit');
      if (point) this.options.fault?.(point);
      atomicWriteJsonSync(this.store, state); this.revision++; this.persistedDigest = hash(JSON.stringify(state));
    } catch (error) { this.blocked = true; throw error; }
  }
  private async restore(value: unknown): Promise<void> {
    const invalid = () => { throw new Error('invalid_note_edit_store'); };
    if (!object(value) || !keys(value, ['version', 'revision', 'records', 'ledger']) || value.version !== 1
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !Array.isArray(value.records) || value.records.length > maxRecords
      || !object(value.ledger) || !keys(value.ledger, ['identity', 'executor_id', 'claims']) || !Array.isArray(value.ledger.claims)
      || value.ledger.claims.length > maxRecords) return invalid();
    assertDefinition('Identity', value.ledger.identity);
    for (const claim of value.ledger.claims) if (!object(claim) || !keys(claim, ['approval', 'state', 'receipt'])) invalid();
    const ledger = new ApprovalLedger(this.identity, executorId, true, value.ledger as unknown as ExecutionSnapshot);
    const records: RecordEntry[] = [], ids = new Set<string>();
    for (const item of value.records) {
      if (!object(item) || !keys(item, ['draft', 'disposition', 'createdAt', 'meta', 'before', 'after', 'resolvedBy'])
        || !['pending', 'dismissed'].includes(String(item.disposition)) || !Number.isSafeInteger(item.createdAt) || (item.createdAt as number) < 0
        || !object(item.meta) || !keys(item.meta, ['folderId', 'folderLabel', 'path', 'grantRevision', 'rootIdentity', 'fileIdentity',
          'beforeSha256', 'afterSha256', 'kind', 'sourceActionId']) || typeof item.before !== 'string' || typeof item.after !== 'string'
        || !(item.resolvedBy === null || validString(item.resolvedBy, 128))) return invalid();
      assertDefinition('ActionDraft', item.draft); const record = item as unknown as RecordEntry, draft = record.draft;
      if (!sameIdentity(draft.identity, this.identity) || draft.executor_id !== executorId || ids.has(draft.draft_id)
        || draft.revision !== 1 || draft.expires_at_ms !== record.createdAt + lifetime || draft.action.tool_id !== 'note_files'
        || draft.action.account_id !== this.identity.principal_id || draft.action.operation !== record.meta.kind
        || draft.action.arguments_json !== JSON.stringify(record.meta)) return invalid();
      const input = capture(this.input(record));
      if (input.before.toString('base64') !== record.before || input.after.toString('base64') !== record.after
        || hash(input.before) !== record.meta.beforeSha256 || hash(input.after) !== record.meta.afterSha256
        || (record.meta.kind === 'edit' ? record.meta.sourceActionId !== null : !validString(record.meta.sourceActionId, 128))) return invalid();
      await ledger.registerDraft(draft); ids.add(draft.draft_id); records.push(structuredClone(record));
    }
    const claimed = new Set<string>();
    for (const claim of ledger.snapshot().claims) {
      const record = records.find(item => item.draft.draft_id === claim.approval.draft_id);
      if (!record || record.disposition !== 'pending' || claimed.has(record.draft.draft_id)
        || record.draft.revision !== claim.approval.draft_revision || record.draft.payload_sha256 !== claim.approval.payload_sha256
        || record.draft.expires_at_ms !== claim.approval.expires_at_ms || (claim.receipt && (claim.receipt.provider_id !== 'note_files'
          || claim.receipt.provider_operation_id !== (claim.state === 'succeeded' ? record.draft.draft_id : null)))) return invalid();
      claimed.add(record.draft.draft_id); this.executions.set(record.draft.draft_id, claim.approval.execution_id);
      if ((value.ledger.claims as ExecutionClaim[]).some(saved => saved.approval.execution_id === claim.approval.execution_id && saved.state === 'running'))
        this.uncertain.add(record.draft.draft_id);
    }
    this.ledger = ledger; this.records = records;
    for (const [index, record] of records.entries()) {
      const sourceId = record.meta.sourceActionId;
      if (sourceId) {
        const sourceIndex = records.findIndex(item => item.draft.draft_id === sourceId), source = records[sourceIndex];
        if (!source || sourceIndex >= index || source.meta.folderId !== record.meta.folderId || source.meta.path !== record.meta.path
          || source.meta.rootIdentity !== record.meta.rootIdentity || source.draft.action.target !== record.draft.action.target
          || (record.meta.kind === 'undo' ? source.before : this.backup(source).before) !== record.after || !this.claim(source)
          || (record.meta.kind === 'undo' ? this.status(source) !== 'succeeded' : this.status(source) !== 'unknown')
          || (this.status(record) === 'succeeded' && source.resolvedBy !== record.draft.draft_id)) return invalid();
      }
      if (record.resolvedBy !== null) {
        const resolver = records.find(item => item.draft.draft_id === record.resolvedBy);
        if (!resolver || this.status(resolver) !== 'succeeded' || (resolver.meta.kind === 'undo'
          ? resolver.meta.sourceActionId !== record.draft.draft_id
          : resolver.meta.kind !== 'recovery' || this.status(record) !== 'unknown'
            || !resolver.meta.sourceActionId || this.backup(this.find(resolver.meta.sourceActionId)).draft.draft_id !== this.backup(record).draft.draft_id)) return invalid();
      }
    }
    this.revision = value.revision as number; this.persistedDigest = hash(JSON.stringify(value));
  }
}
