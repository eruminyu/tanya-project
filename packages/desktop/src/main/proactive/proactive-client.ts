import { assertDefinition, type ModelRef } from '@kirian/contracts';
import { type ProactiveCandidates, type ProactiveResult, type ProactiveSource } from '../../shared/proactive.js';
import { exact, integer } from './proactive-store.js';
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max*2&&[...v].length<=max;
export class ProactiveClient {
 constructor(private readonly request:(path:string,body?:unknown,signal?:AbortSignal)=>Promise<unknown>,private readonly models:{model:ModelRef}[]){}
 async candidates(signal?:AbortSignal,include:string[]=[]):Promise<ProactiveCandidates>{const value=await this.request('v1/proactive/sources'+(include.length?'?include='+encodeURIComponent(include.join(',')):''),undefined,signal);
  if(!exact(value,['generation','sources'])||!integer(value.generation)||!Array.isArray(value.sources)||value.sources.length>50)throw Error('invalid_response');
  for(const source of value.sources){
   if(!exact(source,['source_id','revision','title','kind','fingerprint'])||!text(source.title,120)||!['memory','screen'].includes(source.kind)
    ||typeof source.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(source.fingerprint))throw Error('invalid_response');
   assertDefinition('SourceRef',{source_id:source.source_id,revision:source.revision});
  }
  if(new Set(value.sources.map(s=>s.source_id)).size!==value.sources.length)throw Error('invalid_response');return structuredClone(value) as ProactiveCandidates;
 }
 async generate(sources:ProactiveSource[],modelId:string|null,attempt:string,signal:AbortSignal):Promise<ProactiveResult>{
  const model=modelId===null?null:this.models.find(m=>JSON.stringify([m.model.endpoint_id,m.model.provider_id,m.model.model_id])===modelId)?.model;
  if(model===undefined)throw Error('model_not_allowed');
  const value=await this.request('v1/proactive/generate',{sources:sources.map(s=>({source_id:s.source_id,revision:s.revision})),model,attempt_id:attempt},signal);
  if(!exact(value,['suggestion','actual_model','routing_reason','generation'])||!integer(value.generation))throw Error('invalid_response');
  assertDefinition('ModelRef',value.actual_model);assertDefinition('RoutingReason',value.routing_reason);
  if(value.suggestion!==null){const s=value.suggestion;if(!exact(s,['text','quote','source_id','revision','title'])||!text(s.text,400)||!s.text.trim()||!text(s.quote,300)||!s.quote.trim()
    ||!text(s.title,120)||!sources.some(ref=>ref.source_id===s.source_id&&ref.revision===s.revision))throw Error('invalid_response');}
  return structuredClone(value) as ProactiveResult;
 }
}
