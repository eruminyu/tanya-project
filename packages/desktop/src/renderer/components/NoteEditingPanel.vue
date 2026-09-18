<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { NoteEditApproval, NoteEditDocument, NoteEditReview, NoteEditSummary } from '../../shared/note-editing.js';

const props = defineProps<{
  document: NoteEditDocument | null; review: NoteEditReview | null; history: NoteEditSummary[];
  available: boolean; busy: boolean; error: string | null;
}>();
const emit = defineEmits<{
  preview: [text: string]; approve: [approval: NoteEditApproval]; dismiss: [draftId: string];
  review: [draftId: string]; undo: [draftId: string]; forget: [draftId: string]; close: []; refresh: [];
}>();
const panel = ref<HTMLDetailsElement | null>(null);
const editor = ref<HTMLTextAreaElement | null>(null);
const text = ref('');
const consent = ref(false);
const forgetting = ref<string | null>(null);
const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now(); }, 1_000);
onBeforeUnmount(() => clearInterval(timer));
const canManage = computed(() => props.available && !props.busy);
const pendingCount = computed(() => props.history.filter((item) => item.status === 'pending').length);
// Textarea values use LF; the approved byte hash binds the original file's serialized line endings.
const normalized = (value: string): string => value.replace(/\r\n/g, '\n');
const reviewMatchesEditor = computed(() => !props.document || props.review?.kind !== 'edit' ||
  (props.document.folderId === props.review.folderId && props.document.path === props.review.path &&
    normalized(text.value) === normalized(props.review.afterText)));
const expired = computed(() => !!props.review && props.review.expiresAt <= now.value);
const canApprove = computed(() => canManage.value && props.review?.status === 'pending' &&
  !expired.value && reviewMatchesEditor.value && consent.value);
const textBytes = computed(() => new TextEncoder().encode(text.value).byteLength);
const canPreview = computed(() => canManage.value && !!props.document && textBytes.value <= 262_144);
const statusLabels: Record<NoteEditSummary['status'], string> = {
  pending: '승인 대기', dismissed: '취소됨', running: '저장 결과 확인 중',
  succeeded: '파일 저장 완료', failed: '저장 실패', unknown: '결과 확인 필요',
};
const kindLabels: Record<NoteEditSummary['kind'], string> = { edit: '원본 편집', undo: '되돌리기', recovery: '원본 복구' };

watch(() => props.document?.documentId, async () => {
  text.value = props.document?.text ?? '';
  consent.value = false;
  if (props.document) {
    await nextTick();
    if (panel.value) panel.value.open = true;
    editor.value?.focus();
  }
}, { immediate: true });
watch(() => JSON.stringify([props.review?.draftId, props.review?.revision, props.review?.payloadSha256,
  props.review?.beforeSha256, props.review?.afterSha256, props.review?.status]), async () => {
  consent.value = false;
  now.value = Date.now();
  if (props.review) {
    await nextTick();
    if (panel.value) panel.value.open = true;
  }
}, { immediate: true });
watch(text, () => { consent.value = false; });
watch(() => props.available, () => { consent.value = false; });
watch(expired, () => { consent.value = false; });
watch(() => props.history, items => {
  if (forgetting.value && !items.some(item => item.draftId === forgetting.value && item.status !== 'unknown' && item.status !== 'running')) forgetting.value = null;
});
watch(() => props.available, available => { if (!available) forgetting.value = null; });

