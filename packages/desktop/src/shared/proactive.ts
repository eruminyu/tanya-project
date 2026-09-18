import type { ModelRef, RoutingReason } from '@kirian/contracts';
export interface ProactiveSettings {
  enabled:boolean; screenAnalyses:boolean; memorySourceIds:string[];
  calendar:{connectionId:string;calendarId:string}|null; modelId:string|null;
  intervalMinutes:number; dailyLimit:number;
}
export const defaultProactiveSettings=():ProactiveSettings=>({enabled:false,screenAnalyses:false,memorySourceIds:[],calendar:null,modelId:null,intervalMinutes:10,dailyLimit:5});
export interface ProactiveSource {source_id:string;revision:number;title:string;kind:'screen'|'memory';fingerprint:string;}
export interface ProactiveCandidates {generation:number;sources:ProactiveSource[];}
export interface ProactiveResult {
  suggestion:{text:string;quote:string;source_id:string;revision:number;title:string}|null;
  actual_model:ModelRef;routing_reason:RoutingReason;generation:number;
}
export interface ProactiveCard {
  id:string;kind:'screen'|'memory'|'calendar';text:string;quote:string;title:string;
  sourceId:string;revision:number;createdAt:number;expiresAt:number;
  actualModel:ModelRef|null;routingReason:string;
}
export interface ProactiveState {
  available:boolean;running:boolean;busy:boolean;reason:string;version:number;revision:number;
  settings:ProactiveSettings;attemptsToday:number;cards:ProactiveCard[];sources:ProactiveSource[];
}
export const emptyProactive=():ProactiveState=>({available:false,running:false,busy:false,reason:'brain_unavailable',version:0,revision:0,settings:defaultProactiveSettings(),attemptsToday:0,cards:[],sources:[]});
export const proactiveLabels:Record<string,string>={
  ready:'제안할 맥락을 확인하고 있어요',paused:'일시 정지',resume_required:'설정 확인 후 시작해 주세요',disabled:'선제 제안 꺼짐',
  brain_unavailable:'개인 Brain 연결 후 사용할 수 있어요',context_changed:'연결이나 사용 권한이 바뀌었어요',source_changed:'근거가 바뀌어 제안을 지웠어요',
  settings_changed:'설정을 저장했어요. 시작을 눌러 주세요',locked:'화면 잠금으로 중단했어요',suspended:'절전으로 중단했어요',closed:'창이 닫혀 중단했어요',
  daily_limit:'오늘 제안 시도 한도에 도달했어요',interval_limit:'다음 제안 간격을 기다려요',no_context:'허용된 새 맥락이 없어요',
  routing_limit:'모델의 공유 호출·비용 한도에 도달했어요',routing_changed:'모델 설정이 바뀌었어요',routing_no_candidate:'허용한 처리 모델이 없어요',
  model_not_allowed:'자동 처리에 허용된 모델을 선택해 주세요',context_blocked:'이 모델은 근거의 처리 범위를 벗어나요',unsupported_model:'이 모델은 필요한 입력을 지원하지 않아요',
  provider_unavailable:'모델에 연결할 수 없어요',provider_error:'모델 응답을 확인할 수 없어요',invalid_suggestion:'근거를 확인할 수 없어 제안을 표시하지 않았어요',
  model_mismatch:'실제 응답 모델이 달라 제안을 폐기했어요',incomplete_response:'모델 응답이 완료되지 않았어요',turn_timeout:'제안 생성 시간이 초과됐어요',
  proactive_busy:'이전 제안을 정리하는 중이에요',invalid_request:'설정이나 선택을 다시 확인해 주세요',invalid_response:'서비스 응답을 확인할 수 없어요',
  storage_unavailable:'제안 설정·제한 기록을 저장할 수 없어요',ledger_full:'중복 방지 기록이 가득 차 새 제안을 중단했어요',
  calendar_unavailable:'선택한 Google Calendar 연결·접근 권한을 확인해 주세요',calendar_read_limit:'오늘 일정 자동 조회 한도에 도달했어요',
};
