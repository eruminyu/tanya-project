<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { BrainSnapshot } from '../../shared/bridge.js';
import type { CalendarView, ExternalConnection } from '../../shared/external.js';
import { defaultProactiveSettings, proactiveLabels, type ProactiveState } from '../../shared/proactive.js';
import { routingReason } from '../../shared/routing.js';
const props=defineProps<{brain:BrainSnapshot}>(),emit=defineEmits<{reviewExternal:[]}>(),bridge=window.kirianDesktop;
const state=ref<ProactiveState|null>(null),draft=ref(defaultProactiveSettings()),busy=ref(false),dirty=ref(false),error=ref('');
const connections=ref<ExternalConnection[]>([]),calendars=ref<CalendarView[]>([]),connectionId=ref(''),calendarId=ref('');
let alive=false,version=-1,epoch=0,unsubscribe:(()=>void)|undefined;
function receive(value:ProactiveState){if(!alive||value.version<version)return;version=value.version;state.value=value;
 if(!dirty.value){draft.value=structuredClone(value.settings);connectionId.value=value.settings.calendar?.connectionId??'';calendarId.value=value.settings.calendar?.calendarId??'';}}
const models=computed(()=>props.brain.models.filter(m=>m.supportsText&&m.automaticAllowed&&m.budgetUnits!=null));
const available=computed(()=>props.brain.phase==='ready'&&state.value?.available);
async function run(work:()=>Promise<ProactiveState>,saved=false){const current=epoch;busy.value=true;error.value='';try{const result=await work();if(!alive||current!==epoch)return;if(saved)dirty.value=false;receive(result);}catch{if(alive&&current===epoch)error.value='요청을 완료하지 못했어요. 연결·허용 설정을 확인해 주세요.';}finally{if(current===epoch)busy.value=false;}}
async function save(){if(!state.value||!bridge)return;const settings=JSON.parse(JSON.stringify(draft.value));
 settings.calendar=connectionId.value&&calendarId.value?{connectionId:connectionId.value,calendarId:calendarId.value}:null;
 await run(()=>bridge.configureProactive({revision:state.value!.revision,settings}),true);}
async function loadConnections(){if(!bridge)return;const current=epoch;busy.value=true;error.value='';try{const result=await bridge.getExternalState();if(alive&&current===epoch)connections.value=result.connections.filter(c=>c.kind==='google'&&c.phase==='ready');}
 catch{if(alive&&current===epoch)error.value='Google 연결 상태를 확인할 수 없어요.';}finally{if(current===epoch)busy.value=false;}}
async function loadCalendars(){if(!bridge||!connectionId.value)return;const current=epoch;busy.value=true;error.value='';try{const result=await bridge.listExternalCalendars(connectionId.value);if(alive&&current===epoch)calendars.value=result;}
 catch{if(alive&&current===epoch)error.value='캘린더 목록을 가져올 수 없어요.';}finally{if(current===epoch)busy.value=false;}}
onMounted(()=>{alive=true;unsubscribe=bridge?.subscribeProactive(receive);if(bridge)void bridge.getProactive().then(receive).catch(()=>{});});
onUnmounted(()=>{alive=false;epoch++;unsubscribe?.();});
watch(()=>props.brain.phase,phase=>{if(phase!=='ready'){epoch++;busy.value=false;dirty.value=false;state.value=null;draft.value=defaultProactiveSettings();connections.value=[];calendars.value=[];connectionId.value='';calendarId.value='';error.value='';}});
</script>

