import type { ModelRef } from '@kirian/contracts';

export type ScreenBoundary = 'local' | 'private_lan';
export interface ScreenTarget { id: string; name: string; kind: 'screen' | 'window'; }
export interface ScreenPreview {
  id: string; revision: number; title: string; capturedAt: number;
  width: number; height: number; boundary: ScreenBoundary; dataUrl: string;
}
export interface ScreenAnalysis {
  sourceId: string; revision: number; screenSourceId: string; screenRevision: number;
  text: string; actualModel: ModelRef;
  routingReason?: string;
  cached?: boolean;
}
export interface StoredScreen {
  captureId: string; sourceId: string; revision: number; title: string; capturedAt: number;
  boundary: ScreenBoundary; imageAvailable: boolean; analysisSourceId: string | null; actualModel: ModelRef | null;
  routingReason?: string;
}
export interface ScreenState {
  version: number; available: boolean;
  phase: 'idle' | 'listing' | 'capturing' | 'preview' | 'analyzing' | 'deleting' | 'error';
  targets: ScreenTarget[]; preview: ScreenPreview | null; analysis: ScreenAnalysis | null; saved: StoredScreen[];
  error: string | null;
}
export type ScreenCommandResult = { ok: true } | { ok: false; code: string };
export interface ScreenCaptureInput { sourceId: string; boundary: ScreenBoundary; }
export interface ScreenAnalyzeInput { captureId: string; revision: number; modelId: string | null; prompt: string; }
export const emptyScreens = (): ScreenState => ({ version: 0, available: false, phase: 'idle', targets: [], preview: null, analysis: null, saved: [], error: null });
