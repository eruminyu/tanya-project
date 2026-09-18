import type { ModelRef } from '@kirian/contracts';

export type MemoryCategory = 'preference' | 'fact' | 'task';
export interface AutoMemorySettings {
  enabled: boolean;
  conversations: boolean;
  conversation_boundary: 'local' | 'private_lan' | 'cloud';
  note_collection_ids: string[];
  screen_analyses: boolean;
  categories: MemoryCategory[];
  retrieval_enabled: boolean;
}
export const defaultAutoMemorySettings = (): AutoMemorySettings => ({enabled:false, conversations:false,
  conversation_boundary:'local', note_collection_ids:[], screen_analyses:false,
  categories:['preference','fact','task'], retrieval_enabled:false});
export interface MemoryReference { source_id: string; revision: number; title: string; }
export interface MemoryEvidence extends MemoryReference {
  category: MemoryCategory; quote: string; actual_model: ModelRef;
  parent: MemoryReference; created_at: number;
}
export interface MemoryUsage extends MemoryReference {
  conversation_id: string; turn_id: string; actual_model: ModelRef; reason: 'response_context';
}
export interface AutoMemoryState {
  settings: AutoMemorySettings; revision: number; status: string; embedding_model: ModelRef | null;
  pending_count: number; memory_count: number; indexed_count: number;
  evidence: MemoryEvidence[]; recent_usage: MemoryUsage[];
}
export interface AutoMemoryUpdate { settings: AutoMemorySettings; expected_revision: number; }
export interface SemanticMatch extends MemoryReference { score: number; reason: 'semantic_similarity'; }
export interface SemanticSearch { results: SemanticMatch[]; status: string; }

export const memoryStatusLabels: Record<string, string> = {
  disabled:'자동 기능 꺼짐', ready:'준비됨', running:'기억 정리 중',
  embedding_not_configured:'임베딩 모델 미설정 · 서비스 설정이 필요해요',
  embedding_unavailable:'임베딩 모델에 연결할 수 없어요', embedding_error:'임베딩 응답을 확인할 수 없어요',
  routing_unavailable:'모델 라우팅을 사용할 수 없어요', routing_limit:'허용한 호출·예산 한도에 도달했어요',
  routing_no_candidate:'허용 범위와 한도를 만족하는 모델이 없어요', routing_changed:'모델 설정이 바뀌어 작업을 중단했어요',
  model_not_allowed:'자동 처리에 허용된 모델이 아니에요', unsupported_model:'이 모델은 필요한 입력을 지원하지 않아요',
  model_mismatch:'응답 모델이 설정과 달라 결과를 저장하지 않았어요', context_blocked:'출처의 처리 허용 범위를 넘을 수 없어요',
  source_changed:'원본이 바뀌어 이전 작업을 폐기했어요', settings_changed:'설정이 바뀌었어요. 최신 설정을 확인해 주세요',
  memory_cancelled:'설정 변경이나 취소로 중단했어요', memory_busy:'다른 기억 검색이 진행 중이에요',
  provider_unavailable:'추출 모델에 연결할 수 없어요', provider_error:'추출 모델 응답을 확인할 수 없어요',
  incomplete_response:'추출 응답이 끝나지 않았어요', invalid_extraction:'원문 근거를 확인할 수 없어 추출을 저장하지 않았어요',
  source_too_large:'이 대화는 추출 입력 한도를 넘었어요', index_limit:'기억 색인 저장 한도에 도달했어요',
  turn_timeout:'처리 시간이 초과됐어요', storage_unavailable:'기억 저장소를 사용할 수 없어요',
  invalid_request:'설정을 다시 확인해 주세요', invalid_response:'서비스 응답을 확인할 수 없어요',
  brain_unavailable:'Brain 연결 후 사용할 수 있어요', connection_changed:'연결이 바뀌었어요',
};