<template>
 <section class="proactive-panel" data-testid="proactive-panel" aria-label="키리안의 선제 제안">
  <div v-if="state?.cards.length" class="suggestions" aria-live="polite">
   <article v-for="card in state.cards" :key="card.id" data-testid="proactive-card">
    <strong>키리안의 제안</strong><p>{{ card.text }}</p>
    <small>근거 · {{ card.title }}</small><blockquote>{{ card.quote }}</blockquote>
    <small v-if="card.actualModel">{{ card.actualModel.provider_id }} / {{ card.actualModel.model_id }} · {{ routingReason(card.routingReason) }}</small>
    <small v-else>시작 15분 이내 일정 · 추가 모델 호출 없음</small>
    <p class="actions"><button @click="run(()=>bridge!.dismissProactive(card.id))">이 제안 거절</button>
     <button v-if="card.kind==='calendar'" @click="emit('reviewExternal')">일정·도구 검토 화면</button></p>
   </article>
  </div>
  <details>
   <summary>선제 제안 · {{ state?.running?'켜짐':state?.settings.enabled?'일시 정지':'꺼짐' }}</summary>
   <p>허용한 근거로 도움을 제안합니다. 화면 수집·기억 생성은 각각의 설정에서 켜야 합니다. 제안은 작업을 실행하지 않으며, 변경은 검토 화면에서 따로 승인합니다.</p>
   <p v-if="!available">이 PC의 개인 Brain을 연결해 주세요.</p>
   <template v-else>
    <fieldset :disabled="busy||state?.running" @change="dirty=true">
     <legend>제안에 사용할 맥락</legend>
     <label><input v-model="draft.enabled" type="checkbox" data-testid="proactive-enabled"> 선제 제안 허용</label>
     <label><input v-model="draft.screenAnalyses" type="checkbox" data-testid="proactive-screens"> 저장된 화면 분석과 그 파생 기억 허용</label>
     <button @click="run(()=>bridge!.refreshProactiveSources())">기억 목록 확인</button>
     <label v-for="source in state?.sources.filter(s=>s.kind==='memory')" :key="source.source_id">
      <input v-model="draft.memorySourceIds" type="checkbox" :value="source.source_id"> {{ source.title }}
     </label>
     <small>선택한 기억 최대 8개. 화면에서 파생된 기억은 화면 허용 설정을 따릅니다.</small>
     <button @click="loadConnections">연결한 Google 계정 확인</button>
     <label>일정 계정<select v-model="connectionId" @change="calendarId='';calendars=[]">
      <option value="">일정 사용 안 함</option><option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
      <option v-if="connectionId&&!connections.some(c=>c.id===connectionId)" :value="connectionId">저장된 연결 · 상태 확인 필요</option>
     </select></label>
     <button :disabled="!connectionId" @click="loadCalendars">캘린더 목록 확인</button>
     <label>조회 허용 캘린더<select v-model="calendarId"><option value="">선택 안 함</option>
      <option v-for="calendar in calendars" :key="calendar.id" :value="calendar.id">{{ calendar.label }}</option>
      <option v-if="calendarId&&!calendars.some(c=>c.id===calendarId)" :value="calendarId">저장된 캘린더 · {{ calendarId }}</option>
     </select></label>
     <small>실행 중 선택 캘린더만 5분 간격·하루 최대 96회 조회합니다. 임박 일정 제안에는 모델을 호출하지 않습니다.</small>
     <label>화면·기억 제안 모델<select v-model="draft.modelId" data-testid="proactive-model">
      <option :value="null">저장된 기본값 / 자동 라우팅 설정 따름</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }} · {{ model.boundary }}</option>
     </select></label>
     <label>제안 시도 최소 간격(분)<input v-model.number="draft.intervalMinutes" type="number" min="2" max="1440"></label>
     <label>하루 제안 시도 상한<input v-model.number="draft.dailyLimit" type="number" min="1" max="20"></label>
    </fieldset>
    <p>모델 호출 직전에 시도를 기록하며, 실패나 제안 없음도 횟수에 포함합니다. 같은 내용은 30일 동안 다시 시도하지 않습니다. 모델은 공유 호출·비용 한도도 적용합니다.</p>
    <div class="actions"><button :disabled="busy||state?.running" data-testid="proactive-save" @click="save">설정 저장</button>
     <button :disabled="busy||dirty||!state?.settings.enabled||state?.running||state?.busy" data-testid="proactive-start" @click="run(()=>bridge!.startProactive())">시작 / 재개</button>
     <button :disabled="!state?.running&&!state?.busy" data-testid="proactive-pause" @click="run(()=>bridge!.pauseProactive())">즉시 정지</button></div>
    <p role="status">{{ proactiveLabels[state?.reason??'']??'상태 확인 중' }} · 오늘 시도 {{ state?.attemptsToday }}/{{ state?.settings.dailyLimit }}</p>
    <small>잠금·절전·재연결·앱 재시작 후에는 직접 재개합니다. 정지하면 표시한 제안과 처리 중인 응답을 비웁니다.</small>
   </template>
   <p v-if="error" role="alert">{{ error }}</p>
  </details>
 </section>
</template>

<style scoped>
.proactive-panel{border:1px solid #555064;border-radius:12px;padding:12px;margin-block:12px;font-size:13px;color:#eeeaf4;background:#211d2b}
summary{cursor:pointer;font-weight:650}fieldset{display:grid;gap:10px;margin-block:12px;border:1px solid #555064;border-radius:8px;min-width:0}
label{display:flex;gap:8px;align-items:center;flex-wrap:wrap}select{max-width:100%;flex:1}input[type=number]{width:80px}.actions{display:flex;gap:8px;flex-wrap:wrap}
input,select,button{font:inherit;color:inherit;background:#302a3c;border:1px solid #706780;border-radius:5px;padding:7px;min-width:0;max-width:100%}
button{cursor:pointer;padding:7px 10px}button:disabled{cursor:default;opacity:.55}article{padding:12px;background:var(--surface);border:1px solid #706780;border-radius:8px;margin-bottom:10px}
blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #7ca7a9;white-space:pre-wrap;overflow-wrap:anywhere}small{display:block;opacity:.8}
</style>
