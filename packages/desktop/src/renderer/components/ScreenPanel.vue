<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { BrainSnapshot, ModelOption } from '../../shared/bridge.js';
import type { LibraryState } from '../../shared/persistence.js';
import { emptyScreens, type ScreenBoundary, type ScreenCommandResult, type ScreenState } from '../../shared/screens.js';
import { routingReason } from '../../shared/routing.js';

const props = defineProps<{ brain: BrainSnapshot; library: LibraryState; enabled: boolean }>();
const bridge = typeof window === 'undefined' ? undefined : window.kirianDesktop;
const screens = ref<ScreenState>(emptyScreens());
const selectedTarget = ref('');
const selectedBoundary = ref<ScreenBoundary>('local');
const selectedModelId = ref('');
const prompt = ref('이 화면의 핵심 내용을 설명해 줘.');
const localAction = ref<string | null>(null);
const localError = ref<string | null>(null);
const imageLoaded = ref(false);
const imageFailed = ref(false);
const deleting = ref<{ captureId: string; revision: number; title: string } | null>(null);
let mounted = false, generation = 0, commandVersion = 0, latestVersion = -1;
let unsubscribe: (() => void) | undefined;

const connected = computed(() => !!bridge && props.brain.phase === 'ready' && screens.value.available);
const hostBusy = computed(() => ['listing', 'capturing', 'analyzing', 'deleting'].includes(screens.value.phase));
const busy = computed(() => hostBusy.value || localAction.value !== null);
const canManage = computed(() => connected.value && props.enabled && !busy.value);
const effectiveModelId = computed(() => props.brain.selectedModelId ?? props.library.defaultModelId);
const automatic = computed(() => !selectedModelId.value && !props.brain.selectedModelId && props.brain.routing?.enabled === true);
const modelId = computed(() => automatic.value ? null : selectedModelId.value || effectiveModelId.value);
const model = computed(() => props.brain.models.find(option => option.id === modelId.value));
const currentModel = computed(() => props.brain.models.find(option => option.id === effectiveModelId.value));
const captureBoundary = computed(() => screens.value.preview?.boundary ?? selectedBoundary.value);
const promptLength = computed(() => [...prompt.value].length);
const previewUrl = computed(() => {
  const value = screens.value.preview?.dataUrl ?? '';
  // A preview may only refer to pixels already held by this process.
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
});
const modelProblem = computed(() => {
  if (automatic.value) return props.brain.models.some(m => m.automaticAllowed && m.supportsText !== false && m.supportsImages && m.budgetUnits !== null
    && (m.boundary === 'local' || captureBoundary.value === 'private_lan' && m.boundary === 'private_lan')) ? null : '이 화면을 처리할 수 있는 자동 허용 모델이 없어요.';
  if (!model.value) return '분석에 사용할 모델을 직접 선택해 주세요.';
  if (model.value.supportsImages !== true) return '선택한 모델은 화면 이미지를 분석할 수 없어요. 이미지 입력을 지원하는 모델을 직접 선택해 주세요.';
  if (model.value.boundary === 'cloud') return '화면 이미지는 외부 API 모델에 보내지 않아요. 이 PC 또는 허용한 개인 LAN의 모델을 선택해 주세요.';
  if (!model.value.boundary) return '이 모델의 처리 위치를 확인할 수 없어요. 처리 위치가 확인된 모델을 선택해 주세요.';
  if (captureBoundary.value === 'local' && model.value.boundary !== 'local') return '이 캡처는 이 PC에서만 사용할 수 있어요. 로컬 모델을 선택하거나 삭제 후 개인 LAN 허용으로 다시 캡처해 주세요.';
  return null;
});
const canCapture = computed(() => canManage.value && !screens.value.preview && screens.value.targets.some(target => target.id === selectedTarget.value));
const canAnalyze = computed(() => canManage.value && !!screens.value.preview && !!previewUrl.value && imageLoaded.value &&
  !imageFailed.value && !screens.value.analysis && !modelProblem.value && prompt.value.trim().length > 0 && promptLength.value <= 2048);
