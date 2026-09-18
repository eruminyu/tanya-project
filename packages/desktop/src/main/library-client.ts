import { assertDefinition, sameIdentity, type ContextItem, type Identity, type ModelRef, type ModelSelection, type SourceRecord } from '@kirian/contracts';
import { emptyLibrary, type ConversationSummary, type LibrarySource, type LibraryState, type SourceInput, type SourceUpdate } from '../shared/persistence.js';
import type { ChatMessage, SessionSnapshot } from '../shared/bridge.js';
import { CollectionClient } from './notes/collection-client.js';

export const modelKey = (model: ModelRef) => JSON.stringify([model.endpoint_id, model.provider_id, model.model_id]);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(v);
// JSON Schema and Python count Unicode code points; JS length counts UTF-16 units.
const string = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max * 2 && [...v].length <= max;
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).sort().join() === keys.sort().join();
function invalid(): never { throw new Error('invalid_response'); }
export interface LibraryCatalog { identity: Identity; default_selection: ModelSelection; models: {model: ModelRef; label: string}[]; }
export interface ConversationDetail { conversation: ConversationSummary; messages: ChatMessage[]; actualModel: SessionSnapshot['actualModel']; }

/** Authenticated host data only. Durable history is a view, never replayed wire events. */
export class LibraryClient {
  private state = emptyLibrary();
  private conversationRequest = 0;
  private query = '';
  private fullSources = new Map<string, { record: SourceRecord; title: string; text: string }>();
  constructor(private readonly catalog: LibraryCatalog,
    private readonly request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
    private readonly changed: () => void) {
    this.state.available = true;
    this.updateDefault(catalog.default_selection);
  }
  snapshot(): LibraryState { return structuredClone(this.state); }
  collections(): CollectionClient { return new CollectionClient(this.request); }
  updateDefault(selection: ModelSelection): void {
    assertDefinition('ModelSelection', selection);
    if (!['initial_local', 'saved_default'].includes(selection.source)) invalid();
    this.catalog.default_selection = structuredClone(selection);
    this.state.defaultModelId = modelKey(selection.model);
    this.state.defaultMissing = !this.catalog.models.some(item => modelKey(item.model) === this.state.defaultModelId);
  }
  private summary(value: unknown): ConversationSummary {
    if (!record(value) || !exact(value, ['id', 'title', 'updated_at', 'model']) || !id(value.id)
      || !string(value.title, 160) || !Number.isSafeInteger(value.updated_at) || value.updated_at < 0) invalid();
    if (value.model !== null) assertDefinition('ModelRef', value.model);
    return { id: value.id, title: value.title, updatedAt: value.updated_at, modelId: value.model === null ? null : modelKey(value.model) };
  }
  async refreshConversations(): Promise<void> {
    const request = ++this.conversationRequest;
    const result = await this.request('v1/conversations');
    // A turn-end background refresh cannot restore a list fetched before a mutation.
    if (request !== this.conversationRequest) return;
    if (!record(result) || !exact(result, ['conversations']) || !Array.isArray(result.conversations) || result.conversations.length > 100) invalid();
    const items = result.conversations.map(v => this.summary(v));
    if (new Set(items.map(item => item.id)).size !== items.length) invalid();
    this.state.conversations = items; this.changed();
  }
  async initialize(preferred: string | null): Promise<ConversationDetail> {
    await this.refreshConversations();
    const chosen = this.state.conversations.find(item => item.id === preferred) ?? this.state.conversations[0];
    const detail = chosen ? await this.open(chosen.id) : await this.createConversation();
    await this.search(''); return detail;
  }
  private detail(value: unknown, preserveSelection = false): ConversationDetail {
    if (!record(value) || !exact(value, ['conversation', 'messages']) || !Array.isArray(value.messages) || value.messages.length > 100) invalid();
    const conversation = this.summary(value.conversation);
    const messages: ChatMessage[] = []; let actualModel: SessionSnapshot['actualModel'] = null, characters = 0;
    for (const raw of value.messages) {
      if (!record(raw) || !exact(raw, ['id', 'turn_id', 'role', 'text', 'status', ...['error_code','actual_model','routing_reason'].filter(key => key in raw)])
        || !id(raw.id) || !id(raw.turn_id) || !['user', 'assistant'].includes(raw.role) || !string(raw.text, 32768)
        || !['completed', 'cancelled', 'failed'].includes(raw.status) || ('error_code' in raw && !string(raw.error_code, 128))) invalid();
      characters += [...raw.text].length; if (characters > 32768) invalid();
      if ('actual_model' in raw) {
        if (raw.role !== 'assistant') invalid();
        assertDefinition('ModelRef', raw.actual_model);
        actualModel = { providerId: raw.actual_model.provider_id, modelId: raw.actual_model.model_id, endpointId: raw.actual_model.endpoint_id };
      }
      if ('routing_reason' in raw) { assertDefinition('RoutingReason',raw.routing_reason); if (!('actual_model' in raw)) invalid(); }
      messages.push({ id: raw.id, turnId: raw.turn_id, role: raw.role, text: raw.text, status: raw.status, ...(raw.error_code ? {errorCode: raw.error_code} : {}),
        ...('actual_model' in raw ? {actualModel:structuredClone(actualModel!)} : {}), ...('routing_reason' in raw ? {routingReason:raw.routing_reason} : {}) });
    }
    if (new Set(messages.map(message => message.id)).size !== messages.length) invalid();
    if (!preserveSelection || this.state.conversationId !== conversation.id) this.state.selectedSourceIds = [];
    this.state.conversationId = conversation.id; this.changed();
    return { conversation, messages, actualModel };
  }
  async open(conversationId: string, preserveSelection = false): Promise<ConversationDetail> {
    if (!id(conversationId)) throw new Error('invalid_request');
    const result = await this.request('v1/conversations/' + conversationId);
    if (!record(result) || !record(result.conversation) || result.conversation.id !== conversationId) invalid();
    return this.detail(result, preserveSelection);
  }
  async createConversation(): Promise<ConversationDetail> {
    const detail = this.detail(await this.request('v1/conversations', 'POST', {}));
    await this.refreshConversations(); return detail;
  }
  async deleteConversation(conversationId: string): Promise<void> {
    if (!id(conversationId)) throw new Error('invalid_request');
    await this.request('v1/conversations/' + conversationId, 'DELETE');
    await this.refreshConversations(); await this.search('');
  }
  async saveConversationModel(model: ModelRef | null): Promise<void> {
    if (!this.state.conversationId) throw new Error('invalid_request');
    if (model) assertDefinition('ModelRef', model);
    const result = await this.request('v1/conversations/' + this.state.conversationId + '/model', 'PUT', { model });
    if (!record(result) || !exact(result, ['conversation'])) invalid();
    const summary = this.summary(result.conversation);
    if (summary.id !== this.state.conversationId || summary.modelId !== (model === null ? null : modelKey(model))) invalid();
    await this.refreshConversations();
  }
  async saveDefault(model: ModelRef): Promise<void> {
    assertDefinition('ModelRef', model);
    if (!this.catalog.models.some(item => modelKey(item.model) === modelKey(model))) throw new Error('invalid_request');
    const result = await this.request('v1/preferences', 'PUT', { model });
    if (!record(result) || !exact(result, ['default_selection'])) invalid();
    assertDefinition('ModelSelection', result.default_selection);
    if (result.default_selection.source !== 'saved_default' || modelKey(result.default_selection.model) !== modelKey(model)) invalid();
    this.updateDefault(result.default_selection); this.changed();
  }
  async search(query: string): Promise<void> {
    if (!string(query, 256)) throw new Error('invalid_request');
    const result = await this.request('v1/sources?q=' + encodeURIComponent(query));
    if (!record(result) || !exact(result, ['sources']) || !Array.isArray(result.sources) || result.sources.length > 50) invalid();
    const sources: LibrarySource[] = [], full = new Map<string, {record: SourceRecord; title: string; text: string}>();
    for (const item of result.sources) {
      if (!record(item) || !exact(item, ['record', 'title', 'text', ...('origin' in item ? ['origin'] : [])]) || !string(item.title, 120) || !string(item.text, 8192)) invalid();
      if ('origin' in item && (!record(item.origin) || !exact(item.origin, ['collection_id', 'collection_label', 'path', 'chunk_index', 'chunk_count'])
        || !id(item.origin.collection_id) || !string(item.origin.collection_label, 120) || !item.origin.collection_label.trim()
        || !string(item.origin.path, 1024) || !item.origin.path.toLowerCase().endsWith('.md') || /[\\:\x00-\x1f\x7f]/.test(item.origin.path)
        || item.origin.path.split('/').some((part: string) => ['', '.', '..'].includes(part))
        || !Number.isSafeInteger(item.origin.chunk_index) || item.origin.chunk_index < 0 || !Number.isSafeInteger(item.origin.chunk_count)
        || item.origin.chunk_count < 1 || item.origin.chunk_index >= item.origin.chunk_count)) invalid();
      assertDefinition('SourceRecord', item.record);
      const source = item.record as SourceRecord;
      if (!sameIdentity(source.identity, this.catalog.identity) || source.deleted || full.has(source.source_id)) invalid();
      full.set(source.source_id, structuredClone(item) as any);
      sources.push({ id: source.source_id, revision: source.revision, title: item.title, text: item.text, kind: source.kind,
        boundary: source.boundary, parents: source.parents.map(parent => ({sourceId: parent.source_id, revision: parent.revision})),
        ...(source.source_id.startsWith('screen-analysis-') || source.source_id.startsWith('auto-memory-') ? {readOnly: true} : {}),
        ...(item.origin ? {origin: structuredClone(item.origin)} : {}) });
    }
    this.query = query; this.fullSources = full; this.state.sources = sources;
    this.state.selectedSourceIds = this.state.selectedSourceIds.filter(sourceId => full.has(sourceId)); this.changed();
  }
  async refreshSources(): Promise<void> { await this.search(this.query); }
  select(ids: unknown): void {
    if (!Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length || ids.some(value => !id(value) || !this.fullSources.has(value))) throw new Error('invalid_request');
    this.state.selectedSourceIds = [...ids]; this.changed();
  }
  contexts(): ContextItem[] { return this.state.selectedSourceIds.map(sourceId => {
    const source = this.fullSources.get(sourceId)!; return { source_id: sourceId, revision: source.record.revision, text: source.text };
  }); }
  private input(value: SourceInput): void {
    if (!record(value) || !exact(value, ['title', 'text', 'boundary']) || !string(value.title, 120) || !value.title.trim()
      || !string(value.text, 8192) || !value.text.trim() || !['local', 'private_lan', 'cloud'].includes(value.boundary)) throw new Error('invalid_request');
  }
  async createSource(value: SourceInput): Promise<void> { this.input(value);
    await this.request('v1/sources', 'POST', { ...value, kind: 'note', parents: [] }); await this.search(''); }
  async updateSource(value: SourceUpdate): Promise<void> {
    if (!record(value) || !exact(value, ['id', 'revision', 'title', 'text', 'boundary']) || !id(value.id) || !Number.isSafeInteger(value.revision)) throw new Error('invalid_request');
    const { id: sourceId, revision, ...input } = value; this.input(input);
    await this.request('v1/sources/' + sourceId, 'PUT', { ...input, expected_revision: revision }); await this.search('');
  }
  async deleteSource(value: {id: string; revision: number}): Promise<void> {
    if (!record(value) || !exact(value, ['id', 'revision']) || !id(value.id) || !Number.isSafeInteger(value.revision)) throw new Error('invalid_request');
    await this.request('v1/sources/' + value.id + '?revision=' + value.revision, 'DELETE'); await this.search('');
  }
}
