<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { LibrarySource, LibraryState } from '../../shared/persistence.js';
import type { NoteFolder } from '../../shared/note-folders.js';
import AutoMemoryPanel from './AutoMemoryPanel.vue';

const props = withDefaults(defineProps<{ library: LibraryState; enabled: boolean; busy: boolean; writableFolderIds?: string[]; noteFolders?: NoteFolder[] }>(), {
  writableFolderIds: () => [],
  noteFolders: () => [],
});
const emit = defineEmits<{
  refresh: [query: string];
  create: [source: { title: string; text: string; boundary: LibrarySource['boundary'] }];
  update: [source: { id: string; revision: number; title: string; text: string; boundary: LibrarySource['boundary'] }];
  remove: [source: { id: string; revision: number }];
  select: [ids: string[]];
  conversation: [id: string];
  newConversation: [];
  deleteConversation: [id: string];
  editFile: [file: { folderId: string; path: string }];
}>();
const query = ref('');
const editorOpen = ref(false);
const editing = ref<{ id: string; revision: number } | null>(null);
const title = ref('');
const text = ref('');
const boundary = ref<LibrarySource['boundary']>('local');
const deleting = ref<{ id: string; revision: number; title: string } | null>(null);
const deletingConversation = ref<string | null>(null);
const canManage = computed(() => props.enabled && props.library.available && !props.busy);
const editChanged = computed(() => {
  if (!editing.value) return false;
  const source = props.library.sources.find((item) => item.id === editing.value?.id);
  return !source || !editable(source) || source.revision !== editing.value.revision;
});
const canSave = computed(() => canManage.value && !editChanged.value &&
  title.value.trim().length > 0 && title.value.length <= 120 && text.value.trim().length > 0 && text.value.length <= 8192);
const currentConversation = computed(() => props.library.conversations.find((item) => item.id === props.library.conversationId));
const boundaryLabels: Record<LibrarySource['boundary'], string> = {
  local: '이 PC에서만', private_lan: '개인 LAN까지', cloud: 'API 사용 허용',
};
const kindLabels: Record<LibrarySource['kind'], string> = {
  note: '노트', memory: '기억', conversation: '대화', screen: '화면', calendar: '일정', index: '검색 자료', tool_result: '도구 실행 결과',
};
const boundaryDescription = computed(() => boundary.value === 'local'
  ? '이 자료는 이 PC의 모델에서만 사용할 수 있어요.'
  : boundary.value === 'private_lan'
    ? '이 PC와 허용한 개인 LAN의 모델에서 사용할 수 있어요.'
    : '이 자료를 대화에 선택하면 내용이 외부 API로 전달될 수 있어요.');

watch(() => props.library.conversationId, () => { deletingConversation.value = null; });
watch(() => props.library.sources, (sources) => {
  if (deleting.value && !sources.some((source) => source.id === deleting.value?.id && source.revision === deleting.value.revision))
    deleting.value = null;
});

function refresh(): void { if (canManage.value) emit('refresh', query.value.trim()); }
function togglePanel(event: Event): void {
  if (event.target instanceof HTMLDetailsElement && event.target.open) refresh();
}
function editable(source: LibrarySource): boolean {
  return !source.readOnly && !source.origin && (source.kind === 'note' || source.kind === 'memory') && source.parents.length === 0;
}
function startNote(): void {
  if (!canManage.value) return;
  editing.value = null;
  title.value = ''; text.value = ''; boundary.value = 'local';
  editorOpen.value = true;
}
function edit(source: LibrarySource): void {
  if (!canManage.value || !editable(source)) return;
  editing.value = { id: source.id, revision: source.revision };
  title.value = source.title; text.value = source.text; boundary.value = source.boundary;
  editorOpen.value = true;
}
function canEditFile(source: LibrarySource): boolean {
  return canManage.value && !!source.origin && props.writableFolderIds.includes(source.origin.collection_id);
}
function editFile(source: LibrarySource): void {
  if (source.origin && canEditFile(source)) emit('editFile', { folderId: source.origin.collection_id, path: source.origin.path });
}
function save(): void {
  if (!canSave.value) return;
  const source = { title: title.value.trim(), text: text.value, boundary: boundary.value };
  if (editing.value) emit('update', { ...editing.value, ...source });
  else emit('create', source);
  // Emitting does not confirm a save. Keep the text so a failed request cannot erase it.
}
function selectSource(source: LibrarySource, event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  const checked = event.target.checked;
  event.target.checked = props.library.selectedSourceIds.includes(source.id);
  if (!canManage.value) return;
  const ids = new Set(props.library.selectedSourceIds);
  if (checked) ids.add(source.id); else ids.delete(source.id);
  emit('select', [...ids]);
}
function selectConversation(event: Event): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const id = event.target.value;
  event.target.value = props.library.conversationId ?? '';
  if (canManage.value && props.library.conversations.some((conversation) => conversation.id === id)) emit('conversation', id);
}
function removeSource(): void {
  if (!canManage.value || !deleting.value) return;
  emit('remove', { id: deleting.value.id, revision: deleting.value.revision });
  deleting.value = null;
}
function removeConversation(): void {
  if (!canManage.value || !deletingConversation.value) return;
  emit('deleteConversation', deletingConversation.value);
  deletingConversation.value = null;
}
function parentTitle(id: string): string {
  return props.library.sources.find((source) => source.id === id)?.title || '현재 목록에 없는 원본';
}
</script>

