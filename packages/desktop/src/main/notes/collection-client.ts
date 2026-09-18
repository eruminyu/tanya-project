import type { NoteFolderBoundary } from '../../shared/note-folders.js';
import type { NoteDocument } from './note-types.js';

export interface Collection {
  id: string; label: string; boundary: NoteFolderBoundary; revision: number; available: boolean; source_count: number;
}
type Request = (path: string, method?: string, body?: unknown) => Promise<unknown>;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value);
function collection(value: unknown): Collection {
  if (!object(value) || Object.keys(value).sort().join() !== 'available,boundary,id,label,revision,source_count'
    || !id(value.id) || typeof value.label !== 'string' || [...value.label].length > 120
    || !['local', 'private_lan'].includes(value.boundary) || typeof value.available !== 'boolean'
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.source_count)
    || value.source_count < 0 || value.source_count > 100000) throw new Error('invalid_response');
  return structuredClone(value) as Collection;
}
export class CollectionClient {
  constructor(private readonly request: Request) {}
  async list(): Promise<Collection[]> {
    const result = await this.request('v1/collections');
    if (!object(result) || Object.keys(result).join() !== 'collections' || !Array.isArray(result.collections) || result.collections.length > 1000)
      throw new Error('invalid_response');
    const values = result.collections.map(collection);
    if (new Set(values.map(value => value.id)).size !== values.length) throw new Error('invalid_response');
    return values;
  }
  async sync(value: {id: string; label: string; boundary: NoteFolderBoundary}, revision: number, documents: NoteDocument[]): Promise<Collection> {
    if (!id(value.id)) throw new Error('invalid_request');
    const result = await this.request('v1/collections/' + value.id, 'PUT', {
      expected_revision: revision, label: value.label, boundary: value.boundary, documents,
    });
    if (!object(result) || Object.keys(result).join() !== 'collection') throw new Error('invalid_response');
    const saved = collection(result.collection);
    if (saved.id !== value.id || saved.label !== value.label || saved.boundary !== value.boundary || !saved.available
      || saved.revision !== revision + 1) throw new Error('invalid_response');
    return saved;
  }
  async unavailable(collectionId: string): Promise<void> {
    if (!id(collectionId)) throw new Error('invalid_request');
    const result = await this.request('v1/collections/' + collectionId + '/availability', 'PUT', {available: false});
    if (!object(result) || Object.keys(result).join() !== 'collection') throw new Error('invalid_response');
    const saved = collection(result.collection);
    if (saved.id !== collectionId || saved.available) throw new Error('invalid_response');
  }
  async remove(collectionId: string, revision: number): Promise<void> {
    if (!id(collectionId)) throw new Error('invalid_request');
    const result = await this.request('v1/collections/' + collectionId + '?revision=' + revision, 'DELETE');
    if (!object(result) || Object.keys(result).join() !== 'ok' || result.ok !== true) throw new Error('invalid_response');
  }
}
