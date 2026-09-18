<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { NoteFolder, NoteFolderBoundary, NoteFoldersState } from '../../shared/note-folders.js';

const props = defineProps<{ state: NoteFoldersState; enabled: boolean }>();
const emit = defineEmits<{
  choose: [boundary: NoteFolderBoundary];
  refresh: [id: string];
  remove: [id: string];
  boundary: [id: string, boundary: NoteFolderBoundary];
  writePermission: [permission: { id: string; enabled: boolean }];
  editFile: [id: string];
}>();
const selectedBoundary = ref<NoteFolderBoundary>('local');
const removing = ref<{ id: string; label: string; path: string } | null>(null);
const canManage = computed(() => props.enabled && props.state.available && !props.state.busy);
const phaseLabels: Record<NoteFolder['phase'], string> = {
  idle: '동기화 대기', syncing: '변경 확인 중', ready: '동기화됨', error: '확인 필요',
};
const boundaryDescription = computed(() => selectedBoundary.value === 'local'
  ? '이 폴더의 노트는 이 PC의 모델에서만 사용할 수 있어요.'
  : '이 폴더의 노트를 연결한 개인 LAN 서버에서도 처리할 수 있도록 허용해요.');

watch(() => props.state.folders.map((folder) => [folder.id, folder.label, folder.path, folder.kind]), () => {
  const pending = removing.value;
  if (pending && !props.state.folders.some((folder) => folder.id === pending.id &&
    folder.label === pending.label && folder.path === pending.path && folder.kind === 'vault')) removing.value = null;
});
watch(() => props.state.available, (available) => { if (!available) removing.value = null; });

