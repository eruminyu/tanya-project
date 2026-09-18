import { Ajv, type ValidateFunction } from 'ajv';
import { protocolSchema } from './schema.generated.js';
import type { ProtocolMessage } from './protocol.generated.js';

export class ContractError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContractError'; }
}
const ajv = new Ajv({allErrors: false, strict: true, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false});
const wireValidator = ajv.compile<ProtocolMessage>(protocolSchema);
const definitions = new Map<string, ValidateFunction>();

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value) || ancestors.size >= 64)
    throw new ContractError('non_json_value');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new ContractError('non_json_value');
  if (Object.getOwnPropertySymbols(value).length) throw new ContractError('non_json_value');
  ancestors.add(value);
  try {
    for (const child of Object.values(value)) assertJson(child, ancestors);
  } finally { ancestors.delete(value); }
}
export function assertDefinition(name: string, value: unknown): void {
  assertJson(value);
  if (!Object.hasOwn(protocolSchema.definitions, name)) throw new ContractError('unknown_definition');
  let validator = definitions.get(name);
  if (!validator) {
    validator = ajv.compile({$ref: protocolSchema.$id + '#/definitions/' + name});
    definitions.set(name, validator);
  }
  if (!validator(value)) throw new ContractError('invalid_' + name);
}
export function parseMessage(value: unknown): ProtocolMessage {
  assertJson(value);
  if (!wireValidator(value)) throw new ContractError('invalid_message');
  return structuredClone(value);
}
