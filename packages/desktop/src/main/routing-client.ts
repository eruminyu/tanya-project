import type { ModelRef } from '@kirian/contracts';
import type { RoutingState, RoutingSettings } from '../shared/routing.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join() === keys.sort().join();
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export function validateRouting(value: unknown): RoutingState {
  if (!object(value) || !exact(value, ['enabled','revision','daily_call_limit','daily_budget_units','calls_used','budget_units_used','resets_at','persistent'])
    || typeof value.enabled !== 'boolean' || typeof value.persistent !== 'boolean' || !integer(value.revision, 0)
    || !integer(value.daily_call_limit, 1, 100000) || !integer(value.daily_budget_units, 0, 1000000000)
    || !integer(value.calls_used, 0) || !integer(value.budget_units_used, 0) || !integer(value.resets_at, 0)
    || value.enabled && !value.persistent) throw new Error('invalid_response');
  return structuredClone(value) as unknown as RoutingState;
}
export function validateRoutingSettings(value: unknown): RoutingSettings {
  if (!object(value) || !exact(value, ['enabled','expected_revision','daily_call_limit','daily_budget_units'])
    || typeof value.enabled !== 'boolean' || !integer(value.expected_revision, 0)
    || !integer(value.daily_call_limit, 1, 100000) || !integer(value.daily_budget_units, 0, 1000000000)) throw new Error('invalid_request');
  return structuredClone(value) as unknown as RoutingSettings;
}
export interface RoutingModel {
  model: ModelRef; automatic_allowed?: boolean; supports_text?: boolean; supports_images?: boolean;
  budget_units?: number | null; boundary?: string;
}
export function automaticCandidates(models: RoutingModel[], capability: 'text' | 'images', boundary?: string): ModelRef[] {
  return models.filter(m => m.automatic_allowed === true && m.supports_text !== false && typeof m.budget_units === 'number'
    && (capability === 'text' || m.supports_images === true && ['local', 'private_lan'].includes(m.boundary ?? '')
      && (boundary !== 'local' || m.boundary === 'local'))).map(m => structuredClone(m.model));
}
