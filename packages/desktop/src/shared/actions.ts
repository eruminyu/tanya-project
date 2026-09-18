export interface ActionView {
  draftId: string;
  revision: number;
  payloadSha256: string;
  title: string;
  body: string;
  target: string;
  expiresAt: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'dismissed';
  receipt?: {
    executionId: string;
    providerId: string;
    operationId: string | null;
    status: 'succeeded' | 'failed' | 'unknown';
    errorCode: string | null;
    recordedAt: number;
  };
}

export interface NoteDraftInput { title: string; body: string; }
export interface ActionApprovalInput { draftId: string; revision: number; payloadSha256: string; }
