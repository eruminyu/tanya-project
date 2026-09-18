import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { assertDefinition, type Identity } from '@kirian/contracts';
import { atomicWriteJsonSync, readJsonSync } from '../persistence/atomic-json.js';
import { checkNoteRoot, scanNotes } from './scan-notes.js';
import { CollectionClient, type Collection } from './collection-client.js';
import type { NoteFolder, NoteFolderBoundary, NoteFoldersState } from '../../shared/note-folders.js';

type SavedFolder = Pick<NoteFolder, 'id' | 'label' | 'path' | 'boundary' | 'kind'> & {rootIdentity: string; removing?: true; writeEnabled?: boolean; writeRevision?: number};
export interface NoteEditingGrant { folderId: string; folderLabel: string; root: string; rootIdentity: string; grantRevision: number; }
interface Entry { saved: SavedFolder; view: NoteFolder; digest: string | null; remoteRevision: number | null; }
const boundary = (value: unknown): value is NoteFolderBoundary => value === 'local' || value === 'private_lan';
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function failed(code: string): never { throw new Error(code); }
const safeError = (error: unknown) => {
  const code = error instanceof Error ? error.message : '';
  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '') || code === 'invalid_note_root') return 'root_unavailable';
  if (/^note_.*_limit$/.test(code)) return 'note_limit';
  if (code === 'note_invalid_encoding') return 'invalid_encoding';
  if (code === 'note_tree_changed') return 'source_changed';
  return ['root_unavailable', 'invalid_encoding', 'note_limit', 'source_changed', 'storage_unavailable', 'connection_changed', 'note_write_unknown'].includes(code) ? code : 'scan_failed';
};
function rootIdentity(path: string): string {
  const canonical = checkNoteRoot(path), stat = lstatSync(canonical, {bigint: true});
  if (key(canonical) !== key(path)) failed('root_unavailable');
  return `${stat.dev}:${stat.ino}`;
}

