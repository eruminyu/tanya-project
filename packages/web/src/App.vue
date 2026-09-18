<script setup lang="ts">
// Public demo shell: the desktop's presence (Live2D) and chat panels driven by the gateway client.
// A visitor gets text turns, spoken answers, the character and a reviewer guide; no settings, no memory.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import PresencePanel from '../../desktop/src/renderer/components/PresencePanel.vue';
import { josa, profile } from './profile';
import ChatPanel from '../../desktop/src/renderer/components/ChatPanel.vue';
import { SpeechPlayer } from '../../desktop/src/renderer/audio/speech-player.js';
import type { CommandResult } from '../../desktop/src/shared/bridge.js';
import { DemoClient, type ClientState } from './demo-client.js';
import CalendarCard from './CalendarCard.vue';
import DemoCalendarPanel from './DemoCalendarPanel.vue';
import SuggestionCard from './SuggestionCard.vue';
import type { ProactiveCard } from './demo-client.js';

const client = new DemoClient();
const state = ref<ClientState>(client.getState());
const draft = ref('');
const submitting = ref(false);
const cancelPending = ref(false);
const notice = ref('');
const mouthOpen = ref(0), speaking = ref(false);
const cancelledOnce = ref(false);
const draftSeen = ref(false), receiptSeen = ref(false), suggestionSeen = ref(false);
const toolPending = ref(false);
const calendarRefresh = ref(0);
let disposed = false;
let unsubscribe: (() => void) | undefined, unsubscribeAudio: (() => void) | undefined;
const player = new SpeechPlayer(client, (level, active) => { mouthOpen.value = level; speaking.value = active; },
  () => { notice.value = '음성을 재생하지 못했어요. 대화 내용은 화면에서 확인할 수 있어요.'; });

const snapshot = computed(() => state.value.snapshot);
const messages = computed(() => snapshot.value?.session.messages ?? []);
// Any answer that ended as cancelled counts as an interruption, whether by the cancel button or by sending the next message mid-answer.
const interrupted = computed(() => messages.value.some(row => row.role === 'assistant' && row.status === 'cancelled'));
const connected = computed(() => state.value.phase === 'ready' && snapshot.value?.brain.phase === 'ready');
const activeTurn = computed(() => Boolean(snapshot.value?.session.activeTurnId));
const voiceEnabled = computed(() => Boolean(snapshot.value?.brain.speech.enabled));
const voiceAvailable = computed(() => Boolean(snapshot.value?.brain.speech.available));
const turnsLeft = computed(() => snapshot.value ? Math.max(0, snapshot.value.demo.turnsLimit - snapshot.value.demo.turnsUsed) : null);
const canSend = computed(() => connected.value && !submitting.value && (turnsLeft.value ?? 0) > 0);
const modelLabel = computed(() => snapshot.value?.session.actualModel?.modelId ?? state.value.info?.modelLabel ?? '아직 처리된 응답이 없어요');
const modelDetail = computed(() => snapshot.value?.session.actualModel ? '서버에서 처리 · 저장하지 않음' : '');

