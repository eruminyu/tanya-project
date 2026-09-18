<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { CommandResult, DesktopSnapshot } from '../shared/bridge.js';
import ChatPanel from './components/ChatPanel.vue';
import ConnectionPanel from './components/ConnectionPanel.vue';
import RoutingPanel from './components/RoutingPanel.vue';
import PresencePanel from './components/PresencePanel.vue';
import WindowBar from './components/WindowBar.vue';
import WindowSettingsPanel from './components/WindowSettingsPanel.vue';
import RuntimePanel from './components/RuntimePanel.vue';
import { emptyWindowControls } from '../shared/window-controls.js';
import MemoryPanel from './components/MemoryPanel.vue';
import ActionsPanel from './components/ActionsPanel.vue';
import ExternalToolsPanel from './components/ExternalToolsPanel.vue';
import NoteFoldersPanel from './components/NoteFoldersPanel.vue';
import ScreenPanel from './components/ScreenPanel.vue';
import AutoScreenPanel from './components/AutoScreenPanel.vue';
import ProactivePanel from './components/ProactivePanel.vue';
import NoteEditingPanel from './components/NoteEditingPanel.vue';
import { useNoteEditing } from './note-editing.js';
import { emptyNoteFolders } from '../shared/note-folders.js';
import { emptyLibrary } from '../shared/persistence.js';
import type { ActionView } from '../shared/actions.js';
import { SpeechPlayer } from './audio/speech-player.js';
import { MicrophoneCapture, type MicrophoneState } from './audio/microphone.js';

const bridge = window.kirianDesktop;
const browserPreview = bridge === undefined;
const snapshot = shallowRef<DesktopSnapshot>({
  session: {
    revision: 0,
    connection: { phase: 'disconnected', reason: null },
    actualModel: null,
    messages: [],
    activeTurnId: null,
  },
  brain: {
    phase: 'disconnected',
    reason: null,
    url: '',
    models: [],
    selectedModelId: null,
    speech: { available: false, enabled: false, label: null, phase: 'idle', sentence: null, error: null },
    transcription: { available: false, label: null },
  },
  window: { alwaysOnTop: false, ...emptyWindowControls() },
  capabilities: { chat: false, voice: false, live2d: false },
  library: emptyLibrary(),
  noteFolders: emptyNoteFolders(),
});
const loading = ref(!browserPreview);
const draft = ref('');
function reviewExternal(){const panel=document.querySelector<HTMLDetailsElement>('[data-testid="external-panel"]');if(panel){panel.open=true;panel.scrollIntoView({block:'nearest'});}}
const submitting = ref(false);
const pinPending = ref(false);
const brainPending = ref<
  'connect' | 'disconnect' | 'reconnect' | 'model' | null
>(null);
const cancelPending = ref(false);
const notice = ref('');
const libraryPending = ref(false), actionPending = ref(false);
const actions = ref<ActionView[]>([]);
let actionGeneration = 0;
const panelGeneration = ref(0);
const mouthOpen = ref(0), speaking = ref(false);
const microphoneState = ref<MicrophoneState>('idle');
const player = bridge ? new SpeechPlayer(bridge, (level, active) => { mouthOpen.value = level; speaking.value = active; },
  () => { notice.value = '음성을 재생하지 못했어요. 대화 내용은 화면에서 확인할 수 있어요.'; }) : null;
const microphone = bridge ? new MicrophoneCapture(bridge, state => { microphoneState.value = state; },
  async text => { draft.value = text; await sendMessage(); }, message => { notice.value = message; }) : null;
let disposed = false;
let receivedSnapshot = 0;
let unsubscribe: (() => void) | undefined;
let unsubscribeAudio: (() => void) | undefined;

