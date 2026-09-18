<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { BrainSnapshot } from '../../shared/bridge.js';
import { defaultAutoScreenSettings, type AutoScreenState } from '../../shared/auto-screen.js';
import { routingReason } from '../../shared/routing.js';
const props=defineProps<{brain:BrainSnapshot}>();
const bridge=window.kirianDesktop;
const state=ref<AutoScreenState|null>(null), draft=ref(defaultAutoScreenSettings());
const dirty=ref(false),busy=ref(false),error=ref(''),confirmDelete=ref(false);
let alive=false,version=-1,unsubscribe:(()=>void)|undefined;
function receive(value:AutoScreenState){
  if(!alive || value.version<version)return;version=value.version;state.value=value;
  if(!dirty.value)draft.value=structuredClone(value.settings);
}
const available=computed(()=>props.brain.phase==='ready' && state.value?.available);
const models=computed(()=>props.brain.models.filter(m=>m.supportsImages && m.automaticAllowed && m.budgetUnits!=null
  && (m.boundary==='local' || draft.value.boundary==='private_lan' && m.boundary==='private_lan')));
const selected=computed({get:()=>draft.value.targets.map(t=>t.id),set:(ids:string[])=>{
  draft.value.targets=state.value?.sources.filter(t=>ids.includes(t.id))??[];dirty.value=true;
}});
const status=computed(()=>state.value?.running?'자동 수집 중':state.value?.settings.enabled?'일시정지 · 대상 확인 후 재개':'자동 수집 꺼짐');
const reasons:Record<string,string>={resume_required:'창을 다시 확인하고 재개해 주세요.',target_changed:'선택한 창이 닫히거나 이름이 바뀌었어요. 목록에서 다시 선택해 주세요.',
  locked:'화면 잠금으로 중단했어요.',suspended:'절전으로 중단했어요.',renderer_changed:'화면을 다시 열어 자동 수집을 중단했어요.',
  connection_changed:'연결이 바뀌어 중단했어요.',routing_limit:'분석 호출 한도에 도달했어요.',routing_changed:'모델 설정이 바뀌었어요.',
  routing_no_candidate:'자동 분석이 허용된 모델이 없어요.',screen_limit:'화면 보관함이 가득 찼어요. 기록을 정리해 주세요.',
  cleanup_required:'이전 자동 기록의 삭제를 확인하지 못했어요. 연결 후 정리를 다시 시도해 주세요.',storage_unavailable:'자동 수집 설정을 저장하거나 읽지 못했어요.',
  capture_denied:'현재 화면 수집 권한을 사용할 수 없어요.',capture_unavailable:'선택한 창을 가져오지 못했어요. 창 상태를 확인해 주세요.',
  capture_source_changed:'선택한 창이 바뀌었어요. 목록에서 다시 확인해 주세요.',model_not_allowed:'이 모델의 자동 처리가 허용되지 않았어요.',
  unsupported_model:'화면 입력을 지원하는 모델을 선택해 주세요.',provider_error:'분석 모델의 응답을 받지 못했어요.',
  provider_unavailable:'분석 모델 서버가 제한 시간 안에 응답을 시작하지 않았어요. 서버가 바쁘거나 GPU 여유가 부족한지 확인해 주세요.',turn_timeout:'분석이 제한 시간을 넘겨 중단됐어요.',
  model_mismatch:'응답한 모델이 선택한 모델과 달라 분석을 보관하지 않았어요.',incomplete_response:'분석 응답이 끝나지 않아 보관하지 않았어요.',image_limit:'이미지 처리 용량에 도달했어요.',
  capture_timeout:'선택한 창을 가져오는 시간이 초과됐어요.',context_blocked:'선택한 처리 범위에서 이 모델을 사용할 수 없어요.'};
const reason=computed(()=>reasons[state.value?.reason??'']??'');
async function run(work:()=>Promise<AutoScreenState>,saved=false){
  if(!bridge)return;busy.value=true;error.value='';
  try{const result=await work();if(saved)dirty.value=false;receive(result);}
  catch{error.value='요청을 완료하지 못했어요. 연결·허용 대상·모델 설정을 확인해 주세요.';}
  finally{busy.value=false;}
}
async function save(){if(state.value)await run(()=>bridge!.configureAutoScreen({revision:state.value!.revision,settings:JSON.parse(JSON.stringify(draft.value))}),true);}
onMounted(()=>{alive=true;unsubscribe=bridge?.subscribeAutoScreen(receive);if(bridge)void bridge.getAutoScreen().then(receive).catch(()=>{});});
onUnmounted(()=>{alive=false;unsubscribe?.();});
watch(()=>props.brain.phase,phase=>{if(phase!=='ready'){dirty.value=false;draft.value=defaultAutoScreenSettings();state.value=null;confirmDelete.value=false;}});
</script>

