export interface RoutingState {
  enabled: boolean; revision: number; daily_call_limit: number; daily_budget_units: number;
  calls_used: number; budget_units_used: number; resets_at: number; persistent: boolean;
}
export interface RoutingSettings {
  enabled: boolean; expected_revision: number; daily_call_limit: number; daily_budget_units: number;
}
export const routingReason = (reason?: string): string => ({
  automatic_budget: '자동 선택 · 입력 능력·출처 경계·남은 한도를 충족하는 최소 예약 단위 모델',
  request_fixed: '이번 요청에 고정한 모델', conversation_fixed: '이 대화에 고정한 모델',
  saved_default: '저장된 기본 모델', initial_local: '초기 로컬 기본 모델',
}[reason ?? ''] ?? '');