/** Reviewer guide: what to try, in order. Chips only fill the composer; nothing is sent automatically. */
const calendarAvailable = computed(() => Boolean(snapshot.value?.tools.available));
const guideSteps = computed(() => {
  const used = snapshot.value?.demo.turnsUsed ?? 0;
  return [
    { id: 'greet', title: '인사해 보기', example: '안녕, 너는 누구야? 두 문장으로 소개해 줘.', done: used >= 1 },
    { id: 'calendar', title: '일정 부탁하기', example: '내일 오후 3시에 운동 일정 추가해 줘.', done: draftSeen.value, soon: !calendarAvailable.value },
    { id: 'approve', title: state.value.info?.calendar?.kind === 'google_demo' ? '내용 확인 후 승인 → 데모 캘린더에 실제 생성' : '내용 확인 후 승인 → 내 캘린더에 담기', example: '', done: receiptSeen.value, soon: !calendarAvailable.value },
    { id: 'cancel', title: '답변 중 끼어들기', example: '산책이 좋은 이유를 다섯 문장으로 말해 줘.', done: cancelledOnce.value || interrupted.value,
      hint: '답변이 나오는 동안 "답변 중단"을 누르거나 다른 말을 보내 보세요.' },
    { id: 'proactive', title: '먼저 말 걸어오기', example: '10분 뒤에 스트레칭 일정 추가해 줘.', done: suggestionSeen.value, soon: !calendarAvailable.value,
      hint: `곧 시작하는 일정을 승인하면 ${josa(profile.brandName, '이', '가')} 먼저 제안 카드를 띄워요 (내일 일정은 시작 30분 전에).` },
  ];
});
const currentStep = computed(() => guideSteps.value.find(step => !step.done && !step.soon)?.id ?? null);
/** Completion: every step done once → one congratulation with the choice to wipe this session now or keep talking. */
const allDone = computed(() => guideSteps.value.every(step => step.done));
const completionShown = ref(false), completionOpen = ref(false), finishing = ref(false);
const createdEvents = ref(0);
const seenExecutions = new Set<string>();
watch(allDone, done => { if (done && !completionShown.value) { completionShown.value = true; completionOpen.value = true; } });
async function finishDemo(): Promise<void> {
  if (finishing.value || !connected.value) return;
  finishing.value = true;
  notice.value = '';
  try {
    const result = await client.finish();
    if (!disposed && !result.ok) notice.value = commandError(result);
  } finally { if (!disposed) { finishing.value = false; completionOpen.value = false; } }
}
function useExample(text: string): void {
  if (!text) return;
  draft.value = text;
  document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
}

const caption = computed(() => {
  const speech = snapshot.value?.brain.speech;
  if (speech?.phase === 'error') return '음성을 재생하지 못했어요.';
  if (speaking.value && speech?.sentence) return speech.sentence;
  if (speaking.value) return `${josa(profile.brandName, '이', '가')} 말하고 있어요.`;
  return voiceEnabled.value ? `${josa(profile.brandName, '과', '와')} 이야기를 나눠 보세요.` : '음성 답변이 꺼져 있어요.';
});

const connectionLabel = computed(() => {
  switch (state.value.phase) {
    case 'requesting': return '입장 확인 중';
    case 'connecting': return '연결 중';
    case 'ready': return connected.value ? '연결됨' : '연결 중';
    case 'closed': return '연결 끊김';
    default: return '준비 중';
  }
});

const closedReason = computed(() => {
  if (state.value.phase !== 'closed') return '';
  const retry = state.value.retryAfterSeconds ? ` 약 ${Math.ceil(state.value.retryAfterSeconds / 60)}분 뒤에 다시 시도해 주세요.` : '';
  switch (state.value.reason) {
    case 'finished': return `체험을 마쳤어요. 대화 기록과 이 세션에서 만든 데모 일정 ${state.value.deletedEvents ?? 0}개를 지금 지웠어요. 다시 시작할 수 있어요.`;
    case 'idle': return '한동안 대화가 없어 세션을 정리했어요. 다시 시작할 수 있어요.';
    case 'session_expired': return '이번 세션의 시간이 끝났어요. 다시 시작할 수 있어요.';
    case 'client_rate': return '이 네트워크에서 열 수 있는 세션 수를 모두 사용했어요.' + retry;
    case 'client_concurrency': return '이미 열려 있는 데모 창이 있어요. 다른 창을 닫고 다시 시도해 주세요.';
    case 'total_concurrency': return '지금은 방문자가 많아요.' + (retry || ' 잠시 뒤에 다시 시도해 주세요.');
    case 'brain_unavailable': return '지금은 모델 서비스가 준비되지 않았어요. 잠시 뒤에 다시 시도해 주세요.';
    case 'network_error': return '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    case 'gateway_stopping': return '서비스가 잠시 재시작 중이에요. 곧 다시 시도해 주세요.';
    default: return '연결이 끊어졌어요. 다시 시작할 수 있어요.';
  }
});

const connectionDescription = computed(() => {
  if (state.value.phase === 'requesting' || state.value.phase === 'connecting') return `${profile.brandName}에게 연결하고 있어요. 잠시 기다려 주세요.`;
  if (state.value.phase === 'closed') return closedReason.value;
  if (!connected.value) return '연결을 준비하고 있어요.';
  if (snapshot.value?.demo.busy) return '지금은 다른 방문자가 대화 중이에요. 잠시 뒤에 다시 보내 주세요.';
  if ((turnsLeft.value ?? 0) <= 0) return '이번 세션의 대화 횟수를 모두 사용했어요. 다시 시작하면 새 세션이 열려요.';
  if (activeTurn.value) return `${josa(profile.brandName, '이', '가')} 답변하고 있어요. 잠시 기다려 주세요.`;
  return `메시지를 보내 대화를 시작해 보세요. 남은 대화 ${turnsLeft.value}회.`;
});

