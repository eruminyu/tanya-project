<script setup lang="ts">
import {onMounted,onUnmounted,ref,computed} from 'vue';
import {runtimeMessages,type RuntimeState} from '../../shared/runtime.js';
const bridge=window.kirianDesktop,state=ref<RuntimeState|null>(null),pending=ref(false),notice=ref('');
let unsubscribe:(()=>void)|undefined,disposed=false,received=0;
function accept(value:RuntimeState):boolean{if(disposed||state.value&&value.sequence<state.value.sequence)return false;state.value=value;return true;}
const disabled=computed(()=>pending.value||state.value?.busy);
const status=computed(()=>({stopped:'중지됨',starting:'시작 중',ready:'실행 중',error:'복구 필요'}[state.value?.phase??'stopped']));
onMounted(async()=>{
  if(!bridge?.getRuntime)return;
  unsubscribe=bridge.subscribeRuntime(value=>{received++;accept(value);});const before=received;
  try{const value=await bridge.getRuntime();if(!disposed&&before===received)accept(value);}catch{notice.value='서비스 상태를 확인하지 못했어요.';}
});
onUnmounted(()=>{disposed=true;unsubscribe?.();});
async function command(action:'start'|'stop'|'import'|'restore'|'folder'){
  if(!bridge||disabled.value)return;pending.value=true;notice.value='';
  try{
    if(action==='folder')await bridge.openRuntimeDataFolder();
    else{
      const value=await ({start:()=>bridge.startRuntime(),stop:()=>bridge.stopRuntime(),import:()=>bridge.importRuntimeSettings(),restore:()=>bridge.restoreRuntimeSettings()})[action]();
      if(accept(value))notice.value=value.reason?(runtimeMessages[value.reason]??'서비스 작업을 완료하지 못했어요.'):'';
    }
  }catch{if(!disposed)notice.value='서비스 작업을 완료하지 못했어요. 다시 시도해 주세요.';}
  finally{if(!disposed)pending.value=false;}
}
</script>
<template>
  <details v-if="state" class="runtime-panel" data-testid="runtime-panel">
    <summary>앱 관리 · {{status}}</summary>
    <p>버전 {{state.version}} · <span data-testid="runtime-status">{{status}}</span></p>
    <template v-if="state.available">
      <p>기본 연결은 이 PC의 Ollama예요. 모델은 별도로 준비해 주세요. 기존 모델·음성 서비스의 JSON 설정도 가져올 수 있어요.</p>
      <div class="runtime-actions">
        <button type="button" :disabled="disabled" data-testid="runtime-start" @click="command('start')">{{state.phase==='ready'?'대화 서비스 다시 시작':'대화 서비스 시작'}}</button>
        <button type="button" :disabled="disabled||state.phase==='stopped'" data-testid="runtime-stop" @click="command('stop')">서비스 중지</button>
        <button type="button" :disabled="disabled" data-testid="runtime-import" @click="command('import')">모델 설정 가져오기</button>
        <button type="button" :disabled="disabled||!state.canRestore" data-testid="runtime-restore" @click="command('restore')">이전 설정 복원</button>
      </div>
      <p>재시작하면 진행 중인 대화가 중단돼요. 화면 수집과 선제 제안은 직접 재개해 주세요.</p>
    </template>
    <p v-else>개발 실행에서는 기존 로컬 실행 도구나 연결 설정을 사용해 주세요.</p>
    <p role="status" data-testid="runtime-notice">{{notice||(state.reason?runtimeMessages[state.reason]:'')}}</p>
    <p>업데이트는 새 설치본을 실행해 진행해요. 같은 버전 재설치로 앱 파일을 복구할 수 있고, 기억·승인 기록·설정은 유지돼요.</p>
    <p class="runtime-path">데이터 위치: {{state.dataDirectory}}</p>
    <button type="button" :disabled="disabled" @click="command('folder')">데이터 폴더 열기</button>
  </details>
</template>
<style scoped>
.runtime-panel{margin:12px 0;padding:12px;border:1px solid #494452;border-radius:12px;font-size:12px;color:#d6d0dc}
summary{cursor:pointer;font-weight:600}p{line-height:1.6;margin:8px 0}.runtime-actions{display:flex;flex-wrap:wrap;gap:6px}
button{border:1px solid #625870;border-radius:8px;background:#2b2435;color:#f3edf8;padding:7px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.runtime-path{overflow-wrap:anywhere}
</style>
