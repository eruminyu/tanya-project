<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CalendarView, ConversationToolsState, ExternalBoundary, ExternalConnection } from '../../shared/external.js';
const props=defineProps<{state?:ConversationToolsState;connection?:ExternalConnection;toolName:string;enabled:boolean;calendar?:CalendarView;calendarOperation?:'create'|'update'|'delete'}>();
const isCalendar=computed(()=>props.connection?.kind==='google');
const operationLabels={create:'일정 만들기',update:'일정 수정',delete:'일정 삭제'};
const chosenTool=computed(()=>isCalendar.value&&props.calendarOperation?'calendar.'+props.calendarOperation:props.toolName);
const canAdd=computed(()=>props.connection?.phase==='ready'&&(isCalendar.value?props.calendar?.canWrite&&props.calendarOperation:props.toolName));
const selectedLabel=computed(()=>isCalendar.value&&props.calendarOperation?`${props.calendar?.label} · ${operationLabels[props.calendarOperation]}`:props.toolName);
const metadata=ref<ExternalBoundary>('local'),argumentsTo=ref<ExternalBoundary>('local'),result=ref<ExternalBoundary>('local');
const busy=ref(false),error=ref('');
const choices=[{value:'local',label:'이 PC'},{value:'private_lan',label:'이 PC · 개인망'},{value:'cloud',label:'클라우드 포함'}];
async function save(enabled:boolean,selections=props.state?.selections??[]){
 if(busy.value||!window.kirianDesktop)return;busy.value=true;error.value='';
 try{await window.kirianDesktop.configureConversationTools({enabled,selections});}
 catch{error.value='설정을 적용하지 못했어요. 연결과 선택한 도구를 확인해 주세요.';}
 finally{busy.value=false;}
}
function add(){
 if(!props.connection||!canAdd.value)return;
 const selections=(props.state?.selections??[]).filter(s=>s.connectionId!==props.connection!.id||s.toolName!==chosenTool.value);
 selections.push({connectionId:props.connection.id,toolName:chosenTool.value,approvedArgumentBoundary:isCalendar.value?'cloud':argumentsTo.value,metadataBoundary:metadata.value,resultBoundary:result.value,...(isCalendar.value?{calendarId:props.calendar!.id}:{})});
 void save(props.state?.enabled??false,selections);
}
function remove(index:number){const selections=props.state!.selections.filter((_,i)=>i!==index);void save(selections.length>0&&props.state!.enabled,selections);}
</script>
<template>
 <fieldset class="conversation-tools-settings" data-testid="conversation-tools-settings">
  <legend>대화에서 외부 도구 제안</legend>
  <p>선택한 도구의 설명을 모델에 제공해 실행 내용을 제안받아요. 제안마다 계정·대상·전체 입력값을 확인하고 승인합니다. 연결을 다시 하면 이 설정은 꺼져요.</p>
  <label><input type="checkbox" data-testid="conversation-tools-enable" :checked="state?.enabled??false" :disabled="busy||!enabled||!state?.selections.length" @change="save(($event.target as HTMLInputElement).checked)" />대화 도구 제안 켜기</label>
  <p>도구 호출을 지원하도록 설정된 모델에서 사용할 수 있어요. 미지원 모델은 일반 대화를 이어가요. 일정은 선택한 계정·캘린더·작업만 제안합니다.</p>
  <ul v-if="state?.selections.length">
   <li v-for="(item,index) in state.selections" :key="item.connectionId+item.toolName">{{ item.toolName }} <span v-if="item.calendarId">· {{ item.calendarId }}</span> · 설명 {{ item.metadataBoundary }} / 인자 {{ item.approvedArgumentBoundary }} / 결과 {{ item.resultBoundary }} <button :disabled="busy||!enabled" @click="remove(index)">제안 목록에서 제외</button></li>
  </ul>
  <template v-if="canAdd">
   <p>{{ connection?.label }} · {{ selectedLabel }}의 데이터 처리 범위를 직접 지정해 주세요.</p>
   <p v-if="isCalendar">승인한 일정 내용은 Google로 전송됩니다. 일정 제안을 사용하려면 아래 설명 처리 범위를 ‘클라우드 포함’으로 선택해 주세요. 결과의 처리 범위는 별도로 지정할 수 있어요.</p>
   <div class="boundaries">
    <label>도구 설명 처리 범위<select v-model="metadata"><option v-for="choice in choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
    <label v-if="!isCalendar">도구 인자 전송 위치<select v-model="argumentsTo"><option v-for="choice in choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
    <label>결과 처리 범위<select v-model="result"><option v-for="choice in choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
   </div>
   <button :disabled="busy||!enabled||(state?.selections.length??0)>=16||(isCalendar&&metadata!=='cloud')" data-testid="conversation-tools-add" @click="add">선택한 도구와 범위 적용</button>
  </template>
  <p v-else>아래에서 연결과 도구, 또는 쓰기 가능한 캘린더와 작업을 선택하면 대화 제안 목록에 추가할 수 있어요.</p>
  <p v-if="error" role="alert">{{ error }}</p>
 </fieldset>
</template>
<style scoped>
fieldset{border:1px solid #675571;border-radius:10px;display:grid;gap:10px;padding:12px;min-width:0}legend{font-weight:600}p,li{font-size:13px;line-height:1.6}p{margin:0}.boundaries{display:flex;flex-wrap:wrap;gap:10px}label{display:flex;gap:7px;align-items:center}.boundaries label{display:grid}select,button{font:inherit;color:inherit;background:#302538;border:1px solid #8c75a5;border-radius:6px;padding:7px}button:disabled{opacity:.45}li{overflow-wrap:anywhere;margin:5px 0}
</style>
