export type DataBoundary = 'local' | 'private_lan' | 'cloud';
export interface ConversationSummary { id: string; title: string; updatedAt: number; modelId: string | null; }
export interface LibrarySource {
  id: string; revision: number; title: string; text: string;
  kind: 'note' | 'memory' | 'conversation' | 'screen' | 'calendar' | 'index' | 'tool_result';
  boundary: DataBoundary; parents: { sourceId: string; revision: number }[];
  readOnly?: boolean;
  origin?: {collection_id: string; collection_label: string; path: string; chunk_index: number; chunk_count: number};
}
export interface LibraryState {
  available: boolean; conversationId: string | null; conversations: ConversationSummary[];
  sources: LibrarySource[]; selectedSourceIds: string[]; defaultModelId: string | null; defaultMissing: boolean;
}
export interface SourceInput { title: string; text: string; boundary: DataBoundary; }
export interface SourceUpdate extends SourceInput { id: string; revision: number; }
export const emptyLibrary = (): LibraryState => ({ available: false, conversationId: null, conversations: [],
  sources: [], selectedSourceIds: [], defaultModelId: null, defaultMissing: false });
