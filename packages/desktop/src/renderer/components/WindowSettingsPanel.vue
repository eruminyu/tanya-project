<script setup lang="ts">
import {ref} from 'vue';
import type {WindowState} from '../../shared/window-controls.js';
const props = defineProps<{state: WindowState; enabled: boolean}>();
const pending = ref(false), notice = ref('');
async function command(kind: 'toggle' | 'recover'): Promise<void> {
  const bridge = window.kirianDesktop;
  if (!bridge || !props.enabled || pending.value) return;
  pending.value = true; notice.value = '';
  try {
    const result = kind === 'recover' ? await bridge.recoverWindow() : await bridge.setClickThrough(!props.state.clickThrough);
    if (!result.ok) notice.value = result.code === 'shortcut_unavailable'
      ? '복구 단축키를 사용할 수 없어 클릭 통과를 켜지 않았어요.'
      : result.code === 'interaction_blocked' ? '잠금 또는 절전 중에는 클릭 통과를 켤 수 없어요.'
      : '창 설정을 변경하지 못했어요. 앱을 다시 실행해 주세요.';
  } catch { notice.value = '창 설정을 변경하지 못했어요. 앱을 다시 실행해 주세요.'; }
  finally { pending.value = false; }
}
</script>

<template>
  <details class="window-settings" aria-labelledby="window-settings-title">
    <summary id="window-settings-title">창 사용 설정</summary>
    <p>클릭 통과를 켜면 키리안 창 아래로 마우스 입력이 전달돼요.</p>
    <p>복구: <kbd>{{ state.recoveryShortcut }}</kbd> · 클릭 통과를 끄고 키리안 창을 앞으로 가져와요.</p>
    <div class="window-settings-actions">
      <button type="button" class="secondary-button" data-testid="click-through-toggle" :aria-pressed="state.clickThrough"
        :disabled="!enabled || pending || (!state.clickThrough && !state.recoveryAvailable)" @click="command('toggle')">
        클릭 통과 {{ state.clickThrough ? '켜짐' : '꺼짐' }}
      </button>
      <button type="button" class="secondary-button" data-testid="recover-window" :disabled="!enabled || pending" @click="command('recover')">창 위치 복구</button>
    </div>
    <p v-if="enabled && !state.recoveryAvailable" role="status" data-testid="shortcut-unavailable">복구 단축키 등록에 실패했거나 사용할 수 없어요. 클릭 통과를 켤 수 없어요.</p>
    <p>창 위치와 크기는 자동 저장돼요. 다시 실행하면 클릭 통과는 꺼져요. 키리안을 다시 실행해도 현재 창을 복구할 수 있어요.</p>
    <p v-if="state.boundsPersistenceError" role="alert">창 위치를 저장하거나 불러오지 못했어요. 기존 파일은 보존하며, 이번 위치는 다음 실행에 반영되지 않을 수 있어요.</p>
    <p v-if="notice" role="alert">{{ notice }}</p>
  </details>
</template>

<style scoped>
.window-settings { padding: 12px 0; border-top: 1px solid var(--line); }
summary { font-size: 13px; cursor: pointer; }
p { color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.window-settings-actions { display: flex; gap: 8px; flex-wrap: wrap; }
kbd { color: var(--accent); }
</style>
