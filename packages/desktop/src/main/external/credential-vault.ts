import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { atomicWriteJsonSync, readJsonSync } from '../persistence/atomic-json.js';

/** Electron main의 safeStorage만 주입한다. 평문 또는 자체 키 대체 저장은 허용하지 않는다. */
export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface EncryptedRecord { version: 1; ciphertext: string; }
const valueLimit = 64 * 1024;
const ciphertextLimit = 128 * 1024;
const fileLimit = 256 * 1024;
const secureBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function failStorage(): never { throw new Error('credential_storage_unavailable'); }
function failEncryption(): never { throw new Error('credential_encryption_unavailable'); }

/** JSON에서 조용히 사라지거나 변환되는 값과 접근자를 저장 전에 거부한다. */
function serializeValue(value: unknown): string {
  let remaining = 8192;
  const visited = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (--remaining < 0 || depth > 16) throw new Error();
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') { if (Buffer.byteLength(current, 'utf8') > valueLimit) throw new Error(); return; }
    if (typeof current === 'number') { if (!Number.isFinite(current)) throw new Error(); return; }
    if (typeof current !== 'object' || visited.has(current)) throw new Error();
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw new Error();
    visited.add(current);
    const keys = Reflect.ownKeys(current);
    if (keys.length > remaining || keys.some(key => typeof key !== 'string')) throw new Error();
    if (array && (keys.length !== current.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(String(key))))) throw new Error();
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
      if (Buffer.byteLength(String(key), 'utf8') > valueLimit) throw new Error();
      visit(descriptor.value, depth + 1);
    }
    visited.delete(current);
  }
  try {
    visit(value, 0);
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > valueLimit) throw new Error();
    return serialized;
  } catch { throw new Error('invalid_credential_value'); }
}

/**
 * 인증된 identity마다 분리한 rootDir을 main에서 공급한다. get 결과는 main의 제공자
 * 어댑터만 소비하며 IPC 응답·renderer 상태·Brain 메시지에 이 객체를 넣지 않는다.
 * Windows DPAPI의 보장은 같은 Windows 사용자로 실행되는 다른 앱을 배제하지 않는다.
 */
export class SecureCredentialVault {
  private readonly root: string;
  private readonly scope: string;
  private rootIdentity: string | null = null;

  constructor(rootDir: string, private readonly encryption: CredentialEncryption) {
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || rootDir.includes('\0')
      || rootDir.split(/[\\/]/).some(part => part === '..')
      || (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(rootDir) || rootDir.slice(2).includes(':'))))
      throw new Error('invalid_credential_root');
    this.root = resolve(rootDir);
    if (samePath(this.root, parse(this.root).root)) throw new Error('invalid_credential_root');
    this.scope = hash(process.platform === 'win32' ? this.root.toLowerCase() : this.root);
  }

  set(id: string, value: unknown): void {
    const file = this.file(id), serialized = serializeValue(value);
    this.requireEncryption();
    const current = this.storage(() => { this.ensureDirectories(true); return this.readRecord(file); });
    if (current !== undefined) this.decrypt(id, current);
    let ciphertext: Buffer;
    try {
      ciphertext = this.encryption.encryptString(JSON.stringify({ version: 1, scope: this.scope, id, value: JSON.parse(serialized) }));
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length > ciphertextLimit) failEncryption();
    } catch { failEncryption(); }
    this.requireEncryption();
    this.storage(() => {
      this.ensureDirectories();
      if (!this.sameRecord(current, this.readRecord(file))) failStorage();
      atomicWriteJsonSync(file, { version: 1, ciphertext: ciphertext.toString('base64') });
      this.ensureDirectories();
    });
  }

  get(id: string): unknown | undefined {
    const file = this.file(id); this.requireEncryption();
    const current = this.storage(() => this.ensureDirectories() ? this.readRecord(file) : undefined);
    if (current === undefined) return undefined;
    const value = this.decrypt(id, current);
    this.requireEncryption();
    this.storage(() => {
      if (!this.ensureDirectories() || !this.sameRecord(current, this.readRecord(file))) failStorage();
    });
    return value;
  }

  /** 암호화 서비스 장애나 손상된 암호문도 사용자의 명시적 자격 증명 삭제를 막지 않는다. */
  delete(id: string): void {
    const file = this.file(id);
    this.storage(() => {
      if (!this.ensureDirectories() || !this.fileStat(file)) return;
      this.ensureDirectories();
      unlinkSync(file);
    });
  }

  private file(id: string): string {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(id)) throw new Error('invalid_credential_id');
    return join(this.root, hash(id) + '.json');
  }

  private requireEncryption(): void {
    try {
      if (this.encryption.isEncryptionAvailable() !== true) failEncryption();
      if (this.encryption.getSelectedStorageBackend && !secureBackends.has(this.encryption.getSelectedStorageBackend())) failEncryption();
      if (process.platform === 'linux' && !this.encryption.getSelectedStorageBackend) failEncryption();
    } catch { failEncryption(); }
  }

  private decrypt(id: string, record: EncryptedRecord): unknown {
    return this.storage(() => {
      const plaintext = this.encryption.decryptString(Buffer.from(record.ciphertext, 'base64'));
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > valueLimit + 2048) failStorage();
      const decoded: unknown = JSON.parse(plaintext);
      if (!object(decoded) || Object.keys(decoded).sort().join() !== 'id,scope,value,version'
        || decoded.version !== 1 || decoded.scope !== this.scope || decoded.id !== id) failStorage();
      serializeValue(decoded.value);
      return decoded.value;
    });
  }

  private ensureDirectories(create = false): boolean {
    const chain: string[] = []; let cursor = this.root;
    for (;;) { chain.unshift(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
    for (const directory of chain) {
      let stat: BigIntStats;
      try { stat = lstatSync(directory, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (this.rootIdentity !== null) failStorage();
        if (!create) return false;
        mkdirSync(directory, { mode: 0o700 }); stat = lstatSync(directory, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(directory), directory)) failStorage();
      if (directory === this.root) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (this.rootIdentity !== null && this.rootIdentity !== identity) failStorage();
        this.rootIdentity = identity;
      }
    }
    return true;
  }

  private fileStat(file: string): BigIntStats | undefined {
    let stat: BigIntStats;
    try { stat = lstatSync(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !samePath(realpathSync(file), file)) failStorage();
    return stat;
  }

  private readRecord(file: string): EncryptedRecord | undefined {
    const before = this.fileStat(file);
    if (!before) return undefined;
    const value = readJsonSync(file, fileLimit), after = this.fileStat(file);
    if (!after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) failStorage();
    if (!object(value) || Object.keys(value).sort().join() !== 'ciphertext,version' || value.version !== 1
      || typeof value.ciphertext !== 'string' || value.ciphertext.length === 0) failStorage();
    const ciphertext = Buffer.from(value.ciphertext, 'base64');
    if (ciphertext.length === 0 || ciphertext.length > ciphertextLimit || ciphertext.toString('base64') !== value.ciphertext) failStorage();
    return { version: 1, ciphertext: value.ciphertext };
  }

  private sameRecord(a: EncryptedRecord | undefined, b: EncryptedRecord | undefined): boolean { return a?.ciphertext === b?.ciphertext; }
  private storage<T>(work: () => T): T { try { return work(); } catch { return failStorage(); } }
}
