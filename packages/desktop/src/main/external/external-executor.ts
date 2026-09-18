import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { ApprovalLedger, assertDefinition, digestAction, sameIdentity,
  type ActionDraft, type ExecutionReceipt, type ExecutionSnapshot, type Identity } from '@kirian/contracts';
import { atomicWriteJsonSync, readJsonSync } from '../persistence/atomic-json.js';
import type { ExternalActionView, ExternalApproval } from '../../shared/external.js';

export interface ExternalPlan {
  providerId: 'mcp' | 'google_calendar'; connectionId: string; generation: string; fingerprint: string;
  accountId: string; label: string; target: string; operation: string; effect: 'read' | 'write' | 'untrusted';
  payload: Record<string, unknown>;
}
export interface ExternalResult {
  status: 'succeeded' | 'failed' | 'unknown'; operationId: string | null; errorCode: string | null; resultJson?: string;
}
export type ExternalGuard = () => boolean;
/** Main-owned authority only; these hooks are deliberately absent from the durable draft. */
export interface ExternalDraftAuthority {
  expiresAtMs: number;
  guard?(): void;
  revalidate(): Promise<void>;
}
export interface ExternalBinding {
  current(): boolean;
  execute(plan: ExternalPlan, executionId: string, signal: AbortSignal, guard: () => void,
    authorizeDispatch: () => Promise<void>): Promise<ExternalResult>;
  reconcile?(plan: ExternalPlan, executionId: string, signal: AbortSignal, guard: () => void): Promise<ExternalResult>;
}
interface RecordEntry {draft: ActionDraft; disposition: 'pending' | 'dismissed'; resultJson: string | null;}
export const externalExecutorId = 'kirian-external-v1';
const executorId = externalExecutorId, maxRecords = 256, maxBytes = 16 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Canonical JSON, with bounded depth and no lossy/non-JSON input. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) throw new Error('external_invalid_json');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString() === value) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 4096 || Object.keys(value).length !== value.length) throw new Error('external_invalid_json');
    return '[' + value.map(child => canonicalJson(child, depth + 1)).join(',') + ']';
  }
  if (object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Object.keys(value).sort();
    if (keys.length > 1024 || keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('external_invalid_json');
    return '{' + keys.map(key => canonicalJson(key, depth + 1) + ':' + canonicalJson(value[key], depth + 1)).join(',') + '}';
  }
  throw new Error('external_invalid_json');
}
function validatePlan(value: unknown): ExternalPlan {
  const json = canonicalJson(value);
  if (json.length > 32768 || !object(value)
    || Object.keys(value).sort().join() !== 'accountId,connectionId,effect,fingerprint,generation,label,operation,payload,providerId,target'
    || !['mcp','google_calendar'].includes(String(value.providerId))
    || !['connectionId','generation','accountId','operation'].every(key => typeof value[key] === 'string' && idPattern.test(value[key] as string))
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 300
    || typeof value.target !== 'string' || value.target.length < 1 || value.target.length > 2048
    || !['read','write','untrusted'].includes(String(value.effect)) || !object(value.payload)) throw new Error('external_invalid_plan');
  return JSON.parse(json) as ExternalPlan;
}
/** Main-owned durable, one-time consent. The resolver never trusts a wire tool/account ID. */
export class ExternalExecutor {
  private readonly root: string;
  private readonly file: string;
  private readonly identity: Identity;
  private ledger: ApprovalLedger;
  private records: RecordEntry[] = [];
  private revision = 0;
  private digest: string | null = null;
  private initialized = false;
  private blocked = false;
  private epoch = 0;
  private readonly running = new Map<string, AbortController>();
  private readonly uncertain = new Set<string>();
  private readonly preparing = new Set<string>();
  private readonly authorities = new Map<string, ExternalDraftAuthority>();
  constructor(root: string, identity: Identity,
    private readonly resolveBinding: (plan: ExternalPlan, recovering?: boolean) => ExternalBinding | undefined,
    private readonly options: {now?: () => number; fault?: (point: string) => void} = {}) {
    assertDefinition('Identity', identity);
    if (!isAbsolute(root) || identity.mode !== 'personal') throw new Error('external_personal_only');
    this.root = resolve(root); this.file = join(this.root,'executions.json'); this.identity = structuredClone(identity);
    this.ledger = new ApprovalLedger(identity, executorId, true);
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.blocked) throw new Error('external_store_unavailable');
    try {
      mkdirSync(this.root,{recursive:true}); this.checkDirectory();
      const saved = readJsonSync(this.file,maxBytes);
      if (saved !== undefined) {
        if (!object(saved) || Object.keys(saved).sort().join() !== 'ledger,records,revision,version' || saved.version !== 1
          || !Number.isSafeInteger(saved.revision) || Number(saved.revision) < 1 || !Array.isArray(saved.records) || saved.records.length > maxRecords
          || !object(saved.ledger) || !Array.isArray(saved.ledger.claims) || saved.ledger.claims.length > maxRecords) throw new Error('external_invalid_store');
        const ledger = new ApprovalLedger(this.identity,executorId,true,saved.ledger as unknown as ExecutionSnapshot);
        const ids = new Set<string>();
        for (const item of saved.records) {
          if (!object(item) || Object.keys(item).sort().join() !== 'disposition,draft,resultJson' || !['pending','dismissed'].includes(String(item.disposition))
            || (item.resultJson !== null && (typeof item.resultJson !== 'string' || item.resultJson.length > 65536))) throw new Error('external_invalid_store');
          assertDefinition('ActionDraft',item.draft); const draft = item.draft as ActionDraft;
          const plan = validatePlan(JSON.parse(draft.action.arguments_json));
          if (!sameIdentity(draft.identity,this.identity) || draft.executor_id !== executorId || ids.has(draft.draft_id)
            || canonicalJson(plan) !== draft.action.arguments_json || draft.action.tool_id !== plan.providerId
            || draft.action.account_id !== plan.accountId || draft.action.target !== plan.target || draft.action.operation !== plan.operation) throw new Error('external_invalid_store');
          await ledger.registerDraft(draft); ids.add(draft.draft_id);
        }
        const claims = ledger.snapshot().claims, claimedDrafts = new Set<string>();
        for (const claim of claims) {
          const record = saved.records.find(item => item.draft.draft_id === claim.approval.draft_id) as RecordEntry | undefined;
          if (!record || claimedDrafts.has(record.draft.draft_id) || record.disposition !== 'pending'
            || record.draft.revision !== claim.approval.draft_revision || record.draft.payload_sha256 !== claim.approval.payload_sha256
            || record.draft.expires_at_ms !== claim.approval.expires_at_ms
            || (claim.receipt && claim.receipt.provider_id !== record.draft.action.tool_id)
            || (claim.state === 'succeeded' && record.resultJson === null)) throw new Error('external_invalid_store');
          claimedDrafts.add(record.draft.draft_id);
        }
        this.ledger = ledger; this.records = structuredClone(saved.records) as RecordEntry[];
        // A recovered consent screen cannot retain a live connection authority.
        for (const record of this.records) if (!claimedDrafts.has(record.draft.draft_id)) record.disposition = 'dismissed';
        this.revision = Number(saved.revision); this.digest = hash(JSON.stringify(saved));
      }
      this.initialized = true; this.persist();
    } catch { this.block(); throw new Error('external_store_unavailable'); }
  }
  async preview(value: ExternalPlan, context: ExternalGuard = () => true, authority?: ExternalDraftAuthority): Promise<ExternalActionView> {
    this.ready(); const epoch = this.epoch, plan = validatePlan(value); this.checkContext(context);
    const ownedAuthority = authority && { expiresAtMs: authority.expiresAtMs, guard: authority.guard, revalidate: authority.revalidate };
    if (ownedAuthority && (!Number.isSafeInteger(ownedAuthority.expiresAtMs) || ownedAuthority.expiresAtMs <= this.now()
      || typeof ownedAuthority.revalidate !== 'function')) throw new Error('external_proposal_expired');
    if (this.records.length >= maxRecords) throw new Error('external_record_limit');
    const binding = this.resolveBinding(plan); if (!binding?.current()) throw new Error('external_connection_changed');
    const action = {tool_id:plan.providerId,operation:plan.operation,account_id:plan.accountId,target:plan.target,arguments_json:canonicalJson(plan)};
    const draft: ActionDraft = {draft_id:randomUUID(),revision:1,identity:this.identity,executor_id:executorId,
      action,payload_sha256:await digestAction(action),expires_at_ms:Math.min(this.now()+10*60*1000,ownedAuthority?.expiresAtMs??Infinity)};
    this.ready(); this.checkContext(context); this.checkEpoch(epoch);
    await this.ledger.registerDraft(draft);
    if (ownedAuthority) await ownedAuthority.revalidate();
    this.ready(); this.checkContext(context); this.checkEpoch(epoch);
    if (this.now() >= draft.expires_at_ms) throw new Error('external_proposal_expired');
    if (!binding.current() || this.records.length >= maxRecords) throw new Error('external_connection_changed');
    const record: RecordEntry = {draft,disposition:'pending',resultJson:null};this.records.push(record);
    if (ownedAuthority) this.authorities.set(draft.draft_id,ownedAuthority);
    this.persist();return this.view(record);
  }
  async approve(value: ExternalApproval, context: ExternalGuard = () => true): Promise<ExternalActionView> {
    if (!object(value) || Object.keys(value).sort().join() !== 'draftId,payloadSha256,revision'
      || typeof value.draftId !== 'string' || !Number.isSafeInteger(value.revision) || typeof value.payloadSha256 !== 'string') throw new Error('external_invalid_approval');
    const input = structuredClone(value); this.ready();const record = this.find(input.draftId);
    if (this.claim(record) || record.disposition !== 'pending' || this.preparing.has(input.draftId)) throw new Error('external_already_decided');
    if (record.draft.revision !== input.revision || record.draft.payload_sha256 !== input.payloadSha256) throw new Error('external_stale_draft');
    this.preparing.add(input.draftId);
    try {
      const actualDigest = await digestAction(record.draft.action);
      this.ready();this.checkContext(context);
      if (record.disposition !== 'pending' || this.claim(record)) throw new Error('external_already_decided');
      if (actualDigest !== record.draft.payload_sha256) throw new Error('external_stale_draft');
      const plan = validatePlan(JSON.parse(record.draft.action.arguments_json)), binding = this.resolveBinding(plan);
      if (!binding?.current()) throw new Error('external_connection_changed');
      const authority = this.authorities.get(input.draftId);
      if (authority) {
        try { await authority.revalidate(); }
        catch (error) { this.cancel(input.draftId); throw error; }
      }
      this.ready();this.checkContext(context);authority?.guard?.();
      if (record.disposition !== 'pending' || this.claim(record)) throw new Error('external_already_decided');
      if (!binding.current()) throw new Error('external_connection_changed');
      const approval = this.ledger.approve(input.draftId,input.revision,randomUUID(),randomUUID(),this.now());
      this.ledger.claim(approval,this.now());
      try {this.persist('before_claim_persist');this.options.fault?.('after_claim_persist');}
      catch {this.uncertain.add(input.draftId);this.block();throw new Error('external_store_unavailable');}
      const abort = new AbortController();this.running.set(input.draftId,abort);
      const guard = () => {this.ready();this.checkContext(context);authority?.guard?.();if(abort.signal.aborted || !binding.current())throw new Error('external_connection_changed');
        if(authority&&this.now()>=record.draft.expires_at_ms)throw new Error('external_proposal_expired');};
      const authorizeDispatch = async () => {guard();if(authority)await authority.revalidate();guard();};
      let result: ExternalResult;
      let allowed=true;try{guard();}catch{allowed=false;}
      try {result = allowed?await binding.execute(structuredClone(plan),approval.execution_id,abort.signal,guard,authorizeDispatch)
        :{status:'failed',operationId:null,errorCode:'external_proposal_revoked'};}
      catch {result={status:'unknown',operationId:null,errorCode:'external_result_unknown'};}
      finally {this.running.delete(input.draftId);}
      return this.recordResult(record,result);
    } finally {this.preparing.delete(input.draftId);}
  }
  cancel(id: string): ExternalActionView {
    this.running.get(id)?.abort();
    this.ready();const record=this.find(id),claim=this.claim(record);
    if (!claim && record.disposition === 'pending') {record.disposition='dismissed';this.persist();}
    return this.view(record);
  }
  invalidate(): void {
    this.epoch++;
    for(const abort of this.running.values())abort.abort();
    if(!this.initialized || this.blocked)return;
    let changed=false;
    for(const record of this.records)if(!this.claim(record)&&record.disposition==='pending'){record.disposition='dismissed';changed=true;}
    if(changed)this.persist();
  }
  async reconcile(id: string,context:ExternalGuard=()=>true):Promise<ExternalActionView> {
    this.ready();const record=this.find(id),claim=this.claim(record);
    if(!claim || claim.state!=='unknown' || this.running.has(id))throw new Error('external_recovery_unavailable');
    const plan=validatePlan(JSON.parse(record.draft.action.arguments_json)),binding=this.resolveBinding(plan,true);
    if(!binding?.reconcile || !binding.current())throw new Error('external_recovery_unavailable');
    const abort=new AbortController();this.running.set(id,abort);
    const guard=()=>{this.ready();this.checkContext(context);if(abort.signal.aborted||!binding.current())throw new Error('external_connection_changed');};
    let result:ExternalResult;
    try{guard();result=await binding.reconcile(plan,claim.approval.execution_id,abort.signal,guard);}
    catch{result={status:'unknown',operationId:null,errorCode:'external_result_unknown'};}
    finally{this.running.delete(id);}
    return this.recordResult(record,result);
  }
  list():ExternalActionView[]{if(!this.initialized)throw new Error('external_store_unavailable');return this.records.map(record=>this.view(record));}
  lookupReceipt(id:string):{receipt:ExecutionReceipt|null;resultJson:string|null}{
    this.ready();const record=this.find(id),receipt=this.claim(record)?.receipt??null;
    return {receipt:receipt?structuredClone(receipt):null,resultJson:record.resultJson};
  }
  private recordResult(record:RecordEntry,value:ExternalResult):ExternalActionView {
    if(this.blocked){this.uncertain.add(record.draft.draft_id);throw new Error('external_store_unavailable');}
    const claim=this.claim(record)!;let result=value;
    if (!object(value) || !['succeeded','failed','unknown'].includes(value.status)
      || (value.operationId!==null&&(typeof value.operationId!=='string'||!idPattern.test(value.operationId)))
      || (value.errorCode!==null&&(typeof value.errorCode!=='string'||!idPattern.test(value.errorCode)))
      || (value.status==='succeeded'&&(value.operationId===null||value.errorCode!==null||typeof value.resultJson!=='string'))
      || (value.resultJson!==undefined&&(typeof value.resultJson!=='string'||value.resultJson.length>65536)))
      result={status:'unknown',operationId:null,errorCode:'external_invalid_result'};
    const base={execution_id:claim.approval.execution_id,draft_id:record.draft.draft_id,draft_revision:record.draft.revision,
      identity:this.identity,executor_id:executorId,payload_sha256:record.draft.payload_sha256,provider_id:record.draft.action.tool_id,recorded_at_ms:this.now()};
    const receipt:ExecutionReceipt=result.status==='succeeded'?{...base,status:'succeeded',provider_operation_id:result.operationId!,error_code:null}:
      {...base,status:result.status,provider_operation_id:result.operationId,error_code:result.errorCode};
    this.ledger.recordReceipt(receipt,executorId);record.resultJson=result.resultJson??null;
    try{this.persist('before_receipt_persist');}catch{this.uncertain.add(record.draft.draft_id);throw new Error('external_store_unavailable');}
    return this.view(record);
  }
  private now():number {const now=(this.options.now??Date.now)();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-600000)throw new Error('external_invalid_time');return now;}
  private find(id:string):RecordEntry{const record=this.records.find(r=>r.draft.draft_id===id);if(!record)throw new Error('external_unknown_draft');return record;}
  private claim(record:RecordEntry){return this.ledger.snapshot().claims.find(c=>c.approval.draft_id===record.draft.draft_id);}
  private checkContext(context:ExternalGuard):void{if(context()!==true)throw new Error('external_context_changed');}
  private checkEpoch(epoch:number):void{if(epoch!==this.epoch)throw new Error('external_context_changed');}
  private block():void {
    this.blocked=true;
    for(const [id,abort] of this.running){this.uncertain.add(id);abort.abort();}
  }
  private ready():void{if(!this.initialized||this.blocked)throw new Error('external_store_unavailable');}
  private view(record:RecordEntry):ExternalActionView {
    const plan=JSON.parse(record.draft.action.arguments_json) as ExternalPlan,claim=this.claim(record),uncertain=this.uncertain.has(record.draft.draft_id);
    return {draftId:record.draft.draft_id,revision:record.draft.revision,payloadSha256:record.draft.payload_sha256,providerId:plan.providerId,
      connectionId:plan.connectionId,accountLabel:plan.label,target:plan.target,operation:plan.operation,effect:plan.effect,
      argumentsJson:record.draft.action.arguments_json,expiresAt:record.draft.expires_at_ms,status:uncertain?'unknown':claim?.state??record.disposition,
      executionId:claim?.approval.execution_id??null,errorCode:uncertain?'external_store_unavailable':claim?.receipt?.error_code??null,
      operationId:uncertain?null:claim?.receipt?.provider_operation_id??null,resultJson:uncertain?null:record.resultJson,
      recoverable:!this.blocked&&!uncertain&&claim?.state==='unknown'&&plan.providerId==='google_calendar'};
  }
  private checkDirectory():void{
    for(let path=this.root;;path=dirname(path)){const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path).toLowerCase()!==path.toLowerCase())throw new Error('external_unsafe_directory');if(dirname(path)===path)break;}
  }
  private persist(point?:string):void {
    try{this.checkDirectory();const saved=readJsonSync(this.file,maxBytes);
      if((saved===undefined?null:hash(JSON.stringify(saved)))!==this.digest)throw new Error('external_store_changed');
      const next={version:1,revision:this.revision+1,records:this.records,ledger:this.ledger.snapshot()};
      const json=JSON.stringify(next);if(Buffer.byteLength(json)>maxBytes||!Number.isSafeInteger(next.revision))throw new Error('external_store_limit');
      if(point)this.options.fault?.(point);atomicWriteJsonSync(this.file,next);this.revision=next.revision;this.digest=hash(json);
    }catch{this.block();throw new Error('external_store_unavailable');}
  }
}
