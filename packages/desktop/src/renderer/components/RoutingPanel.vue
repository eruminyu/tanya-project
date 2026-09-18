<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { BrainSnapshot } from '../../shared/bridge.js';
const props = defineProps<{brain: BrainSnapshot}>();
const bridge = window.kirianDesktop;
const pending = ref(false), notice = ref('');
const calls = ref(100), units = ref(1000);
const state = computed(() => props.brain.routing);
watch(() => [state.value?.revision, props.brain.phase], () => {
  if (state.value) { calls.value = state.value.daily_call_limit; units.value = state.value.daily_budget_units; }
}, {immediate:true});
const candidates = computed(() => props.brain.models.filter(m => m.automaticAllowed && m.supportsText !== false));
function toggle(event: Event) {
  const target = event.target as HTMLInputElement, enabled = target.checked;
  void save(enabled).finally(() => { target.checked = state.value?.enabled ?? false; });
}
async function save(enabled: boolean) {
  if (!bridge || !state.value || pending.value) return;
  pending.value = true; notice.value = '';
  try {
    const result = await bridge.configureRouting({enabled, expected_revision:state.value.revision,
      daily_call_limit:calls.value, daily_budget_units:units.value});
    notice.value = result.ok ? '자동 모델 설정을 저장했어요.' : result.code === 'routing_changed'
      ? '설정이 변경되어 최신 값을 가져왔어요. 확인 후 다시 저장해 주세요.' : '설정을 저장하지 못했어요. 한도와 연결 상태를 확인해 주세요.';
  } catch { notice.value = '설정 상태를 확인하지 못했어요. 연결 후 다시 확인해 주세요.'; }
  finally { pending.value = false; }
}
</script>

<template>
  <details v-if="state && brain.phase === 'ready'" class="routing-panel" data-testid="routing-panel">
    <summary>자동 모델 선택 <strong>{{ pending ? '저장 중' : state.enabled ? 'ON' : 'OFF' }}</strong></summary>
    <p>대화나 이번 화면 분석에 고정한 모델이 우선해요. 자동 선택은 아래 허용 모델의 입력 능력·출처 경계·남은 한도를 확인해요.</p>
    <label><input data-testid="routing-enabled" type="checkbox" :checked="state.enabled" :disabled="pending || !state.persistent"
      @change="toggle"> 자동 모델 선택 사용</label>
    <form @submit.prevent="save(state.enabled)">
      <label>하루 호출 한도 <input v-model.number="calls" data-testid="routing-calls" type="number" min="1" max="100000" required :disabled="pending"></label>
      <label>하루 예약 단위 <input v-model.number="units" data-testid="routing-units" type="number" min="0" max="1000000000" required :disabled="pending"></label>
      <button data-testid="routing-save" type="submit" :disabled="pending">한도 저장</button>
    </form>
    <p data-testid="routing-usage">오늘 {{ state.calls_used }} / {{ state.daily_call_limit }}회 · {{ state.budget_units_used }} / {{ state.daily_budget_units }} 예약 단위</p>
    <p>예약 단위는 host가 정한 보수적 호출 예산이며 실제 청구액이 아니에요. 실패한 호출도 사용량에 포함하며, 자동 기억·검색과 한도를 공유해요. 매일 UTC 0시에 새 한도가 시작돼요.</p>
    <ul><li v-for="model in candidates" :key="model.id">{{ model.label }} · {{ model.budgetUnits === null ? '비용 미설정: 자동 선택 차단' : `${model.budgetUnits} 단위/호출` }} · {{ model.boundary === 'local' ? '이 PC' : model.boundary === 'private_lan' ? '개인 LAN' : '외부 API' }}</li></ul>
    <p v-if="!candidates.length">host가 자동 선택을 허용한 모델이 없어요.</p>
    <p role="status">{{ notice }}</p>
  </details>
</template>

<style scoped>
.routing-panel { border: 1px solid var(--border, #d7dce2); border-radius: 12px; padding: 12px; font-size: 12px; }
summary { cursor: pointer; font-weight: 600; } p { line-height: 1.6; margin: 8px 0; }
form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-top: 10px; }
form label { display: grid; gap: 4px; } input[type=number] { width: 110px; padding: 6px; }
ul { padding-left: 20px; } li { margin: 5px 0; }
</style>
