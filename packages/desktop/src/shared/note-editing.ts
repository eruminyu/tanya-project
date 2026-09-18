/** Whole-file editing stays on the device. No Markdown or native paths go through Brain IPC. */
export interface NoteEditDocument {
  documentId: string; folderId: string; folderLabel: string; path: string; target: string;
  text: string; sha256: string; bytes: number; encoding: string;
}
export interface NoteEditSummary {
  draftId: string; revision: number; payloadSha256: string;
  folderId: string; folderLabel: string; path: string; target: string;
  kind: 'edit' | 'undo' | 'recovery';
  status: 'pending' | 'dismissed' | 'running' | 'succeeded' | 'failed' | 'unknown';
  createdAt: number; expiresAt: number; error: string | null;
  canUndo: boolean; resolvedBy: string | null;
}
export interface NoteEditReview extends NoteEditSummary {
  beforeText: string | null; afterText: string; beforeSha256: string; afterSha256: string;
  beforeBytes: number; afterBytes: number; encoding: string;
}
export interface NoteEditApproval { draftId: string; revision: number; payloadSha256: string; }
