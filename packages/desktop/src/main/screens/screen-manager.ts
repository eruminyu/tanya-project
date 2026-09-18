import { randomUUID } from 'node:crypto';
import { emptyScreens, type ScreenAnalyzeInput, type ScreenCommandResult, type ScreenState, type ScreenTarget } from '../../shared/screens.js';
import { ScreenClient, validCaptureId } from './screen-client.js';

export interface CaptureAdapter {
  listSources(): Promise<ScreenTarget[]>;
  capture(sourceId: string, expectedName: string, signal: AbortSignal): Promise<{jpeg: Buffer; width: number; height: number}>;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, any>, fields: string[]) => Object.keys(v).sort().join() === fields.sort().join();
const codes = new Set(['unsupported_model', 'context_blocked', 'model_not_allowed', 'source_changed', 'screen_busy', 'screen_limit', 'image_limit',
  'routing_changed', 'routing_no_candidate', 'routing_limit', 'persistence_unavailable',
  'capture_unavailable', 'capture_cancelled', 'capture_timeout', 'connection_changed', 'provider_error', 'provider_unavailable', 'turn_timeout', 'model_mismatch',
  'incomplete_response', 'storage_unavailable', 'invalid_request', 'invalid_response', 'deletion_unconfirmed', 'screen_cancelled']);
const errorCode = (error: unknown) => {
  if (!(error instanceof Error)) return 'capture_unavailable';
  if (error.name === 'AbortError') return 'capture_cancelled';
  const native: Record<string, string> = {capture_busy: 'screen_busy', capture_source_changed: 'source_changed',
    capture_denied: 'capture_unavailable', capture_limit: 'image_limit'};
  return native[error.message] ?? (codes.has(error.message) ? error.message : 'capture_unavailable');
};
const fail = (code: string): ScreenCommandResult => ({ok: false, code});

