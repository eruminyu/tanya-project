import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertDefinition, type Identity } from '@kirian/contracts';
import { atomicWriteJsonSync, readJsonSync } from '../persistence/atomic-json.js';
import { defaultAutoScreenSettings, type AutoScreenRecord, type AutoScreenSettings } from '../../shared/auto-screen.js';

export interface AutoScreenData { revision: number; settings: AutoScreenSettings; records: AutoScreenRecord[]; lastAttemptAt: number; }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).sort().join() === [...keys].sort().join();
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v)>=min && Number(v)<=max;
const id = (v: unknown): v is string => typeof v==='string' && v.length<=128 && /^window:\d+:\d+$(?![\s\S])/.test(v);
export function validateAutoScreenSettings(value: unknown): asserts value is AutoScreenSettings {
  const defaults=defaultAutoScreenSettings();
  if (!object(value) || !exact(value,Object.keys(defaults)) || typeof value.enabled!=='boolean' || typeof value.analysisEnabled!=='boolean'
    || !Array.isArray(value.targets) || value.targets.length>4 || !Array.isArray(value.excludedIds) || value.excludedIds.length>32
    || !Array.from(value.excludedIds).every(id) || new Set(value.excludedIds).size!==value.excludedIds.length
    || !['local','private_lan'].includes(value.boundary) || (value.modelId!==null && (typeof value.modelId!=='string' || !value.modelId || value.modelId.length>1024))
    || typeof value.prompt!=='string' || !value.prompt.trim() || value.prompt.length>2048 || value.prompt.includes('\0')
    || !integer(value.collectionSeconds,10,300) || !integer(value.analysisSeconds,60,3600)
    || !integer(value.retentionMinutes,1,1440) || !integer(value.maxRecords,1,16)) throw new Error('invalid_request');
  for (const target of value.targets) {
    if (!object(target) || !exact(target,['id','name','kind']) || !id(target.id) || target.kind!=='window'
      || typeof target.name!=='string' || !target.name || target.name.length>4096 || target.name.includes('\0')
      || value.excludedIds.includes(target.id)) throw new Error('invalid_request');
  }
  if (new Set(value.targets.map(t=>t.id)).size!==value.targets.length || value.enabled && !value.targets.length) throw new Error('invalid_request');
}
function validate(value: unknown): asserts value is AutoScreenData {
  if (!object(value) || !exact(value,['revision','settings','records','lastAttemptAt']) || !integer(value.revision,0,Number.MAX_SAFE_INTEGER-1)
    || !integer(value.lastAttemptAt,0,Number.MAX_SAFE_INTEGER) || !Array.isArray(value.records) || value.records.length>17) throw new Error('storage_unavailable');
  validateAutoScreenSettings(value.settings);
  if (value.records.some((record: unknown)=>!object(record) || !exact(record,['id','capturedAt','status'])
    || typeof record.id!=='string' || !/^auto-[0-9a-f-]{36}$(?![\s\S])/.test(record.id)
    || !integer(record.capturedAt,0,Number.MAX_SAFE_INTEGER) || !['pending','saved'].includes(record.status))
    || new Set(value.records.map(r=>r.id)).size!==value.records.length) throw new Error('storage_unavailable');
}
/** Only settings and deletion fences are persisted. Pixel bytes remain in RAM. */
export class AutoScreenStore {
  constructor(private readonly root: string) {}
  private file(identity: Identity): string {
    assertDefinition('Identity',identity);
    return join(this.root,createHash('sha256').update(JSON.stringify([identity.instance_id,identity.mode,identity.principal_id])).digest('hex')+'.json');
  }
  read(identity: Identity): AutoScreenData {
    const data=readJsonSync(this.file(identity),65536);
    if (data===undefined) return {revision:0,settings:defaultAutoScreenSettings(),records:[],lastAttemptAt:0};
    validate(data);return structuredClone(data);
  }
  write(identity: Identity, data: AutoScreenData): void {
    validate(data);
    const json=JSON.stringify(data);if(Buffer.byteLength(json,'utf8')+1>65536)throw new Error('storage_unavailable');
    validate(JSON.parse(json));mkdirSync(this.root,{recursive:true});
    const stat=lstatSync(this.root);if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('storage_unavailable');
    atomicWriteJsonSync(this.file(identity),data);
  }
}