function choose(): void {
  if (canManage.value) emit('choose', selectedBoundary.value);
}
function refresh(folder: NoteFolder): void {
  if (canManage.value && folder.phase !== 'syncing') emit('refresh', folder.id);
}
function changeBoundary(folder: NoteFolder, event: Event): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  // Keep the host-confirmed policy visible until the changed state is received.
  event.target.value = folder.boundary;
  if (canManage.value && folder.phase !== 'syncing' && value !== folder.boundary &&
    (value === 'local' || value === 'private_lan')) emit('boundary', folder.id, value);
}
function changeWritePermission(folder: NoteFolder, event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  const enabled = event.target.checked;
  event.target.checked = folder.writeEnabled;
  if (canChangeWritePermission(folder) && enabled !== folder.writeEnabled)
    emit('writePermission', { id: folder.id, enabled });
}
function canChangeWritePermission(folder: NoteFolder): boolean {
  // Revocation remains available during an in-flight save or synchronization.
  return folder.writeEnabled ? props.state.available : canManage.value && folder.phase !== 'syncing';
}
function chooseFile(folder: NoteFolder): void {
  if (canManage.value && folder.writeEnabled && folder.phase !== 'syncing') emit('editFile', folder.id);
}
function requestRemove(folder: NoteFolder): void {
  if (canManage.value && folder.kind === 'vault' && folder.phase !== 'syncing')
    removing.value = { id: folder.id, label: folder.label, path: folder.path };
}
function confirmRemove(): void {
  const pending = removing.value;
  if (!canManage.value || !pending) return;
  const folder = props.state.folders.find((item) => item.id === pending.id && item.path === pending.path &&
    item.label === pending.label && item.kind === 'vault');
  if (!folder || folder.phase === 'syncing') return;
  emit('remove', folder.id);
  removing.value = null;
}
function errorMessage(code: string | null): string {
  switch (code) {
    case 'scan_failed': return '노트 파일을 읽지 못했어요. 폴더 접근 권한을 확인한 뒤 다시 동기화해 주세요.';
    case 'root_unavailable': return '연결한 폴더를 찾거나 열 수 없어요. 폴더 위치와 연결된 드라이브를 확인해 주세요.';
    case 'invalid_encoding': return '읽을 수 없는 문자 형식의 노트가 있어요. 해당 노트를 UTF-8로 저장한 뒤 다시 동기화해 주세요.';
    case 'note_limit': return '가져올 수 있는 노트의 양을 넘었어요. 더 작은 노트 폴더를 선택해 주세요.';
    case 'source_changed': return '자료가 변경되어 동기화를 완료하지 못했어요. 다시 동기화해 주세요.';
    case 'storage_unavailable': return '가져온 노트를 저장하지 못했어요. 저장 공간과 접근 권한을 확인해 주세요.';
    case 'connection_changed': return '연결이 바뀌어 동기화를 멈췄어요. 연결 후 다시 동기화해 주세요.';
    case 'edit_unknown': case 'note_write_unknown': return '원본 편집의 완료 여부를 확인할 수 없어 동기화를 멈췄어요. 원본 편집 기록에서 현재 파일과 복구 내용을 확인해 주세요.';
    default: return '노트를 동기화하지 못했어요. 폴더와 대화 서비스 연결을 확인한 뒤 다시 시도해 주세요.';
  }
}
function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('ko-KR') : '—';
}
function syncedAt(value: number | null): string {
  if (value === null) return '아직 동기화하지 않았어요';
  const date = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) return '마지막 동기화 시간을 확인할 수 없어요';
  return '마지막 동기화 · ' + new Intl.DateTimeFormat('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
</script>

<template>
  <details class="note-folders-panel" data-testid="note-folders-panel">
    <summary data-testid="note-folders-toggle">
      <span>노트 폴더 연결</span>
      <span class="summary-hint">{{ state.folders.length ? `${state.folders.length}개 폴더 연결됨` : '나의 노트를 대화에 함께' }}</span>
    </summary>
    <div class="panel-content" :aria-busy="state.busy">
      <p v-if="!state.available" class="notice" role="status">노트 폴더 연결을 아직 사용할 수 없어요. 대화 서비스 연결을 확인해 주세요.</p>
      <p v-else-if="!enabled" class="notice" role="status">지금은 폴더 연결을 변경할 수 없어요. 현재 작업이 끝나면 다시 사용할 수 있어요.</p>

      <form class="folder-chooser" @submit.prevent="choose">
        <div class="section-heading"><h3>참고할 노트 폴더</h3><span class="hint">처음에는 읽기만</span></div>
        <p class="hint">Obsidian 보관함이나 노트 폴더를 선택해 주세요. 가져온 노트는 ‘기억과 대화’에서 검색하고 대화의 참고 자료로 선택할 수 있어요.</p>
        <label for="note-folder-boundary">새로 연결할 폴더의 사용 범위</label>
        <div class="choose-row">
          <select id="note-folder-boundary" v-model="selectedBoundary" data-testid="note-folder-boundary" :disabled="!canManage" aria-describedby="note-folder-boundary-description">
            <option value="local">이 PC에서만</option>
            <option value="private_lan">개인 LAN까지 허용</option>
          </select>
          <button type="submit" class="choose-button" data-testid="note-folder-choose" :disabled="!canManage">폴더 선택</button>
        </div>
        <p id="note-folder-boundary-description" class="hint" :class="{ 'lan-hint': selectedBoundary === 'private_lan' }">{{ boundaryDescription }}</p>
      </form>

      <p v-if="state.available && state.folders.length === 0" class="empty-state" data-testid="note-folders-empty">아직 연결한 폴더가 없어요. 위의 폴더 선택으로 시작해 보세요.</p>
      <div v-if="state.folders.length" class="folder-list">
        <p class="hint auto-sync-hint">연결한 폴더의 변경 사항은 자동으로 확인해요.</p>
        <article v-for="folder in state.folders" :key="folder.id" class="folder-card" :data-folder-id="folder.id" data-testid="note-folder-card">
          <div class="folder-heading">
            <div class="folder-name"><span class="folder-kind">{{ folder.kind === 'approved_notes' ? '승인한 노트' : '연결한 폴더' }}</span><h3>{{ folder.label }}</h3></div>
            <span class="folder-status" :class="`status-${folder.phase}`" data-testid="note-folder-status">{{ phaseLabels[folder.phase] }}</span>
          </div>
          <p class="folder-path" data-testid="note-folder-path">{{ folder.path }}</p>
          <p v-if="folder.kind === 'approved_notes'" class="hint approved-hint">승인해 만든 파일 노트를 자동으로 참고 자료에 연결해요. 키리안이 관리하는 폴더라 연결 해제는 제공하지 않아요.</p>
          <div class="folder-counts" data-testid="note-folder-counts"><span>노트 파일 {{ count(folder.documentCount) }}개</span><span>참고 항목 {{ count(folder.sourceCount) }}개</span><span v-if="folder.skipped > 0" class="skipped-count">제외한 파일 {{ count(folder.skipped) }}개</span></div>
          <p v-if="folder.skipped > 0" class="hint skipped-hint">제외한 파일은 대화의 참고 자료로 가져오지 않았어요.</p>
          <p class="sync-time" data-testid="note-folder-last-sync">{{ syncedAt(folder.lastSyncedAt) }}</p>
          <p v-if="folder.phase === 'error'" class="folder-error" data-testid="note-folder-error">{{ errorMessage(folder.error) }}</p>
          <div class="folder-policy">
            <label :for="`note-folder-policy-${folder.id}`">이 폴더의 사용 범위</label>
            <select :id="`note-folder-policy-${folder.id}`" data-testid="note-folder-policy" :value="folder.boundary" :disabled="!canManage || folder.phase === 'syncing'" @change="changeBoundary(folder, $event)">
              <option value="local">이 PC에서만</option>
              <option value="private_lan">개인 LAN까지 허용</option>
            </select>
          </div>
          <p class="hint policy-hint">{{ folder.boundary === 'local' ? '이 폴더의 노트는 이 PC의 모델에서만 사용해요.' : '이 폴더의 노트를 연결한 개인 LAN 서버에서도 처리할 수 있어요.' }}</p>
          <div class="write-permission">
            <label class="write-label" :for="`note-folder-write-${folder.id}`">
              <input :id="`note-folder-write-${folder.id}`" type="checkbox" data-testid="note-folder-write" :checked="folder.writeEnabled" :disabled="!canChangeWritePermission(folder)" :aria-describedby="`note-folder-write-description-${folder.id}`" @change="changeWritePermission(folder, $event)" />
              <span>키리안에서 원본 편집 허용</span>
            </label>
            <p :id="`note-folder-write-description-${folder.id}`" class="hint">{{ folder.writeEnabled ? '켜져 있어도 파일을 바로 수정하지 않아요. 변경 전후를 확인하고 매번 승인해야 저장해요.' : '꺼져 있어도 폴더의 변경 사항을 읽고 동기화해요. 원본 편집은 폴더마다 따로 허용할 수 있어요.' }}</p>
          </div>
          <div class="folder-buttons">
            <button type="button" data-testid="note-folder-edit-choose" :disabled="!canManage || !folder.writeEnabled || folder.phase === 'syncing'" :aria-label="`${folder.label} 파일 골라 편집`" @click="chooseFile(folder)">파일 골라 편집</button>
            <button v-if="folder.kind === 'vault'" type="button" class="quiet-button" data-testid="note-folder-remove" :disabled="!canManage || folder.phase === 'syncing'" :aria-label="`${folder.label} 연결 해제`" @click="requestRemove(folder)">연결 해제</button>
            <button type="button" data-testid="note-folder-sync" :disabled="!canManage || folder.phase === 'syncing'" :aria-label="`${folder.label} 지금 동기화`" @click="refresh(folder)">{{ folder.phase === 'syncing' ? '확인 중…' : '지금 동기화' }}</button>
          </div>
          <div v-if="removing?.id === folder.id" class="remove-review" data-testid="note-folder-remove-review">
            <p><strong>{{ removing.label }}</strong> 연결을 해제할까요?</p>
            <p>키리안에 가져온 자료와 이를 바탕으로 만든 기억·대화 참조를 지워요. 원본 파일은 그대로 남아요.</p>
            <div class="remove-buttons">
              <button type="button" :disabled="state.busy" @click="removing = null">연결 유지</button>
              <button type="button" class="remove-button" data-testid="note-folder-remove-confirm" :disabled="!canManage || folder.phase === 'syncing'" @click="confirmRemove">이 폴더 연결 해제</button>
            </div>
          </div>
        </article>
      </div>
    </div>
  </details>
</template>

<style scoped>
.note-folders-panel { min-width: 0; flex: none; border-top: 1px solid var(--line); color: #e1dce9; font-size: 12px; }
summary { padding: 11px 2px; font-weight: 600; cursor: pointer; -webkit-app-region: no-drag; }
.summary-hint { margin-left: 10px; color: var(--quiet); font-size: 10px; font-weight: 400; }
.panel-content { display: grid; gap: 12px; max-height: min(400px, 48dvh); overflow: auto; padding: 3px 3px 14px; scrollbar-width: thin; scrollbar-color: #544b64 transparent; }
h3, p { margin: 0; }
h3 { font-size: 12px; font-weight: 500; line-height: 1.55; overflow-wrap: anywhere; }
.hint, .notice, .empty-state { color: var(--muted); font-size: 11px; line-height: 1.7; }
.notice, .empty-state { padding: 10px; border-radius: 8px; background: #ffffff04; }
.folder-chooser, .folder-card, .folder-list { display: grid; gap: 8px; min-width: 0; }
.folder-chooser { padding: 11px; border: 1px solid #c0aaf616; border-radius: 9px; }
.section-heading, .choose-row, .folder-heading, .folder-policy, .folder-buttons, .remove-buttons { display: flex; align-items: center; gap: 8px; }
.section-heading, .folder-heading { justify-content: space-between; }
.section-heading .hint { color: var(--quiet); font-size: 10px; }
label { color: var(--muted); font-size: 11px; }
button, input, select { font: inherit; -webkit-app-region: no-drag; }
button { padding: 7px 9px; border: 1px solid #c0aaf625; border-radius: 7px; background: #c0aaf60d; color: #d9c8f5; font-size: 11px; line-height: 1.5; }
button:hover:not(:disabled) { background: #c0aaf622; }
button:disabled, input:disabled, select:disabled { opacity: .45; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
select { width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid #ffffff12; border-radius: 7px; background: #15151e; color: #e6e0ed; font-size: 11px; }
.choose-row select { flex: 1; }
.choose-button { flex: none; background: #c0aaf622; }
.lan-hint { color: #cbb7e7; }
.auto-sync-hint { color: var(--quiet); }
.folder-card { padding: 11px; border: 1px solid #ffffff0d; border-radius: 10px; background: #ffffff03; }
.folder-heading { align-items: flex-start; }
.folder-name { min-width: 0; }
.folder-kind { display: block; margin-bottom: 3px; color: var(--quiet); font-size: 10px; }
.folder-status { flex: none; padding: 3px 6px; border-radius: 5px; background: #c0aaf60d; color: #c9b6ea; font-size: 10px; }
.status-ready { color: #acceb9; background: #82b99d0d; }
.status-error { color: #dfb4c1; background: #c787990d; }
.status-idle { color: var(--muted); background: #ffffff05; }
.folder-path { color: #bbb0c8; font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.approved-hint { padding: 8px; border-radius: 6px; background: #c0aaf607; }
.folder-counts { display: flex; flex-wrap: wrap; gap: 4px 12px; color: #cec1df; font-size: 11px; line-height: 1.6; }
.skipped-count, .skipped-hint { color: var(--muted); }
.sync-time { color: var(--quiet); font-size: 10px; line-height: 1.6; }
.folder-error { padding: 8px; border-radius: 6px; background: #c7879908; color: #dfb4c1; font-size: 11px; line-height: 1.7; }
.folder-policy { margin-top: 3px; }
.folder-policy label { flex: none; }
.folder-policy select { flex: 1; }
.policy-hint { font-size: 10px; }
.write-permission { display: grid; gap: 5px; padding: 9px; border: 1px solid #c0aaf616; border-radius: 7px; }
.write-label { display: flex; align-items: flex-start; gap: 8px; color: #d9c8f5; cursor: pointer; }
.write-label input { flex: none; width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
.folder-buttons, .remove-buttons { justify-content: flex-end; flex-wrap: wrap; }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.remove-review { display: grid; gap: 8px; padding: 10px; border: 1px solid #dfb4c125; border-radius: 8px; font-size: 11px; line-height: 1.7; }
.remove-review p { overflow-wrap: anywhere; }
.remove-button { color: #edb7c4; border-color: #edb7c42a; }
@media (max-width: 420px) { .summary-hint { display: none; } .section-heading, .folder-heading { flex-wrap: wrap; } .folder-policy { align-items: stretch; flex-direction: column; } }
</style>