const canCancel = computed(() => connected.value && ['capturing', 'analyzing'].includes(screens.value.phase) && localAction.value !== 'cancel');
const analysisSelected = computed(() => !!screens.value.analysis && props.library.selectedSourceIds.includes(screens.value.analysis.sourceId));
const history = computed(() => screens.value.saved.filter(saved => saved.captureId !== screens.value.preview?.id));
const error = computed(() => localError.value ?? screens.value.error);
const phaseLabel = computed(() => ({ idle: '선택한 화면 한 장만', listing: '화면 목록 확인 중', capturing: '한 장 가져오는 중',
  preview: screens.value.analysis ? '분석 완료' : '분석 전 미리보기', analyzing: '화면 분석 중', deleting: '기록 삭제 중', error: '확인 필요' })[screens.value.phase]);

function boundaryLabel(value: ScreenBoundary): string { return value === 'local' ? '이 PC에서만' : '개인 LAN까지 허용'; }
function modelLabel(option: ModelOption): string {
  const location = option.boundary === 'local' ? '이 PC' : option.boundary === 'private_lan' ? '개인 LAN' : option.boundary === 'cloud' ? '외부 API · 사용 불가' : '위치 미확인';
  return `${option.label} · ${location}${option.supportsImages === true ? '' : ' · 이미지 미지원'}`;
}
function dateLabel(value: number): string {
  const date = new Date(value);
  return Number.isFinite(value) && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    : '시간 확인 불가';
}
function errorMessage(code: string): string {
  switch (code) {
    case 'unsupported_model': return '선택한 모델은 이미지 입력을 지원하지 않아요. 화면 분석 모델을 직접 바꿔 주세요.';
    case 'routing_changed': return '자동 선택 설정이 변경되었어요. 설정을 확인한 뒤 다시 분석해 주세요.';
    case 'routing_no_candidate': return '이미지 처리 능력·출처 경계·남은 한도를 충족하는 모델이 없어요.';
    case 'routing_limit': return '오늘의 호출 또는 예약 단위 한도에 도달했어요.';
    case 'context_blocked': return '캡처의 사용 범위와 모델의 처리 위치가 맞지 않아요. 범위에 맞는 모델을 선택해 주세요.';
    case 'model_not_allowed': return '이 모델로 화면을 분석할 수 없어요. 허용된 이미지 모델을 직접 선택해 주세요.';
    case 'source_changed': return '화면이나 참고 기록이 바뀌었어요. 현재 기록을 확인한 뒤 필요한 경우 삭제하고 다시 캡처해 주세요.';
    case 'screen_busy': return '이전 화면 작업을 처리하고 있어요. 완료되거나 취소된 뒤 다시 시도해 주세요.';
    case 'screen_limit': return '화면 기록 32개가 보관되어 있어요. 아래에서 필요 없는 기록을 삭제한 뒤 다시 분석해 주세요.';
    case 'image_limit': return '가져올 수 있는 이미지 크기를 넘었어요. 더 작은 창을 선택해 주세요.';
    case 'capture_unavailable': return '선택한 화면을 가져올 수 없어요. 창이 열려 있는지와 화면 접근 권한을 확인해 주세요.';
    case 'capture_cancelled': return '화면 작업을 취소했어요. 이미 완료되어 저장된 분석은 그대로 남아 있어요.';
    case 'capture_timeout': return '화면 작업이 제한 시간 안에 끝나지 않았어요. 상태를 확인한 뒤 다시 시도해 주세요.';
    case 'connection_changed': return '연결이 바뀌어 화면 작업을 멈췄어요. 다시 연결한 뒤 시작해 주세요.';
    case 'provider_error': return '분석 모델이 응답하지 못했어요. 모델 연결을 확인한 뒤 다시 시도해 주세요.';
    case 'provider_unavailable': return '분석 모델 서버가 제한 시간 안에 응답을 시작하지 않았어요. 모델 서버가 다른 작업으로 바쁘거나 GPU 여유가 부족하지 않은지 확인한 뒤 다시 시도해 주세요.';
    case 'turn_timeout': return '분석이 제한 시간을 넘겨 중단됐어요. 모델 서버가 느리지 않은지 확인한 뒤 다시 시도해 주세요.';
    case 'model_mismatch': return '선택한 모델과 실제 응답 모델이 달라 결과를 사용하지 않았어요. 모델 설정을 확인해 주세요.';
    case 'incomplete_response': return '분석이 끝까지 완료되지 않았어요. 완료된 결과로 저장되지 않았으니 다시 시도해 주세요.';
    case 'storage_unavailable': return '화면 기록의 저장 상태를 확인하지 못했어요. 연결과 저장 공간을 확인한 뒤 다시 시도해 주세요.';
    case 'deletion_unconfirmed': return '기록 삭제를 확인하지 못했어요. 삭제된 것으로 처리하지 않았으니 기록을 새로 확인하거나 삭제를 다시 시도해 주세요.';
    default: return '화면 작업을 완료하지 못했어요. 현재 기록과 연결 상태를 확인한 뒤 다시 시도해 주세요.';
  }
}
function resetLocal(): void {
  generation += 1; commandVersion += 1; screens.value = emptyScreens();
  selectedTarget.value = ''; selectedBoundary.value = 'local'; selectedModelId.value = '';
  prompt.value = '이 화면의 핵심 내용을 설명해 줘.';
  deleting.value = null; localAction.value = null; localError.value = null;
  imageLoaded.value = false; imageFailed.value = false;
}
function acceptState(value: ScreenState, expectedGeneration = generation): void {
  if (!mounted || generation !== expectedGeneration || props.brain.phase !== 'ready' || value.version <= latestVersion) return;
  // Host versions span connections. Clearing pixels must not forget which old
  // snapshots were already retired by a disconnect.
  latestVersion = value.version;
  screens.value = value;
  if (!value.targets.some(target => target.id === selectedTarget.value)) selectedTarget.value = '';
  const pending = deleting.value;
  if (pending && !(value.preview?.id === pending.captureId && value.preview.revision === pending.revision) &&
    !value.saved.some(saved => saved.captureId === pending.captureId && saved.revision === pending.revision)) deleting.value = null;
}
async function readState(): Promise<void> {
  const expectedGeneration = generation;
  try { if (bridge) acceptState(await bridge.getScreenState(), expectedGeneration); }
  catch { if (mounted && generation === expectedGeneration && props.brain.phase === 'ready') localError.value = 'storage_unavailable'; }
}
async function run(action: string, work: () => Promise<ScreenCommandResult>): Promise<void> {
  const expectedGeneration = generation, version = ++commandVersion;
  localAction.value = action; localError.value = null;
  try {
    const result = await work();
    if (!mounted || generation !== expectedGeneration || version !== commandVersion) return;
    if (!result.ok) localError.value = result.code;
    else if (action === 'delete') deleting.value = null;
  } catch {
    if (mounted && generation === expectedGeneration && version === commandVersion)
      localError.value = action === 'delete' ? 'deletion_unconfirmed' : 'storage_unavailable';
  } finally {
    if (generation === expectedGeneration && version === commandVersion) localAction.value = null;
  }
}
function listTargets(): void {
  if (bridge && canManage.value && !screens.value.preview) void run('list', () => bridge.listScreenSources());
}
function capture(): void {
  if (bridge && canCapture.value) {
    const input = { sourceId: selectedTarget.value, boundary: selectedBoundary.value };
    void run('capture', () => bridge.captureScreen(input));
  }
}
function analyze(): void {
  const preview = screens.value.preview, selected = modelId.value;
  if (bridge && preview && (selected || automatic.value) && canAnalyze.value) {
    const input = { captureId: preview.id, revision: preview.revision, modelId: selected, prompt: prompt.value.trim() };
    void run('analyze', async () => { try { return await bridge.analyzeScreen(input); } finally { await bridge.refreshRouting(); } });
  }
}
function cancel(): void {
  if (bridge && canCancel.value) void run('cancel', () => bridge.cancelScreenAnalysis());
}
function useAnalysis(): void {
  const preview = screens.value.preview;
  if (bridge && canManage.value && preview && screens.value.analysis && !analysisSelected.value)
    void run('use', () => bridge.useScreenAnalysis({ captureId: preview.id, revision: preview.revision }));
}
function releasePreview(): void {
  if (bridge && canManage.value && screens.value.preview && screens.value.analysis)
    void run('release', () => bridge.releaseScreenPreview());
}
function requestDelete(captureId: string, revision: number, title: string): void {
  if (canManage.value) deleting.value = { captureId, revision, title };
}
function confirmDelete(): void {
  const pending = deleting.value;
  if (bridge && canManage.value && pending)
    void run('delete', () => bridge.deleteScreenCapture({ captureId: pending.captureId, revision: pending.revision }));
}
function refreshHistory(): void {
  if (bridge && canManage.value) void run('refresh', () => bridge.refreshSavedScreens());
}