function preview(): void {
  if (canPreview.value) { consent.value = false; emit('preview', text.value); }
}
function approve(): void {
  const review = props.review;
  if (!canApprove.value || !review) return;
  consent.value = false;
  emit('approve', { draftId: review.draftId, revision: review.revision, payloadSha256: review.payloadSha256 });
}
function forget(): void {
  const item = props.history.find(item => item.draftId === forgetting.value);
  if (!canManage.value || !item || item.status === 'unknown' || item.status === 'running') return;
  forgetting.value = null;
  emit('forget', item.draftId);
}
function time(value: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return '시간 확인 불가';
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}
function errorMessage(code: string | null): string {
  switch (code) {
    case 'write_disabled': case 'write_not_enabled': case 'permission_denied':
      return '이 폴더의 원본 편집이 꺼져 있어요. 노트 폴더 연결에서 편집을 허용한 뒤 원본을 다시 열어 주세요.';
    case 'file_changed': case 'source_changed': case 'revision_conflict': case 'conflict': case 'note_file_conflict':
      return '다른 프로그램에서 원본을 변경했어요. 현재 파일을 다시 열어 내용을 비교한 뒤 새 변경안을 만들어 주세요.';
    case 'grant_changed': case 'permission_changed':
      return '폴더의 편집 권한이 바뀌었어요. 현재 권한으로 원본을 다시 열어 주세요.';
    case 'root_unavailable': case 'root_changed': case 'file_unavailable': case 'file_missing': case 'note_root_changed': case 'note_file_unavailable':
      return '원본 파일이나 연결한 폴더를 확인할 수 없어요. 파일 위치와 폴더 연결을 확인해 주세요.';
    case 'invalid_encoding': case 'note_invalid_encoding': case 'invalid_note_encoding':
      return '이 파일을 UTF-8 Markdown으로 읽을 수 없어요. 원본의 문자 형식을 확인해 주세요.';
    case 'note_limit': case 'file_too_large': case 'content_too_large': case 'note_file_limit': case 'invalid_note_bytes':
      return '한 번에 편집할 수 있는 파일 크기인 256 KiB를 넘었어요.';
    case 'unsafe_path': case 'invalid_path': case 'file_identity_changed': case 'unsafe_file': case 'invalid_note_path': case 'note_file_unsafe':
      return '선택한 원본 파일인지 확인하지 못했어요. 연결한 폴더 안의 일반 Markdown 파일을 다시 열어 주세요.';
    case 'expired': case 'draft_expired': case 'document_expired': case 'note_document_expired': case 'approval_expired':
      return '확인 시간이 지났어요. 원본을 다시 열고 새로운 변경 내용을 확인해 주세요.';
    case 'already_claimed': case 'already_executed': case 'duplicate_approval': case 'not_pending': case 'action_already_decided':
      return '이미 처리한 변경이에요. 아래 기록에서 결과를 확인해 주세요.';
    case 'connection_changed': case 'context_changed': case 'cancelled': case 'aborted':
      return '연결이나 현재 작업이 바뀌었어요. 기록에서 결과를 확인한 뒤 다시 원본을 열어 주세요.';
    case 'storage_unavailable': case 'journal_unavailable': case 'journal_changed': case 'storage_limit': case 'note_edit_store_unavailable': case 'note_edit_store_changed':
      return '변경 기록을 안전하게 저장하지 못했어요. 저장 공간과 접근 권한을 확인해 주세요.';
    case 'file_locked': case 'sharing_violation':
      return '다른 프로그램이 원본 파일을 사용하고 있어요. 파일을 닫은 뒤 다시 내용을 확인해 주세요.';
    case 'edit_unknown': case 'write_unknown': case 'outcome_unknown': case 'note_write_unknown': case 'note_edit_unresolved':
      return '원본에 변경이 적용됐는지 확인할 수 없어요. 같은 변경을 다시 실행하지 말고 기록의 복구 내용을 확인해 주세요.';
    case 'no_changes': case 'note_no_change': case 'note_unchanged': return '원본과 같은 내용이에요. 편집 후 변경 내용을 확인해 주세요.';
    case 'stale_draft': return '승인할 변경안이 달라졌어요. 최신 변경 전후를 다시 확인해 주세요.';
    case 'note_edit_record_limit': case 'note_edit_store_limit': return '편집 기록의 저장 한도에 도달해 새 변경안을 만들 수 없어요.';
    case 'note_document_limit': return '열어 둔 원본이 너무 많아요. 편집창을 닫은 뒤 다시 열어 주세요.';
    case 'note_undo_unavailable': return '이 기록은 지금 되돌릴 수 없어요. 현재 원본과 후속 편집 기록을 확인해 주세요.';
    case 'note_forget_unavailable': case 'note_edit_forget_unavailable': return '연결된 변경 중 아직 결과를 확인해야 하는 기록이 있어요. 복구를 완료한 뒤 기록을 삭제해 주세요.';
    case 'note_io_failed': return '원본 파일을 읽거나 저장하지 못했어요. 파일 접근 권한과 다른 프로그램의 파일 사용 상태를 확인해 주세요.';
    default: return '작업을 완료하지 못했어요. 원본 파일과 변경 기록을 확인해 주세요. 입력한 내용은 이 편집창에 남아 있어요.';
  }
}
</script>

