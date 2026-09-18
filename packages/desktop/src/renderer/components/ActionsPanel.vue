<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ActionView } from '../../shared/actions.js';

const props = withDefaults(defineProps<{
  actions: ActionView[];
  enabled: boolean;
  busy: boolean;
  suggestedBody?: string;
}>(), { suggestedBody: '' });
const emit = defineEmits<{
  approve: [action: { draftId: string; revision: number; payloadSha256: string }];
  dismiss: [draftId: string];
  create: [draft: { title: string; body: string }];
}>();
const title = ref('');
const body = ref('');
const now = ref(Date.now());
const panelOpen = ref(false);
const openReviews = ref(new Set<string>());
const reviewed = ref(new Map<string, string>());
let clock: ReturnType<typeof setInterval> | undefined;
const pendingCount = computed(() => props.actions.filter((action) => action.status === 'pending').length);
const canCreate = computed(() => props.enabled && !props.busy && title.value.trim().length > 0 &&
  title.value.length <= 120 && body.value.trim().length > 0 && body.value.length <= 8192);
const canUseSuggestion = computed(() => props.enabled && !props.busy &&
  props.suggestedBody.trim().length > 0 && props.suggestedBody.length <= 8192);
const statusLabels: Record<ActionView['status'], string> = {
  pending: '승인 대기', running: '실행 중', succeeded: '노트 생성 완료',
  failed: '실행 실패', unknown: '결과 확인 필요', dismissed: '제안 닫힘',
};

onMounted(() => { clock = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (clock !== undefined) clearInterval(clock); });

