import type { ScreenAnalysis, ScreenBoundary, ScreenPreview, ScreenTarget } from './screens.js';

export interface AutoScreenSettings {
  enabled: boolean;
  analysisEnabled: boolean;
  targets: ScreenTarget[];
  excludedIds: string[];
  boundary: ScreenBoundary;
  modelId: string | null;
  prompt: string;
  collectionSeconds: number;
  analysisSeconds: number;
  retentionMinutes: number;
  maxRecords: number;
}
export interface AutoScreenRecord { id: string; capturedAt: number; status: 'pending' | 'saved'; }
export interface AutoScreenState {
  version: number;
  available: boolean;
  revision: number;
  settings: AutoScreenSettings;
  running: boolean;
  phase: 'unavailable' | 'paused' | 'waiting' | 'capturing' | 'analyzing';
  reason: string | null;
  sources: ScreenTarget[];
  preview: ScreenPreview | null;
  analysis: ScreenAnalysis | null;
  records: AutoScreenRecord[];
  lastAttemptAt: number;
  captures: number;
  unchanged: number;
}
export interface AutoScreenUpdate { revision: number; settings: AutoScreenSettings; }
export const defaultAutoScreenSettings = (): AutoScreenSettings => ({enabled:false,analysisEnabled:false,
  targets:[],excludedIds:[],boundary:'local',modelId:null,prompt:'화면의 현재 상황과 중요한 변경점을 간단히 설명해 주세요.',
  collectionSeconds:30,analysisSeconds:60,retentionMinutes:60,maxRecords:8});