<template>
  <details ref="panel" class="note-editing-panel" data-testid="note-editor">
    <summary data-testid="note-editor-toggle"><span>원본 노트 편집</span><span class="summary-hint">{{ pendingCount ? `${pendingCount}개 승인 대기` : '변경을 확인한 뒤 저장' }}</span></summary>
    <div class="panel-content" :aria-busy="busy">
      <p v-if="!available" class="notice" role="status">원본 편집을 아직 사용할 수 없어요. 대화 서비스와 노트 폴더 연결을 확인해 주세요.</p>
      <p v-if="error" class="notice error" data-testid="note-edit-error" role="alert">{{ errorMessage(error) }}</p>
      <p v-if="!document && !review" class="hint">노트 폴더에서 원본 편집을 허용한 다음, ‘기억과 대화’의 자료에서 ‘원본 편집’을 눌러 주세요.</p>

      <form v-if="document" class="edit-form" @submit.prevent="preview">
        <div class="section-heading"><h3>원본 Markdown 전체</h3><button type="button" class="quiet-button" data-testid="note-editor-close" :disabled="busy" @click="emit('close')">편집 닫기</button></div>
        <p class="hint">{{ document.folderLabel }} · {{ document.path }}</p>
        <p class="file-path" data-testid="note-edit-target">{{ document.target }}</p>
        <p class="hint">검색 자료의 일부 조각이 아닌 원본 파일 전체를 편집해요. 빈 내용으로 저장하면 파일 내용 전체가 지워져요.</p>
        <details class="file-facts"><summary>열었을 때의 파일 정보</summary><p>{{ document.bytes.toLocaleString('ko-KR') }}바이트 · {{ document.encoding }}</p><p class="hash">SHA-256 {{ document.sha256 }}</p></details>
        <label for="note-edit-markdown">Markdown 원문</label>
        <textarea id="note-edit-markdown" ref="editor" v-model="text" data-testid="note-edit-text" rows="12" spellcheck="false" :disabled="!canManage" aria-describedby="note-edit-size" />
        <div class="button-row"><p id="note-edit-size" class="hint" :class="{ error: textBytes > 262_144 }">입력 {{ textBytes.toLocaleString('ko-KR') }}바이트 · 최대 256 KiB</p><button type="submit" data-testid="note-edit-preview" :disabled="!canPreview">변경 내용 확인</button></div>
      </form>

      <section v-if="review" class="review" data-testid="note-edit-review-panel" aria-labelledby="note-edit-review-title">
        <div class="section-heading"><h3 id="note-edit-review-title">{{ kindLabels[review.kind] }} · 변경 전후</h3><span class="status" :class="`status-${review.status}`" data-testid="note-edit-status" role="status">{{ statusLabels[review.status] }}</span></div>
        <p class="file-path">{{ review.target }}</p>
        <p class="hint">아래의 전체 내용으로 이 파일을 저장해요. 문자 형식: {{ review.encoding }}</p>
        <p v-if="review.status === 'unknown'" class="notice error" data-testid="note-edit-unknown" role="alert">저장이 완료됐는지 확인할 수 없어요. 같은 변경을 자동으로 다시 실행하지 않아요. 기록에서 복구 내용을 열어 현재 파일과 보관한 원본을 비교해 주세요.</p>
        <p v-if="review.error" class="notice error" role="status">{{ errorMessage(review.error) }}</p>
        <div class="comparison">
          <div class="version"><h4>변경 전 전체 내용</h4><p class="hint">{{ review.beforeBytes.toLocaleString('ko-KR') }}바이트</p><p class="hash">SHA-256 {{ review.beforeSha256 }}</p><p v-if="review.beforeText === ''" class="hint">내용이 비어 있어요.</p><pre v-if="review.beforeText !== null" data-testid="note-edit-before">{{ review.beforeText }}</pre><p v-else class="notice error" data-testid="note-edit-before">현재 파일을 UTF-8 문자로 표시할 수 없어요. 위의 파일 크기와 해시로 현재 파일을 확인하며, 승인하면 ‘변경 후 전체 내용’의 복구 내용으로 저장해요.</p></div>
          <div class="version"><h4>변경 후 전체 내용</h4><p class="hint">{{ review.afterBytes.toLocaleString('ko-KR') }}바이트</p><p class="hash">SHA-256 {{ review.afterSha256 }}</p><p v-if="review.afterText === ''" class="notice error">저장하면 파일의 전체 내용이 비워져요.</p><pre data-testid="note-edit-after">{{ review.afterText }}</pre></div>
        </div>
        <template v-if="review.status === 'pending'">
          <p v-if="expired" class="notice error" role="status">이 변경안의 확인 시간이 지났어요. 원본을 다시 열고 새 변경안을 만들어 주세요.</p>
          <p v-else-if="!reviewMatchesEditor" class="notice" data-testid="note-edit-stale" role="status">입력 내용이 이 변경안과 달라졌어요. ‘변경 내용 확인’을 다시 눌러 주세요.</p>
          <p v-else class="hint">승인 가능 시간: {{ time(review.expiresAt) }}까지. 저장 직전 원본이 바뀌었다면 덮어쓰지 않아요.</p>
          <label class="consent"><input v-model="consent" type="checkbox" data-testid="note-edit-consent" :disabled="!canManage || expired || !reviewMatchesEditor" /><span>파일 경로와 변경 전후 전체 내용을 확인했으며, 이 변경 한 번의 저장을 승인합니다.</span></label>
          <div class="button-row review-buttons"><button type="button" class="quiet-button" data-testid="note-edit-dismiss" :disabled="!canManage" @click="emit('dismiss', review.draftId)">이 변경 취소</button><button type="button" class="approve-button" data-testid="note-edit-approve" :disabled="!canApprove" @click="approve">승인하고 파일 저장</button></div>
        </template>
      </section>

      <section class="history" aria-labelledby="note-edit-history-title">
        <div class="section-heading"><h3 id="note-edit-history-title">원본 편집 기록</h3><button type="button" data-testid="note-edit-refresh" :disabled="!canManage" @click="emit('refresh')">새로고침</button></div>
        <p class="hint">앱을 다시 열어도 기록에서 결과를 확인할 수 있어요. 되돌리기와 복구도 새 변경안을 확인하고 승인해야 저장해요.</p>
        <p v-if="!history.length" class="empty-state">아직 원본 편집 기록이 없어요.</p>
        <ul class="records" data-testid="note-edit-history">
          <li v-for="item in history" :key="item.draftId" class="record" data-testid="note-edit-record" :data-draft-id="item.draftId">
            <div class="section-heading"><strong>{{ item.path }}</strong><span class="status" :class="`status-${item.status}`">{{ statusLabels[item.status] }}</span></div>
            <p class="hint">{{ item.folderLabel }} · {{ kindLabels[item.kind] }} · {{ time(item.createdAt) }}</p>
            <p v-if="item.resolvedBy" class="hint">후속 복구 또는 되돌리기 기록이 있어요.</p>
            <p v-else-if="item.status === 'unknown'" class="error hint">현재 파일 확인이 필요해요. 동일한 저장은 재실행하지 않아요.</p>
            <p v-if="item.error" class="error hint">{{ errorMessage(item.error) }}</p>
            <div class="record-buttons"><button type="button" data-testid="note-edit-review" :disabled="!canManage" :aria-label="`${item.path} 변경 내용 확인`" @click="emit('review', item.draftId)">변경 내용 보기</button><button v-if="item.canUndo" type="button" data-testid="note-edit-undo" :disabled="!canManage" :aria-label="`${item.path} ${item.status === 'unknown' ? '복구 내용 확인' : '되돌릴 내용 확인'}`" @click="emit('undo', item.draftId)">{{ item.status === 'unknown' ? '복구 내용 확인' : '되돌릴 내용 확인' }}</button><button v-if="item.status === 'pending' && item.draftId !== review?.draftId" type="button" class="quiet-button" data-testid="note-edit-dismiss" :disabled="!canManage" @click="emit('dismiss', item.draftId)">변경 취소</button><button v-if="item.status !== 'unknown' && item.status !== 'running'" type="button" class="quiet-button" data-testid="note-edit-forget" :disabled="!canManage" :aria-label="`${item.path} 연결된 편집 기록 삭제`" @click="forgetting = item.draftId">기록 삭제</button></div>
            <div v-if="forgetting === item.draftId" class="forget-review" data-testid="note-edit-forget-review">
              <p>연결된 편집 기록과 보관한 원본 백업을 삭제합니다. 원본 파일은 변경하지 않습니다.</p>
              <p class="hint">이 기록으로 되돌리거나 복구할 수 없게 돼요.</p>
              <div class="record-buttons"><button type="button" :disabled="busy" @click="forgetting = null">기록 유지</button><button type="button" class="danger-button" data-testid="note-edit-forget-confirm" :disabled="!canManage" @click="forget">연결된 기록과 백업 삭제</button></div>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </details>
