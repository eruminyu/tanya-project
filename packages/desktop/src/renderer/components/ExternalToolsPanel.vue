<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { CalendarEventInput, CalendarView, ExternalActionView, ExternalState, ConversationToolsState } from '../../shared/external.js';
import ConversationToolsSettings from './ConversationToolsSettings.vue';
const props=defineProps<{enabled:boolean;conversation?:ConversationToolsState}>();
const bridge=window.kirianDesktop;
const state=ref<ExternalState>({available:false,connections:[],actions:[]});
const opened=ref(false),busy=ref(false),error=ref(''),connectionId=ref(''),toolName=ref(''),argumentsJson=ref('{}');
const calendars=ref<CalendarView[]>([]),calendarId=ref(''),events=ref<unknown[]>([]);
const operation=ref<'create'|'update'|'delete'>('create'),eventId=ref(''),summary=ref(''),description=ref(''),location=ref('');
const allDay=ref(false),start=ref(''),end=ref('');
const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
const from=ref(new Date().toISOString().slice(0,10)),until=ref(new Date(Date.now()+7*86400000).toISOString().slice(0,10));
const checked=ref(new Map<string,string>()),now=ref(Date.now());
let disposed=false,epoch=0,selectionRevision=0,refreshRevision=0,poll:ReturnType<typeof setInterval>|undefined;
type EventTime=NonNullable<CalendarEventInput['start']>;
let originalTimes:{connectionId:string;calendarId:string;eventId:string;allDay:boolean;startInput:string;endInput:string;start:EventTime;end:EventTime}|null=null;
const selected=computed(()=>state.value.connections.find(c=>c.id===connectionId.value));
const selectedTool=computed(()=>selected.value?.tools.find(t=>t.name===toolName.value));
const canUse=computed(()=>props.enabled&&state.value.available&&!!bridge);
const statusLabel={pending:'승인 대기',dismissed:'취소됨',running:'실행 중',succeeded:'성공 응답 확인',failed:'실행 실패',unknown:'결과 확인 필요'};
const operationLabel={create:'일정 만들기',update:'일정 수정',delete:'일정 삭제'};
function key(action:ExternalActionView){return JSON.stringify([action.draftId,action.revision,action.payloadSha256,action.argumentsJson,action.target,action.accountLabel,action.expiresAt]);}
function requestContext(){
 const current=epoch,selection=selectionRevision,connection=connectionId.value,calendar=calendarId.value;
 return()=>!disposed&&props.enabled&&current===epoch&&selection===selectionRevision&&connection===connectionId.value&&calendar===calendarId.value;
}
async function refresh(){
 if(!bridge||!props.enabled)return;
 const current=epoch,read=++refreshRevision;
 try{const next=await bridge.getExternalState();if(disposed||current!==epoch||read!==refreshRevision)return;
  state.value=next;
  for(const [id,value]of checked.value)if(!next.actions.some(a=>a.draftId===id&&a.status==='pending'&&key(a)===value))checked.value.delete(id);
 }catch{if(!disposed&&current===epoch&&read===refreshRevision)error.value='외부 작업 상태를 읽지 못했어요. 실행을 반복하지 말고 연결과 기록을 확인해 주세요.';}
}
async function run(work:(isCurrent:()=>boolean)=>Promise<unknown>){
 if(busy.value||!canUse.value)return;const current=epoch,isCurrent=requestContext();busy.value=true;error.value='';
 try{await work(isCurrent);}catch(e){if(isCurrent())error.value=message(e);}
 finally{if(current===epoch&&!disposed){busy.value=false;await refresh();}}
}
function message(value:unknown){
 const text=value instanceof Error?value.message:'';
 if(text.includes('credential_encryption_unavailable'))return '이 PC의 보안 저장소를 사용할 수 없어요. 자격 증명은 저장되지 않았어요.';
 if(text.includes('google_scope'))return 'Google 일정 권한이 필요해요. 계정 연결에서 요청한 권한을 확인해 주세요.';
 if(text.includes('google_reconnect_required'))return 'Google 인증이 만료되었거나 철회됐어요. Google 계정 연결 버튼으로 같은 계정에 다시 로그인해 주세요. 이전 실행은 자동으로 반복하지 않아요.';
 if(text.includes('google_event_not_supported'))return '반복 일정·참석자 초대·회의가 있는 일정은 이 화면에서 변경할 수 없어요.';
 if(text.includes('mcp_auth_required'))return '이 MCP 서버는 인증이 필요해요. 현재는 별도 인증이 필요 없는 MCP 연결을 지원해요.';
 if(text.includes('mcp_unsupported_protocol'))return '초기화 기반 MCP 2025-11-25, 2025-06-18, 2025-03-26 서버를 지원해요.';
 if(text.includes('google_cancelled'))return 'Google 연결을 취소했거나 연결 제한 시간이 지났어요.';
 return '요청을 완료하지 못했어요. 연결·입력값·작업 기록을 확인해 주세요. 결과가 불명확한 작업은 자동으로 다시 실행하지 않아요.';
}
function actionError(code:string){return code==='google_reconnect_required'?message(new Error(code)):code;}
async function immediate(work:()=>Promise<unknown>){
 const isCurrent=requestContext();
 try{await work();}catch(e){if(isCurrent())error.value=message(e);}finally{if(isCurrent())await refresh();}
}
function toggle(event:Event){opened.value=(event.target as HTMLDetailsElement).open;checked.value.clear();if(opened.value)void refresh();}
watch(()=>props.enabled,enabled=>{epoch++;busy.value=false;checked.value.clear();calendars.value=[];events.value=[];connectionId.value='';originalTimes=null;state.value={available:false,connections:[],actions:[]};if(enabled)void refresh();},{immediate:true,flush:'sync'});
watch(connectionId,()=>{selectionRevision++;toolName.value='';calendars.value=[];calendarId.value='';events.value=[];eventId.value='';originalTimes=null;checked.value.clear();},{flush:'sync'});
watch(calendarId,()=>{selectionRevision++;events.value=[];eventId.value='';originalTimes=null;},{flush:'sync'});
poll=setInterval(()=>{now.value=Date.now();if(opened.value&&props.enabled)void refresh();},1500);
onUnmounted(()=>{disposed=true;epoch++;if(poll)clearInterval(poll);});
async function add(kind:'mcp'|'google'){await run(async isCurrent=>{const connection=await(kind==='mcp'?bridge!.addMcpConnection():bridge!.addGoogleCalendar());if(connection&&isCurrent())connectionId.value=connection.id;});}
function parseEvent(value:unknown):Record<string,any>|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;}
function copyTime(value:unknown):EventTime|null{
 const time=parseEvent(value);if(!time)return null;
 if(typeof time.date==='string')return {date:time.date};
 if(typeof time.dateTime==='string')return {dateTime:time.dateTime,...(typeof time.timeZone==='string'?{timeZone:time.timeZone}:{})};
 return null;
}
function selectEvent(value:unknown){
 const event=parseEvent(value);if(!event)return;
 const startTime=copyTime(event.start),endTime=copyTime(event.end);if(!startTime||!endTime)return;
 const local=(value:string)=>{const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,23);};
 const startInput='date' in startTime?startTime.date:local(startTime.dateTime),endInput='date' in endTime?endTime.date:local(endTime.dateTime);
 eventId.value=String(event.id);summary.value=String(event.summary??'');description.value=String(event.description??'');location.value=String(event.location??'');allDay.value='date' in startTime;
 start.value=startInput;end.value=endInput;operation.value='update';
 originalTimes={connectionId:connectionId.value,calendarId:calendarId.value,eventId:eventId.value,allDay:allDay.value,startInput,endInput,start:startTime,end:endTime};
}
function submittedTime(side:'start'|'end'):EventTime{
 const value=side==='start'?start.value:end.value;
 if(operation.value==='update'&&originalTimes&&originalTimes.connectionId===connectionId.value&&originalTimes.calendarId===calendarId.value
  &&originalTimes.eventId===eventId.value&&originalTimes.allDay===allDay.value&&originalTimes[side+'Input' as 'startInput'|'endInput']===value){
  return {...originalTimes[side]};
 }
 return allDay.value?{date:value}:{dateTime:new Date(value).toISOString(),timeZone:zone};
}
async function preview(){await run(async()=>{
 if(selected.value?.kind==='mcp'){await bridge!.previewExternalAction({kind:'mcp',connectionId:connectionId.value,toolName:toolName.value,argumentsJson:argumentsJson.value});return;}
 const fields=operation.value==='delete'?{eventId:eventId.value}:{...(operation.value==='update'?{eventId:eventId.value}:{}),summary:summary.value,description:description.value,location:location.value,
  start:submittedTime('start'),end:submittedTime('end')};
 await bridge!.previewExternalAction({kind:'google',connectionId:connectionId.value,calendarId:calendarId.value,operation:operation.value,event:fields});
});}
async function approve(action:ExternalActionView){
 now.value=Date.now();if(!canApprove(action))return;checked.value.delete(action.draftId);
 await run(()=>bridge!.approveExternalAction({draftId:action.draftId,revision:action.revision,payloadSha256:action.payloadSha256}));
}
function canApprove(action:ExternalActionView){return opened.value&&canUse.value&&!busy.value&&action.status==='pending'&&action.expiresAt>now.value&&checked.value.get(action.draftId)===key(action);}
function acknowledge(action:ExternalActionView,event:Event){if((event.target as HTMLInputElement).checked)checked.value.set(action.draftId,key(action));else checked.value.delete(action.draftId);}
function pretty(value:string|null){if(value===null)return '';try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}
function reviewPayload(action:ExternalActionView){
 try{
  const envelope=parseEvent(JSON.parse(action.argumentsJson)),payload=parseEvent(envelope?.payload);
  if(action.providerId==='mcp'&&payload)return JSON.stringify({tool:payload.name,arguments:payload.arguments},null,2);
  const plan=parseEvent(payload?.calendarPlan);
  if(action.providerId==='google_calendar'&&plan){
   const fields=(value:unknown)=>{const event=parseEvent(value);return event?{summary:event.summary,start:event.start,end:event.end,description:event.description,location:event.location}:null;};
   return JSON.stringify({account:plan.accountLabel,calendar:{id:plan.calendarId,label:plan.calendarLabel,timeZone:plan.calendarTimeZone},operation:plan.operation,before:fields(plan.before),event:fields(plan.event)},null,2);
  }
 }catch{}
 return pretty(action.argumentsJson);
}
async function loadCalendars(){await run(async isCurrent=>{const result=await bridge!.listExternalCalendars(connectionId.value);if(isCurrent()&&selected.value?.phase==='ready')calendars.value=result;});}
async function loadEvents(){await run(async isCurrent=>{const result=await bridge!.listExternalEvents({connectionId:connectionId.value,calendarId:calendarId.value,timeMin:new Date(from.value).toISOString(),timeMax:new Date(until.value).toISOString()});if(isCurrent()&&selected.value?.phase==='ready')events.value=result;});}
</script>

