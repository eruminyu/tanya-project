<script setup lang="ts">
defineProps<{ alwaysOnTop: boolean; enabled: boolean; busy: boolean }>();
defineEmits<{ togglePin: []; minimize: []; close: [] }>();
</script>

<template>
  <header class="window-bar">
    <div class="window-brand">
      <span class="brand-mark" aria-hidden="true">k.</span>
      <span class="brand-name">KIRIAN</span>
      <span class="window-caption">나의 데스크톱 동반자</span>
    </div>
    <div class="window-actions">
      <button
        class="window-button pin-button"
        :class="{ 'is-pinned': alwaysOnTop }"
        :disabled="!enabled || busy"
        :aria-pressed="alwaysOnTop"
        :aria-label="alwaysOnTop ? '항상 위에 표시 해제' : '항상 위에 표시'"
        :title="alwaysOnTop ? '항상 위에 표시 중' : '항상 위에 표시'"
        data-testid="always-on-top"
        @click="$emit('togglePin')"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m8 4 8 0-1 6 3 3v2H6v-2l3-3-1-6Zm4 11v6" />
        </svg>
      </button>
      <span class="window-action-divider" aria-hidden="true" />
      <button
        class="window-button"
        :disabled="!enabled"
        aria-label="최소화"
        title="최소화"
        data-testid="minimize-window"
        @click="$emit('minimize')"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 12h12" />
        </svg>
      </button>
      <button
        class="window-button close-button"
        :disabled="!enabled"
        aria-label="닫기"
        title="닫기"
        data-testid="close-window"
        @click="$emit('close')"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m7 7 10 10M17 7 7 17" />
        </svg>
      </button>
    </div>
  </header>
</template>
