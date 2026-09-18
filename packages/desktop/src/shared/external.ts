/** 단말의 외부 작업 화면 계약. 자격 증명과 실행 권한 객체는 포함하지 않는다. */
export interface ExternalApproval { draftId: string; revision: number; payloadSha256: string; }
export interface ExternalActionView extends ExternalApproval {
  providerId: string; connectionId: string; accountLabel: string; target: string; operation: string;
  effect: 'read' | 'write' | 'untrusted'; argumentsJson: string; expiresAt: number;
  status: 'pending' | 'dismissed' | 'running' | 'succeeded' | 'failed' | 'unknown';
  executionId: string | null; errorCode: string | null; operationId: string | null; resultJson: string | null;
  recoverable: boolean;
}
export interface ExternalTool { name: string; description: string; inputSchemaJson: string; readOnlyHint: boolean; }
export interface ExternalConnection {
  id: string; kind: 'mcp' | 'google'; label: string; destination: string;
  phase: 'disconnected' | 'connecting' | 'ready' | 'error'; errorCode: string | null; tools: ExternalTool[];
}
export interface CalendarView { id: string; label: string; timeZone: string; accessRole: string; canWrite: boolean; }
export interface ExternalState { available: boolean; connections: ExternalConnection[]; actions: ExternalActionView[]; }
export type ExternalBoundary = 'local' | 'private_lan' | 'cloud';
export interface ConversationToolSelection {
  connectionId: string; toolName: string; calendarId?: string; approvedArgumentBoundary: ExternalBoundary;
  metadataBoundary: ExternalBoundary; resultBoundary: ExternalBoundary;
}
export interface ConversationToolsSettings { enabled: boolean; selections: ConversationToolSelection[]; }
export interface ConversationToolsState extends ConversationToolsSettings {
  phase: 'off' | 'ready' | 'preparing' | 'awaiting_approval' | 'running' | 'summarizing' | 'finished' | 'unavailable';
  draftId: string | null; errorCode: string | null;
}
export interface CalendarEventInput {
  eventId?: string; summary?: string; start?: {dateTime: string; timeZone?: string} | {date: string};
  end?: {dateTime: string; timeZone?: string} | {date: string}; description?: string; location?: string;
}
export type ExternalPreviewInput =
  | {kind: 'mcp'; connectionId: string; toolName: string; argumentsJson: string}
  | {kind: 'google'; connectionId: string; calendarId: string; operation: 'create' | 'update' | 'delete'; event: CalendarEventInput};
