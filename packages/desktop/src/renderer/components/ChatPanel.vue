<script setup lang="ts">
import { routingReason } from '../../shared/routing.js';
import { nextTick, ref, watch } from 'vue';
import type { ChatMessage } from '../../shared/bridge.js';

const props = defineProps<{
  messages: readonly ChatMessage[];
  modelValue: string;
  canSend: boolean;
  submitting: boolean;
  connectionLabel: string;
  connectionDescription: string;
  connected: boolean;
  modelLabel: string;
  modelDetail: string;
  activeTurn: boolean;
  cancelPending: boolean;
  canCancel: boolean;
  /** Display name of the companion; the web demo shows a different character with the same panel. */
  companionName?: string;
}>();
const name = () => props.companionName ?? '키리안';
const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  cancel: [];
}>();
const transcript = ref<HTMLElement>();
const statusLabels: Record<ChatMessage['status'], string> = {
  streaming: '응답 중',
  completed: '',
  cancelled: '중단됨',
  failed: '실패',
};

function failedReason(code: string | undefined): string {
  switch (code) {
    case 'source_changed': return '참고하던 자료가 변경되어 답변을 중단했어요.';
    case 'routing_changed': return '자동 선택 설정이 변경되어 호출을 중단했어요. 설정을 확인한 뒤 다시 보내 주세요.';
    case 'routing_no_candidate': return '입력 능력·자료 사용 범위·남은 한도를 충족하는 자동 선택 모델이 없어요.';
    case 'routing_limit': return '오늘의 모델 호출 또는 예약 단위 한도에 도달했어요.';
    case 'storage_unavailable': return '대화를 저장하지 못해 답변을 중단했어요.';
    case 'speech_unavailable': return '현재 목소리의 음성 서비스에 연결할 수 없어요.';
    case 'speech_error': return '음성을 완성하지 못했어요. 답변은 화면에서 확인할 수 있어요.';
    case 'playback_failed': return '음성 재생을 완료하지 못했어요. 오디오 장치를 확인해 주세요.';
    case 'provider_unavailable':
      return '모델 서비스에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.';
    case 'provider_error':
      return '모델이 답변을 처리하지 못했어요. 다시 시도해 주세요.';
    case 'model_mismatch':
      return '선택한 모델과 실제 응답 모델이 달라 답변을 중단했어요.';
    case 'incomplete_response':
      return '답변이 끝까지 도착하지 않았어요. 다시 시도해 주세요.';
    case 'empty_response':
      return '모델이 빈 답변을 반환했어요. 다시 시도해 주세요.';
    case 'response_limit':
      return '답변 길이 제한에 도달해 중단했어요.';
    case 'model_not_allowed':
      return '이 대화에서는 선택한 모델을 사용할 수 없어요.';
    case 'context_blocked':
      return '이 모델에 전달할 수 없는 정보가 포함되어 있어 요청을 중단했어요.';
    case 'invalid_request':
      return '요청을 처리할 수 없어요. 메시지를 확인해 주세요.';
    case 'session_limit':
      return '대화 처리 한도에 도달했어요. 다시 연결한 후 시도해 주세요.';
    case 'turn_timeout':
      return '답변 시간이 초과되었어요. 다시 시도해 주세요.';
    default:
      return '답변을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

function updateDraft(event: Event): void {
  if (event.target instanceof HTMLTextAreaElement)
    emit('update:modelValue', event.target.value);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (props.canSend && !props.submitting && props.modelValue.trim())
      emit('submit');
  }
}

watch(
  () => [
    props.messages.length,
    props.messages.at(-1)?.text,
    props.messages.at(-1)?.status,
  ],
  async () => {
    await nextTick();
    if (transcript.value)
      transcript.value.scrollTop = transcript.value.scrollHeight;
  }
);
</script>

<template>
  <section class="chat-panel" aria-labelledby="conversation-title">
    <div class="conversation-heading">
      <div>
        <span class="eyebrow">CONVERSATION</span>
        <h2 id="conversation-title">우리의 대화</h2>
      </div>
      <span
        class="connection-pill"
        :class="{ 'is-connected': connected }"
        role="status"
        data-testid="connection-status"
      >
        <span class="status-dot" aria-hidden="true" />{{ connectionLabel }}
      </span>
    </div>

    <slot name="connection-settings" />

    <div class="model-strip" aria-label="실제 응답 모델">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="3" />
        <path d="M10 3v3m4-3v3m-4 12v3m4-3v3M3 10h3m-3 4h3m12-4h3m-3 4h3" />
      </svg>
      <div class="model-strip-copy">
        <span class="model-label">실제 응답 모델</span>
        <strong data-testid="actual-model">{{ modelLabel }}</strong>
      </div>
      <span v-if="modelDetail" class="model-detail">{{ modelDetail }}</span>
    </div>

    <div
      ref="transcript"
      class="transcript"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="대화 기록"
      data-testid="messages"
    >
      <div
        v-if="messages.length === 0"
        class="conversation-empty"
        data-testid="conversation-empty"
      >
        <span class="empty-chat-icon" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <path
              d="M25 20a4 4 0 0 1-4 4H12l-6 4V9a4 4 0 0 1 4-4h11a4 4 0 0 1 4 4v11Z"
            />
            <path d="M12 12h7m-7 5h4" />
          </svg>
        </span>
        <h3>아직 나눈 이야기가 없어요</h3>
        <p>
          {{
            canSend
              ? '첫 메시지로 대화를 시작해 보세요.'
              : connectionDescription
          }}
        </p>
      </div>
      <article
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="`message-${message.role}`"
      >
        <span class="message-author">{{
          message.role === 'user' ? '나' : name()
        }}</span>
        <div class="message-bubble">
          <p>{{ message.text }}</p>
          <p v-if="message.actualModel" class="message-model" data-testid="message-routing">{{ message.actualModel.providerId }} / {{ message.actualModel.modelId }} · {{ routingReason(message.routingReason) }}</p>
          <span
            v-if="message.status !== 'completed'"
            class="message-status"
            :class="`is-${message.status}`"
            >{{ statusLabels[message.status] }}</span
          >
          <p v-if="message.status === 'failed'" class="message-error">
            {{ failedReason(message.errorCode) }}
          </p>
        </div>
      </article>
    </div>

    <div class="composer-area">
      <slot name="tools-status" />
      <div v-if="activeTurn" class="turn-controls">
        <span>{{
          cancelPending ? '답변을 중단하고 있어요.' : '답변을 생성하고 있어요.'
        }}</span>
        <button
          class="cancel-turn-button"
          type="button"
          data-testid="turn-cancel"
          :disabled="!canCancel || cancelPending"
          @click="$emit('cancel')"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1" />
          </svg>
          {{ cancelPending ? '중단 중' : '답변 중단' }}
        </button>
      </div>
      <p v-if="!canSend" id="connection-description" class="connection-notice">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7" />
          <path d="M10 9v5m0-8v.5" />
        </svg>
        {{ connectionDescription }}
      </p>
      <form
        class="composer"
        :class="{ 'is-disabled': !canSend }"
        @submit.prevent="$emit('submit')"
      >
        <label class="sr-only" for="message-input">{{ name() }}에게 보낼 메시지</label>
        <textarea
          id="message-input"
          data-testid="chat-input"
          :value="modelValue"
          :disabled="!canSend || submitting"
          :aria-describedby="!canSend ? 'connection-description' : undefined"
          :placeholder="
            canSend
              ? `${name()}에게 이야기해 주세요…`
              : connected
                ? '지금은 메시지를 보낼 수 없어요'
                : '연결 후 메시지를 보낼 수 있어요'
          "
          rows="2"
          maxlength="32768"
          @input="updateDraft"
          @keydown="onKeydown"
        />
        <button
          class="send-button"
          type="submit"
          :disabled="!canSend || submitting || !modelValue.trim()"
          :aria-label="submitting ? '메시지 보내는 중' : '메시지 보내기'"
          data-testid="chat-send"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 18V6m-5 5 5-5 5 5" />
          </svg>
        </button>
      </form>
      <div class="composer-footer">
        <span>나의 곁에, {{ name() }}</span
        ><span
          >Enter 전송 <span aria-hidden="true">·</span> Shift + Enter
          줄바꿈</span
        >
      </div>
    </div>
  </section>
</template>
