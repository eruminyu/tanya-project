<script setup lang="ts">
import { ref, watch } from 'vue';
import type { BrainSnapshot } from '../../shared/bridge.js';

const props = defineProps<{
  brain: BrainSnapshot;
  enabled: boolean;
  busy: boolean;
  activeTurn: boolean;
  connect: (options: { url: string; token: string }) => Promise<boolean>;
}>();
const emit = defineEmits<{
  disconnect: [];
  reconnect: [];
  'select-model': [id: string | null];
}>();
const expanded = ref(false);
const url = ref(props.brain.url || 'http://127.0.0.1:8766');
const token = ref('');
let urlEdited = false;

watch(
  () => props.brain.url,
  (value) => {
    if (!urlEdited && value) url.value = value;
  }
);

function updateUrl(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  urlEdited = true;
  url.value = event.target.value;
}

function updateToken(event: Event): void {
  if (event.target instanceof HTMLInputElement)
    token.value = event.target.value;
}

async function connect(): Promise<void> {
  if (!props.enabled || props.busy || !url.value.trim() || !token.value.trim())
    return;
  if (
    await props.connect({ url: url.value.trim(), token: token.value.trim() })
  ) {
    token.value = '';
    urlEdited = false;
    if (props.brain.url) url.value = props.brain.url;
  }
}

function selectModel(event: Event): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const id = event.target.value || null;
  // The host's confirmed selection remains visible until its next snapshot arrives.
  event.target.value = props.brain.selectedModelId ?? '';
  if (
    props.enabled &&
    !props.busy &&
    !props.activeTurn &&
    props.brain.phase === 'ready'
  ) {
    emit('select-model', id);
  }
}
</script>

<template>
  <div class="connection-controls">
    <div class="connection-toolbar">
      <button
        class="settings-toggle"
        type="button"
        :aria-expanded="expanded"
        aria-controls="brain-settings"
        data-testid="brain-settings-toggle"
        @click="expanded = !expanded"
      >
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M3 6h14M3 14h14" />
          <circle cx="7" cy="6" r="2" />
          <circle cx="13" cy="14" r="2" />
        </svg>
        연결 설정
        <span class="settings-chevron" aria-hidden="true">{{
          expanded ? '−' : '+'
        }}</span>
      </button>
      <div class="model-selection">
        <label class="sr-only" for="conversation-model"
          >이 대화에 사용할 모델</label
        >
        <select
          id="conversation-model"
          data-testid="model-select"
          :value="brain.selectedModelId ?? ''"
          :disabled="!enabled || busy || activeTurn || brain.phase !== 'ready'"
          title="이 대화에 사용할 모델"
          @change="selectModel"
        >
          <option value="">{{ brain.routing?.enabled ? '자동 선택' : '서버 기본 모델' }}</option>
          <option
            v-for="model in brain.models.filter(item => item.supportsText !== false)"
            :key="model.id"
            :value="model.id"
          >
            {{ model.label }}
          </option>
        </select>
        <span class="model-selection-hint">이 대화에 적용</span>
      </div>
    </div>
    <form
      v-if="expanded"
      id="brain-settings"
      class="brain-settings"
      @submit.prevent="connect"
    >
      <div class="connection-fields">
        <div class="connection-field">
          <label for="brain-url">서비스 주소</label>
          <input
            id="brain-url"
            data-testid="brain-url"
            type="url"
            :value="url"
            :disabled="!enabled || busy"
            autocomplete="off"
            spellcheck="false"
            required
            maxlength="2048"
            @input="updateUrl"
          />
        </div>
        <div class="connection-field">
          <label for="brain-token">연결 토큰</label>
          <input
            id="brain-token"
            data-testid="brain-token"
            type="password"
            :value="token"
            :disabled="!enabled || busy"
            autocomplete="off"
            spellcheck="false"
            placeholder="서비스의 연결 토큰"
            required
            maxlength="4096"
            @input="updateToken"
          />
        </div>
      </div>
      <div class="connection-actions">
        <p>토큰은 이번 실행에서만 사용하며 연결되면 입력창에서 지워져요.</p>
        <div class="connection-action-buttons">
          <button
            class="secondary-button"
            type="button"
            data-testid="brain-disconnect"
            :disabled="!enabled || busy || brain.phase === 'disconnected'"
            @click="$emit('disconnect')"
          >
            연결 해제
          </button>
          <button
            class="secondary-button"
            type="button"
            data-testid="brain-reconnect"
            :disabled="!enabled || busy || !brain.url"
            @click="$emit('reconnect')"
          >
            다시 연결
          </button>
          <button
            class="primary-button"
            type="submit"
            data-testid="brain-connect"
            :disabled="!enabled || busy || !url.trim() || !token.trim()"
          >
            연결
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
