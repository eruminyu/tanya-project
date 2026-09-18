import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertDefinition, type Identity } from '@kirian/contracts';
import { atomicWriteJsonSync, readJsonSync } from './persistence/atomic-json.js';

export interface LocalSettings { voiceEnabled: boolean; conversationId: string | null; }
export class LocalPreferences {
  constructor(private readonly root: string) {}
  private file(identity: Identity): string {
    assertDefinition('Identity', identity);
    const key = createHash('sha256').update(JSON.stringify([identity.instance_id, identity.mode, identity.principal_id])).digest('hex');
    return join(this.root, key + '.json');
  }
  read(identity: Identity): LocalSettings {
    const value = readJsonSync(this.file(identity), 8192) as any;
    if (value === undefined) return { voiceEnabled: true, conversationId: null };
    if (!value || Object.keys(value).sort().join() !== 'conversationId,voiceEnabled' || typeof value.voiceEnabled !== 'boolean'
      || (value.conversationId !== null && (typeof value.conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value.conversationId))))
      throw new Error('storage_unavailable');
    return structuredClone(value);
  }
  write(identity: Identity, update: Partial<LocalSettings>): void {
    if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).some(key => !['voiceEnabled', 'conversationId'].includes(key))
      || ('voiceEnabled' in update && typeof update.voiceEnabled !== 'boolean')
      || ('conversationId' in update && update.conversationId !== null && (typeof update.conversationId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(update.conversationId)))) throw new Error('invalid_request');
    this.ensureDirectory();
    atomicWriteJsonSync(this.file(identity), { ...this.read(identity), ...update });
  }
  pinned(): boolean {
    const value = readJsonSync(join(this.root, 'window.json'), 1024) as any;
    if (value === undefined) return false;
    if (!value || Object.keys(value).join() !== 'alwaysOnTop' || typeof value.alwaysOnTop !== 'boolean') throw new Error('storage_unavailable');
    return value.alwaysOnTop;
  }
  private ensureDirectory(): void {
    mkdirSync(this.root, { recursive: true });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('storage_unavailable');
  }
  savePinned(alwaysOnTop: boolean): void {
    if (typeof alwaysOnTop !== 'boolean') throw new Error('invalid_request');
    this.ensureDirectory(); this.pinned(); atomicWriteJsonSync(join(this.root, 'window.json'), { alwaysOnTop });
  }
}