<template>
 <details class="external-panel" data-testid="external-panel" @toggle="toggle">
  <summary data-testid="external-toggle">외부 도구 · Google 일정 <small>내용을 확인하고 건별 실행</small></summary>
  <div class="external-content">
   <p v-if="!enabled">개인 대화 서비스에 연결하면 이 PC의 외부 도구와 일정 계정을 사용할 수 있어요.</p>
   <p>계정과 연결 정보는 이 PC의 보안 저장소에 보관해요. 재시작 뒤에는 직접 다시 연결해 주세요.</p>
   <div class="row">
    <button data-testid="external-add-mcp" :disabled="!canUse || busy" @click="add('mcp')">MCP 설정 파일로 연결</button>
    <button data-testid="external-add-google" :disabled="!canUse || busy" @click="add('google')">Google 계정 연결</button>
    <button v-if="busy" data-testid="external-stop-connections" :disabled="!canUse" @click="immediate(()=>bridge!.cancelExternalConnections())">연결·요청 대기 취소</button>
    <button :disabled="!enabled" @click="refresh">기록 새로고침</button>
   </div>
   <details class="setup-help"><summary>연결 준비</summary>
    <p>Google Cloud에서 Calendar API를 사용 설정하고 OAuth 클라이언트 종류를 데스크톱 앱으로 만든 뒤 다운로드한 JSON을 선택해 주세요. 브라우저에서 연결할 계정을 직접 선택합니다.</p>
    <p>MCP JSON 형식은 아래와 같아요. 서버 프로그램 설치와 경로 지정이 필요합니다. 별도 인증이 필요한 HTTP 서버, 구 HTTP+SSE 방식, MCP 2026 규격은 현재 지원하지 않아요.</p>
    <pre>{"kind":"stdio","command":"실행 파일의 절대 경로","args":[]}
{"kind":"http","url":"https://서버주소/mcp"}</pre>
   </details>
   <p v-if="error" role="alert" data-testid="external-error">{{ error }}</p>
   <ConversationToolsSettings :state="conversation" :connection="selected" :tool-name="toolName" :enabled="canUse" :calendar="calendars.find(c=>c.id===calendarId)" :calendar-operation="operation" />
   <div v-for="connection in state.connections" :key="connection.id" class="connection-card">
    <strong>{{ connection.label }}</strong><span>{{ connection.phase==='ready'?'연결됨':connection.phase==='connecting'?'연결 중':connection.phase==='error'?'연결 확인 필요':'연결 안 됨' }}</span>
    <small>{{ connection.destination }}</small>
    <div class="row">
     <button :disabled="!canUse || busy || connection.phase!=='ready'" @click="connectionId=connection.id">이 연결 선택</button>
     <button v-if="connection.phase!=='ready' && connection.phase!=='connecting'" :disabled="!canUse || busy" @click="run(()=>bridge!.connectExternal(connection.id))">다시 연결</button>
     <button v-else :disabled="!canUse" @click="immediate(()=>bridge!.disconnectExternal(connection.id))">연결 해제</button>
    </div>
   </div>
   <div v-if="selected?.phase==='ready'" class="tool-form">
    <h4>{{ selected.label }} 작업 준비</h4>
    <template v-if="selected.kind==='mcp'">
     <p>도구 설명과 결과는 서버가 보낸 자료예요. 조회 전용이라는 표시가 있어도 실행 내용은 각각 확인합니다.</p>
     <label>도구<select v-model="toolName" data-testid="external-tool-select"><option value="">도구 선택</option><option v-for="tool in selected.tools" :key="tool.name" :value="tool.name">{{ tool.name }}</option></select></label>
     <p v-if="selectedTool">{{ selectedTool.description }}</p>
     <details v-if="selectedTool"><summary>도구 입력 형식</summary><pre>{{ pretty(selectedTool.inputSchemaJson) }}</pre></details>
     <label>입력값 JSON<textarea v-model="argumentsJson" data-testid="external-arguments" rows="5" maxlength="24576" spellcheck="false" /></label>
    </template>
    <template v-else>
     <button :disabled="busy" data-testid="external-calendars" @click="loadCalendars">캘린더 조회</button>
     <label>대상 캘린더<select v-model="calendarId" data-testid="external-calendar-select"><option value="">캘린더 선택</option><option v-for="calendar in calendars" :key="calendar.id" :value="calendar.id">{{ calendar.label }} · {{ calendar.canWrite?'변경 가능':'조회 전용' }}</option></select></label>
     <div class="row"><label>조회 시작<input v-model="from" type="date" /></label><label>조회 끝<input v-model="until" type="date" /></label><button :disabled="busy || !calendarId" @click="loadEvents">일정 조회</button></div>
     <div v-for="(event,index) in events" :key="index" class="event-card"><pre>{{ JSON.stringify(event,null,2) }}</pre><button :disabled="busy || !parseEvent(event)?.editable" @click="selectEvent(event)">이 일정 수정 준비</button></div>
     <label>작업<select v-model="operation"><option value="create">일정 만들기</option><option value="update">일정 수정</option><option value="delete">일정 삭제</option></select></label>
     <label v-if="operation!=='create'">선택한 일정 ID<input v-model="eventId" readonly placeholder="위의 일정 조회에서 선택해 주세요" /></label>
     <template v-if="operation!=='delete'">
      <label>제목<input v-model="summary" maxlength="1000" data-testid="external-event-summary" /></label>
      <label class="check"><input v-model="allDay" type="checkbox" @change="start='';end=''" />종일 일정</label>
      <small>{{ allDay?'종료 날짜는 포함하지 않아요. 하루 일정은 다음 날을 종료로 선택해 주세요.':`입력 시간대: ${zone} (이 PC의 로컬 시간)` }}</small>
      <small v-if="operation==='update'">수정하지 않은 시작·종료 시간은 원래 정밀도와 시간대를 유지해요.</small>
      <div class="row"><label>시작<input v-model="start" :type="allDay?'date':'datetime-local'" :step="allDay?undefined:'0.001'" /></label><label>종료<input v-model="end" :type="allDay?'date':'datetime-local'" :step="allDay?undefined:'0.001'" /></label></div>
      <label>설명<textarea v-model="description" rows="3" maxlength="8192" /></label><label>장소<input v-model="location" maxlength="1000" /></label>
     </template>
    </template>
    <button class="preview-button" data-testid="external-preview" :disabled="busy || !canUse || (selected.kind==='mcp'?!toolName:!calendarId)" @click="preview">{{ selected.kind==='mcp'?'도구 실행':operationLabel[operation] }} 미리보기</button>
   </div>
   <article v-for="action in [...state.actions].reverse()" :key="action.draftId" class="action-card" :data-status="action.status" data-testid="external-action">
    <strong>{{ statusLabel[action.status] }} · {{ action.operation }}</strong>
    <p>{{ action.accountLabel }} · {{ action.target }}</p>
    <p v-if="action.effect==='untrusted'">MCP 도구는 조회·변경 여부를 보장할 수 없어요. 아래 전체 입력값을 확인해 주세요.</p>
    <pre data-testid="external-review-payload">{{ reviewPayload(action) }}</pre>
    <details><summary>전체 실행 기록</summary><pre>{{ pretty(action.argumentsJson) }}</pre><small>검토 내용 SHA-256: {{ action.payloadSha256 }}</small></details>
    <template v-if="action.status==='pending'">
     <label class="check"><input type="checkbox" data-testid="external-ack" :checked="checked.get(action.draftId)===key(action)" :disabled="!canUse || busy || action.expiresAt<=now" @change="acknowledge(action,$event)" />계정·대상·전체 입력값을 확인했고 이 한 건을 실행합니다.</label>
     <div class="row"><button data-testid="external-approve" :disabled="!canApprove(action)" @click="approve(action)">이 내용 승인하고 실행</button><button :disabled="!canUse" @click="immediate(()=>bridge!.cancelExternalAction(action.draftId))">취소</button></div>
     <p v-if="action.expiresAt<=now">미리보기가 만료됐어요. 새 미리보기가 필요해요.</p>
    </template>
    <button v-if="action.status==='running'" :disabled="!canUse" data-testid="external-cancel" @click="immediate(()=>bridge!.cancelExternalAction(action.draftId))">응답 대기 취소</button>
    <p v-if="action.status==='running' || action.status==='unknown'">실행을 시작한 뒤 취소해도 외부 변경이 취소됐다고 단정할 수 없어요. 이 실행은 자동으로 반복하지 않아요.</p>
    <button v-if="action.recoverable" :disabled="!canUse || busy" @click="run(()=>bridge!.reconcileExternalAction(action.draftId))">같은 계정에 연결 후 실제 결과 조회</button>
    <p v-if="action.status==='unknown' && !action.recoverable">서버나 캘린더에서 실제 결과를 직접 확인해 주세요.</p>
    <small v-if="action.executionId">실행 ID: {{ action.executionId }} · {{ action.operationId??'결과 ID 없음' }}</small>
    <p v-if="action.errorCode">{{ actionError(action.errorCode) }}</p>
    <details v-if="action.resultJson"><summary>제공자가 반환한 결과 자료</summary><pre>{{ pretty(action.resultJson) }}</pre></details>
   </article>
  </div>
 </details>