watch(() => props.brain.phase, phase => {
  if (phase !== 'ready') resetLocal();
  else if (mounted) void readState();
}, { flush: 'sync' });
watch(() => screens.value.preview?.id, (id, previous) => {
  imageLoaded.value = false; imageFailed.value = false;
  if (!id && previous) { selectedBoundary.value = 'local'; selectedTarget.value = ''; }
});
onMounted(() => {
  mounted = true;
  if (!bridge) return;
  unsubscribe = bridge.subscribeScreens(value => acceptState(value));
  if (props.brain.phase === 'ready') void readState();
});
onUnmounted(() => { mounted = false; unsubscribe?.(); resetLocal(); });
</script>

<template>
  <details class="screen-panel" data-testid="screen-panel">
    <summary data-testid="screen-toggle"><span>화면 함께 보기</span><span class="summary-hint" data-testid="screen-status">{{ connected ? phaseLabel : '연결 후 사용' }}</span></summary>
    <div class="panel-content" :aria-busy="busy">
      <p class="hint privacy-copy">선택한 화면을 버튼으로 한 장씩 가져와요. 자동으로 캡처하거나 분석하지 않아요.</p>
      <p v-if="!connected" class="notice" role="status">대화 서비스에 연결하면 화면을 함께 볼 수 있어요.</p>
      <p v-else-if="!enabled" class="notice" role="status">현재 대화 작업이 끝나면 화면 작업을 시작할 수 있어요.</p>
      <p v-if="error" class="error-copy" role="alert" data-testid="screen-error">{{ errorMessage(error) }}</p>

      <section v-if="!screens.preview" class="capture-setup">
        <label for="screen-boundary">이번 캡처의 사용 범위</label>
        <select id="screen-boundary" v-model="selectedBoundary" data-testid="screen-boundary" :disabled="!canManage">
          <option value="local">이 PC에서만</option><option value="private_lan">개인 LAN까지 허용</option>
        </select>
        <p class="hint">{{ selectedBoundary === 'local' ? '이미지와 분석 내용을 이 PC의 모델에서만 사용할 수 있어요.' : '이미지와 분석 내용을 연결한 개인 LAN 서버에서도 처리하도록 허용해요.' }}</p>
        <button type="button" data-testid="screen-list" :disabled="!canManage" @click="listTargets">{{ screens.phase === 'listing' ? '목록 확인 중…' : '화면·창 목록 보기' }}</button>
        <template v-if="screens.targets.length">
          <label for="screen-target">가져올 화면 또는 창</label>
          <select id="screen-target" v-model="selectedTarget" data-testid="screen-target" :disabled="!canManage">
            <option value="">직접 선택해 주세요</option>
            <option v-for="target in screens.targets" :key="target.id" :value="target.id">{{ target.kind === 'screen' ? '화면' : '창' }} · {{ target.name }}</option>
          </select>
          <button type="button" class="primary-button" data-testid="screen-capture" :disabled="!canCapture" @click="capture">선택한 화면 한 장 가져오기</button>
        </template>
        <button v-if="screens.phase === 'capturing'" type="button" data-testid="screen-cancel" :disabled="!canCancel" @click="cancel">화면 가져오기 취소</button>
      </section>

      <section v-else class="preview-section" data-testid="screen-preview">
        <div class="section-heading"><h3>{{ screens.preview.title }}</h3><span class="tag">{{ boundaryLabel(screens.preview.boundary) }}</span></div>
        <img v-if="previewUrl" :key="screens.preview.id" :src="previewUrl" class="preview-image" data-testid="screen-preview-image" alt="분석 전에 확인하는 선택한 화면 한 장" @load="imageLoaded = true" @error="imageFailed = true" />
        <p v-if="!previewUrl || imageFailed" class="error-copy">미리보기를 표시하지 못했어요. 이 캡처를 삭제한 뒤 다시 가져와 주세요.</p>
        <p class="hint">{{ dateLabel(screens.preview.capturedAt) }} · {{ screens.preview.width }} × {{ screens.preview.height }}<br />사용 범위를 바꾸려면 이 캡처를 삭제하고 다시 가져와 주세요.</p>
        <p class="hint">앱 미리보기는 연결 해제 시 지워요. 분석 서버의 임시 이미지는 10분 후 재사용이 만료돼요. 분석 내용은 삭제할 때까지 보관해요.</p>

        <label for="screen-model">이번 화면을 분석할 모델</label>
        <select id="screen-model" v-model="selectedModelId" data-testid="screen-model" :disabled="!canManage || !!screens.analysis">
          <option value="">{{ automatic ? '자동 선택 · 화면 사용 범위 적용' : `현재 대화 모델${currentModel ? ` · ${currentModel.label}` : ' · 선택되지 않음'}` }}</option>
          <option v-for="option in brain.models" :key="option.id" :value="option.id">{{ modelLabel(option) }}</option>
        </select>
        <p v-if="modelProblem && !screens.analysis" class="notice" data-testid="screen-model-warning">{{ modelProblem }}</p>
        <p v-else-if="model && !screens.analysis" class="hint" data-testid="screen-analysis-scope">{{ model.label }} · {{ model.boundary === 'local' ? '이 PC에서 처리' : '허용한 개인 LAN에서 처리' }}. 아래 버튼을 누르면 이 한 장과 요청 내용을 분석해요.</p>
        <label for="screen-prompt">화면에서 확인할 내용</label>
        <textarea id="screen-prompt" v-model="prompt" rows="3" maxlength="4096" data-testid="screen-prompt" :disabled="!canManage || !!screens.analysis" placeholder="이 화면에서 어떤 내용을 확인할까요?" />
        <p v-if="promptLength > 2048" class="error-copy">요청 내용은 2,048자 이내로 줄여 주세요.</p>
        <div class="button-row">
          <button type="button" class="quiet-button" data-testid="screen-delete" :disabled="!canManage" @click="requestDelete(screens.preview.id, screens.preview.revision, screens.preview.title)">캡처와 분석 삭제</button>
          <button v-if="screens.phase === 'analyzing'" type="button" data-testid="screen-cancel" :disabled="!canCancel" @click="cancel">분석 취소</button>
          <button v-else type="button" class="primary-button" data-testid="screen-analyze" :disabled="!canAnalyze" @click="analyze">{{ screens.analysis ? '분석 완료' : '이 화면 분석' }}</button>
        </div>
        <p v-if="screens.phase === 'analyzing'" class="hint" role="status">선택한 모델로 화면을 분석하고 있어요. 취소해도 이전에 완료된 분석 기록은 남아요.</p>

        <section v-if="screens.analysis" class="analysis-result" data-testid="screen-analysis">
          <h3>화면 분석 결과</h3>
          <p class="analysis-text" data-testid="screen-analysis-text">{{ screens.analysis.text }}</p>
          <p data-testid="screen-routing-reason">{{ routingReason(screens.analysis.routingReason) }}</p>
          <p v-if="screens.analysis.cached" class="hint">이전에 완료된 동일 분석을 불러왔어요.</p>
          <p class="hint" data-testid="screen-actual-model">실제 분석 모델 · {{ screens.analysis.actualModel.provider_id }} / {{ screens.analysis.actualModel.model_id }}</p>
          <p class="hint">대화에 쓰려면 참고 자료로 선택해 주세요. 분석을 보관한 채 새 화면을 가져오거나, 필요 없는 기록은 삭제할 수 있어요.</p>
          <button type="button" data-testid="screen-use" :disabled="!canManage || analysisSelected" @click="useAnalysis">{{ analysisSelected ? '대화 참고 자료로 선택됨' : '대화 참고 자료로 선택' }}</button>
          <button type="button" class="quiet-button" data-testid="screen-release" :disabled="!canManage" @click="releasePreview">분석 보관하고 새 캡처 준비</button>
        </section>
      </section>

      <section class="saved-section" data-testid="screen-history">
        <div class="section-heading"><h3>보관한 화면 기록</h3><button type="button" class="quiet-button" data-testid="screen-history-refresh" :disabled="!canManage" @click="refreshHistory">기록 새로 확인</button></div>
        <p class="hint">분석 내용은 다시 실행해도 ‘기억과 대화’에 남아요. 화면 이미지는 PC 파일로 저장하지 않아요.</p>
        <p v-if="history.length === 0" class="empty-state">{{ screens.preview ? '현재 캡처 외에 보관한 기록이 없어요.' : '보관한 화면 기록이 없어요.' }}</p>
        <article v-for="saved in history" :key="saved.captureId" class="saved-card" data-testid="screen-history-item" :data-capture-id="saved.captureId">
          <div class="section-heading"><h3>{{ saved.title }}</h3><span class="tag">{{ boundaryLabel(saved.boundary) }}</span></div>
          <p class="hint">{{ dateLabel(saved.capturedAt) }} · {{ saved.imageAvailable ? '임시 이미지 남아 있음' : '이미지는 지워짐' }}</p>
          <p v-if="saved.actualModel" class="hint">분석 모델 · {{ saved.actualModel.provider_id }} / {{ saved.actualModel.model_id }}</p>
          <p v-if="saved.routingReason" class="hint">{{ routingReason(saved.routingReason) }}</p>
          <p v-else class="hint">완료된 분석이 없는 캡처 기록이에요.</p>
          <button type="button" class="quiet-button" data-testid="screen-history-delete" :disabled="!canManage" :aria-label="`${saved.title} 화면 기록 삭제`" @click="requestDelete(saved.captureId, saved.revision, saved.title)">기록과 분석 삭제</button>
        </article>
      </section>

      <section v-if="deleting" class="delete-review" data-testid="screen-delete-review">
        <h3>{{ deleting.title }} 기록을 삭제할까요?</h3>
        <p>캡처와 분석 내용, 이를 바탕으로 만든 참고 기록도 함께 지워요. 삭제가 확인되기 전에는 완료로 표시하지 않아요.</p>
        <div class="button-row"><button type="button" :disabled="busy" @click="deleting = null">기록 유지</button><button type="button" class="delete-button" data-testid="screen-delete-confirm" :disabled="!canManage" @click="confirmDelete">캡처와 분석 기록 삭제</button></div>
      </section>
    </div>
  </details>
