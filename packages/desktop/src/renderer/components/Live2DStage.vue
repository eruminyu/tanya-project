<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { CubismStageController } from '../live2d/cubism-renderer.js';
import { calculateCanvasSize } from '../live2d/cubism-layout.js';
import { loadCubismCore } from '../live2d/core-loader.js';
import { normalizeGazePoint } from '../live2d/gaze-tracking.js';
import type { Live2DEmotion } from '../live2d/live2d-emotion.js';
import { kirianManifest, type Live2DModelManifest } from '../live2d/live2d-model.js';
import { INITIAL_LIVE2D_LOAD_PROGRESS } from '../live2d/live2d-loading.js';
import { playbackMouth } from '../live2d/parameters.js';

const props = withDefaults(defineProps<{
  mouthOpen?: number; speaking?: boolean; emotion?: Live2DEmotion; live?: boolean; manifest?: Live2DModelManifest;
}>(), { mouthOpen: 0, speaking: false, emotion: 'neutral', live: true, manifest: () => kirianManifest });
const emit = defineEmits<{ ready: [value: boolean]; error: [message: string] }>();
const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const controller = shallowRef<CubismStageController>();
const state = ref<'loading' | 'ready' | 'error' | 'paused'>('loading');
const progress = ref(INITIAL_LIVE2D_LOAD_PROGRESS);
let pending: AbortController | undefined;
let observer: ResizeObserver | undefined;
let generation = 0;
let mounted = false;

function resize(): void {
  if (!host.value || !canvas.value) return;
  const size = calculateCanvasSize(host.value.clientWidth, host.value.clientHeight, window.devicePixelRatio);
  if (canvas.value.width === size.width && canvas.value.height === size.height) return;
  canvas.value.width = size.width;
  canvas.value.height = size.height;
  controller.value?.resize(size.width, size.height);
}
function stop(): void {
  generation += 1;
  pending?.abort();
  pending = undefined;
  controller.value?.destroy();
  controller.value = undefined;
  emit('ready', false);
}
function showError(): void {
  state.value = 'error';
  emit('ready', false);
  emit('error', '캐릭터를 불러오지 못했어요. 다시 불러와 주세요.');
}
async function initialize(): Promise<void> {
  if (!mounted || !canvas.value) return;
  stop();
  if (!props.live) { state.value = 'paused'; return; }
  state.value = 'loading';
  progress.value = INITIAL_LIVE2D_LOAD_PROGRESS;
  const current = generation;
  const attempt = new AbortController();
  pending = attempt;
  resize();
  const element = canvas.value;
  try {
    await loadCubismCore(attempt.signal);
    const { createCubismStage } = await import('../live2d/cubism-renderer.js');
    attempt.signal.throwIfAborted();
    const stage = await createCubismStage(element, props.manifest, value => {
      if (mounted && generation === current) progress.value = value;
    }, { signal: attempt.signal, onError: () => {
      if (mounted && generation === current) showError();
    } });
    if (!mounted || generation !== current || attempt.signal.aborted) { stage.destroy(); return; }
    controller.value = stage;
    stage.resize(element.width, element.height);
    stage.setEmotion(props.emotion);
    stage.setMouthOpen(playbackMouth(props.mouthOpen, props.speaking));
    state.value = 'ready';
    emit('ready', true);
  } catch (error) {
    if (!mounted || generation !== current || attempt.signal.aborted) return;
    console.error('Live2D initialization failed', error);
    showError();
  }
}
function gaze(event: PointerEvent): void {
  if (!host.value) return;
  controller.value?.setGaze(normalizeGazePoint(event.clientX, event.clientY, host.value.getBoundingClientRect()));
}
function resetGaze(): void { controller.value?.setGaze({ x: 0, y: 0 }); }
watch(() => [props.mouthOpen, props.speaking], () => controller.value?.setMouthOpen(playbackMouth(props.mouthOpen, props.speaking)));
watch(() => props.emotion, value => controller.value?.setEmotion(value));
watch(() => [props.live, props.manifest], () => { void initialize(); });
onMounted(() => {
  mounted = true;
  observer = new ResizeObserver(resize);
  if (host.value) observer.observe(host.value);
  window.addEventListener('resize', resize);
  window.addEventListener('blur', resetGaze);
  void initialize();
});
onUnmounted(() => {
  mounted = false;
  stop();
  observer?.disconnect();
  window.removeEventListener('resize', resize);
  window.removeEventListener('blur', resetGaze);
});
</script>

<template>
  <div ref="host" class="live2d-stage" :data-state="state" :data-speaking="speaking" :data-mouth-open="mouthOpen" @pointermove="gaze" @pointerleave="resetGaze">
    <canvas ref="canvas" data-testid="live2d-canvas" :aria-label="`${manifest.displayName} Live2D 캐릭터`" @webglcontextrestored="initialize" />
    <div v-if="state !== 'ready'" class="live2d-state" :role="state === 'error' ? 'alert' : 'status'" data-testid="live2d-status">
      <template v-if="state === 'loading'"><span>{{ manifest.displayName }} 캐릭터를 준비하고 있어요</span><small>{{ progress.message }}</small></template>
      <template v-else-if="state === 'error'"><span>캐릭터를 불러오지 못했어요</span><button type="button" data-testid="live2d-retry" @click="initialize">다시 불러오기</button></template>
      <span v-else>캐릭터 표시가 일시 중지되었어요.</span>
    </div>
  </div>
</template>

<style scoped>
.live2d-stage { position: absolute; inset: 0; overflow: hidden; }
canvas { width: 100%; height: 100%; display: block; }
.live2d-state { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px; padding: 16px; text-align: center; background: #191921c9; color: #c4b4d8; font-size: 12px; }
.live2d-state small { color: #9c8aaa; font-size: 10px; }
.live2d-state button { border: 1px solid #bba0db44; border-radius: 7px; background: #bba0db15; color: #d1bae9; padding: 7px 11px; font-size: 11px; }
@media (max-width: 600px) { .live2d-state { font-size: 10px; gap: 5px; } }
</style>