function commandError(result: CommandResult): string {
  if (result.ok) return '';
  switch (result.code) {
    case 'busy': return snapshot.value?.demo.busy ? '지금은 다른 방문자가 대화 중이에요. 잠시 뒤에 다시 보내 주세요.' : '진행 중인 요청이 있어요. 잠시 후 다시 시도해 주세요.';
    case 'routing_limit': return '이번 세션의 대화 횟수를 모두 사용했어요.';
    case 'invalid_request': return `메시지는 ${snapshot.value?.demo.messageCharacters ?? 500}자 이내로 보내 주세요.`;
    case 'brain_unavailable': return '연결이 끊어졌어요. 다시 시작해 주세요.';
    default: return '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

async function start(): Promise<void> {
  notice.value = '';
  draft.value = '';
  createdEvents.value = 0;
  seenExecutions.clear();
  completionOpen.value = false;
  player.reset();
  await client.connect();
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!canSend.value || submitting.value || !text) return;
  submitting.value = true;
  notice.value = '';
  try {
    // Audio must be unlocked inside the user gesture that sends the message.
    if (voiceEnabled.value) await player.unlock().catch(() => {});
    if (activeTurn.value) {
      const cancelled = await client.cancelTurn();
      if (!cancelled.ok) { notice.value = commandError(cancelled); return; }
    }
    const result = await client.sendText(text);
    if (disposed) return;
    notice.value = commandError(result);
    if (result.ok) draft.value = '';
  } finally {
    if (!disposed) submitting.value = false;
  }
}

async function cancelTurn(): Promise<void> {
  if (!activeTurn.value || cancelPending.value) return;
  cancelPending.value = true;
  try {
    const result = await client.cancelTurn();
    // invalid_request here means the answer had already finished; nothing to report.
    if (!disposed) { notice.value = !result.ok && result.code === 'invalid_request' ? '' : commandError(result); if (result.ok) cancelledOnce.value = true; }
  } finally { if (!disposed) cancelPending.value = false; }
}

async function toggleVoice(): Promise<void> {
  if (!connected.value || !voiceAvailable.value || activeTurn.value) return;
  notice.value = '';
  const enabled = !voiceEnabled.value;
  if (enabled) await player.unlock().catch(() => {});
  const result = await client.setVoiceEnabled(enabled);
  if (!result.ok) notice.value = commandError(result);
}

async function approveDraft(draftId: string): Promise<void> {
  if (toolPending.value) return;
  toolPending.value = true;
  notice.value = '';
  try {
    const result = await client.approveDraft(draftId);
    if (!disposed && !result.ok) notice.value = result.code === 'source_changed' ? '승인 대기 시간이 지났어요. 다시 부탁해 주세요.' : commandError(result);
  } finally { if (!disposed) toolPending.value = false; }
}
async function askSuggestion(card: ProactiveCard): Promise<void> {
  if (!canSend.value || submitting.value) return;
  // Plain conversation, not another calendar request: the persona's "call the tool at once" rule must not fire.
  const topic = card.quote.replace(/^\[데모\]\s*/, '');
  draft.value = `곧 "${topic}"을(를) 시작하려고 해. 준비하면 좋은 것과 주의할 점을 두세 문장으로 알려 줘.`;
  await sendMessage();
  if (!disposed) await client.dismissSuggestion(card.id);
}
async function dismissSuggestion(cardId: string): Promise<void> {
  const result = await client.dismissSuggestion(cardId);
  if (!disposed && !result.ok) notice.value = commandError(result);
}
async function rejectDraft(draftId: string): Promise<void> {
  if (toolPending.value) return;
  toolPending.value = true;
  try {
    const result = await client.rejectDraft(draftId);
    if (!disposed && !result.ok) notice.value = commandError(result);
  } finally { if (!disposed) toolPending.value = false; }
}

/** Phones: the bar, notice and guide hide as soon as the page scrolls in either direction, so reading the transcript
 * is undisturbed; they come back when the page reaches the very top (or on a pull at scroll 0, for browsers that
 * stop scroll events while over-scrolling). Desktop layouts never hide them. */
const topElement = ref<HTMLElement | null>(null);
const topHidden = ref(false), topHeight = ref(0);
let touchStartY: number | null = null, topObserver: ResizeObserver | undefined;
const phone = () => window.innerWidth <= 600;
const phoneLayout = ref(false);
function onResize(): void { phoneLayout.value = phone(); }
function onScroll(): void {
  if (!phone()) { topHidden.value = false; return; }
  const y = window.scrollY;
  // Reaching the very top brings the hints back; anything below a small margin hides them.
  if (y <= 0) topHidden.value = false;
  else if (y > 24) topHidden.value = true;
}
function onWheel(event: WheelEvent): void {
  if (phone() && topHidden.value && window.scrollY <= 0 && event.deltaY < 0) topHidden.value = false;
}
function onTouchStart(event: TouchEvent): void { touchStartY = event.touches[0]?.clientY ?? null; }
function onTouchMove(event: TouchEvent): void {
  if (!phone() || !topHidden.value || touchStartY === null || window.scrollY > 0) return;
  const y = event.touches[0]?.clientY;
  if (y !== undefined && y - touchStartY > 40) { topHidden.value = false; touchStartY = null; }
}

onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  if (topElement.value && typeof ResizeObserver !== 'undefined') {
    topObserver = new ResizeObserver(entries => { topHeight.value = Math.round((entries[0]?.target as HTMLElement | undefined)?.getBoundingClientRect().height ?? 0); });
    topObserver.observe(topElement.value);
  }
  unsubscribe = client.subscribe(value => {
    state.value = value;
    const tools = value.snapshot?.tools;
    if (tools?.phase === 'awaiting_approval') draftSeen.value = true;
    if (tools?.receipt?.status === 'succeeded') {
      if (!receiptSeen.value || tools.phase === 'finished') calendarRefresh.value += 1;
      if (tools.receipt.created && !seenExecutions.has(tools.receipt.executionId)) { seenExecutions.add(tools.receipt.executionId); createdEvents.value += 1; }
      receiptSeen.value = true;
    }
    if (value.snapshot?.proactive.cards.length) suggestionSeen.value = true;
  });
  unsubscribeAudio = client.onAudio(event => player.accept(event));
  void start();
});