</template>

<style scoped>
.screen-panel { min-width: 0; flex: none; border-top: 1px solid var(--line); color: #e1dce9; font-size: 12px; }
summary { padding: 11px 2px; cursor: pointer; font-weight: 600; -webkit-app-region: no-drag; }
.summary-hint { margin-left: 10px; color: var(--quiet); font-size: 10px; font-weight: 400; }
.panel-content { display: grid; gap: 12px; max-height: min(560px, 60dvh); overflow: auto; padding: 3px 3px 14px; scrollbar-width: thin; scrollbar-color: #544b64 transparent; }
h3, p { margin: 0; }
h3 { min-width: 0; font-size: 12px; font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; }
.hint, .notice, .empty-state { color: var(--muted); font-size: 11px; line-height: 1.75; overflow-wrap: anywhere; }
.notice, .empty-state { padding: 9px; border-radius: 7px; background: #ffffff04; }
.privacy-copy { color: #c5b4df; }
.capture-setup, .preview-section, .saved-section, .saved-card, .analysis-result, .delete-review { display: grid; gap: 8px; min-width: 0; }
.capture-setup, .preview-section, .saved-card { padding: 11px; border: 1px solid #c0aaf616; border-radius: 9px; background: #ffffff02; }
.section-heading, .button-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.section-heading { justify-content: space-between; }
.button-row { justify-content: flex-end; }
label { color: var(--muted); font-size: 11px; }
button, select, textarea { font: inherit; -webkit-app-region: no-drag; }
button { padding: 7px 9px; border: 1px solid #c0aaf625; border-radius: 7px; background: #c0aaf60d; color: #d9c8f5; font-size: 11px; line-height: 1.5; }
button:hover:not(:disabled) { background: #c0aaf622; }
button:disabled, select:disabled, textarea:disabled { opacity: .45; }
button:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
select, textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid #ffffff12; border-radius: 7px; background: #15151e; color: #e6e0ed; font-size: 11px; }
textarea { resize: vertical; min-height: 65px; max-height: 180px; line-height: 1.7; }
.primary-button { background: #c0aaf622; }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.tag { flex: none; padding: 3px 6px; border-radius: 5px; background: #c0aaf60d; color: #c9b6ea; font-size: 10px; }
.preview-image { display: block; width: 100%; max-height: 280px; object-fit: contain; border-radius: 6px; background: #0d0d13; }
.analysis-result { padding: 10px; border-radius: 8px; background: #c0aaf608; }
.analysis-text { color: #e4dced; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.error-copy { padding: 8px; border-radius: 6px; background: #c7879908; color: #dfb4c1; font-size: 11px; line-height: 1.75; overflow-wrap: anywhere; }
.saved-card { border-color: #ffffff0d; }
.saved-card > button { justify-self: end; }
.delete-review { padding: 10px; border: 1px solid #dfb4c125; border-radius: 8px; font-size: 11px; line-height: 1.7; }
.delete-review p { overflow-wrap: anywhere; }
.delete-button { color: #edb7c4; border-color: #edb7c42a; }
@media (max-width: 400px) { .summary-hint { display: none; } .button-row { align-items: stretch; flex-direction: column; } .preview-image { max-height: 200px; } }
</style>