</template>

<style scoped>
.note-editing-panel { min-width: 0; flex: none; border-top: 1px solid var(--line); color: #e1dce9; font-size: 12px; }
summary { cursor: pointer; -webkit-app-region: no-drag; }
.note-editing-panel > summary { padding: 11px 2px; font-weight: 600; }
.summary-hint { margin-left: 10px; color: var(--quiet); font-size: 10px; font-weight: 400; }
.panel-content { display: grid; gap: 16px; max-height: min(590px, 65dvh); overflow: auto; padding: 3px 3px 14px; scrollbar-width: thin; scrollbar-color: #544b64 transparent; }
h3, h4, p { margin: 0; }
h3, h4 { font-size: 12px; font-weight: 600; }
form, section, .version, .record { min-width: 0; }
.edit-form, .review { display: grid; gap: 9px; padding: 10px; border: 1px solid #c0aaf622; border-radius: 9px; background: #c0aaf604; }
.section-heading, .button-row, .record-buttons { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.hint, .notice, .empty-state { color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.notice, .empty-state { padding: 9px; border-radius: 7px; background: #ffffff05; }
.error { color: #e1b7c6; }
.file-path, .hash { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.file-path { font-size: 11px; line-height: 1.65; color: #cec1df; }
.hash { color: var(--quiet); font-size: 10px; line-height: 1.7; }
.file-facts { min-width: 0; color: var(--muted); font-size: 10px; line-height: 1.7; }
label { color: #cec1df; font-size: 11px; }
button, input, textarea { font: inherit; -webkit-app-region: no-drag; }
button { padding: 7px 9px; border: 1px solid #c0aaf625; border-radius: 7px; background: #c0aaf60d; color: #d9c8f5; font-size: 11px; line-height: 1.5; }
button:hover:not(:disabled) { background: #c0aaf622; }
button:disabled, input:disabled, textarea:disabled { opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 190px; padding: 9px; border: 1px solid #ffffff16; border-radius: 7px; background: #15151e; color: #e6e0ed; line-height: 1.65; resize: vertical; tab-size: 2; }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.approve-button { background: #c0aaf628; }
.comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.version { display: flex; flex-direction: column; gap: 5px; }
pre { flex: 1; margin: 0; min-height: 70px; max-height: 320px; overflow: auto; padding: 9px; border: 1px solid #ffffff12; border-radius: 7px; background: #15151e; color: #e6e0ed; font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; user-select: text; }
.consent { display: flex; align-items: flex-start; gap: 8px; line-height: 1.7; cursor: pointer; }
input[type=checkbox] { flex: none; width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--accent); }
.review-buttons, .record-buttons { justify-content: flex-end; }
.status { flex: none; padding: 3px 6px; border-radius: 5px; background: #c0aaf60d; color: #c9b6ea; font-size: 10px; }
.status-succeeded { color: #acceb9; background: #82b99d0d; }
.status-failed, .status-unknown { color: #e1b7c6; background: #c787990d; }
.status-dismissed { color: var(--muted); background: #ffffff05; }
.history { display: grid; gap: 8px; }
.records { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.record { display: grid; gap: 7px; padding: 10px; border: 1px solid #ffffff10; border-radius: 8px; }
.record strong { font-size: 11px; font-weight: 500; overflow-wrap: anywhere; }
.forget-review { display: grid; gap: 8px; padding: 9px; border: 1px solid #e1b7c62a; border-radius: 7px; font-size: 11px; line-height: 1.7; }
.danger-button { color: #e1b7c6; border-color: #e1b7c62a; }
@media (max-width: 620px) { .comparison { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 420px) { .summary-hint { display: none; } .edit-form, .review { padding: 8px; } .record-buttons button { flex: 1; } }
</style>