const connected = computed(() => snapshot.value.brain.phase === 'ready');
const writableFolderIds = computed(() => snapshot.value.noteFolders.folders.filter(folder => folder.writeEnabled).map(folder => folder.id));
const editAvailable = computed(() => connected.value && snapshot.value.noteFolders.available);
const editing = useNoteEditing(bridge, editAvailable, panelGeneration);
watch(writableFolderIds, ids => {
  const folderId = editing.document.value?.folderId ?? editing.review.value?.folderId;
  if (folderId && !ids.includes(folderId)) editing.close();
});
const activeTurn = computed(() => snapshot.value.session.activeTurnId !== null);
const canSend = computed(
  () =>
    Boolean(bridge) &&
    !loading.value &&
    brainPending.value === null &&
    connected.value &&
    snapshot.value.capabilities.chat &&
    !libraryPending.value &&
    !(snapshot.value.library.defaultMissing && snapshot.value.brain.selectedModelId === null) &&
    microphoneState.value === 'idle'
);
const messages = computed(() => snapshot.value.session.messages);
const connectionLabel = computed(() => {
  if (browserPreview) return '화면 미리보기';
  if (loading.value) return '상태 확인 중';
  switch (snapshot.value.brain.phase) {
    case 'ready':
      return '연결됨';
    case 'connecting':
      return '연결 중';
    case 'error':
      return '연결 오류';
    default:
      return '연결 안 됨';
  }
});
const connectionDescription = computed(() => {
  if (browserPreview)
    return '이 화면은 미리보기예요. 실제 대화는 아직 연결되지 않았어요.';
  if (loading.value) return '앱의 연결 상태를 확인하고 있어요.';
  if (
    snapshot.value.brain.phase === 'connecting' ||
    brainPending.value === 'connect' ||
    brainPending.value === 'reconnect'
  )
    return '대화 서비스에 연결하고 있어요. 잠시 기다려 주세요.';
  if (snapshot.value.brain.phase === 'error')
    return connectionError(snapshot.value.brain.reason);
  if (brainPending.value === 'model')
    return '대화에 사용할 모델을 변경하고 있어요.';
  if (brainPending.value === 'disconnect')
    return '대화 서비스 연결을 해제하고 있어요.';
  if (connected.value && !snapshot.value.capabilities.chat) {
    return '연결되어 있지만 지금은 텍스트 대화를 사용할 수 없어요.';
  }
  if (
    connected.value &&
    snapshot.value.capabilities.chat &&
    snapshot.value.session.activeTurnId !== null
  ) {
    return '키리안이 답변하고 있어요. 잠시 기다려 주세요.';
  }
  if (connected.value) return '메시지를 보내 대화를 시작해 보세요.';
  return '대화 서비스가 아직 연결되지 않았어요. 연결 설정에서 서비스를 연결해 주세요.';
});
const modelLabel = computed(
  () =>
    snapshot.value.session.actualModel?.modelId ?? '아직 처리된 응답이 없어요'
);
const modelDetail = computed(
  () => snapshot.value.session.actualModel?.providerId ?? ''
);

function applySnapshot(next: DesktopSnapshot): void {
  if (disposed || next.session.revision < snapshot.value.session.revision)
    return;
  receivedSnapshot += 1;
  if (next.brain.phase !== 'ready' && microphoneState.value !== 'idle') microphone?.cancel();
  const becameReady = next.brain.phase === 'ready' && snapshot.value.brain.phase !== 'ready';
  const wasConnected = snapshot.value.brain.phase === 'ready';
  if (next.brain.phase !== 'ready') { actions.value = []; actionGeneration++; if (wasConnected) panelGeneration.value++; }
  snapshot.value = next;
  loading.value = false;
  if (becameReady) void refreshActions();
}

async function refreshSnapshot(): Promise<void> {
  if (!bridge) return;
  const before = receivedSnapshot;
  const next = await bridge.getSnapshot();
  if (!disposed && before === receivedSnapshot) applySnapshot(next);
}

