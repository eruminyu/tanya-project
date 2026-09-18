import {mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';

export type HostSettings = Record<string, unknown>;
const MAX_BYTES = 128 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function parseHostFile(raw: string): HostSettings {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw Error('invalid_config');
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!object(value) || Object.keys(value).some(key => !['identity','bindings','saved_default','speech','transcription','embedding'].includes(key)) ||
      !object(value.identity) || value.identity.mode !== 'personal' || !Array.isArray(value.bindings) || value.bindings.length < 1 || value.bindings.length > 32)
    throw Error('invalid_config');
  const endpoints = [...value.bindings, ...['speech','transcription','embedding'].flatMap(key => value[key] == null ? [] : [value[key]])];
  for (const endpoint of endpoints) {
    if (!object(endpoint) || 'api_key' in endpoint || typeof endpoint.url !== 'string') throw Error('invalid_config');
    const url = new URL(endpoint.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname || url.port === '0') throw Error('invalid_config');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
    if (!['local','private_lan','cloud'].includes(String(endpoint.boundary)) || endpoint.boundary === 'local' && !local || endpoint.boundary === 'cloud' && url.protocol !== 'https:') throw Error('invalid_config');
  }
  return value;
}
function atomic(path: string, contents: string): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, contents, {encoding:'utf8', flag:'wx', mode:0o600});
    const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch {} }
}
export class RuntimeStore {
  constructor(readonly directory: string) {}
  private path(previous = false): string { return join(this.directory, previous ? 'settings.previous.json' : 'settings.json'); }
  private load(previous = false): HostSettings | null {
    let raw: string;
    try { if (statSync(this.path(previous)).size > MAX_BYTES + 100) throw Error('invalid_config'); raw = readFileSync(this.path(previous), 'utf8'); }
    catch (error) { if (!previous && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw Error('settings_unavailable'); }
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion','host'].includes(key))) throw Error('settings_unavailable');
    return value.host === null ? null : parseHostFile(JSON.stringify(value.host));
  }
  read(): HostSettings | null { return this.load(); }
  previous(): HostSettings | null { return this.load(true); }
  canRestore(): boolean { try { this.previous(); return true; } catch { return false; } }
  save(host: HostSettings): void {
    const checked = parseHostFile(JSON.stringify(host)), previous = this.read();
    mkdirSync(this.directory, {recursive:true});
    atomic(this.path(true), JSON.stringify({schemaVersion:1,host:previous}));
    atomic(this.path(), JSON.stringify({schemaVersion:1,host:checked}));
  }
  restore(): void {
    const previous = this.previous();
    let current: HostSettings | null;
    try { current = this.read(); }
    catch {
      // Explicit recovery retains the damaged original for manual inspection.
      const raw = readFileSync(this.path());
      writeFileSync(join(this.directory, 'settings-recovered-' + randomUUID() + '.json'), raw, {flag:'wx',mode:0o600});
      atomic(this.path(), JSON.stringify({schemaVersion:1,host:previous})); return;
    }
    atomic(this.path(), JSON.stringify({schemaVersion:1,host:previous}));
    atomic(this.path(true), JSON.stringify({schemaVersion:1,host:current}));
  }
}