<template>
  <details class="memory-panel" data-testid="memory-panel" @toggle="togglePanel">
    <summary data-testid="memory-toggle">
      <span>기억과 대화</span>
      <span class="summary-hint">{{ library.selectedSourceIds.length ? `${library.selectedSourceIds.length}개 자료 선택` : '필요한 이야기만 함께' }}</span>
    </summary>
    <div class="panel-content" :aria-busy="busy">
      <p v-if="!library.available" class="notice" role="status">저장된 기억과 대화를 아직 불러올 수 없어요.</p>
      <p v-else-if="!enabled" class="notice" role="status">지금은 기억과 대화를 변경할 수 없어요. 현재 작업이 끝나면 다시 사용할 수 있어요.</p>
      <p v-if="library.defaultMissing" class="notice" role="status">저장한 기본 모델을 현재 서비스에서 찾을 수 없어요. 연결 설정에서 다시 선택해 주세요.</p>

      <section aria-labelledby="saved-conversations-title">
        <div class="section-heading">
          <h3 id="saved-conversations-title">저장된 대화</h3>
          <button type="button" data-testid="conversation-new" :disabled="!canManage" @click="emit('newConversation')">새 대화</button>
        </div>
        <div class="conversation-row">
          <label class="sr-only" for="saved-conversation">이어갈 대화</label>
          <select id="saved-conversation" data-testid="conversation-select" :value="library.conversationId ?? ''" :disabled="!canManage || !library.conversations.length" @change="selectConversation">
            <option v-if="!library.conversationId" value="" disabled>{{ library.conversations.length ? '이어갈 대화를 선택하세요' : '저장된 대화가 없어요' }}</option>
            <option v-for="conversation in library.conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title || '이름 없는 대화' }}</option>
          </select>
          <button type="button" class="quiet-button" data-testid="conversation-delete" :disabled="!canManage || !currentConversation" @click="deletingConversation = library.conversationId">대화 삭제</button>
        </div>
        <div v-if="deletingConversation" class="delete-review" data-testid="conversation-delete-review">
          <p><strong>{{ currentConversation?.title || '이 대화' }}</strong>를 삭제할까요? 저장된 대화 기록을 지워요.</p>
          <div class="button-row">
            <button type="button" :disabled="busy" @click="deletingConversation = null">유지하기</button>
            <button type="button" class="danger-button" data-testid="conversation-delete-confirm" :disabled="!canManage" @click="removeConversation">대화 삭제</button>
          </div>
        </div>
      </section>

      <section aria-labelledby="memory-sources-title">
        <div class="section-heading">
          <h3 id="memory-sources-title">함께 참고할 자료</h3>
          <button type="button" data-testid="memory-new" :disabled="!canManage" @click="startNote">새 노트</button>
        </div>
        <p class="hint">체크한 자료를 다음 메시지에서 참고해요. 자동 기억 참고를 켜면 관련 기억도 함께 찾아요. 각 자료의 사용 허용 범위가 적용돼요.</p>
        <form class="search-row" @submit.prevent="refresh">
          <label class="sr-only" for="memory-query">저장된 자료 검색</label>
          <input id="memory-query" v-model="query" data-testid="memory-search" type="search" maxlength="256" placeholder="제목이나 내용으로 찾기" :disabled="!canManage" />
          <button type="submit" data-testid="memory-refresh" :disabled="!canManage">{{ query.trim() ? '검색' : '새로고침' }}</button>
        </form>
        <div v-if="library.selectedSourceIds.length" class="selection-row">
          <span>{{ library.selectedSourceIds.length }}개 선택됨</span>
          <button type="button" class="quiet-button" data-testid="memory-clear-selection" :disabled="!canManage" @click="emit('select', [])">선택 해제</button>
        </div>
        <p v-if="library.available && library.sources.length === 0" class="empty-state" data-testid="memory-empty">{{ query.trim() ? '찾은 자료가 없어요. 다른 검색어로 찾아보세요.' : '아직 저장한 자료가 없어요. 기억해 둘 내용을 노트로 남겨 보세요.' }}</p>
        <ul v-else class="sources" data-testid="memory-sources">
          <li v-for="source in library.sources" :key="source.id" class="source-card" :data-source-id="source.id" data-testid="memory-source">
            <div class="source-heading">
              <label class="source-selection">
                <input type="checkbox" data-testid="memory-select" :checked="library.selectedSourceIds.includes(source.id)" :disabled="!canManage" @change="selectSource(source, $event)" />
                <span><strong>{{ source.title || '제목 없는 자료' }}</strong><span class="source-meta">{{ kindLabels[source.kind] }} · {{ boundaryLabels[source.boundary] }}</span></span>
              </label>
              <div class="source-buttons">
                <button v-if="source.origin" type="button" data-testid="memory-edit-file" :disabled="!canEditFile(source)" :aria-label="`${source.origin.path} 원본 전체 편집`" :title="writableFolderIds.includes(source.origin.collection_id) ? '원본 Markdown 파일 전체 열기' : '노트 폴더 연결에서 이 폴더의 원본 편집을 먼저 허용해 주세요.'" @click="editFile(source)">원본 편집</button>
                <button v-if="editable(source)" type="button" data-testid="memory-edit" :disabled="!canManage" :aria-label="`${source.title} 수정`" @click="edit(source)">수정</button>
                <button v-if="!source.origin" type="button" class="quiet-button" data-testid="memory-delete" :disabled="!canManage" :aria-label="`${source.title} 삭제`" @click="deleting = { id: source.id, revision: source.revision, title: source.title }">삭제</button>
              </div>
            </div>
            <p v-if="source.origin" class="hint" data-testid="memory-source-origin">{{ source.origin.collection_label }} · {{ source.origin.path }} · {{ source.origin.chunk_index + 1 }}/{{ source.origin.chunk_count }} 조각 · {{ writableFolderIds.includes(source.origin.collection_id) ? '원본 전체 편집 가능' : '원본 폴더에서 수정 · 키리안 편집은 꺼짐' }}</p>
            <details class="source-detail">
              <summary data-testid="memory-source-view">내용 보기</summary>
              <p class="source-text">{{ source.text }}</p>
              <p v-if="source.parents.length" class="hint">연결된 원본: {{ source.parents.map((parent) => parentTitle(parent.sourceId)).join(', ') }}</p>
            </details>
          </li>
        </ul>
        <div v-if="deleting" class="delete-review" data-testid="memory-delete-review">
          <p><strong>{{ deleting.title || '이 자료' }}</strong>를 삭제할까요? 삭제한 자료는 다음 대화에서 사용할 수 없어요.</p>
          <div class="button-row">
            <button type="button" :disabled="busy" @click="deleting = null">유지하기</button>
            <button type="button" class="danger-button" data-testid="memory-delete-confirm" :disabled="!canManage" @click="removeSource">자료 삭제</button>
          </div>
        </div>
      </section>

      <form v-if="editorOpen" class="note-editor" data-testid="memory-editor" @submit.prevent="save">
        <div class="section-heading"><h3>{{ editing ? '자료 수정' : '새 노트' }}</h3><button type="button" class="quiet-button" data-testid="memory-editor-close" :disabled="busy" @click="editorOpen = false">접기</button></div>
        <label for="memory-title">제목</label>
        <input id="memory-title" v-model="title" data-testid="memory-title" maxlength="120" required :disabled="!canManage" placeholder="어떤 내용을 기억할까요?" />
        <label for="memory-text">내용</label>
        <textarea id="memory-text" v-model="text" data-testid="memory-text" rows="5" maxlength="8192" required :disabled="!canManage" placeholder="참고할 내용을 적어 주세요." />
        <label for="memory-boundary">사용 허용 범위</label>
        <select id="memory-boundary" v-model="boundary" data-testid="memory-boundary" :disabled="!canManage" aria-describedby="memory-boundary-description">
          <option value="local">이 PC에서만</option>
          <option value="private_lan">개인 LAN까지 허용</option>
          <option value="cloud">API 사용 허용</option>
        </select>
        <p id="memory-boundary-description" class="hint" :class="{ 'api-notice': boundary === 'cloud' }">{{ boundaryDescription }}</p>
        <p v-if="editChanged" class="notice" role="status">자료 목록이 바뀌었어요. 최신 자료를 다시 열어 수정해 주세요. 입력한 내용은 그대로 남아 있어요.</p>
        <div class="button-row"><span class="hint">{{ text.length.toLocaleString() }} / 8,192자</span><button type="submit" class="save-button" data-testid="memory-save" :disabled="!canSave">{{ busy ? '처리 중…' : editing ? '수정 저장' : '노트 저장' }}</button></div>
      </form>
      <AutoMemoryPanel :enabled="enabled && library.available" :folders="noteFolders" />
    </div>
  </details>
