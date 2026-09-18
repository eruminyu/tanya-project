import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertDefinition, type Identity } from '@kirian/contracts';
import { atomicWriteJsonSync, readJsonSync } from '../persistence/atomic-json.js';
import { defaultProactiveSettings, type ProactiveSettings } from '../../shared/proactive.js';
export const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join() === [...keys].sort().join();
export const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(v);
export const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
export function validateProactiveSettings(value:unknown):asserts value is ProactiveSettings {
 if(!exact(value,Object.keys(defaultProactiveSettings()))||typeof value.enabled!=='boolean'||typeof value.screenAnalyses!=='boolean'
  ||!Array.isArray(value.memorySourceIds)||value.memorySourceIds.length>8||Object.keys(value.memorySourceIds).length!==value.memorySourceIds.length
  ||Array.from(value.memorySourceIds).some(v=>!id(v))||new Set(value.memorySourceIds).size!==value.memorySourceIds.length
  ||value.modelId!==null&&(typeof value.modelId!=='string'||!value.modelId.length||value.modelId.length>2048)
  ||!integer(value.intervalMinutes,2,1440)||!integer(value.dailyLimit,1,20)
  ||value.calendar!==null&&(!exact(value.calendar,['connectionId','calendarId'])||!id(value.calendar.connectionId)||typeof value.calendar.calendarId!=='string'
   ||!value.calendar.calendarId.trim()||value.calendar.calendarId.length>512||/[\x00-\x1f\x7f]/.test(value.calendar.calendarId)))throw Error('invalid_request');
}
export interface ProactiveData {revision:number;settings:ProactiveSettings;day:number;count:number;reads:number;lastAt:number;readAt:number;seen:{hash:string;at:number}[];}
const fresh=():ProactiveData=>({revision:0,settings:defaultProactiveSettings(),day:0,count:0,reads:0,lastAt:0,readAt:0,seen:[]});
export class ProactiveStore {
 constructor(private readonly root:string){}
 private file(identity:Identity):string {assertDefinition('Identity',identity);if(identity.mode!=='personal')throw Error('context_changed');
  return join(this.root,createHash('sha256').update(JSON.stringify([identity.instance_id,identity.mode,identity.principal_id])).digest('hex')+'.json');}
 read(identity:Identity):ProactiveData {try {
  const value=readJsonSync(this.file(identity),128*1024);if(value===undefined)return fresh();
  if(!exact(value,['revision','settings','day','count','reads','lastAt','readAt','seen'])||['revision','day','count','reads','lastAt','readAt'].some(k=>!integer(value[k]))
   ||!Array.isArray(value.seen)||value.seen.length>512||value.seen.some(v=>!exact(v,['hash','at'])||typeof v.hash!=='string'||!/^[a-f0-9]{64}$/.test(v.hash)||!integer(v.at))
   ||new Set(value.seen.map(v=>v.hash)).size!==value.seen.length)throw Error();
  validateProactiveSettings(value.settings);return structuredClone(value) as ProactiveData;
 }catch{throw Error('storage_unavailable');}}
 write(identity:Identity,value:ProactiveData):void {try{mkdirSync(this.root,{recursive:true});atomicWriteJsonSync(this.file(identity),value);}catch{throw Error('storage_unavailable');}}
}
