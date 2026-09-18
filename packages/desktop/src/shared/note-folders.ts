export type NoteFolderBoundary = 'local' | 'private_lan';

export interface NoteFolder {
  id: string;
  label: string;
  path: string;
  boundary: NoteFolderBoundary;
  kind: 'vault' | 'approved_notes';
  writeEnabled: boolean;
  phase: 'idle' | 'syncing' | 'ready' | 'error';
  documentCount: number;
  sourceCount: number;
  skipped: number;
  lastSyncedAt: number | null;
  error: string | null;
}

export interface NoteFoldersState {
  available: boolean;
  folders: NoteFolder[];
  busy: boolean;
}

export const emptyNoteFolders = (): NoteFoldersState => ({
  available: false,
  folders: [],
  busy: false,
});
