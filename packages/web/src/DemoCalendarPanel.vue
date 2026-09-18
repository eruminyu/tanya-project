<script setup lang="ts">
// Public verification: what the demo calendar holds right now, read through the gateway from the demo account.
import { onMounted, onUnmounted, ref, watch } from 'vue';
import type { DemoClient, EventTime } from './demo-client.js';

const props = defineProps<{ client: DemoClient; refresh: number }>();
const events = ref<{ id: string; summary: string; start: EventTime; end: EventTime }[]>([]);
const calendar = ref<{ label: string; timeZone: string } | null>(null);
const loaded = ref(false), failed = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;
async function load(): Promise<void> {
  const result = await props.client.fetchCalendar();
  if (!result) { failed.value = true; return; }
  failed.value = false; loaded.value = true;
  calendar.value = { label: result.calendar.label, timeZone: result.calendar.timeZone };
  events.value = result.events;
}
function when(start: EventTime, timeZone: string): string {
  try {
    if ('date' in start) return new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(start.date + 'T00:00:00')) + ' 종일';
    return new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(start.dateTime));
  } catch { return 'date' in start ? start.date : start.dateTime; }
}
onMounted(() => { void load(); timer = setInterval(() => { void load(); }, 30_000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
watch(() => props.refresh, () => { setTimeout(() => { void load(); }, 1500); });
</script>

<template>
  <details class="demo-calendar" data-testid="demo-calendar">
    <summary>공개 데모 캘린더{{ calendar ? ` · ${calendar.label}` : '' }} · {{ loaded ? `${events.length}개 예정` : failed ? '읽지 못함' : '불러오는 중' }}</summary>
    <p class="demo-calendar-note">승인한 일정이 실제로 만들어졌는지 여기와 영수증의 Google 링크로 확인할 수 있어요. 데모 일정은 잠시 뒤 자동 삭제돼요.</p>
    <ul v-if="events.length" class="demo-calendar-list">
      <li v-for="item in events" :key="item.id"><span class="demo-calendar-when">{{ when(item.start, calendar?.timeZone ?? 'Asia/Seoul') }}</span> {{ item.summary }}</li>
    </ul>
    <p v-else-if="loaded" class="demo-calendar-note">아직 예정된 일정이 없어요.</p>
  </details>
</template>