function commandError(result: CommandResult): string {
  if (result.ok) return '';
  switch (result.code) {
    case 'storage_unavailable': return '저장소를 읽거나 기록하지 못했어요. 변경이 저장됐는지 확인해 주세요.';
    case 'note_write_unknown': return '원본 편집의 완료 여부를 확인할 수 없어 폴더 연결을 해제하지 않았어요. 원본 편집 기록에서 먼저 복구해 주세요.';
    case 'source_changed': return '자료가 변경되었어요. 새로 불러온 뒤 다시 선택해 주세요.';
    case 'default_unavailable': return '저장된 모델을 사용할 수 없어요. 사용할 모델을 직접 선택해 주세요.';
    case 'routing_changed': return '자동 선택 설정이 변경되었어요. 최신 설정을 확인한 뒤 다시 보내 주세요.';
    case 'routing_no_candidate': return '입력 능력·자료 사용 범위·남은 한도를 충족하는 자동 선택 모델이 없어요.';
    case 'routing_limit': return '오늘의 모델 호출 또는 예약 단위 한도에 도달했어요.';
    case 'persistence_unavailable': return '자동 설정을 유지할 저장소를 사용할 수 없어요.';
    case 'brain_unavailable':
      return '대화 서비스가 연결되지 않았어요. 연결 설정을 확인해 주세요.';
    case 'window_unavailable':
      return '창을 조작하지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'busy':
      return '진행 중인 요청이 있어요. 잠시 후 다시 시도해 주세요.';
    case 'auth_failed':
    case 'connection_failed':
    case 'invalid_response':
    case 'endpoint_not_allowed':
    case 'protocol_error':
      return connectionError(result.code);
    default:
      return '요청을 처리하지 못했어요. 입력한 내용을 확인해 주세요.';
  }
}

function connectionError(code: string | null): string {
  switch (code) {
    case 'auth_failed':
      return '인증하지 못했어요. 연결 설정의 토큰을 확인해 주세요.';
    case 'connection_failed':
      return '대화 서비스에 연결할 수 없어요. 주소와 서비스 실행 상태를 확인해 주세요.';
    case 'endpoint_not_allowed':
      return '허용된 대화 서비스 주소를 사용해 주세요.';
    case 'invalid_response':
    case 'protocol_error':
      return '대화 서비스의 응답을 확인하지 못했어요. 서비스 설정을 확인한 후 다시 연결해 주세요.';
    default:
      return '대화 서비스 연결이 끊겼어요. 연결 설정에서 다시 연결해 주세요.';
  }
}

async function runBrainCommand(
  kind: 'connect' | 'disconnect' | 'reconnect' | 'model',
  command: () => Promise<CommandResult>
): Promise<boolean> {
  if (!bridge || brainPending.value !== null) return false;
  brainPending.value = kind;
  notice.value = '';
  try {
    const result = await command();
    if (disposed) return result.ok;
    notice.value = commandError(result);
    if (result.ok) {
      try {
        await refreshSnapshot();
      } catch {
        if (!disposed)
          notice.value = '요청은 처리했지만 최신 상태를 불러오지 못했어요.';
      }
    }
    return result.ok;
  } catch {
    if (!disposed)
      notice.value =
        '대화 서비스 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
    return false;
  } finally {
    if (!disposed) brainPending.value = null;
  }
}

async function connectBrain(options: {
  url: string;
  token: string;
}): Promise<boolean> {
  if (!bridge) return false;
  return runBrainCommand('connect', () => bridge.connectBrain(options));
}

async function changeConnection(
  kind: 'disconnect' | 'reconnect'
): Promise<void> {
  if (!bridge) return;
  await runBrainCommand(kind, () =>
    kind === 'disconnect' ? bridge.disconnectBrain() : bridge.reconnectBrain()
  );
}

async function selectModel(id: string | null): Promise<void> {
  if (!bridge || !connected.value || activeTurn.value) return;
  await runBrainCommand('model', () => bridge.selectModel(id));
}

async function cancelTurn(): Promise<void> {
  if (!bridge || !connected.value || !activeTurn.value || cancelPending.value)
    return;
  cancelPending.value = true;
  notice.value = '';
  try {
    const result = await bridge.cancelTurn();
    if (disposed) return;
    notice.value = commandError(result);
    if (result.ok) await refreshSnapshot();
  } catch {
    if (!disposed)
      notice.value =
        '답변 중단 상태를 확인하지 못했어요. 연결 상태를 확인해 주세요.';
  } finally {
    if (!disposed) cancelPending.value = false;
  }
}

async function togglePin(): Promise<void> {
  if (!bridge || pinPending.value) return;
  pinPending.value = true;
  notice.value = '';
  try {
    const result = await bridge.setAlwaysOnTop(
      !snapshot.value.window.alwaysOnTop
    );
    if (disposed) return;
    notice.value = commandError(result);
    if (result.ok) await refreshSnapshot();
  } catch {
    if (!disposed) notice.value = '항상 위에 표시 설정을 변경하지 못했어요.';
  } finally {
    if (!disposed) pinPending.value = false;
  }
}

