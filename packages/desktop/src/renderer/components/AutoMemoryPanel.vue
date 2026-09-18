<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, toRaw } from 'vue';
import { defaultAutoMemorySettings, memoryStatusLabels, type AutoMemoryState, type MemoryCategory, type SemanticSearch } from '../../shared/auto-memory.js';
import type { NoteFolder } from '../../shared/note-folders.js';

const props = defineProps<{ enabled: boolean; folders: NoteFolder[] }>();
const bridge = window.kirianDesktop;
const state = ref<AutoMemoryState | null>(null);
const draft = ref(defaultAutoMemorySettings());
const dirty = ref(false), pending = ref(false), searching = ref(false);
const error = ref(''), query = ref(''), matches = ref<SemanticSearch | null>(null);
let disposed = false, generation = 0, request = 0, readRequest = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const categories: {id: MemoryCategory; label: string}[] = [
  {id:'preference',label:'선호'}, {id:'fact',label:'지속되는 사실'}, {id:'task',label:'진행 과제'},
];
const currentStatus = computed(() => memoryStatusLabels[state.value?.status ?? 'brain_unavailable']);
const canSave = computed(() => props.enabled && state.value && !pending.value && draft.value.categories.length > 0);
function accept(value: AutoMemoryState): void {
  if (state.value && value.revision < state.value.revision) return;
  state.value = value;
  if (!dirty.value) draft.value = structuredClone(value.settings);
}
function failure(value: unknown): void {
  const message = value instanceof Error ? value.message : '';
  const code = Object.keys(memoryStatusLabels).find(key => message.includes(key)) ?? 'invalid_response';
  error.value = memoryStatusLabels[code]!;
}
async function refresh(): Promise<void> {
  if (!props.enabled || !bridge) return;
  const current = generation, reading = ++readRequest;
  try { const value = await bridge.getAutoMemory(); if (!disposed && generation === current && reading === readRequest) accept(value); }
  catch (value) { if (!disposed && generation === current && reading === readRequest) failure(value); }
}
async function save(stop = false): Promise<void> {
  if (!bridge || !props.enabled || !state.value || !stop && !canSave.value) return;
  const current = generation, operation = ++request;
  readRequest++;
  pending.value = true; error.value = ''; matches.value = null;
  const settings = stop ? {...structuredClone(toRaw(state.value.settings)), enabled:false, retrieval_enabled:false} : structuredClone(toRaw(draft.value));
  try {
    const value = await bridge.configureAutoMemory({settings, expected_revision:state.value.revision});
    if (disposed || current !== generation || operation !== request) return;
    dirty.value = false; accept(value);
  } catch (value) {
    if (!disposed && current === generation && operation === request) { failure(value); await refresh(); }
  } finally { if (!disposed && current === generation && operation === request) pending.value = false; }
}
async function search(): Promise<void> {
  if (!props.enabled || !bridge || searching.value || !query.value.trim()) return;
  const current = generation, revision = state.value?.revision;
  searching.value = true; error.value = ''; matches.value = null;
  try {
    const value = await bridge.searchAutoMemory(query.value.trim());
    if (!disposed && generation === current && state.value?.revision === revision) matches.value = value;
  } catch (value) { if (!disposed && generation === current) failure(value); }
  finally { if (!disposed && generation === current) searching.value = false; }
}
watch(() => props.enabled, () => {
  generation++; request++; pending.value = false; searching.value = false; matches.value = null;
  state.value = null; dirty.value = false; error.value = ''; draft.value = defaultAutoMemorySettings();
  void refresh();
});
onMounted(() => { void refresh(); timer = setInterval(() => { if (!pending.value) void refresh(); }, 3000); });
onBeforeUnmount(() => { disposed = true; generation++; if (timer) clearInterval(timer); });
</script>

