import { assertDefinition, type ContextItem } from '@kirian/contracts';
import { defaultAutoMemorySettings, memoryStatusLabels, type AutoMemoryState, type AutoMemorySettings, type AutoMemoryUpdate, type SemanticSearch } from '../shared/auto-memory.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).sort().join() === [...keys].sort().join();
const string = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max * 2 && [...v].length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(v);
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
const category = (v: unknown) => ['preference','fact','task'].includes(v as string);
function invalid(code = 'invalid_response'): never { throw new Error(code); }
function settings(value: unknown, code: string): asserts value is AutoMemorySettings {
  if (!object(value) || !exact(value, Object.keys(defaultAutoMemorySettings()))
    || ['enabled','conversations','screen_analyses','retrieval_enabled'].some(key => typeof value[key] !== 'boolean')
    || !['local','private_lan','cloud'].includes(value.conversation_boundary)
    || !Array.isArray(value.categories) || !value.categories.length || value.categories.length > 3 || value.categories.some(v => !category(v))
    || new Set(value.categories).size !== value.categories.length || !Array.isArray(value.note_collection_ids)
    || value.note_collection_ids.length > 32 || value.note_collection_ids.some(v => !id(v))
    || new Set(value.note_collection_ids).size !== value.note_collection_ids.length) invalid(code);
}
function reference(value: unknown): void {
  if (!object(value) || !id(value.source_id) || !integer(value.revision, 1) || !string(value.title, 120)) invalid();
}
function status(value: unknown): void {
  if (typeof value !== 'string' || !Object.hasOwn(memoryStatusLabels, value)) invalid();
}
export function validateAutoMemoryState(value: unknown): AutoMemoryState {
  if (!object(value) || !exact(value, ['settings','revision','status','embedding_model','pending_count','memory_count','indexed_count','evidence','recent_usage'])
    || !integer(value.revision) || !integer(value.pending_count) || value.pending_count > 66
    || !integer(value.memory_count) || !integer(value.indexed_count) || value.indexed_count > 10000
    || !Array.isArray(value.evidence) || value.evidence.length > 50 || !Array.isArray(value.recent_usage) || value.recent_usage.length > 20) invalid();
  settings(value.settings, 'invalid_response'); status(value.status);
  try {
    if (value.embedding_model !== null) assertDefinition('ModelRef', value.embedding_model);
    for (const entry of value.evidence) {
      if (!object(entry) || !exact(entry, ['source_id','revision','title','category','quote','actual_model','parent','created_at'])
        || !category(entry.category) || !string(entry.quote,1024) || !entry.quote.trim() || !integer(entry.created_at)
        || !object(entry.parent) || !exact(entry.parent,['source_id','revision','title'])) invalid();
      reference(entry); reference(entry.parent); assertDefinition('ModelRef',entry.actual_model);
    }
    if (new Set(value.evidence.map(v => v.source_id)).size !== value.evidence.length) invalid();
    for (const entry of value.recent_usage) {
      if (!object(entry) || !exact(entry,['source_id','revision','title','conversation_id','turn_id','actual_model','reason'])
        || !id(entry.conversation_id) || !id(entry.turn_id) || entry.reason !== 'response_context') invalid();
      reference(entry); assertDefinition('ModelRef',entry.actual_model);
    }
  } catch { invalid(); }
  return structuredClone(value) as AutoMemoryState;
}

/** renderer는 검색어와 설정만 전달한다. 원문 context는 main의 LibraryClient가 공급한다. */
export class AutoMemoryClient {
  constructor(private readonly request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
    private readonly contexts: () => ContextItem[]) {}
  async read(): Promise<AutoMemoryState> { return validateAutoMemoryState(await this.request('v1/auto-memory','GET')); }
  async configure(input: AutoMemoryUpdate): Promise<AutoMemoryState> {
    if (!object(input) || !exact(input,['settings','expected_revision']) || !integer(input.expected_revision)) invalid('invalid_request');
    settings(input.settings, 'invalid_request');
    return validateAutoMemoryState(await this.request('v1/auto-memory','PUT',structuredClone(input)));
  }
  async search(query: string): Promise<SemanticSearch> {
    if (!string(query,256) || !query.trim()) invalid('invalid_request');
    const context = this.contexts();
    if (context.length > 16) invalid('invalid_request');
    for (const item of context) assertDefinition('ContextItem',item);
    const value = await this.request('v1/auto-memory/search','POST',{query,context});
    if (!object(value) || !exact(value,['results','status']) || !Array.isArray(value.results) || value.results.length > 8) invalid();
    status(value.status);
    for (const match of value.results) {
      if (!object(match) || !exact(match,['source_id','revision','title','score','reason']) || match.reason !== 'semantic_similarity'
        || typeof match.score !== 'number' || !Number.isFinite(match.score) || match.score < -1 || match.score > 1) invalid();
      reference(match);
    }
    if (new Set(value.results.map(v => v.source_id)).size !== value.results.length || value.status !== 'ready' && value.results.length) invalid();
    return structuredClone(value) as SemanticSearch;
  }
}