/** One explicit capture, bound to a connection. Collection never triggers inference. */
export class ScreenManager {
  private state = emptyScreens();
  private api: ScreenClient | null = null;
  private generation = -1;
  private operation = 0;
  private abort: AbortController | null = null;
  private jpeg: Buffer | null = null;
  private rootId: string | null = null;
  private uploadAttempted = false;
  private listedAt = 0;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private refreshSequence = 0;
  constructor(private readonly native: CaptureAdapter, private readonly changed: (state: ScreenState) => void,
    private readonly imported: () => void, private readonly useSource: (id: string, revision: number) => Promise<ScreenCommandResult>) {}
  snapshot(): ScreenState { return structuredClone(this.state); }
  private emit(): void { this.state.version++; this.changed(this.snapshot()); }
  private releaseImage(): void {
    this.jpeg?.fill(0); this.jpeg = null;
    if (this.expiry) clearTimeout(this.expiry); this.expiry = null;
  }
  setConnection(generation: number, api: ScreenClient | null): void {
    if (generation === this.generation && !!api === !!this.api) return;
    const previous = this.api, preview = this.state.preview;
    this.abort?.abort(); this.abort = null; this.operation++; this.refreshSequence++;
    if (previous && preview && this.state.phase === 'analyzing') void previous.cancel(preview.id, preview.revision).catch(() => {});
    this.releaseImage(); this.rootId = null; this.uploadAttempted = false; this.listedAt = 0;
    this.generation = generation; this.api = api;
    this.state = {...emptyScreens(), version: this.state.version, available: !!api}; this.emit();
    if (api) void this.refreshSaved();
  }
  private busy(): boolean { return ['listing', 'capturing', 'analyzing', 'deleting'].includes(this.state.phase); }
  private current(operation: number, api: ScreenClient): boolean { return operation === this.operation && api === this.api; }
  private error(error: unknown): ScreenCommandResult { const code = errorCode(error); this.state.error = code; this.state.phase = 'error'; this.emit(); return fail(code); }
  async refreshSaved(): Promise<ScreenCommandResult> {
    const api = this.api, request = ++this.refreshSequence;
    if (!api) return fail('connection_changed');
    try {
      const saved = await api.list();
      if (api !== this.api || request !== this.refreshSequence) return fail('connection_changed');
      this.state.saved = saved;
      const analysis = this.state.analysis;
      if (analysis && !saved.some(s => s.analysisSourceId === analysis.sourceId && s.revision === analysis.screenRevision)) this.state.analysis = null;
      this.emit(); return {ok: true};
    } catch (error) {
      if (api !== this.api || request !== this.refreshSequence) return fail('connection_changed');
      this.state.error = errorCode(error); this.emit(); return fail(this.state.error);
    }
  }
  async list(): Promise<ScreenCommandResult> {
    const api = this.api;
    if (!api) return fail('connection_changed');
    if (this.busy()) return fail('screen_busy');
    const operation = ++this.operation;
    this.state.phase = 'listing'; this.state.error = null; this.state.targets = []; this.listedAt = 0; this.emit();
    try {
      const targets = await this.native.listSources();
      if (!this.current(operation, api)) return fail('connection_changed');
      if (targets.length > 256 || targets.some(t => typeof t.id !== 'string' || !t.id || t.id.length > 256 || typeof t.name !== 'string'
        || !t.name.trim() || t.name.length > 2048 || !['screen', 'window'].includes(t.kind)) || new Set(targets.map(t => t.id)).size !== targets.length)
        throw new Error('capture_unavailable');
      this.state.targets = structuredClone(targets); this.listedAt = Date.now();
      this.state.phase = this.state.preview ? 'preview' : 'idle'; this.emit(); return {ok: true};
    } catch (error) { return this.current(operation, api) ? this.error(error) : fail('connection_changed'); }
  }
  async capture(input: unknown): Promise<ScreenCommandResult> {
    const api = this.api;
    if (!api) return fail('connection_changed');
    if (this.busy() || this.state.preview) return fail('screen_busy');
    if (!object(input) || !exact(input, ['sourceId', 'boundary']) || !['local', 'private_lan'].includes(input.boundary)) return fail('invalid_request');
    const target = this.state.targets.find(t => t.id === input.sourceId);
    if (!target || Date.now() - this.listedAt > 60000) return this.error(new Error('source_changed'));
    const operation = ++this.operation, abort = new AbortController(); this.abort = abort;
    this.state.phase = 'capturing'; this.state.error = null; this.emit();
    try {
      const image = await this.native.capture(target.id, target.name, abort.signal);
      if (!this.current(operation, api)) { image.jpeg.fill(0); return fail('connection_changed'); }
      if (!Buffer.isBuffer(image.jpeg) || image.jpeg.length > 4 * 1024 * 1024 || image.jpeg.length < 4
        || image.jpeg[0] !== 0xff || image.jpeg[1] !== 0xd8 || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
        || image.width < 1 || image.height < 1 || image.width > 1600 || image.height > 1600) throw new Error('image_limit');
      this.jpeg = image.jpeg; this.rootId = null; this.uploadAttempted = false;
      this.state.preview = { id: randomUUID(), revision: 1, title: [...target.name].slice(0, 120).join(''), capturedAt: Date.now(),
        width: image.width, height: image.height, boundary: input.boundary, dataUrl: 'data:image/jpeg;base64,' + image.jpeg.toString('base64') };
      this.state.analysis = null; this.state.phase = 'preview'; this.state.targets = []; this.listedAt = 0;
      this.expiry = setTimeout(() => {
        const expired = this.state.preview;
        if (this.state.phase === 'analyzing') { this.abort?.abort(); this.operation++; }
        this.releaseImage();
        if (this.state.preview) this.state.preview.dataUrl = '';
        if (this.state.phase !== 'deleting' && this.state.phase !== 'listing') {
          this.state.error = 'source_changed'; this.state.phase = 'error';
        }
        this.emit();
        if (expired && this.uploadAttempted && this.api === api) {
          // Upload may happen minutes after capture. Revoke that later server
          // image too, while retaining an already completed analysis source.
          void api.cancel(expired.id, expired.revision).then(() => {
            if (this.api === api) return this.refreshSaved();
          }).catch(() => {
            if (this.api === api && this.state.preview?.id === expired.id && this.state.phase !== 'deleting') {
              this.state.error = 'storage_unavailable'; this.emit();
            }
          });
        }
      }, 10 * 60 * 1000); this.expiry.unref?.();
      this.emit(); return {ok: true};
    } catch (error) { return this.current(operation, api) ? this.error(error) : fail('connection_changed'); }
    finally { if (this.current(operation, api)) this.abort = null; }
  }
  async analyze(input: unknown): Promise<ScreenCommandResult> {
    const api = this.api, preview = this.state.preview;
    if (!api) return fail('connection_changed');
    if (this.busy()) return fail('screen_busy');
    if (!object(input) || !exact(input, ['captureId', 'revision', 'modelId', 'prompt']) || (input.modelId !== null && typeof input.modelId !== 'string')
      || typeof input.prompt !== 'string' || input.prompt.length > 4096 || [...input.prompt].length > 2048 || !input.prompt.trim()) return fail('invalid_request');
    if (!preview || preview.id !== input.captureId || preview.revision !== input.revision || !this.jpeg || this.state.analysis) return fail('source_changed');
    let model; try { model = api.model(input.modelId, preview.boundary); } catch (error) { return this.error(error); }
    const operation = ++this.operation, abort = new AbortController(); this.abort = abort;
    this.state.phase = 'analyzing'; this.state.error = null; this.emit();
    try {
      if (!this.rootId) {
        if (this.uploadAttempted) {
          const existing = (await api.list(abort.signal)).find(s => s.captureId === preview.id);
          if (!this.current(operation, api)) return fail('connection_changed');
          if (existing) {
            if (existing.revision !== preview.revision || existing.boundary !== preview.boundary || existing.title !== preview.title) throw new Error('source_changed');
            this.rootId = existing.sourceId;
          }
        }
        if (!this.rootId) { this.uploadAttempted = true; const rootId = await api.upload(preview, this.jpeg!, abort.signal);
          if (!this.current(operation, api)) return fail('connection_changed'); this.rootId = rootId; }
      }
      const analysis = await api.analyze(preview, this.rootId, model, (input as ScreenAnalyzeInput).prompt, abort.signal);
      if (!this.current(operation, api)) return fail('connection_changed');
      this.state.analysis = analysis; this.state.phase = 'preview'; this.imported(); this.emit();
      await this.refreshSaved(); return {ok: true};
    } catch (error) { if (!this.current(operation, api)) return fail('connection_changed'); return this.error(error); }
    finally { if (this.current(operation, api)) this.abort = null; }
  }
  async cancel(): Promise<ScreenCommandResult> {
    if (!['capturing', 'analyzing'].includes(this.state.phase)) return {ok: true};
    const api = this.api, preview = this.state.preview;
    this.abort?.abort(); this.abort = null; const operation = ++this.operation;
    this.state.phase = preview ? 'preview' : 'idle'; this.state.error = null; this.emit();
    if (api && preview && this.uploadAttempted) {
      try { await api.cancel(preview.id, preview.revision); if (this.current(operation, api)) {
        this.releaseImage(); if (this.state.preview) this.state.preview.dataUrl = '';
        this.state.error = 'source_changed'; this.emit(); await this.refreshSaved();
      } }
      catch (error) { if (this.current(operation, api)) return this.error(error); }
    }
    return {ok: true};
  }
  async delete(input: unknown): Promise<ScreenCommandResult> {
    const api = this.api;
    if (!api) return fail('connection_changed');
    if (!object(input) || !exact(input, ['captureId', 'revision']) || !validCaptureId(input.captureId) || !Number.isSafeInteger(input.revision) || input.revision < 1) return fail('invalid_request');
    if (this.state.phase === 'deleting') return fail('screen_busy');
    const preview = this.state.preview, current = preview?.id === input.captureId;
    const known = current ? preview : this.state.saved.find(s => s.captureId === input.captureId);
    if (!known || known.revision !== input.revision) return fail('source_changed');
    this.abort?.abort(); this.abort = null; const operation = ++this.operation;
    this.state.phase = 'deleting'; this.state.error = null; this.emit();
    try {
      if (!current || this.uploadAttempted) await api.delete(input.captureId, input.revision);
      if (!this.current(operation, api)) return fail('connection_changed');
      if (current) { this.releaseImage(); this.state.preview = null; this.state.analysis = null; this.rootId = null; this.uploadAttempted = false; }
      this.state.saved = this.state.saved.filter(s => s.captureId !== input.captureId);
      this.state.phase = this.state.preview ? 'preview' : 'idle'; this.imported(); this.emit();
      await this.refreshSaved(); return {ok: true};
    } catch { return this.current(operation, api) ? this.error(new Error('deletion_unconfirmed')) : fail('connection_changed'); }
  }
  async release(): Promise<ScreenCommandResult> {
    const api = this.api, preview = this.state.preview;
    if (!api) return fail('connection_changed');
    if (this.busy()) return fail('screen_busy');
    if (!preview || !this.state.analysis) return fail('source_changed');
    const operation = ++this.operation;
    this.state.phase = 'deleting'; this.state.error = null; this.emit();
    try {
      // Cancellation frees only pixels; a completed analysis remains a source.
      await api.cancel(preview.id, preview.revision);
      if (!this.current(operation, api)) return fail('connection_changed');
      this.releaseImage(); this.rootId = null; this.uploadAttempted = false;
      this.state.preview = null; this.state.analysis = null; this.state.phase = 'idle'; this.emit();
      return await this.refreshSaved();
    } catch (error) { return this.current(operation, api) ? this.error(error) : fail('connection_changed'); }
  }
  async use(input: unknown): Promise<ScreenCommandResult> {
    if (!object(input) || !exact(input, ['captureId', 'revision'])) return fail('invalid_request');
    const preview = this.state.preview, analysis = this.state.analysis, api = this.api, operation = this.operation;
    if (!api || !preview || !analysis || preview.id !== input.captureId || preview.revision !== input.revision || this.busy()) return fail('source_changed');
    const refreshed = await this.refreshSaved(); if (!refreshed.ok) return refreshed;
    if (!this.current(operation, api) || this.state.analysis !== analysis) return fail('source_changed');
    return this.useSource(analysis.sourceId, analysis.revision);
  }
  dispose(): void { this.setConnection(this.generation + 1, null); }
}