<template>
  <details class="auto-screen-panel" data-testid="auto-screen-panel">
    <summary>자동 화면 수집 · {{ status }}</summary>
    <p>선택한 창만 주기적으로 가져옵니다. 이미지는 메모리에만 두고, 자동 분석은 별도로 허용합니다. 재시작·연결 변경·잠금 후에는 직접 재개해야 합니다.</p>
    <p>전체 화면은 자동 수집 대상에서 제외합니다. 브라우저 창을 허용하면 그 창의 탭 변경도 수집할 수 있습니다.</p>
    <p v-if="!available">이 PC의 개인 Brain을 연결해 주세요.</p>
    <template v-else>
      <fieldset :disabled="busy || state?.running" @change="dirty=true">
        <legend>허용 범위와 주기</legend>
        <label><input v-model="draft.enabled" type="checkbox" data-testid="auto-screen-enabled"> 자동 수집 허용</label>
        <button type="button" :disabled="busy" data-testid="auto-screen-list" @click="run(()=>bridge!.listAutoScreenSources())">현재 창 목록 확인</button>
        <label>허용할 창 (최대 4개)
          <select v-model="selected" multiple size="4" data-testid="auto-screen-targets">
            <option v-for="target in state?.sources" :key="target.id" :value="target.id" :disabled="draft.excludedIds.includes(target.id)">{{ target.name }}</option>
          </select>
        </label>
        <p v-if="draft.targets.length">선택: {{ draft.targets.map(t=>t.name).join(', ') }}</p>
        <label>제외할 창
          <select v-model="draft.excludedIds" multiple size="3">
            <option v-for="target in state?.sources" :key="target.id" :value="target.id">{{ target.name }}</option>
          </select>
        </label>
        <label>수집 간격 (초, 10~300)<input v-model.number="draft.collectionSeconds" type="number" min="10" max="300"></label>
        <label><input v-model="draft.analysisEnabled" type="checkbox" data-testid="auto-screen-analysis-enabled"> 변경된 화면의 자동 분석 허용</label>
        <template v-if="draft.analysisEnabled">
          <label>처리 범위<select v-model="draft.boundary"><option value="local">이 PC에서만</option><option value="private_lan">개인 LAN까지 허용</option></select></label>
          <label>분석 모델<select v-model="draft.modelId" data-testid="auto-screen-model"><option :value="null" :disabled="!brain.routing?.enabled">자동 라우팅</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
          <p>고정 모델도 자동 처리 허용과 공통 호출 한도를 적용합니다. 변경이 감지돼도 아래 분석 간격보다 자주 호출하지 않습니다.</p>
          <label>최소 분석 간격 (초, 60~3600)<input v-model.number="draft.analysisSeconds" type="number" min="60" max="3600"></label>
          <label>분석 요청<textarea v-model="draft.prompt" maxlength="2048" rows="2" /></label>
        </template>
        <label>자동 분석 보존 시간 (분, 1~1440)<input v-model.number="draft.retentionMinutes" type="number" min="1" max="1440"></label>
        <label>자동 분석 최대 보관 수 (1~16)<input v-model.number="draft.maxRecords" type="number" min="1" max="16"></label>
        <button :disabled="busy" data-testid="auto-screen-save" @click="save">설정 저장</button>
      </fieldset>
      <div class="actions">
        <button :disabled="busy || dirty || !state?.settings.enabled || state.running" data-testid="auto-screen-start" @click="run(()=>bridge!.startAutoScreen({revision:state!.revision}))">선택한 창 확인 · 재개</button>
        <button :disabled="!state?.running" data-testid="auto-screen-pause" @click="run(()=>bridge!.pauseAutoScreen())">즉시 일시정지</button>
        <button data-testid="auto-screen-disable" @click="run(()=>bridge!.disableAutoScreen(),true)">허용 끄기</button>
      </div>
      <p role="status">{{ status }} · 수집 {{ state?.captures }}회 · 동일 이미지 {{ state?.unchanged }}회 · 보관 {{ state?.records.length }}개</p>
      <p v-if="reason || error" role="alert">{{ error || reason }}</p>
      <figure v-if="state?.preview"><img :src="state.preview.dataUrl" alt="자동 수집한 최신 창" data-testid="auto-screen-preview"><figcaption>{{ state.preview.title }} · {{ new Date(state.preview.capturedAt).toLocaleTimeString() }}</figcaption></figure>
      <div v-if="state?.analysis"><p>{{ state.analysis.text }}</p><small>실제 모델: {{ state.analysis.actualModel.provider_id }} / {{ state.analysis.actualModel.model_id }}</small><p v-if="state.analysis.routingReason">{{ routingReason(state.analysis.routingReason) }}</p></div>
      <p>보존 기한이 지난 자동 기록은 연결된 동안 주기적으로 정리합니다. 삭제하면 해당 화면에서 파생된 기억과 관련 대화도 무효화됩니다. 수동 화면 기록은 자동 정리 대상에 포함하지 않습니다.</p>
      <button :disabled="busy || !state?.records.length" @click="confirmDelete=true">자동 기록 전체 삭제</button>
      <div v-if="confirmDelete" role="alert"><p>자동 화면과 파생 기억·관련 대화까지 삭제할까요?</p><button data-testid="auto-screen-clear" @click="confirmDelete=false;run(()=>bridge!.clearAutoScreens())">삭제 확인</button><button @click="confirmDelete=false">취소</button></div>
    </template>
  </details>
</template>

<style scoped>
.auto-screen-panel{margin-top:12px;padding:12px;border:1px solid #555064;border-radius:10px;color:#eeeaf4;background:#211d2b}
summary{cursor:pointer;font-weight:650}p{font-size:.88rem;line-height:1.6}fieldset{display:grid;gap:10px;border:1px solid #555064;border-radius:8px;margin:12px 0;min-width:0}
label{display:grid;gap:5px;font-size:.88rem}label:has(input[type=checkbox]){display:flex;align-items:center}input,select,textarea,button{font:inherit;color:inherit;background:#302a3c;border:1px solid #706780;border-radius:5px;padding:7px;min-width:0;max-width:100%}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:8px;flex-wrap:wrap}figure{margin:12px 0}img{width:100%;max-height:260px;object-fit:contain}small,figcaption{color:#c1b9cf} [role=alert]{color:#ffd7a9}
</style>
