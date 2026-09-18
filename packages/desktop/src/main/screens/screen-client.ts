import { assertDefinition, sameIdentity, sameModel, type Identity, type ModelRef, type SourceRecord } from '@kirian/contracts';
import type { ScreenAnalysis, ScreenBoundary, ScreenPreview, StoredScreen } from '../../shared/screens.js';
import { modelKey } from '../library-client.js';
import { automaticCandidates, type RoutingModel } from '../routing-client.js';

type Model = RoutingModel & { label: string };
type Source = { record: SourceRecord; title: string; text: string };
export type ScreenRequest = (path: string, method: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).sort().join() === keys.sort().join();
const validString = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n * 2 && [...v].length <= n;
export const validCaptureId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(v);
function invalid(): never { throw new Error('invalid_response'); }

/** Captured pixels only enter the authenticated Brain from the main process. */
export class ScreenClient {
  constructor(private readonly identity: Identity, private readonly models: Model[], private readonly request: ScreenRequest,
    private readonly automaticEnabled: () => boolean = () => false) {}
  model(id: string | null, boundary: ScreenBoundary): ModelRef | null {
    if (id === null) {
      if (!this.automaticEnabled()) throw new Error('routing_changed');
      if (!automaticCandidates(this.models, 'images', boundary).length) throw new Error('routing_no_candidate');
      return null;
    }
    const item = this.models.find(m => modelKey(m.model) === id);
    if (!item) throw new Error('model_not_allowed');
    if (item.supports_images !== true) throw new Error('unsupported_model');
    if (!['local', 'private_lan'].includes(item.boundary ?? '') || boundary === 'local' && item.boundary !== 'local')
      throw new Error('context_blocked');
    return structuredClone(item.model);
  }
  private source(value: unknown, kind: 'screen' | 'memory'): Source {
    if (!object(value) || !exact(value, ['record', 'title', 'text']) || !validString(value.title, 120)
      || !validString(value.text, 8192)) invalid();
    assertDefinition('SourceRecord', value.record);
    const record = value.record as SourceRecord;
    if (!sameIdentity(this.identity, record.identity) || record.deleted || record.kind !== kind
      || !['local', 'private_lan'].includes(record.boundary)) invalid();
    return structuredClone(value) as Source;
  }
  async list(signal?: AbortSignal): Promise<StoredScreen[]> {
    const value = await this.request('v1/screens', 'GET', undefined, signal);
    if (!object(value) || !exact(value, ['screens']) || !Array.isArray(value.screens) || value.screens.length > 32) invalid();
    const result = value.screens.map((item: unknown): StoredScreen => {
      if (!object(item) || !exact(item, ['capture_id', 'source', 'captured_at', 'image_available', 'analysis_source_id', 'actual_model', ...('routing_reason' in item ? ['routing_reason'] : [])])
        || !validCaptureId(item.capture_id) || !Number.isSafeInteger(item.captured_at) || item.captured_at < 0
        || typeof item.image_available !== 'boolean' || (item.analysis_source_id !== null && !validString(item.analysis_source_id, 128))) invalid();
      if (item.actual_model !== null) assertDefinition('ModelRef', item.actual_model);
      if ('routing_reason' in item) { assertDefinition('RoutingReason',item.routing_reason); if (item.actual_model === null) invalid(); }
      if ((item.analysis_source_id === null) !== (item.actual_model === null)) invalid();
      const source = this.source(item.source, 'screen');
      if (source.record.parents.length) invalid();
      return { captureId: item.capture_id, sourceId: source.record.source_id, revision: source.record.revision,
        title: source.title, capturedAt: item.captured_at, boundary: source.record.boundary as ScreenBoundary,
        imageAvailable: item.image_available, analysisSourceId: item.analysis_source_id, actualModel: structuredClone(item.actual_model),
        ...('routing_reason' in item ? {routingReason:item.routing_reason} : {}) };
    });
    if (new Set(result.map(s => s.captureId)).size !== result.length || new Set(result.map(s => s.sourceId)).size !== result.length) invalid();
    return result;
  }
  async upload(preview: ScreenPreview, jpeg: Buffer, signal: AbortSignal): Promise<string> {
    const value = await this.request('v1/screens/' + preview.id, 'PUT', { expected_revision: 0, title: preview.title,
      boundary: preview.boundary, image_base64: jpeg.toString('base64'), captured_at: preview.capturedAt }, signal);
    if (!object(value) || !exact(value, ['source'])) invalid();
    const source = this.source(value.source, 'screen');
    if (source.record.revision !== preview.revision || source.record.boundary !== preview.boundary || source.title !== preview.title
      || source.record.parents.length) invalid();
    return source.record.source_id;
  }
  async analyze(preview: ScreenPreview, sourceId: string, model: ModelRef | null, prompt: string, signal: AbortSignal, background = false): Promise<ScreenAnalysis> {
    if (model === null) this.model(null, preview.boundary);
    const value = await this.request('v1/screens/' + preview.id + (background ? '/auto-analyze' : '/analyze'), 'POST', { revision: preview.revision, model, prompt }, signal);
    if (!object(value) || !exact(value, ['source', 'screen_source', 'actual_model', ...['routing_reason','cached'].filter(key => key in value)])) invalid();
    assertDefinition('ModelRef', value.actual_model);
    if ('routing_reason' in value) assertDefinition('RoutingReason',value.routing_reason);
    if ('cached' in value && value.cached !== true) invalid();
    if (model === null) {
      if (!automaticCandidates(this.models, 'images', preview.boundary).some(candidate => sameModel(candidate, value.actual_model))) throw new Error('model_mismatch');
      if (!value.cached && value.routing_reason !== 'automatic_budget') invalid();
    } else if (!sameModel(value.actual_model, model)) throw new Error('model_mismatch');
    else if (!value.cached && 'routing_reason' in value && value.routing_reason !== 'request_fixed') invalid();
    const source = this.source(value.source, 'memory'), screen = this.source(value.screen_source, 'screen');
    if (screen.record.source_id !== sourceId || screen.record.revision !== preview.revision || screen.record.boundary !== preview.boundary
      || screen.record.parents.length || screen.title !== preview.title || !source.text.trim()
      || source.record.boundary !== preview.boundary || source.record.parents.length !== 1
      || source.record.parents[0]!.source_id !== sourceId || source.record.parents[0]!.revision !== preview.revision) invalid();
    return { sourceId: source.record.source_id, revision: source.record.revision, screenSourceId: sourceId,
      screenRevision: preview.revision, text: source.text, actualModel: structuredClone(value.actual_model),
      ...('routing_reason' in value ? {routingReason:value.routing_reason} : {}), ...(value.cached ? {cached:true} : {}) };
  }
  async cancel(captureId: string, revision: number): Promise<void> {
    const value = await this.request('v1/screens/' + captureId + '/cancel', 'POST', { revision });
    if (!object(value) || !exact(value, ['ok', 'screen']) || value.ok !== true || !object(value.screen)) invalid();
  }
  async delete(captureId: string, revision: number): Promise<void> {
    const value = await this.request('v1/screens/' + captureId + '?revision=' + revision, 'DELETE');
    if (!object(value) || !exact(value, ['ok']) || value.ok !== true) invalid();
  }
}