function reviewKey(action: ActionView): string {
  // Bind acknowledgement to everything visible, even if a host snapshot changes
  // content without changing its declared revision. The host still verifies the digest.
  return JSON.stringify([action.draftId, action.revision, action.payloadSha256,
    action.target, action.title, action.body, action.expiresAt]);
}
watch(() => props.actions.map((action) => ({ id: action.draftId, key: reviewKey(action), status: action.status })), (actions) => {
  for (const [id, key] of reviewed.value) {
    if (!actions.some((action) => action.id === id && action.key === key && action.status === 'pending')) reviewed.value.delete(id);
  }
  for (const id of openReviews.value) if (!actions.some((action) => action.id === id)) openReviews.value.delete(id);
});
function expired(action: ActionView): boolean {
  return !Number.isFinite(action.expiresAt) || action.expiresAt <= now.value;
}
function canApprove(action: ActionView): boolean {
  return panelOpen.value && props.enabled && !props.busy && action.status === 'pending' && !expired(action) &&
    openReviews.value.has(action.draftId) && reviewed.value.get(action.draftId) === reviewKey(action);
}
function togglePanel(event: Event): void {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  panelOpen.value = event.target.open;
  if (!panelOpen.value) reviewed.value.clear();
}
function toggleReview(action: ActionView, event: Event): void {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  if (event.target.open) openReviews.value.add(action.draftId);
  else { openReviews.value.delete(action.draftId); reviewed.value.delete(action.draftId); }
}
function acknowledge(action: ActionView, event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (event.target.checked && panelOpen.value && props.enabled && !props.busy && action.status === 'pending' &&
      !expired(action) && openReviews.value.has(action.draftId)) reviewed.value.set(action.draftId, reviewKey(action));
  else reviewed.value.delete(action.draftId);
}
function approve(action: ActionView): void {
  // Refresh time at the click boundary; background throttling must not extend approval.
  now.value = Date.now();
  if (!canApprove(action)) return;
  reviewed.value.delete(action.draftId);
  emit('approve', { draftId: action.draftId, revision: action.revision, payloadSha256: action.payloadSha256 });
}
function dismiss(action: ActionView): void {
  if (props.enabled && !props.busy && action.status === 'pending') {
    reviewed.value.delete(action.draftId);
    emit('dismiss', action.draftId);
  }
}
function create(): void {
  if (canCreate.value) emit('create', { title: title.value.trim(), body: body.value });
}
function useSuggestion(): void {
  if (canUseSuggestion.value) body.value = props.suggestedBody;
}
function dateLabel(value: number): string {
  if (!Number.isFinite(value)) return '확인할 수 없음';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '확인할 수 없음';
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
</script>

<template>
  <details class="actions-panel" data-testid="actions-panel" @toggle="togglePanel">
    <summary data-testid="actions-toggle"><span>승인한 작업</span><span class="summary-hint">{{ pendingCount ? `${pendingCount}개 확인 대기` : '내용을 확인한 뒤 실행' }}</span></summary>
    <div class="panel-content" :aria-busy="busy">
      <p v-if="!enabled" class="notice" role="status">지금은 작업을 준비하거나 승인할 수 없어요. 기록은 아래에서 확인할 수 있어요.</p>
      <p v-if="actions.length === 0" class="empty-state" data-testid="actions-empty">아직 준비된 작업이 없어요. 노트 초안을 만들면 저장할 내용을 확인하고 승인할 수 있어요.</p>

      <div class="action-list" data-testid="actions-list">
        <article v-for="action in actions" :key="action.draftId" class="action-card" :data-draft-id="action.draftId" data-testid="action-card">
          <div class="action-heading">
            <h3>{{ action.title }}</h3>
            <span class="action-status" :class="`status-${action.status}`" role="status" data-testid="action-status">{{ action.status === 'pending' && expired(action) ? '승인 시간 만료' : statusLabels[action.status] }}</span>
          </div>
          <p v-if="action.status === 'running'" class="hint">승인한 내용으로 실행하고 있어요.</p>
          <p v-else-if="action.status === 'unknown'" class="notice" data-testid="action-unknown">실행 결과를 확인할 수 없어요. 같은 작업을 중복 실행하지 않도록 다시 실행하지 않아요. 저장 위치에서 결과를 확인해 주세요.</p>
          <p v-else-if="action.status === 'failed'" class="notice" data-testid="action-failed">작업을 완료하지 못했어요. 이 작업은 다시 실행하지 않아요.</p>
          <p v-else-if="action.status === 'succeeded'" class="success-copy">승인한 내용으로 노트를 만들었어요.</p>
          <details class="action-review" data-testid="action-review" @toggle="toggleReview(action, $event)">
            <summary data-testid="action-review-toggle">{{ action.status === 'pending' ? '저장할 내용 확인' : '작업 내용 보기' }}</summary>
            <dl class="review-fields">
              <div><dt>저장 위치</dt><dd class="review-target" data-testid="action-target">{{ action.target }}</dd></div>
              <div><dt>제목</dt><dd class="review-title" data-testid="action-title">{{ action.title }}</dd></div>
              <div><dt>내용</dt><dd class="review-body" data-testid="action-body">{{ action.body }}</dd></div>
            </dl>
            <template v-if="action.status === 'pending'">
              <p class="hint">{{ expired(action) ? '승인 가능한 시간이 지났어요. 이 제안은 실행할 수 없어요.' : `${dateLabel(action.expiresAt)}까지 승인할 수 있어요.` }}</p>
              <label class="review-check">
                <input type="checkbox" data-testid="action-reviewed" :checked="reviewed.get(action.draftId) === reviewKey(action)" :disabled="!enabled || busy || expired(action)" @change="acknowledge(action, $event)" />
                <span>저장 위치와 제목, 내용을 확인했어요.</span>
              </label>
              <div class="action-buttons">
                <button type="button" class="quiet-button" data-testid="action-dismiss" :disabled="!enabled || busy" @click="dismiss(action)">제안 닫기</button>
                <button type="button" class="approve-button" data-testid="action-approve" :disabled="!canApprove(action)" @click="approve(action)">이 내용으로 노트 생성 승인</button>
              </div>
            </template>
            <p v-if="action.receipt" class="receipt" data-testid="action-receipt">결과 기록 · {{ dateLabel(action.receipt.recordedAt) }}</p>
          </details>
        </article>
      </div>

      <details class="draft-section" data-testid="action-draft-section">
        <summary data-testid="action-draft-toggle">노트 작업 준비</summary>
        <form class="draft-form" @submit.prevent="create">
          <p class="hint">먼저 초안을 준비해요. 생성된 제안의 내용을 확인하고 승인하면 노트를 만들어요.</p>
          <label for="action-draft-title">제목</label>
          <input id="action-draft-title" v-model="title" data-testid="action-draft-title" maxlength="120" required :disabled="!enabled || busy" placeholder="저장할 노트의 제목" />
          <div class="body-heading"><label for="action-draft-body">내용</label><button v-if="suggestedBody.trim()" type="button" class="quiet-button" data-testid="action-use-suggestion" :disabled="!canUseSuggestion" @click="useSuggestion">최근 답변 가져오기</button></div>
          <textarea id="action-draft-body" v-model="body" data-testid="action-draft-body" rows="5" maxlength="8192" required :disabled="!enabled || busy" placeholder="노트에 담을 내용을 적어 주세요." />
          <p v-if="suggestedBody.length > 8192" class="hint">최근 답변이 너무 길어요. 필요한 부분을 직접 넣어 주세요.</p>
          <div class="draft-footer"><span class="hint">{{ body.length.toLocaleString() }} / 8,192자</span><button type="submit" data-testid="action-create" :disabled="!canCreate">승인할 초안 준비</button></div>
        </form>
      </details>
    </div>
  </details>
</template>

<style scoped>
.actions-panel { min-width: 0; flex: none; border-top: 1px solid var(--line); color: #e1dce9; font-size: 12px; }
summary { cursor: pointer; -webkit-app-region: no-drag; }
.actions-panel > summary { padding: 11px 2px; font-weight: 600; }
.summary-hint { margin-left: 10px; color: var(--quiet); font-size: 10px; font-weight: 400; }
.panel-content { display: grid; gap: 12px; max-height: min(440px, 50dvh); overflow: auto; padding: 3px 3px 14px; scrollbar-width: thin; scrollbar-color: #544b64 transparent; }
h3, p { margin: 0; }
.hint, .notice, .empty-state, .success-copy { font-size: 11px; line-height: 1.7; color: var(--muted); }
.notice, .empty-state { padding: 10px; border-radius: 8px; background: #ffffff04; }
.notice { color: #d7b6c3; }
.success-copy { color: #acceb9; }
.action-list { display: grid; gap: 8px; min-width: 0; }
.action-card { display: grid; gap: 8px; min-width: 0; padding: 11px; border: 1px solid #ffffff0d; border-radius: 10px; background: #ffffff03; }
.action-heading, .action-buttons, .body-heading, .draft-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.action-heading { align-items: flex-start; }
h3 { min-width: 0; font-size: 12px; font-weight: 500; line-height: 1.55; overflow-wrap: anywhere; }
.action-status { flex: none; padding: 3px 6px; border-radius: 5px; background: #c0aaf60d; color: #c9b6ea; font-size: 10px; }
.status-succeeded { color: #acceb9; background: #82b99d0d; }
.status-failed, .status-unknown { color: #dfb4c1; background: #c787990d; }
.status-dismissed { color: var(--quiet); background: #ffffff05; }
.action-review { min-width: 0; border-top: 1px solid var(--line); padding-top: 8px; }
.action-review summary, .draft-section > summary { color: #c6b5df; font-size: 11px; }
.review-fields { display: grid; gap: 10px; margin: 12px 0; }
dt { margin-bottom: 4px; color: var(--quiet); font-size: 10px; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.review-target { color: #c0b3d0; font-size: 11px; }
.review-body { padding: 10px; border: 1px solid #ffffff0b; border-radius: 7px; background: #111119; font-size: 12px; }
.review-check { display: flex; align-items: flex-start; gap: 8px; margin: 11px 0; font-size: 11px; line-height: 1.6; cursor: pointer; }
input[type=checkbox] { flex: none; width: 15px; height: 15px; margin: 1px 0 0; accent-color: var(--accent); }
button, input, textarea { font: inherit; -webkit-app-region: no-drag; }
button { padding: 7px 9px; border: 1px solid #c0aaf625; border-radius: 7px; background: #c0aaf60d; color: #d9c8f5; font-size: 11px; line-height: 1.5; }
button:hover:not(:disabled) { background: #c0aaf622; }
button:disabled, input:disabled, textarea:disabled { opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.approve-button { background: #c0aaf622; }
.receipt { margin-top: 10px; color: var(--quiet); font-size: 10px; }
.draft-section { padding: 11px; border: 1px solid #c0aaf616; border-radius: 9px; }
.draft-form { display: grid; gap: 7px; margin-top: 10px; }
.draft-form label { margin-top: 3px; color: var(--muted); font-size: 11px; }
input:not([type=checkbox]), textarea { width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid #ffffff12; border-radius: 7px; background: #15151e; color: #e6e0ed; }
textarea { resize: vertical; min-height: 90px; line-height: 1.65; }
input::placeholder, textarea::placeholder { color: var(--quiet); }
.body-heading button { padding: 3px 6px; font-size: 10px; }
.action-buttons { flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 420px) { .summary-hint { display: none; } .action-heading { flex-wrap: wrap; } .action-buttons .approve-button { width: 100%; } }
</style>