async function windowCommand(kind: 'minimize' | 'close'): Promise<void> {
  if (!bridge) return;
  notice.value = '';
  try {
    const result = await bridge[kind]();
    if (!disposed) notice.value = commandError(result);
  } catch {
    if (!disposed)
      notice.value = '창을 조작하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!bridge || !canSend.value || submitting.value || !text) return;
  submitting.value = true;
  notice.value = '';
  try {
    if (snapshot.value.brain.speech.enabled) await player?.unlock();
    if (activeTurn.value) {
      const cancelled = await bridge.cancelTurn();
      if (!cancelled.ok) { notice.value = commandError(cancelled); return; }
    }
    const result = await bridge.sendText(text);
    if (disposed) return;
    notice.value = commandError(result);
    if (result.ok) draft.value = '';
  } catch {
    if (!disposed)
      notice.value = '메시지를 보내지 못했어요. 입력한 내용은 그대로 두었어요.';
  } finally {
    if (!disposed) submitting.value = false;
  }
}

async function toggleVoice(): Promise<void> {
  if (!bridge || activeTurn.value) return;
  notice.value = '';
  try {
    const enabled = !snapshot.value.brain.speech.enabled;
    if (enabled) await player?.unlock();
    const result = await bridge.setVoiceEnabled(enabled);
    if (!result.ok) notice.value = commandError(result);
  } catch { notice.value = '음성 재생을 시작하지 못했어요.'; }
}
async function microphoneAction(): Promise<void> {
  if (!bridge || !microphone) return;
  if (microphoneState.value === 'recording') { microphone.finish(); return; }
  if (microphoneState.value !== 'idle') { microphone.cancel(); return; }
  notice.value = '';
  if (activeTurn.value && !(await bridge.cancelTurn()).ok) return;
  try { await player?.unlock(); await microphone.start(); }
  catch { notice.value = '마이크를 시작하지 못했어요.'; }
}

async function libraryCommand(operation: () => Promise<CommandResult>): Promise<void> {
  if (libraryPending.value) return;
  libraryPending.value = true; notice.value = '';
  try {
    const result = await operation();
    if (!disposed) { notice.value = commandError(result); await refreshSnapshot(); }
  } catch { if (!disposed) notice.value = '저장된 내용을 확인하지 못했어요. 다시 불러와 주세요.'; }
  finally { if (!disposed) libraryPending.value = false; }
}
async function setNoteWritePermission(input: {id: string; enabled: boolean}): Promise<void> {
  if (!bridge) return;
  if (input.enabled) { await libraryCommand(() => bridge.setNoteFolderWriteEnabled(input)); return; }
  // Revocation must reach main even while a library synchronization is pending.
  try {
    const result = await bridge.setNoteFolderWriteEnabled(input);
    if (!disposed) { notice.value = commandError(result); await refreshSnapshot(); }
  } catch { if (!disposed) notice.value = '원본 편집을 끄는 설정을 저장하지 못했어요. 폴더 권한을 다시 확인해 주세요.'; }
}
async function refreshActions(): Promise<void> {
  if (!bridge || !connected.value) return;
  const generation = actionGeneration;
  try { const value = await bridge.listActions(); if (!disposed && generation === actionGeneration) actions.value = value; }
  catch { if (!disposed && generation === actionGeneration) notice.value = '승인한 작업 기록을 불러오지 못했어요.'; }
}
async function actionCommand(operation: () => Promise<unknown>): Promise<void> {
  if (actionPending.value) return;
  actionPending.value = true; notice.value = ''; const generation = actionGeneration;
  try { await operation(); }
  catch { if (!disposed && generation === actionGeneration) notice.value = '작업 결과를 확인하지 못했어요. 결과가 불명확한 작업은 다시 실행하지 않아요.'; }
  finally { if (!disposed) { actionPending.value = false; await refreshActions(); } }
}
const suggestedNote = computed(() => [...messages.value].reverse().find(message => message.role === 'assistant' && message.status === 'completed')?.text ?? '');

onMounted(async () => {
  if (!bridge) return;
  try {
    unsubscribe = bridge.subscribe(applySnapshot);
    unsubscribeAudio = bridge.onAudio(event => player?.accept(event));
    await refreshSnapshot();
  } catch {
    if (!disposed) {
      loading.value = false;
      notice.value = '앱의 상태를 불러오지 못했어요. 창을 다시 열어 주세요.';
    }
  }
});

onUnmounted(() => {
  disposed = true;
  unsubscribe?.();
  unsubscribeAudio?.(); microphone?.cancel(); void player?.dispose();
});
</script>

<template>
  <div class="desktop-shell" data-testid="desktop-shell">
    <WindowBar
      :always-on-top="snapshot.window.alwaysOnTop"
      :enabled="!browserPreview"
      :busy="pinPending"
      @toggle-pin="togglePin"
      @minimize="windowCommand('minimize')"
      @close="windowCommand('close')"
    />
    <div v-if="snapshot.window.clickThrough" class="click-through-notice" role="status" data-testid="click-through-notice">
      클릭 통과 켜짐 · {{ snapshot.window.recoveryShortcut }}로 키리안 창 복구
    </div>
    <main class="workspace">
      <PresencePanel :mouth-open="mouthOpen" :speaking="speaking" :emotion="speaking ? 'happy' : 'neutral'"
        :audio-status="snapshot.brain.speech.phase === 'error' ? '음성 연결을 확인해 주세요.' : (speaking ? '키리안이 말하고 있어요.' : '키리안과 이야기를 나눠 보세요.')" />
      <ChatPanel
        v-model="draft"
        :messages="messages"
        :can-send="canSend"
        :submitting="submitting"
        :connection-label="connectionLabel"
        :connection-description="connectionDescription"
        :connected="connected"
        :model-label="modelLabel"
        :model-detail="modelDetail"
        :active-turn="activeTurn"
        :cancel-pending="cancelPending"
        :can-cancel="!browserPreview && connected"
        @submit="sendMessage"
        @cancel="cancelTurn"
      >
        <template #tools-status>
          <p v-if="snapshot.conversationTools?.phase==='awaiting_approval'" data-testid="conversation-tool-pending" role="status">
            외부 도구 실행 승인을 기다리고 있어요. <button class="secondary-button" @click="reviewExternal">실행 내용 검토</button>
          </p>
          <p v-else-if="snapshot.conversationTools?.phase==='running'" role="status">승인한 도구를 실행 중이에요. 결과가 확인될 때까지 같은 작업을 반복하지 마세요.</p>
          <p v-else-if="snapshot.conversationTools?.phase==='summarizing'" role="status">실행 기록을 대화에 연결하고 있어요.</p>
          <p v-else-if="snapshot.conversationTools?.phase==='unavailable'" role="status">도구 제안을 이어갈 수 없어요. 외부 도구 패널에서 실행 기록을 확인해 주세요.</p>
        </template>
        <template #connection-settings>
          <WindowSettingsPanel :state="snapshot.window" :enabled="!browserPreview && !loading" />
          <RuntimePanel />
          <ConnectionPanel
            :brain="snapshot.brain"
            :enabled="!browserPreview && !loading"
            :busy="brainPending !== null"
            :active-turn="activeTurn || microphoneState !== 'idle'"
            :connect="connectBrain"
            @disconnect="changeConnection('disconnect')"
            @reconnect="changeConnection('reconnect')"
            @select-model="selectModel"
          />
          <div class="voice-controls">
            <button type="button" class="secondary-button" data-testid="voice-toggle" :aria-pressed="snapshot.brain.speech.enabled"
              :disabled="!connected || !snapshot.brain.speech.available || activeTurn" @click="toggleVoice">
              {{ snapshot.brain.speech.enabled ? '음성 출력 켜짐' : '음성 출력 꺼짐' }}
            </button>
            <button type="button" class="secondary-button microphone-button" data-testid="microphone-toggle"
              :disabled="!connected || !snapshot.brain.transcription.available" :aria-pressed="microphoneState === 'recording'" @click="microphoneAction">
              {{ microphoneState === 'recording' ? '녹음 끝내고 보내기' : microphoneState === 'transcribing' ? '인식 취소' : microphoneState === 'requesting' ? '시작 취소' : '마이크로 말하기' }}
            </button>
            <span class="voice-hint" data-testid="voice-status">
              {{ microphoneState === 'recording' ? '녹음 중 · 최대 30초' : microphoneState === 'transcribing' ? '말씀을 인식하고 있어요' : snapshot.brain.speech.label ? `음성: ${snapshot.brain.speech.label}` : '음성 서비스 설정 전' }}
            </span>
            <button v-if="microphoneState === 'recording'" class="secondary-button" type="button" data-testid="microphone-cancel" @click="microphone?.cancel()">녹음 취소</button>
          </div>
          <div v-if="snapshot.library.available" class="persistence-settings">
            <button class="secondary-button" type="button" data-testid="default-model-save"
              :disabled="!connected || activeTurn || libraryPending" @click="libraryCommand(() => bridge!.saveDefaultModel())">선택한 모델을 기본값으로 저장</button>
            <small>앱을 다시 열어도 새 대화에서 사용할 모델</small>
            <p v-if="snapshot.library.defaultMissing" role="alert">저장된 기본 모델을 사용할 수 없어요. 모델을 직접 선택해 주세요.</p>
          </div>
          <RoutingPanel :brain="snapshot.brain" />
          <ExternalToolsPanel :key="`external-${panelGeneration}`" :enabled="connected" :conversation="snapshot.conversationTools" />
          <ScreenPanel :brain="snapshot.brain" :library="snapshot.library" :enabled="connected && !libraryPending" />
          <AutoScreenPanel :brain="snapshot.brain" />
          <ProactivePanel :brain="snapshot.brain" @review-external="reviewExternal" />
          <NoteFoldersPanel :key="`notes-${panelGeneration}`" :state="snapshot.noteFolders" :enabled="connected && !libraryPending"
            @write-permission="setNoteWritePermission"
            @edit-file="editing.choose"
            @choose="boundary => libraryCommand(() => bridge!.chooseNoteFolder(boundary))"
            @refresh="id => libraryCommand(() => bridge!.syncNoteFolder(id))"
            @remove="id => libraryCommand(() => bridge!.removeNoteFolder(id))"
            @boundary="(id, boundary) => libraryCommand(() => bridge!.setNoteFolderBoundary({id, boundary}))" />
          <MemoryPanel :key="`memory-${panelGeneration}`" :library="snapshot.library" :enabled="connected" :busy="libraryPending || activeTurn || microphoneState !== 'idle'"
            :note-folders="snapshot.noteFolders.folders"
            :writable-folder-ids="writableFolderIds" @edit-file="editing.open"
            @refresh="query => libraryCommand(() => bridge!.refreshLibrary(query))"
            @create="input => libraryCommand(() => bridge!.createSource(input))"
            @update="input => libraryCommand(() => bridge!.updateSource(input))"
            @remove="input => libraryCommand(() => bridge!.deleteSource(input))"
            @select="ids => libraryCommand(() => bridge!.selectSources(ids))"
            @conversation="id => libraryCommand(() => bridge!.openConversation(id))"
            @new-conversation="libraryCommand(() => bridge!.newConversation())"
            @delete-conversation="id => libraryCommand(() => bridge!.deleteConversation(id))" />
          <NoteEditingPanel :document="editing.document.value" :review="editing.review.value" :history="editing.history.value"
            :available="editAvailable" :busy="editing.busy.value" :error="editing.error.value"
            @preview="editing.preview" @approve="editing.approve" @dismiss="editing.dismiss"
            @review="editing.showReview" @undo="editing.undo" @close="editing.close" @refresh="editing.refresh" @forget="editing.forget" />
          <ActionsPanel :key="`actions-${panelGeneration}`" :actions="actions" :enabled="connected" :busy="actionPending" :suggested-body="suggestedNote"
            @create="input => actionCommand(() => bridge!.createNoteDraft(input))"
            @approve="input => actionCommand(() => bridge!.approveAction(input))"
            @dismiss="id => actionCommand(() => bridge!.dismissAction(id))" />
        </template>
      </ChatPanel>
    </main>
    <p v-if="notice" class="app-notice" role="alert" data-testid="app-notice">
      {{ notice }}
    </p>
    <p
      v-else-if="browserPreview"
      class="app-notice preview-notice"
      role="note"
      data-testid="browser-preview"
    >
      브라우저 미리보기 · 실제 대화와 데스크톱 창 조작은 사용할 수 없어요.
    </p>
  </div>
</template>