</template>

<style scoped>
.external-panel{border:1px solid #494052;border-radius:12px;background:#1f1c28;color:#f0e9fa;margin-top:12px}
summary{cursor:pointer;padding:13px;font-weight:600}summary small{display:block;font-weight:400;color:#baafc9;margin-top:4px}
.external-content{padding:0 14px 14px;display:grid;gap:12px;font-size:13px}.external-content p{line-height:1.65;margin:0;color:#c7bdd1}
.row{display:flex;flex-wrap:wrap;align-items:end;gap:8px}.connection-card,.tool-form,.action-card,.event-card{display:grid;gap:10px;padding:12px;border:1px solid #484052;border-radius:10px;min-width:0}
.connection-card span,.connection-card small{color:#c7bdd1}label{display:grid;gap:6px;min-width:0}.check{display:flex;align-items:flex-start;line-height:1.6}.check input{width:auto;margin-top:4px}
input,textarea,select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #665875;background:#17151e;color:inherit;border-radius:7px;font:inherit}button{border:1px solid #8c75a5;background:#42314f;color:#fff;padding:9px 12px;border-radius:7px;cursor:pointer;font:inherit}button:disabled{opacity:.45;cursor:default}button:hover:enabled{background:#574067}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;background:#131119;padding:10px;border-radius:6px;font-size:12px;line-height:1.6;margin:0}small{overflow-wrap:anywhere;color:#b9afc6}.action-card[data-status="unknown"]{border-color:#d4a457}.preview-button{justify-self:start}h4{margin:0}p[role="alert"]{color:#ffbcbd}.setup-help{border-bottom:1px solid #484052;padding-bottom:10px}
</style>
