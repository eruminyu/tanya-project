<script setup lang="ts">
// Proactive suggestion: the companion speaks first about an event this visitor approved that is about to start.
// Nothing is sent on the visitor's behalf — "이야기하기" only fills and sends the visible question on click.
import { computed, onUnmounted, ref } from 'vue';
import type { ProactiveCard } from './demo-client.js';

const props = defineProps<{ cards: ProactiveCard[]; busy: boolean; companionName: string }>();
const emit = defineEmits<{ ask: [card: ProactiveCard]; dismiss: [cardId: string] }>();

const clock = ref(Date.now());
const timer = setInterval(() => { clock.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));
const minutesLeft = (card: ProactiveCard) => Math.max(0, Math.ceil((card.at - clock.value) / 60_000));
const visible = computed(() => props.cards.filter(card => card.expiresAt > clock.value));
</script>

<template>
  <section v-for="card in visible" :key="card.id" class="calendar-card is-suggestion" data-testid="suggestion-card" aria-live="polite">
    <p class="calendar-card-eyebrow">{{ companionName }}의 선제 제안 · {{ card.title }}</p>
    <h3 class="calendar-card-title">{{ card.text }}</h3>
    <p class="calendar-card-meta">“{{ card.quote }}” · {{ minutesLeft(card) }}분 뒤 시작 · 이 세션에서 승인한 일정만 살펴요.</p>
    <div class="calendar-card-actions">
      <button type="button" class="web-button is-primary" :disabled="busy" data-testid="suggestion-ask" @click="emit('ask', card)">준비 이야기하기</button>
      <button type="button" class="web-button" :disabled="busy" data-testid="suggestion-dismiss" @click="emit('dismiss', card.id)">닫기</button>
    </div>
  </section>
</template>