/** Main-only folder grants. The Brain receives relative paths and file content, never a local root or token. */
export class NoteFoldersManager {
  private readonly file: string;
  private readonly abort = new AbortController();
  private entries: Entry[] = [];
  private initialized = false;
  private busy = false;
  private queue: Promise<unknown> = Promise.resolve();
  private poll: ReturnType<typeof setInterval> | undefined;
  private pollPending = false;
  private editingBlocked: (id: string) => boolean = () => false;
  private readonly revoked = new Set<string>();
  private readonly revocations = new Map<string, number>();
  private activeEdit: {id: string; abort: AbortController} | null = null;
  constructor(private readonly settingsRoot: string, identity: Identity, private readonly approvedRoot: string,
    private readonly api: CollectionClient, private readonly changed: () => void,
    private readonly imported: () => void, private readonly context: () => boolean) {
    assertDefinition('Identity', identity);
    if (identity.mode !== 'personal' || !isAbsolute(settingsRoot)) failed('invalid_request');
    const owner = createHash('sha256').update(JSON.stringify([identity.instance_id, identity.mode, identity.principal_id])).digest('hex');
    this.file = join(settingsRoot, 'note-folders-' + owner + '.json');
  }
  snapshot(): NoteFoldersState {
    return {available: this.initialized && !this.abort.signal.aborted, busy: this.busy,
      folders: this.entries.map(entry => ({...structuredClone(entry.view), writeEnabled: entry.view.writeEnabled && !this.revoked.has(entry.saved.id)}))};
  }
  private guard(): void { if (this.abort.signal.aborted || !this.context()) failed('connection_changed'); }
  private make(saved: SavedFolder): Entry {
    const {rootIdentity: _rootIdentity, removing: _removing, writeRevision: _revision, ...visible} = saved;
    // App-owned folder labels are presentation; keep persisted source identities and user labels intact.
    if (saved.kind === 'approved_notes') visible.label = '승인한 키리안 노트';
    return {saved, digest: null, remoteRevision: null, view: {...visible, writeEnabled: saved.writeEnabled === true, phase: 'idle', documentCount: 0, sourceCount: 0, skipped: 0, lastSyncedAt: null, error: null}};
  }
  async initialize(): Promise<void> {
    this.guard(); mkdirSync(this.settingsRoot, {recursive: true});
    const directory = lstatSync(this.settingsRoot);
    if (!directory.isDirectory() || directory.isSymbolicLink()) failed('storage_unavailable');
    const value = readJsonSync(this.file, 65536);
    if (value !== undefined) {
      if (!object(value) || Object.keys(value).sort().join() !== 'folders,version' || value.version !== 1
        || !Array.isArray(value.folders) || value.folders.length > 6) failed('storage_unavailable');
      const ids = new Set<string>(), paths = new Set<string>();
      for (const folder of value.folders) {
        if (!object(folder) || Object.keys(folder).filter(key => !['removing', 'writeEnabled', 'writeRevision'].includes(key)).sort().join() !== 'boundary,id,kind,label,path,rootIdentity'
          || ('writeEnabled' in folder && typeof folder.writeEnabled !== 'boolean')
          || ('writeRevision' in folder && (!Number.isSafeInteger(folder.writeRevision) || folder.writeRevision < 0))
          || (folder.writeEnabled === true && !('writeRevision' in folder))
          || ('removing' in folder && (folder.removing !== true || folder.kind !== 'vault'))
          || typeof folder.rootIdentity !== 'string' || !/^\d+:\d+(?![\s\S])/.test(folder.rootIdentity)
          || typeof folder.id !== 'string' || !/^notes-[a-f0-9-]{36}(?![\s\S])/.test(folder.id)
          || typeof folder.path !== 'string' || !isAbsolute(folder.path) || folder.path.length > 4096
          || typeof folder.label !== 'string' || !folder.label.trim() || [...folder.label].length > 120
          || !boundary(folder.boundary) || !['vault', 'approved_notes'].includes(folder.kind)
          || ids.has(folder.id) || paths.has(key(folder.path))) failed('storage_unavailable');
        if (folder.kind === 'approved_notes' && key(folder.path) !== key(this.approvedRoot)) failed('storage_unavailable');
        ids.add(folder.id); paths.add(key(folder.path)); this.entries.push(this.make(structuredClone(folder) as SavedFolder));
      }
      if (this.entries.filter(entry => entry.saved.kind === 'approved_notes').length !== 1) failed('storage_unavailable');
    } else {
      this.entries.push(this.make({id: 'notes-' + randomUUID(), label: '승인한 키리안 노트', path: this.approvedRoot, rootIdentity: rootIdentity(this.approvedRoot), boundary: 'local', kind: 'approved_notes'}));
      this.save();
    }
    this.guard(); this.initialized = true; this.changed();
    await this.sync();
    this.guard();
    this.poll = setInterval(() => {
      if (this.pollPending || this.busy || this.abort.signal.aborted) return;
      this.pollPending = true;
      void this.sync().catch(() => {}).finally(() => { this.pollPending = false; });
    }, 5000);
    this.poll.unref();
  }
  private save(): void { this.guard(); atomicWriteJsonSync(this.file, {version: 1, folders: this.entries.map(entry => entry.saved)}); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.guard(); if (!this.initialized) failed('storage_unavailable');
      this.busy = true; this.changed();
      try { return await work(); }
      finally { this.busy = false; if (!this.abort.signal.aborted) this.changed(); }
    });
    this.queue = result.catch(() => {}); return result;
  }
  private find(id: string): Entry { const entry = this.entries.find(item => item.saved.id === id); return entry ?? failed('invalid_request'); }
  sync(id?: string): Promise<boolean> {
    return this.serial(async () => {
      const selected = id === undefined ? [...this.entries] : [this.find(id)];
      const remote = await this.api.list(); this.guard(); let safe = true;
      for (const entry of selected) {
        const collection = remote.find(item => item.id === entry.saved.id);
        if (entry.saved.removing) {
          try { await this.finishRemoval(entry, collection); }
          catch (error) { this.guard(); entry.view.phase = 'error'; entry.view.error = safeError(error); safe = false; }
        } else safe = (await this.syncEntry(entry, collection)) && safe;
      }
      return safe;
    });
  }
  private async syncEntry(entry: Entry, remote?: Collection): Promise<boolean> {
    this.guard();
    try {
      if (this.editingBlocked(entry.saved.id)) failed('note_write_unknown');
      if (rootIdentity(entry.saved.path) !== entry.saved.rootIdentity) failed('root_unavailable');
      const scan = await scanNotes(entry.saved.path, this.abort.signal); this.guard();
      if (rootIdentity(entry.saved.path) !== entry.saved.rootIdentity) failed('root_unavailable');
      const unchanged = scan.digest === entry.digest && remote?.available && remote.revision === entry.remoteRevision && remote.boundary === entry.saved.boundary && remote.label === entry.saved.label;
      if (!unchanged) {
        entry.view.phase = 'syncing'; this.changed();
        const saved = await this.api.sync(entry.saved, remote?.revision ?? 0, scan.documents); this.guard();
        entry.digest = scan.digest; entry.remoteRevision = saved.revision; entry.view.sourceCount = saved.source_count; this.imported();
      }
      Object.assign(entry.view, {phase: 'ready', documentCount: scan.documents.length, skipped: scan.skipped,
        lastSyncedAt: Date.now(), error: null});
      this.changed(); return true;
    } catch (error) {
      this.guard(); entry.view.phase = 'error'; entry.view.error = safeError(error); entry.digest = null; entry.remoteRevision = null;
      let safe = false;
      try {
        // A failed response can follow a committed first PUT. Re-read before
        // concluding that there is no remotely available snapshot to block.
        const current = (await this.api.list()).find(item => item.id === entry.saved.id); this.guard();
        if (current) { await this.api.unavailable(entry.saved.id); this.guard(); this.imported(); }
        safe = true;
      }
      catch { safe = false; }
      this.changed(); return safe;
    }
  }
  add(path: string, policy: NoteFolderBoundary): Promise<void> {
    return this.serial(async () => {
      if (!boundary(policy) || this.entries.length >= 6) failed('invalid_request');
      const canonical = checkNoteRoot(path); this.guard();
      if (this.entries.some(entry => key(entry.saved.path) === key(canonical))) failed('invalid_request');
      const entry = this.make({id: 'notes-' + randomUUID(), label: [...basename(canonical)].slice(0, 120).join('') || '노트 폴더',
        path: canonical, rootIdentity: rootIdentity(canonical), boundary: policy, kind: 'vault'});
      this.entries.push(entry);
      try { this.save(); } catch (error) { this.entries.pop(); throw error; }
      if (!await this.syncEntry(entry)) failed('storage_unavailable');
    });
  }
  setBoundary(id: string, policy: NoteFolderBoundary): Promise<void> {
    return this.serial(async () => {
      if (!boundary(policy)) failed('invalid_request'); const entry = this.find(id), previous = entry.saved.boundary;
      if (entry.saved.removing) failed('invalid_request');
      entry.saved.boundary = policy;
      try { this.save(); } catch (error) { entry.saved.boundary = previous; throw error; }
      entry.view.boundary = policy;
      try {
        const remote = (await this.api.list()).find(item => item.id === id); this.guard();
        if (!await this.syncEntry(entry, remote)) failed('storage_unavailable');
      } catch (error) {
        this.guard(); entry.digest = null;
        Object.assign(entry.view, {phase: 'error', error: 'storage_unavailable'}); this.changed(); throw error;
      }
    });
  }
  remove(id: string): Promise<void> {
    this.revokeEditing(id);
    return this.serial(async () => {
      const entry = this.find(id); if (entry.saved.kind !== 'vault') failed('invalid_request');
      // Keep the original grant ID reachable until its interrupted write is recovered.
      // Check after queued work settles: the revocation above may make that write unknown.
      if (this.editingBlocked(id)) {
        Object.assign(entry.view, {phase: 'error', error: 'note_write_unknown'}); this.changed();
        failed('note_write_unknown');
      }
      // Persist the user's intent before sending DELETE. An uncertain response
      // or restart must retry removal, never recreate or re-import the folder.
      if (!entry.saved.removing) {
        entry.saved.removing = true;
        try { this.save(); } catch (error) { delete entry.saved.removing; throw error; }
      }
      try {
        const remote = (await this.api.list()).find(item => item.id === id); this.guard();
        await this.finishRemoval(entry, remote);
      } catch (error) {
        this.guard(); Object.assign(entry.view, {phase: 'error', error: 'storage_unavailable'}); this.changed(); throw error;
      }
    });
  }
  private async finishRemoval(entry: Entry, remote?: Collection): Promise<void> {
    if (remote) { await this.api.remove(entry.saved.id, remote.revision); this.guard(); }
    const previous = this.entries; this.entries = this.entries.filter(item => item !== entry);
    try { this.save(); } catch (error) { this.entries = previous; throw error; }
    this.imported();
  }
  /** Install before initialize so interrupted writes cannot be indexed on restart. */
  setEditingBlocked(check: (id: string) => boolean): void { this.editingBlocked = check; }
  private revokeEditing(id: string): void {
    this.revoked.add(id);
    this.revocations.set(id, (this.revocations.get(id) ?? 0) + 1);
    if (this.activeEdit?.id === id) this.activeEdit.abort.abort();
    this.changed();
  }
  setWriteEnabled(id: string, enabled: boolean): Promise<void> {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return Promise.reject(new Error('invalid_request'));
    this.revokeEditing(id);
    const revocation = this.revocations.get(id);
    return this.serial(async () => {
      const entry = this.find(id);
      if (entry.saved.removing || (entry.saved.writeRevision ?? 0) >= Number.MAX_SAFE_INTEGER) failed('invalid_request');
      if (enabled && rootIdentity(entry.saved.path) !== entry.saved.rootIdentity) failed('root_unavailable');
      const previous = {...entry.saved};
      entry.saved.writeEnabled = enabled; entry.saved.writeRevision = (entry.saved.writeRevision ?? 0) + 1;
      try { this.save(); } catch (error) { entry.saved = previous; entry.view.writeEnabled = false; throw error; }
      entry.view.writeEnabled = enabled;
      if (revocation === this.revocations.get(id)) this.revoked.delete(id);
      this.changed();
    });
  }
  /** Serializes whole-file I/O with reads/imports. Each call revalidates the current grant. */
  editFile<T>(id: string, options: {expected?: {grantRevision: number; rootIdentity: string}; mutation?: boolean;
    recovery?: boolean; context: () => boolean}, work: (grant: NoteEditingGrant, guard: () => boolean, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const entry = this.find(id), revision = entry.saved.writeRevision ?? 0;
      const abort = new AbortController();
      let entered = false;
      const guard = (): boolean => {
        this.guard();
        if (abort.signal.aborted || !options.context()) failed('connection_changed');
        if (this.revoked.has(id) || !entry.saved.writeEnabled || entry.saved.removing || revision !== (entry.saved.writeRevision ?? 0)) failed('write_not_enabled');
        if (options.expected && (options.expected.grantRevision !== revision || options.expected.rootIdentity !== entry.saved.rootIdentity)) failed('source_changed');
        if (!entered && !options.recovery && this.editingBlocked(id)) failed('note_write_unknown');
        if (rootIdentity(entry.saved.path) !== entry.saved.rootIdentity) failed('root_unavailable');
        return true;
      };
      guard(); this.activeEdit = {id, abort};
      const watch = setInterval(() => { try { guard(); } catch { abort.abort(); } }, 50); watch.unref();
      try {
        if (options.mutation) {
          const remote = (await this.api.list()).find(item => item.id === id); guard();
          if (remote) { await this.api.unavailable(id); guard(); this.imported(); }
          entry.digest = null; entry.remoteRevision = null;
        }
        entered = true;
        return await work({folderId: id, folderLabel: entry.saved.label, root: entry.saved.path, rootIdentity: entry.saved.rootIdentity, grantRevision: revision}, guard, abort.signal);
      } finally {
        clearInterval(watch); this.activeEdit = null;
        if (options.mutation && !this.abort.signal.aborted && this.context()) {
          // Success/failure is already in the journal. Indexing never retries a write.
          try { const remote = (await this.api.list()).find(item => item.id === id); await this.syncEntry(entry, remote); }
          catch { entry.digest = null; Object.assign(entry.view, {phase: 'error', error: 'storage_unavailable'}); this.changed(); }
        }
      }
    });
  }
  dispose(): void { this.abort.abort(); this.activeEdit?.abort.abort(); if (this.poll) clearInterval(this.poll); this.initialized = false; }
}