onUnmounted(() => {
  disposed = true;
  window.removeEventListener('resize', onResize);
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('wheel', onWheel);
  window.removeEventListener('touchstart', onTouchStart);
  window.removeEventListener('touchmove', onTouchMove);
  topObserver?.disconnect();
  unsubscribe?.();
  unsubscribeAudio?.();
  client.disconnect(null);
  void player.dispose();
});
</script>

<template>
  <div class="web-shell" :class="{ 'is-top-hidden': topHidden }" :style="{ '--web-top-height': topHeight + 'px' }" data-testid="web-shell">
    <div ref="topElement" class="web-top" :class="{ 'is-hidden': topHidden }">
    <header class="web-bar">
      <div class="web-brand">
        <span class="brand-mark" aria-hidden="true" />
        <span class="brand-name">{{ profile.brandName }}</span>
        <span class="web-caption">공개 데모</span>
      </div>
      <div class="web-actions">
        <button v-if="voiceAvailable" type="button" class="web-button" :class="{ 'is-on': voiceEnabled }" :disabled="!connected || activeTurn"
          :aria-pressed="voiceEnabled" data-testid="voice-toggle" @click="toggleVoice">
          {{ voiceEnabled ? '음성 답변 켜짐' : '음성 답변 꺼짐' }}
        </button>
        <button v-if="connected" type="button" class="web-button" :disabled="finishing" data-testid="finish" title="대화 기록과 이 세션의 데모 일정을 지금 지우고 끝내요" @click="finishDemo">체험 끝내기</button>
        <button v-if="state.phase === 'closed'" type="button" class="web-button is-primary" data-testid="restart" @click="start">다시 시작</button>
      </div>
    </header>
    <p class="web-notice" role="note">
      대화는 세션이 끝나면 지워지고 개인정보는 입력하지 마세요.
      <template v-if="state.info?.calendar?.kind === 'google_demo'">승인한 일정은 누구나 볼 수 있는 데모 캘린더에 잠시 만들어졌다가 자동 삭제돼요.</template>
      <template v-else>일정은 승인 뒤 내 캘린더에 직접 담아요.</template>
      <template v-if="state.info"> 답변 모델: {{ state.info.modelLabel }}<template v-if="state.info.speechLabel"> · 목소리: {{ state.info.speechLabel }}</template>.</template>
      <a class="web-notice-link" href="notices.html" data-testid="notices-link">고지 및 이용 조건</a>
    </p>
    <nav class="web-guide" aria-label="체험 안내" data-testid="web-guide">
      <ol class="web-guide-steps">
        <li v-for="(step, index) in guideSteps" :key="step.id" class="web-guide-step"
          :class="{ 'is-done': step.done, 'is-current': step.id === currentStep, 'is-soon': step.soon }">
          <span class="web-guide-index" aria-hidden="true">{{ step.done ? '✓' : index + 1 }}</span>
          <span class="web-guide-title">{{ step.title }}<span v-if="step.soon" class="web-guide-soon">준비 중</span></span>
          <button v-if="step.example && !step.soon" type="button" class="web-chip" :disabled="!connected" :title="step.hint ?? '예시를 입력창에 채워요'"
            @click="useExample(step.example)">{{ step.example }}</button>
          <span v-if="step.hint && !step.soon" class="web-guide-hint">{{ step.hint }}</span>
        </li>
      </ol>
    </nav>
    </div>
    <main class="workspace web-workspace">
      <PresencePanel :mouth-open="mouthOpen" :speaking="speaking" :emotion="speaking ? 'happy' : 'neutral'" :audio-status="caption"
        :manifest="profile.manifest" :character-name="profile.brandName" />
      <ChatPanel
        v-model="draft"
        :messages="messages"
        :can-send="canSend"
        :submitting="submitting"
        :connection-label="connectionLabel"
        :connection-description="connectionDescription"
        :connected="connected"
        :model-label="modelLabel"
        :model-detail="modelDetail"
        :active-turn="activeTurn"
        :cancel-pending="cancelPending"
        :can-cancel="connected"
        :companion-name="profile.brandName"
        @submit="sendMessage"
        @cancel="cancelTurn"
      >
        <template #tools-status>
          <div class="web-tools">
          <SuggestionCard v-if="connected && snapshot?.proactive.cards.length" :cards="snapshot.proactive.cards" :busy="submitting || activeTurn" :companion-name="profile.brandName" @ask="askSuggestion" @dismiss="dismissSuggestion" />
          <CalendarCard v-if="connected && snapshot?.tools.available" :tools="snapshot.tools" :busy="toolPending" :executor-kind="state.info?.calendar?.kind" :compact="phoneLayout" @approve="approveDraft" @reject="rejectDraft" />
          <DemoCalendarPanel v-if="state.info?.calendar?.kind === 'google_demo'" :client="client" :refresh="calendarRefresh" />
          <p v-if="notice" role="status" class="web-status" data-testid="web-notice">{{ notice }}</p>
          </div>
        </template>
      </ChatPanel>
    </main>
    <div v-if="completionOpen" class="web-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="completion-title" data-testid="completion">
      <section class="web-modal">
        <p class="calendar-card-eyebrow">체험 완료</p>
        <h2 id="completion-title" class="web-modal-title">다섯 가지를 모두 해 보셨어요 🎉</h2>
        <p class="web-modal-text">
          대화 {{ snapshot?.demo.turnsUsed ?? 0 }}회, 데모 캘린더에 만든 일정 {{ createdEvents }}개.
          지금 끝내면 대화 기록과 이 세션이 만든 일정을 서버에서 바로 지워요. 계속 이야기해도 세션이 끝날 때 똑같이 지워집니다.
        </p>
        <div class="calendar-card-actions">
          <button type="button" class="web-button is-primary" :disabled="finishing" data-testid="completion-finish" @click="finishDemo">지금 정리하고 끝내기</button>
          <button type="button" class="web-button" :disabled="finishing" data-testid="completion-continue" @click="completionOpen = false">계속 이야기하기</button>
        </div>
      </section>
    </div>
  </div>
</template>
