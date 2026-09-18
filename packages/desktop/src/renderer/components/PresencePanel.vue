<script setup lang="ts">
import { ref } from 'vue';
import Live2DStage from './Live2DStage.vue';
import type { Live2DEmotion } from '../live2d/live2d-emotion.js';
import { kirianManifest, type Live2DModelManifest } from '../live2d/live2d-model.js';

// `manifest` and `characterName` let the web demo show another character; the desktop keeps the defaults.
withDefaults(defineProps<{ mouthOpen?: number; speaking?: boolean; emotion?: Live2DEmotion; audioStatus?: string; live?: boolean;
  manifest?: Live2DModelManifest; characterName?: string }>(), {
  mouthOpen: 0, speaking: false, emotion: 'neutral', live: true, manifest: () => kirianManifest, characterName: '키리안',
});
const emit = defineEmits<{ ready: [value: boolean]; error: [message: string] }>();
const ready = ref(false);
const error = ref(false);
function setReady(value: boolean): void { ready.value = value; if (value) error.value = false; emit('ready', value); }
function setError(message: string): void { error.value = true; emit('error', message); }
function subject(name: string): string {
  const code = name.charCodeAt(name.length - 1);
  return name + (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '이' : '가');
}
</script>

<template>
  <aside class="presence-panel" aria-labelledby="presence-title">
    <h1 id="presence-title" class="sr-only">{{ characterName }}</h1>
    <div class="presence-heading">
      <span class="eyebrow">YOUR COMPANION</span>
      <span class="quiet-badge">{{ ready ? 'Live2D 연결됨' : error ? '캐릭터 로딩 오류' : live ? '캐릭터 준비 중' : '캐릭터 일시 중지' }}</span>
    </div>
    <div class="presence-stage presence-live2d" data-testid="character-stage">
      <Live2DStage :mouth-open="mouthOpen" :speaking="speaking" :emotion="emotion" :live="live" :manifest="manifest" @ready="setReady" @error="setError" />
    </div>
    <div class="presence-footer">
      <span class="presence-footer-line" aria-hidden="true" />
      <p>{{ audioStatus || (speaking ? `${subject(characterName)} 말하고 있어요.` : '음성은 아직 연결되지 않았어요.') }}</p>
    </div>
  </aside>
</template>

<style scoped>
.presence-live2d { position: relative; width: 100%; min-height: 200px; }
.presence-heading { position: relative; z-index: 1; }
@media (max-width: 600px) {
  .presence-live2d { position: relative; min-height: 0; }
  .presence-heading { padding-top: 10px; }
}
</style>
