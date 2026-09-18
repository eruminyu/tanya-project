<script setup lang="ts">
// The consent step of the demo: the exact draft the companion prepared, the visitor's approve/reject, and the
// receipt afterwards (a hand-off to the visitor's own calendar, or a created event with its read-back).
import { computed, onUnmounted, ref, watch } from 'vue';
import type { DemoToolsState, EventTime } from './demo-client.js';

const props = defineProps<{ tools: DemoToolsState; busy: boolean; now?: number; executorKind?: string; /** Receipts start folded (phones: they would cover the transcript). */ compact?: boolean }>();
// The receipt folds to one line per execution; the visitor opens it when they want the details or links.
const openedReceipt = ref<string | null>(null);
const receiptOpen = computed(() => !props.compact || openedReceipt.value === props.tools.receipt?.executionId);
function toggleReceipt(): void {
  const id = props.tools.receipt?.executionId ?? null;
  openedReceipt.value = openedReceipt.value === id ? null : id;
}
const emit = defineEmits<{ approve: [draftId: string]; reject: [draftId: string] }>();

const clock = ref(Date.now());
const timer = setInterval(() => { clock.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));

const draft = computed(() => props.tools.draft);
const receipt = computed(() => props.tools.receipt);
const secondsLeft = computed(() => draft.value ? Math.max(0, Math.ceil((draft.value.expiresAt - clock.value) / 1000)) : 0);
const icsUrl = ref<string | null>(null);
watch(() => receipt.value?.handoff?.icsText, text => {
  if (icsUrl.value) { URL.revokeObjectURL(icsUrl.value); icsUrl.value = null; }
  if (text) icsUrl.value = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
}, { immediate: true });
onUnmounted(() => { if (icsUrl.value) URL.revokeObjectURL(icsUrl.value); });

function formatTime(time: EventTime, timeZone: string): string {
  try {
    if ('date' in time) return new Intl.DateTimeFormat('ko-KR', { timeZone, dateStyle: 'full' }).format(new Date(time.date + 'T00:00:00')) + ' (하루 종일)';
    return new Intl.DateTimeFormat('ko-KR', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(time.dateTime));
  } catch { return 'date' in time ? time.date : time.dateTime; }
}
function formatRange(start: EventTime, end: EventTime, timeZone: string): string {
  const from = formatTime(start, timeZone);
  if ('date' in start) return from;
  const sameDay = new Intl.DateTimeFormat('ko-KR', { timeZone, dateStyle: 'short' }).format(new Date(start.dateTime))
    === new Intl.DateTimeFormat('ko-KR', { timeZone, dateStyle: 'short' }).format(new Date(('dateTime' in end ? end.dateTime : end.date) as string));
  const to = sameDay ? new Intl.DateTimeFormat('ko-KR', { timeZone, timeStyle: 'short' }).format(new Date(('dateTime' in end ? end.dateTime : end.date) as string)) : formatTime(end, timeZone);
  return `${from} ~ ${to}`;
}
const errorText = computed(() => {
  switch (props.tools.errorCode) {
    case 'external_proposal_expired': return '승인 대기 시간이 지나 초안을 닫았어요. 다시 부탁하면 새 초안을 만들어요.';
    case 'external_proposal_invalid': return '만들어진 초안의 형식이 맞지 않아 보여드리지 않았어요. 날짜와 시간을 조금 더 구체적으로 말해 주세요.';
    case 'external_context_unavailable': return '이번 턴에는 일정 도구를 준비하지 못했어요.';
    case null: case undefined: return '';
    default: return '일정 초안을 처리하지 못했어요.';
  }
});
</script>

