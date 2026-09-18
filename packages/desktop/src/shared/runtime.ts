export interface RuntimeState {
  sequence:number;
  available:boolean; busy:boolean; phase:'stopped'|'starting'|'ready'|'error';
  reason:string|null; canRestore:boolean; version:string; dataDirectory:string;
}
export const runtimeMessages: Record<string,string> = {
  runtime_start_failed:'대화 서비스를 시작하지 못했어요. 모델 설정과 데이터 폴더를 확인한 뒤 다시 시작해 주세요.',
  runtime_unavailable:'설치된 대화 서비스를 찾지 못했어요. 설치본을 다시 실행해 복구해 주세요.',
  runtime_exited:'대화 서비스가 종료됐어요. 데이터는 유지돼요. 다시 시작해 주세요.',
  invalid_config:'설정 파일을 사용할 수 없어요. 모델 주소·처리 범위·환경 변수의 API 키를 확인해 주세요. 데이터 경로는 설정 파일로 변경할 수 없어요.',
  identity_changed:'다른 사용자 공간의 설정이에요. 기존 기억과 실행 기록을 유지하려면 동일한 identity의 설정을 사용해 주세요.',
  settings_unavailable:'저장된 설정을 읽거나 저장하지 못했어요. 이전 설정 복원 또는 데이터 폴더에서 원본 확인을 할 수 있어요.',
  restore_unavailable:'복원할 이전 설정을 확인하지 못했어요.',
  runtime_busy:'다른 서비스 작업을 마친 뒤 다시 시도해 주세요.',
  request_cancelled:'화면이나 연결 상태가 바뀌어 요청을 취소했어요.',
};