<template>
  <section class="auto-memory" data-testid="auto-memory-panel" aria-labelledby="auto-memory-title">
    <div class="heading">
      <h3 id="auto-memory-title">자동 기억과 의미 검색</h3>
      <button type="button" data-testid="auto-memory-stop" :disabled="!enabled || !state" @click="save(true)">모두 즉시 끄기</button>
    </div>
    <p class="hint">허용한 범위에서 선호·사실·진행 과제를 정리해요. 기억은 참고 자료이며 실행 권한을 부여하지 않아요.</p>
    <p role="status" data-testid="auto-memory-status">{{ currentStatus }}</p>
    <p v-if="state?.embedding_model" class="hint">의미 검색 모델: {{ state.embedding_model.provider_id }} / {{ state.embedding_model.model_id }}</p>
    <p v-if="state" class="hint">기억 {{ state.memory_count }}개 · 검색 색인 {{ state.indexed_count }}개 · 대기/실행 {{ state.pending_count }}개</p>
    <form @submit.prevent="save()" @change="dirty = true">
      <fieldset :disabled="!enabled || !state || pending">
        <legend>저장 후 적용할 설정</legend>
        <label><input v-model="draft.enabled" data-testid="auto-memory-enabled" type="checkbox" /> 허용 자료에서 기억 자동 추출</label>
        <label><input v-model="draft.retrieval_enabled" data-testid="auto-memory-retrieval" type="checkbox" /> 관련 기억을 찾아 대화에 자동 참고</label>
        <label><input v-model="draft.conversations" type="checkbox" /> 새로 완료한 대화</label>
        <label class="boundary">대화 원문의 처리 범위
          <select v-model="draft.conversation_boundary" data-testid="auto-memory-boundary">
            <option value="local">이 PC에서만</option><option value="private_lan">개인 LAN까지</option><option value="cloud">외부 API까지 허용</option>
          </select>
        </label>
        <p class="hint">대화에서 사용한 노트·화면의 더 좁은 허용 범위도 함께 지켜요.</p>
        <label><input v-model="draft.screen_analyses" type="checkbox" /> 완료한 화면 분석</label>
        <div class="scopes">
          <span>기억할 종류</span>
          <label v-for="category in categories" :key="category.id"><input v-model="draft.categories" type="checkbox" :value="category.id" /> {{ category.label }}</label>
        </div>
        <div class="scopes">
          <span>자동 추출과 검색에 허용할 노트 폴더</span>
          <p v-if="!folders.length" class="hint">먼저 노트 폴더를 연결해 주세요.</p>
          <label v-for="folder in folders" :key="folder.id"><input v-model="draft.note_collection_ids" type="checkbox" :value="folder.id" /> {{ folder.label }}</label>
          <label v-for="id in draft.note_collection_ids.filter(id => !folders.some(folder => folder.id === id))" :key="id"><input v-model="draft.note_collection_ids" type="checkbox" :value="id" /> 연결되지 않은 폴더 · {{ id }}</label>
        </div>
      </fieldset>
      <button type="submit" data-testid="auto-memory-save" :disabled="!canSave">{{ pending ? '저장 중…' : '설정 저장' }}</button>
      <span v-if="dirty" class="hint"> 아직 저장하지 않은 설정이 있어요.</span>
    </form>
    <form class="search" @submit.prevent="search">
      <label for="auto-memory-query">뜻이 비슷한 기억 찾기</label>
      <div><input id="auto-memory-query" v-model="query" type="search" maxlength="256" data-testid="auto-memory-query" :disabled="!enabled || !state?.settings.retrieval_enabled" placeholder="예: 내가 아침에 마시는 음료" />
        <button type="submit" :disabled="!enabled || !state?.settings.retrieval_enabled || searching || !query.trim()">{{ searching ? '찾는 중…' : '의미 검색' }}</button></div>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="matches" aria-live="polite">
      <p>{{ matches.status === 'ready' ? (matches.results.length ? '관련 기억을 찾았어요.' : '관련 기억을 찾지 못했어요.') : memoryStatusLabels[matches.status] }}</p>
      <ul><li v-for="match in matches.results" :key="match.source_id">{{ match.title }} <span class="hint">· 의미 유사도 {{ match.score.toFixed(3) }} · 원본 r{{ match.revision }}</span></li></ul>
    </div>
    <details v-if="state?.evidence.length" data-testid="auto-memory-evidence">
      <summary>최근 추출 근거 {{ state.evidence.length }}개</summary>
      <ul><li v-for="entry in state.evidence" :key="entry.source_id">
        <strong>{{ entry.title }}</strong><blockquote>{{ entry.quote }}</blockquote>
        <p class="hint">{{ entry.parent.title }} · r{{ entry.parent.revision }} · {{ entry.parent.source_id }}</p>
        <p class="hint">{{ categories.find(category => category.id === entry.category)?.label }} · 추출 모델 {{ entry.actual_model.provider_id }} / {{ entry.actual_model.model_id }}</p>
      </li></ul>
    </details>
    <details v-if="state?.recent_usage.length" data-testid="auto-memory-usage">
      <summary>완료한 대화에서 참고한 기억</summary>
      <ul><li v-for="entry in state.recent_usage" :key="`${entry.conversation_id}-${entry.turn_id}-${entry.source_id}`">
        {{ entry.title }}<p class="hint">{{ entry.conversation_id }} · {{ entry.turn_id }} · r{{ entry.revision }}</p>
        <p class="hint">응답 모델 {{ entry.actual_model.provider_id }} / {{ entry.actual_model.model_id }}</p>
      </li></ul>
    </details>
  </section>
</template>

<style scoped>
.auto-memory { display:grid; gap:10px; padding-top:14px; border-top:1px solid #ffffff12; font-size:12px; }
.heading, .search > div { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
h3 { font-size:12px; margin:0; } p { margin:0; line-height:1.6; overflow-wrap:anywhere; }
.hint { color:var(--quiet); font-size:11px; }
button, input, select { font:inherit; -webkit-app-region:no-drag; }
button { padding:6px 9px; border:1px solid #c0aaf61a; border-radius:7px; background:#c0aaf60b; color:#d9c8f5; }
input:not([type=checkbox]), select { min-width:0; padding:8px 9px; border:1px solid #ffffff12; border-radius:7px; background:#15151e; color:#e6e0ed; }
button:disabled, fieldset:disabled, input:disabled { opacity:.5; }
button:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
fieldset { border:0; padding:0; display:grid; gap:8px; margin-bottom:10px; }
legend { color:var(--muted); margin-bottom:10px; }
label { display:flex; gap:7px; align-items:center; line-height:1.5; }
.boundary { flex-wrap:wrap; padding-left:22px; }
.scopes { display:grid; gap:6px; padding:8px; border:1px solid #ffffff0d; border-radius:8px; }
.search { display:grid; gap:7px; } .search input { flex:1; min-width:120px; }
ul { list-style:none; padding:0; display:grid; gap:10px; max-height:320px; overflow:auto; }
li { overflow-wrap:anywhere; border-bottom:1px solid #ffffff0d; padding-bottom:8px; }
blockquote { margin:8px 0; padding-left:10px; border-left:2px solid #c0aaf655; white-space:pre-wrap; }
summary { cursor:pointer; color:var(--muted); } [role=alert] { color:#edb7c4; }
</style>