<template>
  <section v-if="draft && tools.phase === 'awaiting_approval'" class="calendar-card is-draft" data-testid="calendar-draft" aria-live="polite">
    <p class="calendar-card-eyebrow">일정 초안 · 승인 전에는 아무것도 실행되지 않아요</p>
    <h3 class="calendar-card-title">{{ draft.event.summary }}</h3>
    <dl class="calendar-card-fields">
      <dt>일시</dt><dd>{{ formatRange(draft.event.start, draft.event.end, draft.timeZone) }}</dd>
      <dt>캘린더</dt><dd>{{ draft.calendarLabel }} · {{ draft.timeZone }}</dd>
      <template v-if="draft.event.location"><dt>장소</dt><dd>{{ draft.event.location }}</dd></template>
      <template v-if="draft.event.description"><dt>메모</dt><dd>{{ draft.event.description }}</dd></template>
    </dl>
    <div class="calendar-card-actions">
      <button type="button" class="web-button is-primary" :disabled="busy" data-testid="calendar-approve" @click="emit('approve', draft.draftId)">{{ props.executorKind === 'google_demo' ? '승인하고 데모 캘린더에 만들기' : '승인하고 내 캘린더에 담기' }}</button>
      <button type="button" class="web-button" :disabled="busy" data-testid="calendar-reject" @click="emit('reject', draft.draftId)">취소</button>
      <span class="calendar-card-timer">{{ secondsLeft }}초 안에 결정해 주세요</span>
    </div>
  </section>
  <section v-else-if="tools.phase === 'running'" class="calendar-card" role="status">
    <p class="calendar-card-eyebrow">승인한 내용 그대로 준비하고 있어요…</p>
  </section>
  <section v-else-if="receipt && (tools.phase === 'summarizing' || tools.phase === 'finished' || tools.phase === 'ready')" class="calendar-card" :class="[receipt.status === 'succeeded' ? 'is-receipt' : 'is-failed', { 'is-folded': !receiptOpen }]" data-testid="calendar-receipt">
    <button v-if="compact" type="button" class="calendar-card-fold" :aria-expanded="receiptOpen" data-testid="calendar-receipt-toggle" @click="toggleReceipt">
      <span class="calendar-card-eyebrow">{{ receipt.status === 'succeeded' ? (receipt.created ? '영수증 · 데모 캘린더에 실제로 만들었어요' : '영수증 · 내 캘린더에 담을 수 있어요') : '실행하지 못했어요' }}</span>
      <span class="calendar-card-chevron" aria-hidden="true">{{ receiptOpen ? '▴' : '▾' }}</span>
    </button>
    <template v-if="!receiptOpen" />
    <template v-else-if="receipt.status === 'succeeded' && receipt.handoff">
      <p v-if="!compact" class="calendar-card-eyebrow">영수증 · 승인한 초안을 내 캘린더에 담을 수 있어요</p>
      <div class="calendar-card-actions">
        <a class="web-button is-primary" :href="receipt.handoff.googleCalendarUrl" target="_blank" rel="noopener noreferrer" data-testid="calendar-google-link">Google 캘린더에서 저장</a>
        <a v-if="icsUrl" class="web-button" :href="icsUrl" :download="receipt.handoff.icsFileName" data-testid="calendar-ics-link">.ics 받기 (Apple·Outlook)</a>
      </div>
      <p class="calendar-card-meta">실행 {{ receipt.executionId.slice(0, 8) }} · {{ new Date(receipt.recordedAt).toLocaleTimeString('ko-KR') }} · 서버는 아무것도 쓰지 않았고 저장은 내 계정에서 직접 해요.</p>
    </template>
    <template v-else-if="receipt.status === 'succeeded' && receipt.created">
      <p v-if="!compact" class="calendar-card-eyebrow">영수증 · 데모 캘린더에 실제로 만들었어요</p>
      <p class="calendar-card-meta">일정 ID {{ receipt.created.eventId }} · 재조회 {{ receipt.created.readBack ? '확인됨' : '미확인' }}</p>
      <div v-if="receipt.created.htmlLink" class="calendar-card-actions">
        <a class="web-button is-primary" :href="receipt.created.htmlLink" target="_blank" rel="noopener noreferrer">Google 캘린더에서 보기</a>
      </div>
    </template>
    <template v-else>
      <p class="calendar-card-eyebrow" :class="{ 'is-detail': compact }">실행하지 못했어요 · {{ receipt.errorCode ?? 'execution_failed' }}</p>
    </template>
  </section>
  <p v-else-if="errorText" class="web-status" role="status" data-testid="calendar-error">{{ errorText }}</p>
</template>
