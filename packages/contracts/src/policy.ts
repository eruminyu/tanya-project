import type { ContextItem, Endpoint, Identity, ModelRef, ModelSelection, SourceRecord } from './protocol.generated.js';
import { assertDefinition, ContractError } from './validation.js';

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.instance_id === b.instance_id && a.mode === b.mode && a.principal_id === b.principal_id;
}
export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider_id === b.provider_id && a.model_id === b.model_id && a.endpoint_id === b.endpoint_id;
}

// Registries/identities must come from authenticated host configuration, never wire claims.
export function resolveEndpoint(model: ModelRef, endpoints: readonly Endpoint[]): Endpoint {
  assertDefinition('ModelRef', model);
  for (const endpoint of endpoints) assertDefinition('Endpoint', endpoint);
  const matches = endpoints.filter(endpoint => endpoint.endpoint_id === model.endpoint_id);
  const endpoint = matches[0];
  if (matches.length !== 1 || !endpoint || !endpoint.approved || endpoint.provider_id !== model.provider_id)
    throw new ContractError('unapproved_endpoint');
  return structuredClone(endpoint);
}
export function resolveModel(
  identity: Identity, endpoints: readonly Endpoint[], initialLocal: ModelRef,
  options: {request?: ModelRef; conversation?: ModelRef; savedDefault?: ModelRef} = {},
): ModelSelection {
  assertDefinition('Identity', identity);
  if (resolveEndpoint(initialLocal, endpoints).boundary === 'cloud') throw new ContractError('initial_model_not_local');
  const [model, source] = options.request ? [options.request, 'request'] as const
    : options.conversation ? [options.conversation, 'conversation'] as const
    : options.savedDefault ? [options.savedDefault, 'saved_default'] as const
    : [initialLocal, 'initial_local'] as const;
  const endpoint = resolveEndpoint(model, endpoints);
  if (identity.mode === 'public_demo' && (model.provider_id !== 'ollama' || endpoint.boundary === 'cloud'))
    throw new ContractError('public_model_blocked');
  return {model: structuredClone(model), source};
}
export function assertActualModel(selection: ModelSelection, actual: ModelRef): void {
  assertDefinition('ModelSelection', selection);
  assertDefinition('ModelRef', actual);
  if (!sameModel(selection.model, actual)) throw new ContractError('unapproved_model_change');
}

export interface ModelPreferencesSnapshot {
  identity: Identity;
  revision: number;
  saved_default: ModelRef | null;
}
// Storage adapter persists snapshots. Temporary request/conversation choices never mutate them.
export class ModelPreferences {
  private saved: ModelRef | undefined;
  private revision = 0;
  private readonly identity: Identity;
  private readonly endpoints: readonly Endpoint[];
  private readonly initialLocal: ModelRef;
  constructor(identity: Identity, endpoints: readonly Endpoint[], initialLocal: ModelRef, snapshot?: ModelPreferencesSnapshot) {
    resolveModel(identity, endpoints, initialLocal);
    this.identity = structuredClone(identity);
    this.endpoints = structuredClone(endpoints);
    this.initialLocal = structuredClone(initialLocal);
    if (snapshot) {
      assertDefinition('Identity', snapshot.identity);
      if (!sameIdentity(identity, snapshot.identity) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0)
        throw new ContractError('invalid_preferences_snapshot');
      if (snapshot.saved_default !== null) {
        resolveModel(identity, endpoints, initialLocal, {savedDefault: snapshot.saved_default});
        this.saved = structuredClone(snapshot.saved_default);
      }
      this.revision = snapshot.revision;
    }
  }
  setDefault(model: ModelRef): ModelPreferencesSnapshot {
    resolveModel(this.identity, this.endpoints, this.initialLocal, {savedDefault: model});
    if (this.revision === Number.MAX_SAFE_INTEGER) throw new ContractError('revision_exhausted');
    this.saved = structuredClone(model);
    this.revision++;
    return this.snapshot();
  }
  resolve(request?: ModelRef, conversation?: ModelRef): ModelSelection {
    return resolveModel(this.identity, this.endpoints, this.initialLocal, {request, conversation, savedDefault: this.saved});
  }
  snapshot(): ModelPreferencesSnapshot {
    return {identity: structuredClone(this.identity), revision: this.revision, saved_default: this.saved ? structuredClone(this.saved) : null};
  }
}

// Revalidate retrieved revisions and every ancestor immediately before dispatch.
export function assertContextAllowed(
  identity: Identity, items: readonly ContextItem[], catalog: readonly SourceRecord[],
  model: ModelRef, endpoints: readonly Endpoint[],
): void {
  assertDefinition('Identity', identity);
  const destination = resolveEndpoint(model, endpoints).boundary;
  const sources = new Map<string, SourceRecord>();
  for (const source of catalog) {
    assertDefinition('SourceRecord', source);
    if (sources.has(source.source_id)) throw new ContractError('duplicate_source');
    sources.set(source.source_id, source);
  }
  const visited = new Set<string>();
  function visit(sourceId: string, revision: number, ancestry: Set<string>): void {
    const source = sources.get(sourceId);
    if (!source) throw new ContractError('unknown_source');
    if (!sameIdentity(identity, source.identity)) throw new ContractError('foreign_source');
    if (source.deleted) throw new ContractError('deleted_source');
    if (source.revision !== revision) throw new ContractError('stale_source');
    if (ancestry.has(sourceId) || ancestry.size >= 64) throw new ContractError('invalid_source_lineage');
    const boundary = source.kind === 'screen' && source.boundary === 'cloud' ? 'private_lan' : source.boundary;
    if ((boundary === 'local' && destination !== 'local') || (boundary === 'private_lan' && destination === 'cloud'))
      throw new ContractError('context_boundary_blocked');
    if (visited.has(sourceId)) return;
    const path = new Set(ancestry).add(sourceId);
    for (const parent of source.parents) visit(parent.source_id, parent.revision, path);
    visited.add(sourceId);
  }
  for (const item of items) {
    assertDefinition('ContextItem', item);
    visit(item.source_id, item.revision, new Set());
  }
}