</template>

<style scoped>
.memory-panel { min-width: 0; flex: none; border-top: 1px solid var(--line); color: #e1dce9; font-size: 12px; }
summary { cursor: pointer; -webkit-app-region: no-drag; }
.memory-panel > summary { padding: 11px 2px; font-weight: 600; }
.summary-hint { margin-left: 10px; color: var(--quiet); font-size: 10px; font-weight: 400; }
.panel-content { display: grid; gap: 16px; max-height: min(420px, 48dvh); overflow: auto; padding: 3px 3px 14px; scrollbar-width: thin; scrollbar-color: #544b64 transparent; }
section, form, .source-card { min-width: 0; }
.section-heading, .conversation-row, .search-row, .button-row, .selection-row, .source-heading { display: flex; align-items: center; gap: 8px; }
.section-heading, .button-row, .selection-row { justify-content: space-between; }
.section-heading { margin-bottom: 8px; }
h3, p { margin: 0; }
h3 { font-size: 12px; font-weight: 600; }
.hint, .notice, .empty-state { color: var(--muted); font-size: 11px; line-height: 1.7; }
.hint { margin-bottom: 8px; }
.notice, .empty-state { padding: 10px; border-radius: 8px; background: #ffffff04; }
.notice, .api-notice { color: #dbbdcb; }
button, input, textarea, select { font: inherit; -webkit-app-region: no-drag; }
button { padding: 6px 9px; border: 1px solid #c0aaf61a; border-radius: 7px; background: #c0aaf60b; color: #d9c8f5; white-space: nowrap; }
button:hover:not(:disabled) { background: #c0aaf61a; }
button:disabled, input:disabled, textarea:disabled, select:disabled { opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:not([type=checkbox]), textarea, select { display: block; width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid #ffffff12; border-radius: 7px; background: #15151e; color: #e6e0ed; }
textarea { resize: vertical; min-height: 90px; line-height: 1.65; }
input::placeholder, textarea::placeholder { color: var(--quiet); }
input[type=checkbox] { flex: none; width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--accent); }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.danger-button { color: #edb7c4; border-color: #edb7c42a; }
.save-button { background: #c0aaf621; }
.conversation-row select, .search-row input { flex: 1; }
.selection-row { margin-top: 6px; color: #c8b6e5; font-size: 11px; }
.sources { display: grid; gap: 7px; margin: 8px 0 0; padding: 0; list-style: none; }
.source-card { padding: 10px; border: 1px solid #ffffff09; border-radius: 9px; background: #ffffff03; }
.source-heading { align-items: flex-start; justify-content: space-between; }
.source-selection { display: flex; align-items: flex-start; gap: 8px; min-width: 0; cursor: pointer; }
.source-selection > span { min-width: 0; }
.source-selection strong { display: block; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; line-height: 1.5; }
.source-meta { display: block; margin-top: 3px; color: var(--quiet); font-size: 10px; }
.source-buttons { display: flex; flex: none; gap: 3px; }
.source-buttons button { padding: 4px 6px; font-size: 10px; }
.source-detail { margin-top: 8px; color: var(--muted); }
.source-detail summary { font-size: 10px; }
.source-text { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; font-size: 11px; }
.delete-review { display: grid; gap: 9px; margin-top: 8px; padding: 10px; border: 1px solid #edb7c422; border-radius: 8px; }
.delete-review p { font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.delete-review .button-row { justify-content: flex-end; }
.note-editor { display: grid; gap: 7px; padding: 11px; border: 1px solid #c0aaf622; border-radius: 10px; background: #c0aaf604; }
.note-editor .section-heading, .note-editor .hint { margin-bottom: 0; }
.note-editor label { margin-top: 3px; font-size: 11px; color: var(--muted); }
@media (max-width: 420px) { .summary-hint { display: none; } .source-heading { flex-wrap: wrap; } .source-buttons { margin-left: auto; } .conversation-row { flex-wrap: wrap; } .conversation-row select { flex-basis: 100%; } }
</style>
