import { randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import type { NoteEditApproval, NoteEditDocument, NoteEditReview } from '../../../shared/note-editing.js';
import { NoteFoldersManager, type NoteEditingGrant } from '../note-folders-manager.js';
import { NoteEditJournal, decodeNoteBytes, encodeNoteText } from './note-edit-journal.js';
import { readNoteFile, writeNoteFile, type NoteFileSnapshot } from './windows-note-file.js';

interface OpenDocument { view: NoteEditDocument; grant: NoteEditingGrant; snapshot: NoteFileSnapshot; expires: number; }
function fields(value: unknown, expected: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== expected.sort().join()) throw new Error('invalid_request');
}
/** Owns ephemeral editor tokens; grants and durable execution remain main-owned. */
export class NoteEditor {
  private documents = new Map<string, OpenDocument>();
  constructor(private readonly folders: NoteFoldersManager, private readonly journal: NoteEditJournal) {}
  list() { return this.journal.list(); }
  review(id: string) { if (typeof id !== 'string') throw new Error('invalid_request'); return this.journal.get(id); }
  close(id: string): void { if (typeof id === 'string') this.documents.delete(id); }
  async choose(id: string, picker: (root: string) => Promise<string | null>, context: () => boolean): Promise<NoteEditDocument | null> {
    if (typeof id !== 'string' || !context()) throw new Error('invalid_request');
    const folder = this.folders.snapshot().folders.find(item => item.id === id);
    if (!folder?.writeEnabled) throw new Error('write_not_enabled');
    const selected = await picker(folder.path);
    if (!context()) throw new Error('connection_changed');
    if (selected === null) return null;
    // The picker is a convenience; open() still enforces the existing folder grant.
    return this.open({folderId: id, path: relative(folder.path, selected).split(sep).join('/')}, context);
  }
  async open(input: {folderId: string; path: string}, context: () => boolean): Promise<NoteEditDocument> {
    fields(input, ['folderId', 'path']);
    if (typeof input.folderId !== 'string' || typeof input.path !== 'string' || input.path.split('/').some(part => part.toLowerCase() === 'node_modules')) throw new Error('invalid_request');
    return this.folders.editFile(input.folderId, {context}, async (grant, guard, signal) => {
      const snapshot = await readNoteFile(grant, input.path, signal); guard();
      const {text, encoding} = decodeNoteBytes(snapshot.bytes);
      for (const [id, item] of this.documents) if (item.expires <= Date.now()) this.documents.delete(id);
      if (this.documents.size >= 16) throw new Error('note_document_limit');
      const view = {documentId: randomUUID(), folderId: grant.folderId, folderLabel: grant.folderLabel,
        path: input.path, target: join(grant.root, ...input.path.split('/')), text, sha256: snapshot.sha256, bytes: snapshot.bytes.length, encoding};
      this.documents.set(view.documentId, {view, grant, snapshot, expires: Date.now() + 10 * 60_000});
      return structuredClone(view);
    });
  }
  async preview(input: {documentId: string; text: string}, context: () => boolean): Promise<NoteEditReview> {
    fields(input, ['documentId', 'text']);
    if (typeof input.documentId !== 'string' || typeof input.text !== 'string' || input.text.length > 262144) throw new Error('invalid_request');
    const document = this.documents.get(input.documentId);
    if (!document || document.expires <= Date.now()) throw new Error('note_document_expired');
    const after = encodeNoteText(input.text, document.snapshot.bytes);
    if (after.equals(document.snapshot.bytes)) throw new Error('note_no_change');
    return this.folders.editFile(document.grant.folderId, {expected: document.grant, context}, async (grant, guard, signal) => {
      const current = await readNoteFile(grant, document.view.path, signal); guard();
      if (current.sha256 !== document.snapshot.sha256 || current.identity !== document.snapshot.identity) throw new Error('note_file_conflict');
      return this.journal.create({folderId: grant.folderId, folderLabel: grant.folderLabel, path: document.view.path,
        target: document.view.target, grantRevision: grant.grantRevision, rootIdentity: grant.rootIdentity, fileIdentity: current.identity,
        before: current.bytes, after, kind: 'edit'}, guard);
    });
  }
  async approve(input: NoteEditApproval, context: () => boolean): Promise<NoteEditReview> {
    fields(input, ['draftId', 'revision', 'payloadSha256']);
    if (typeof input.draftId !== 'string') throw new Error('invalid_request');
    const binding = this.journal.binding(input.draftId), review = this.journal.get(input.draftId);
    return this.folders.editFile(binding.folderId, {expected: binding, mutation: true, recovery: review.kind === 'recovery', context},
      (grant, guard, signal) => this.journal.approve(input, guard, async replacement => {
        guard(); return writeNoteFile(grant, binding.path, replacement, signal);
      }));
  }
  async undo(id: string, context: () => boolean): Promise<NoteEditReview> {
    if (typeof id !== 'string') throw new Error('invalid_request');
    const previous = this.journal.get(id), binding = this.journal.binding(id);
    if (!previous.canUndo) throw new Error('note_undo_unavailable');
    return this.folders.editFile(binding.folderId, {recovery: previous.status === 'unknown', context}, async (grant, guard, signal) => {
      if (grant.rootIdentity !== binding.rootIdentity) throw new Error('note_root_changed');
      const current = await readNoteFile(grant, binding.path, signal); guard();
      // Undo of a known success must not replace a later external edit or another file.
      if (previous.status === 'succeeded' && (current.sha256 !== binding.afterSha256 || current.identity !== binding.fileIdentity)) throw new Error('note_file_conflict');
      return this.journal.create({folderId: grant.folderId, folderLabel: grant.folderLabel, path: binding.path,
        target: join(grant.root, ...binding.path.split('/')), grantRevision: grant.grantRevision, rootIdentity: grant.rootIdentity,
        fileIdentity: current.identity, before: current.bytes, after: this.journal.original(id),
        kind: previous.status === 'unknown' ? 'recovery' : 'undo', sourceActionId: id}, guard);
    });
  }
  dismiss(id: string, context: () => boolean) { return this.journal.dismiss(id, context); }
  forget(id: string, context: () => boolean) { return this.journal.forget(id, context); }
}
