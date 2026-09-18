import { createHash, randomUUID } from 'node:crypto';
import { assertDefinition, parseMessage, sameModel, type ProtocolMessage, type SourceRef, type SourceRecord } from '@kirian/contracts';
import type { BrainConnection, ConversationToolHooks } from '../brain-connection.js';
import type { SessionController } from '../session-controller.js';
import type { ConversationToolsSettings, ConversationToolsState } from '../../shared/external.js';
import { canonicalJson } from './external-executor.js';
import type { ExternalManager } from './external-manager.js';
import { ExternalProposalAdapter } from './external-proposal-adapter.js';
import { ExternalProposalGateway, proposalLimits, type HostTurnEvidence, type HostRegisteredToolResult, type HostToolCandidate } from './external-proposal-gateway.js';

type Start = Extract<ProtocolMessage, {kind:'turn.start'}>;
type Proposed = Extract<ProtocolMessage, {kind:'tool.proposed'}>;
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value);
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const boundary = (value: unknown) => ['local','private_lan','cloud'].includes(String(value));
const exact = (value: Record<string, any>, keys: string[]) => same(Object.keys(value).sort(), keys.sort());
function fail(): never { throw Error('external_observation_mismatch'); }
function refs(value: unknown): SourceRef[] {
  if (!Array.isArray(value) || value.length > 128) return fail();
  for (const ref of value) assertDefinition('SourceRef', ref);
  if (new Set(value.map(ref => ref.source_id)).size !== value.length) return fail();
  return structuredClone(value).sort((a,b) => a.source_id.localeCompare(b.source_id));
}
export function validateConversationTools(value: unknown): ConversationToolsSettings {
  if (!record(value) || !exact(value,['enabled','selections']) || typeof value.enabled !== 'boolean'
    || !Array.isArray(value.selections) || value.selections.length > 16) throw Error('external_invalid_request');
  const seen = new Set<string>();
  for (const item of value.selections) {
    if (!record(item) || !exact(item,['connectionId','toolName','approvedArgumentBoundary','metadataBoundary','resultBoundary',...(item.calendarId===undefined?[]:['calendarId'])])
      || !id(item.connectionId) || typeof item.toolName !== 'string' || !item.toolName.trim() || Buffer.byteLength(item.toolName)>512
      || (item.calendarId!==undefined&&(typeof item.calendarId!=='string'||!item.calendarId||item.calendarId.length>1024||item.approvedArgumentBoundary!=='cloud'))
      || !boundary(item.approvedArgumentBoundary) || !boundary(item.metadataBoundary) || !boundary(item.resultBoundary)) throw Error('external_invalid_request');
    const key=canonicalJson([item.connectionId,item.toolName]);
    if (seen.has(key)) throw Error('external_invalid_request'); seen.add(key);
  }
  if (value.enabled && value.selections.length === 0) throw Error('external_invalid_request');
  return structuredClone(value) as ConversationToolsSettings;
}
interface Active {
  start: Start; generation: number; serial: number; contextId: string | null;
  evidence: HostTurnEvidence | null; manager: ExternalManager | null; adapter: ExternalProposalAdapter | null;
  gateway: ExternalProposalGateway | null; proposed: Proposed | null; draftId: string | null;
  resolved: boolean; timer: ReturnType<typeof setTimeout> | null;
  offered: HostToolCandidate[];
}
/** Host-owned conversation coordination. There is deliberately no approve/execute dependency. */
export class ExternalConversation implements ConversationToolHooks {
  private state: ConversationToolsState = {enabled:false,selections:[],phase:'off',draftId:null,errorCode:null};
  private active: Active | null = null;
  private serial = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  constructor(private readonly deps: {
    brain: BrainConnection; session: SessionController; manager(): Promise<ExternalManager>; changed(): void;
  }) {}
  snapshot(): ConversationToolsState { return structuredClone(this.state); }
  enabled(): boolean { return this.state.enabled && this.state.selections.length > 0; }
  configure(value: unknown): ConversationToolsState {
    const settings=validateConversationTools(value);
    if (same(settings,{enabled:this.state.enabled,selections:this.state.selections})) return this.snapshot();
    if (this.active) this.deps.brain.cancelTurn();
    this.invalidate('settings_changed');
    this.state={...settings,phase:settings.enabled?'ready':'off',draftId:null,errorCode:null};
    this.deps.changed(); return this.snapshot();
  }
  begin(start: Start): void {
    this.invalidate('new_turn');
    this.active={start:structuredClone(start),generation:this.deps.brain.connectionGeneration(),serial:++this.serial,
      contextId:null,evidence:null,manager:null,adapter:null,gateway:null,proposed:null,draftId:null,resolved:false,timer:null,offered:[]};
    this.state.phase='preparing';this.state.errorCode=null;this.state.draftId=null;this.deps.changed();
  }
  invalidate(reason: string): void {
    const active=this.active;
    // A host source invalidation must also release Brain's separate approval wait.
    if (reason==='source_changed' && active?.contextId) this.deps.brain.cancelTurn();
    this.active=null; ++this.serial;
    if (active?.timer) clearTimeout(active.timer);
    if (active?.proposed && active.gateway) void active.gateway.cancel(active.proposed.payload.proposal_id).catch(()=>{});
    if (reason==='connection_changed') { this.state.enabled=false;this.state.selections=[]; }
    this.state.phase=this.state.enabled?'ready':'off';
    this.state.draftId=null;
    if (active && !['new_turn','completed'].includes(reason)) this.state.errorCode=reason;
    // Caller owns lifecycle broadcasting; avoiding an onChange recursion during disconnect.
  }
  private guard(active: Active): void {
    const connection=this.deps.brain.conversationToolContext();
    if (this.active!==active || active.serial!==this.serial || !this.enabled() || !connection.ready || !connection.loopback
      || connection.generation!==active.generation || !same(connection.scope,active.start.scope)
      || this.deps.session.snapshot().activeTurnId!==active.start.turn_id) throw Error('external_context_changed');
    if (active.adapter && active.offered.some(candidate=>!active.adapter!.isCandidateCurrent(candidate))) throw Error('external_offer_changed');
  }
  private current(active: Active): HostTurnEvidence | null {
    try { this.guard(active); return active.evidence ? structuredClone(active.evidence) : null; } catch { return null; }
  }
  receive(message: ProtocolMessage): void {
    const active=this.active;
    if (!active || message.turn_id!==active.start.turn_id) return;
    if (message.kind==='turn.ended' || message.kind==='turn.cancel') {
      const finished=message.kind==='turn.ended' && message.payload.status==='completed';
      this.invalidate(finished?'completed':'cancelled');
      if (finished) this.state.phase=this.state.enabled?'finished':'off';
      this.deps.changed(); return;
    }
    if (message.kind==='tool.context') {
      if (active.contextId) return;
      active.contextId=message.payload.context_id;
      void this.prepare(active).catch(()=>this.reject(active,'external_context_unavailable'));
    } else if (message.kind==='tool.proposed') {
      if (active.proposed) return;
      active.proposed=structuredClone(message);
      void this.propose(active,message).catch(()=>this.reject(active,'external_proposal_unavailable'));
    }
  }
  private async observation(active: Active): Promise<Record<string, any>> {
    this.guard(active);
    if (!active.contextId) return fail();
    const value=await this.deps.brain.conversationToolRequest('v1/external-tools/turns/'+active.contextId);
    this.guard(active);
    if (!record(value) || !exact(value,['context_id','scope','turn_id','intent_id','request_id','expected_model','model_boundary','routing_reason','source_refs','active','state','explicitly_supported','completed_call'])
      || value.context_id!==active.contextId || !same(value.scope,active.start.scope) || value.turn_id!==active.start.turn_id
      || value.intent_id!==active.start.intent_id || value.request_id!==active.start.request_id || value.active!==true
      || value.explicitly_supported!==true || !['awaiting_offers','generating','awaiting_result','summarizing'].includes(value.state)) return fail();
    assertDefinition('ModelRef',value.expected_model);assertDefinition('RoutingReason',value.routing_reason);
    const model=this.deps.brain.conversationToolContext().models.find(item=>sameModel(item.model,value.expected_model));
    if (!model || model.supports_tools!==true || model.boundary!==value.model_boundary) return fail();
    const candidates=active.start.payload.routing_candidates;
    if (candidates) {
      if (!candidates.some(candidate=>sameModel(candidate,value.expected_model)) || value.routing_reason!=='automatic_budget') return fail();
    } else {
      const reason={request:'request_fixed',conversation:'conversation_fixed',saved_default:'saved_default',initial_local:'initial_local'}[active.start.payload.selection.source];
      if (!sameModel(active.start.payload.selection.model,value.expected_model) || value.routing_reason!==reason) return fail();
    }
    const sourceRefs=refs(value.source_refs);
    if (active.evidence && (!same(sourceRefs,active.evidence.sourceRefs) || !same(value.expected_model,active.evidence.expectedModel)
      || value.model_boundary!==active.evidence.modelBoundary || value.routing_reason!==active.evidence.routingReason)) return fail();
    if (active.proposed) {
      const proposed=active.proposed, call=value.completed_call;
      if (!record(call) || !exact(call,['kind','request_id','proposal_id','offer_id','arguments_json','observed_model'])
        || call.kind!==(proposed.payload.provider_kind==='mcp'?'single_mcp_tool_call':'single_google_calendar_call') || call.request_id!==proposed.request_id || call.proposal_id!==proposed.payload.proposal_id
        || call.offer_id!==proposed.payload.offer_id || !same(call.observed_model,value.expected_model)
        || !same(proposed.payload.actual_model,value.expected_model) || proposed.payload.routing_reason!==value.routing_reason
        || !same(refs(proposed.payload.source_refs),sourceRefs) || typeof call.arguments_json!=='string'
        || canonicalJson(JSON.parse(call.arguments_json))!==canonicalJson(JSON.parse(proposed.payload.arguments_json))) return fail();
    } else if (value.completed_call!==null) return fail();
    return value;
  }
  private async resolveSources(active: Active, sourceRefs: readonly SourceRef[], guard: () => void): Promise<readonly SourceRecord[]> {
    guard(); await this.observation(active); guard();
    const value=await this.deps.brain.conversationToolRequest('v1/external-tools/sources',{refs:sourceRefs}); guard();
    if (!record(value) || !exact(value,['sources']) || !Array.isArray(value.sources)) return fail();
    return value.sources;
  }
  private async prepare(active: Active): Promise<void> {
    const observed=await this.observation(active); this.guard(active);
    if (observed.state!=='awaiting_offers') return fail();
    active.evidence={scope:active.start.scope,turnId:active.start.turn_id,intentId:active.start.intent_id,
      epoch:active.generation,sourceEpoch:active.serial,active:true,toolsEnabled:true,brainDestination:'loopback',
      expectedModel:observed.expected_model,modelAuthorized:true,modelBoundary:observed.model_boundary,
      routingReason:observed.routing_reason,sourceRefs:refs(observed.source_refs),completedCall:null};
    const manager=await this.deps.manager();this.guard(active);active.manager=manager;
    const adapter=new ExternalProposalAdapter(manager,{currentTurn:()=>this.current(active),selections:()=>this.state.selections,
      resolveSources:(sourceRefs,guard)=>this.resolveSources(active,sourceRefs,guard)});active.adapter=adapter;
    const gateway=new ExternalProposalGateway({executorId:adapter.executorId,clock:()=>({wallMs:Date.now(),monotonicMs:performance.now()}),newId:randomUUID,
      currentTurn:()=>this.current(active),toolCandidates:()=>adapter.toolCandidates(),isCandidateCurrent:candidate=>adapter.isCandidateCurrent(candidate),
      resolveSources:(sourceRefs,guard)=>this.resolveSources(active,sourceRefs,guard),previewTool:(input,origin,guard)=>adapter.previewTool(input,origin,guard),
      cancelDraft:id=>adapter.cancelDraft(id),lookupReceipt:id=>adapter.lookupReceipt(id),registerResult:async(input,guard)=>{
        guard();await this.observation(active);guard();
        const {receipt}=await adapter.lookupReceipt(input.provenance.draftId);guard();
        const result=await this.deps.brain.conversationToolRequest('v1/external-tools/results',{...input,receipt});guard();
        return result as HostRegisteredToolResult;
      }});active.gateway=gateway;
    const offers=await gateway.offers();this.guard(active);
    active.offered=adapter.toolCandidates();
    this.send(active,'tool.offers',{context_id:active.contextId,offers});
    active.timer=setTimeout(()=>this.reject(active,'external_proposal_expired'),proposalLimits.ttlMs);
    active.timer.unref?.();
    this.state.phase='preparing';this.deps.changed();
  }
  private async propose(active: Active, message: Proposed): Promise<void> {
    const observed=await this.observation(active);this.guard(active);
    if (!active.evidence || !active.gateway || observed.state!=='awaiting_result') return fail();
    const args=canonicalJson(JSON.parse(message.payload.arguments_json));
    active.evidence.completedCall={kind:message.payload.provider_kind==='mcp'?'single_mcp_tool_call':'single_google_calendar_call',explicitlySupported:true,requestId:message.request_id,
      proposalId:message.payload.proposal_id,offerId:message.payload.offer_id,canonicalArgumentsSha256:sha(args),observedModel:observed.completed_call.observed_model};
    const action=await active.gateway.preview({...message.payload,arguments_json:args,scope:message.scope,
      turn_id:message.turn_id,intent_id:message.intent_id,request_id:message.request_id});
    this.guard(active);active.draftId=action.draftId;this.state.draftId=action.draftId;this.state.phase='awaiting_approval';this.deps.changed();
  }
  private send(active: Active, kind: 'tool.offers'|'tool.resolved', payload: unknown): void {
    this.guard(active);
    const result=this.deps.brain.sendConversationTool(parseMessage({protocol:'kirian.rearchitecture.v1',kind,payload,
      scope:active.start.scope,turn_id:active.start.turn_id,intent_id:active.start.intent_id,
      message_id:randomUUID(),request_id:randomUUID(),sequence:0}));
    if (!result.ok) throw Error('external_context_changed');
  }
  refresh(): void {
    if (!this.active?.draftId) return;
    if (this.refreshing) { this.refreshAgain=true;return; }
    const active=this.active;
    const promise=this.collect(active).catch(()=>this.reject(active,'external_result_unavailable'));
    this.refreshing=promise;
    void promise.finally(()=>{
      if(this.refreshing!==promise)return;
      this.refreshing=null;
      if(this.refreshAgain){this.refreshAgain=false;this.refresh();}
    });
  }
  private async collect(active: Active): Promise<void> {
    this.guard(active);if(active.resolved || !active.manager || !active.gateway || !active.proposed)return;
    const action=active.manager.state().actions.find(action=>action.draftId===active.draftId);
    if (!action) return fail();
    if (action.status==='pending') {
      if (Date.now()>=action.expiresAt) this.reject(active,'external_proposal_expired');
      return;
    }
    if (action.status==='running') { this.state.phase='running';this.deps.changed();return; }
    active.resolved=true;
    if (action.status==='dismissed') {
      await active.gateway.cancel(active.proposed.payload.proposal_id);
      this.send(active,'tool.resolved',{proposal_id:active.proposed.payload.proposal_id,state:'unavailable'});
    } else {
      const result=await active.gateway.receipt(active.proposed.payload.proposal_id);this.guard(active);
      const succeeded=result.state==='succeeded' && result.attached && result.registration;
      const state=succeeded?'succeeded':result.state==='failed'?'failed':result.state==='unknown'?'unknown':'unavailable';
      this.send(active,'tool.resolved',{proposal_id:active.proposed.payload.proposal_id,state,
        ...(succeeded?{source_ref:result.registration!.sourceRef}:{})});
      if (!succeeded && result.state==='succeeded') this.state.errorCode=result.errorCode??'external_result_unavailable';
    }
    if(active.timer)clearTimeout(active.timer);active.timer=null;
    this.state.phase='summarizing';this.deps.changed();
  }
  private reject(active: Active, code: string): void {
    if (this.active!==active) return;
    this.deps.brain.cancelTurn();this.invalidate(code);this.state.errorCode=code;this.state.phase='unavailable';this.deps.changed();
  }
}
