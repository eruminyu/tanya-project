import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent } from "react";
import { connectionStatusText } from "./brain";
import { Live2DStage } from "./Live2DStage";
import { latestTanyaMessage, shouldCollapseWhisper } from "./whisper";
import { initialUtilityState, reduceUtilityState, type UtilityPanelKind } from "./utility-panel";
import { UtilityPanel, type UtilityDataState } from "./UtilityPanel";
import { googleCapability, googleRuntime } from "./google-integration";
import { AgentDock } from "./AgentDock";
import { initialAgentDockState, reduceAgentDockState } from "./agent-dock";
import { createCalendarDraft, createTaskDraft, initialGoogleWriteState, reduceGoogleWriteState, type GoogleWriteDraft } from "./google-write";
import { APP_SETTINGS_STORAGE_KEY, parseAppSettings } from "./settings-schema";
import { mergeVoiceTranscript } from "./voice-input";
import type { VoiceSession } from "./voice-session";
import { SCHEDULE_PUSH_INTERVAL_MS, buildScheduleContextMessage } from "./schedule-context";
import { VoiceListeningIndicator } from "./VoiceListeningIndicator";
import { SpeechCaption } from "./SpeechCaption";
import { neutralGaze, normalizeGazePoint, type GazePoint } from "./gaze-tracking";
import { useAppSettings } from "./hooks/useAppSettings";
import { useCompanionWindow } from "./hooks/useCompanionWindow";
import { useTtsAudio } from "./hooks/useTtsAudio";
import { useVoiceInput } from "./hooks/useVoiceInput";
import { useBrainConnection } from "./hooks/useBrainConnection";
import { shouldShowConversation, shouldShowConversationClose, shouldUseTauriGoogleUi, useCompactWebLayout } from "./web-layout";
import { WEB_DEMO_BOUNDARY, describeLlmRoute } from "./demo-experience";
import { TutorialPanel } from "./TutorialPanel";
import { normalizeUtterance, parseTutorialUtterance, tutorialInputKey, tutorialUtteranceContext, tutorialUtteranceExamples } from "./tutorial-utterance";
import { nearestTutorialPhrase, tutorialExampleChips } from "./tutorial-suggestion";
import { SettingsPanel } from "./SettingsPanel";
import {
  TUTORIAL_QUESTION_ID,
  TUTORIAL_SCENARIO_ID,
  NEUTRAL_TUTORIAL_PREFERENCES,
  initialTutorialPreferenceDraft,
  reduceTutorialPreferenceDraft,
  initialTutorialState,
  readTutorialFlowId,
  reduceTutorial,
  tutorialNeedsAutomaticReceipt,
  tutorialOperationTimeoutMs,
  writeTutorialFlowId,
  type TutorialActionRequest,
  type TutorialGoogleKind,
  type TutorialOperation,
  type TutorialPreferences,
  type TutorialPreparationMinutes,
} from "./tutorial";

/**
 * 마이크 도형.
 *
 * 문자 글리프(U+2381)는 무엇을 뜻하는지 읽히지 않는다. 실제 휴대폰 판정에서
 * "이게 음성 입력인지 모르겠다"는 지적을 받아 도형과 텍스트 라벨을 함께 쓴다.
 */
function MicrophoneIcon({ listening }: { listening: boolean }) {
  return (
    <svg className="voice-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3"
        fill={listening ? "currentColor" : "none"}
        stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="18" x2="12" y2="21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 상태 열거값을 그대로 읽어주지 않는다. 사람이 이해하는 문장으로 알린다. */
const VOICE_BUTTON_LABEL: Record<VoiceSession["state"], { text: string; title: string; aria: string }> = {
  idle: {
    text: "말하기",
    title: "마이크로 말하기 (Alt+V를 누르고 말해도 됩니다)",
    aria: "마이크로 말하기. 누르면 녹음을 시작하고 말이 끝나면 자동으로 멈춥니다.",
  },
  listening: {
    text: "듣는 중",
    title: "지금 듣고 있습니다. 누르면 바로 끝냅니다",
    aria: "녹음 중입니다. 말이 끝나면 자동으로 멈추고, 지금 누르면 바로 끝냅니다.",
  },
  processing: {
    text: "옮기는 중",
    title: "말을 글자로 옮기는 중입니다",
    aria: "말을 글자로 옮기는 중입니다. 잠시 기다려 주세요.",
  },
};

export function App() {
  const [input, setInput] = useState("");
  const [tutorialDraft, dispatchTutorialDraft] = useReducer(reduceTutorialPreferenceDraft, initialTutorialPreferenceDraft);
  const [tutorialInputMessage, setTutorialInputMessage] = useState("");
  // 제안은 사용자가 탭할 때까지 아무것도 실행하지 않는다. 만들어진 시점의 입력 key를 함께 들고
  // 있다가 단계·승인이 바뀌면 폐기한다.
  const [tutorialSuggestion, setTutorialSuggestion] = useState<{ display: string; inputKey: string } | null>(null);
  const [lastTranscript, setLastTranscript] = useState("");
  const inputContextRef = useRef<string | null>(null);
  const voiceContextRef = useRef<string | null>(null);
  const [gaze, setGaze] = useState<GazePoint>(neutralGaze);
  const [answerExpanded, setAnswerExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clientSettingsOpen, setClientSettingsOpen] = useState(false);
  const [utilityState, dispatchUtility] = useReducer(reduceUtilityState, initialUtilityState);
  const [utilityData, setUtilityData] = useState<UtilityDataState>({ kind: "disconnected" });
  const [agentDock, dispatchAgentDock] = useReducer(reduceAgentDockState, initialAgentDockState);
  const [googleWrite, dispatchGoogleWrite] = useReducer(reduceGoogleWriteState, initialGoogleWriteState);
  const [tutorial, dispatchTutorial] = useReducer(
    reduceTutorial,
    undefined,
    () => initialTutorialState(typeof sessionStorage === "undefined" ? null : readTutorialFlowId(sessionStorage)),
  );
  const {
    tauriRuntime,
    companionState,
    chatPanelOpen,
    isChatPanelOpen,
    changeChatPanelOpen,
    lockCompanion,
    activateCompanion,
    notifyOverlayOpened,
    notifyOverlayClosed,
    expandWindow,
    restoreWindow,
    utilitySide,
    beginCharacterDrag,
    continueCharacterDrag,
    finishCharacterDrag,
    isDragging,
    openSettingsWindow,
    shortcutError,
    reportShortcutError,
  } = useCompanionWindow();
  const compactWebLayout = useCompactWebLayout(tauriRuntime);
  const conversationOpen = shouldShowConversation(tauriRuntime, chatPanelOpen);
  const googleInvokeUi = shouldUseTauriGoogleUi(tauriRuntime);
  const { appSettings, reconnectNonce, settingsApplyError } = useAppSettings();
  const {
    clientSettings,
    updateClientSettings,
    mouthOpen,
    audioError,
    setAudioError,
    appendTtsChunk,
    appendTtsSentence,
    resetAudio,
    unlockAudio,
    speaking,
    captionText,
  } = useTtsAudio();
  const live2dFraming = useMemo(() => ({
    scale: clientSettings.live2dScale,
    offsetX: clientSettings.live2dOffsetX,
    offsetY: clientSettings.live2dOffsetY,
  }), [clientSettings.live2dOffsetX, clientSettings.live2dOffsetY, clientSettings.live2dScale]);
  // Brain 주소의 단일 진실 원천. WebSocket과 STT가 같은 값을 쓴다.
  const brainUrl = appSettings.brainUrl;
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const tutorialComposerRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (tauriRuntime || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      tutorialComposerRef.current?.closest<HTMLElement>(".chat-panel")?.style.setProperty("--tutorial-viewport-height", `${viewport.height}px`);
    };
    updateViewport();
    viewport.addEventListener("resize", updateViewport);
    return () => viewport.removeEventListener("resize", updateViewport);
  }, [tauriRuntime]);

  const {
    connection,
    retryDelay,
    messages,
    emotion,
    connectionEpoch,
    canSend,
    tutorialSessionSecure,
    canUseTutorial,
    sendText,
    sendScheduleContext,
    approveGoogleWrite: approveGoogleWriteOnBrain,
    rejectGoogleWrite: rejectGoogleWriteOnBrain,
    sendTutorialAction,
  } = useBrainConnection({
    brainUrl,
    dndEnabled: appSettings.dndEnabled,
    proactiveSuggestions: appSettings.proactiveSuggestions,
    reconnectNonce,
    onTtsChunk: appendTtsChunk,
    onTtsSentence: appendTtsSentence,
    onAgentEvent: (agentEvent) => {
      if (!tauriRuntime) return;
      void openAgentDock();
      if (agentEvent.kind === "approval-required") dispatchAgentDock({ type: "approval-required", skill: agentEvent.skill, reason: agentEvent.reason, approvalToken: agentEvent.approvalToken });
      else if (agentEvent.kind === "skill-result") dispatchAgentDock({ type: "skill-result", skill: agentEvent.skill, summary: agentEvent.summary, sources: agentEvent.sources });
      else dispatchAgentDock({ type: "failed", skill: agentEvent.skill, message: agentEvent.message });
    },
    onGoogleDraft: (googleDraft) => {
      if (!googleInvokeUi) return;
      const draft: GoogleWriteDraft = googleDraft.kind === "calendar"
        ? createCalendarDraft(googleDraft.title, googleDraft.startAt, googleDraft.endAt)
        : createTaskDraft(googleDraft.title, googleDraft.due ?? "");
      void previewGoogleWrite(draft);
    },
    onGoogleWriteExecution: (event) => {
      if (event.kind === "completed") dispatchGoogleWrite({ type: "complete", receipt: event.receipt });
      else if (event.kind === "cancelled") dispatchGoogleWrite({ type: "cancel", requestId: event.requestId });
      else dispatchGoogleWrite({ type: "fail", message: event.message });
    },
    onMemoryCapsuleEvent: () => undefined,
    onTutorialEvent: (event) => dispatchTutorial({ type: "brain-event", event }),
    // T-014: 대화창을 열지 않는다. 열면 caption.ts의 !chatPanelOpen 조건이 깨져
    // 자막이 정의상 뜰 수 없고, 선제 제안이 침투적으로 화면을 가로챈다.
    // 발화는 음성과 자막으로 알리고, 전문은 사용자가 대화창을 열면 기록에 남아 있다.
    onProactiveSuggestion: () => undefined,
    onResetAudio: resetAudio,
  });

  // 음성 콜백이 매 렌더 새로 만들어지면 전역 Alt+V 리스너가 그때마다 재등록된다.
  // 최신 값은 ref로 읽어 콜백 정체성을 고정한다. ref는 렌더마다 갱신되므로 stale하지 않다.
  const inputRef = useRef(input);
  inputRef.current = input;
  const canSendRef = useRef(canSend);
  canSendRef.current = canSend;
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  const conversationOpenRef = useRef(conversationOpen);
  conversationOpenRef.current = conversationOpen;
  const tutorialRef = useRef(tutorial);
  tutorialRef.current = tutorial;
  const currentInputKey = tutorialInputKey(tutorial, connectionEpoch);
  useEffect(() => {
    // 제안을 만든 뒤 단계나 승인이 바뀌면 화면에서도 즉시 치운다.
    setTutorialSuggestion((current) =>
      current && current.inputKey !== currentInputKey ? null : current);
  }, [currentInputKey]);
  const currentInputKeyRef = useRef(currentInputKey);
  currentInputKeyRef.current = currentInputKey;

  /** 전송 성공 시 true. 입력창 비우기까지 여기서 책임진다. 타이핑·음성 두 경로가 공유한다. */
  const sendMessage = useCallback((raw: string): boolean => {
    if (!tauriRuntime) return false;
    const text = raw.trim();
    if (!text || !canSendRef.current) return false;
    if (!sendTextRef.current(text)) return false;
    setAudioError("");
    resetAudio();
    void unlockAudio();
    setInput("");
    return true;
  }, [resetAudio, setAudioError, tauriRuntime, unlockAudio]);

  const handleVoiceTranscribed = useCallback((text: string) => {
    const merged = mergeVoiceTranscript(inputRef.current, text);
    if (!tauriRuntime) {
      setInput(merged);
      setLastTranscript(text);
      // 녹음 시작 뒤 phase나 preview가 바뀌면 기존 발화를 새 승인에 사용하지 않는다.
      inputContextRef.current = voiceContextRef.current;
      setTutorialInputMessage("음성 인식 결과를 검토·수정한 뒤 전송해 주세요. 아직 실행하지 않았어요.");
      messageInputRef.current?.focus();
      return;
    }
    // 전송하지 못하면(연결 끊김 등) 입력창에 남겨 다시 시도할 수 있게 한다.
    if (!sendMessage(merged)) setInput(merged);
    messageInputRef.current?.focus();
  }, [sendMessage, tauriRuntime]);

  const handleVoiceActivate = useCallback(() => {
    if (tauriRuntime) { activateCompanion(); return; }
    voiceContextRef.current = inputRef.current.trim() ? inputContextRef.current : currentInputKeyRef.current;
  }, [activateCompanion, tauriRuntime]);

  const handleVoiceFinished = useCallback(() => {
    if (!conversationOpenRef.current) void changeChatPanelOpen(true);
  }, [changeChatPanelOpen]);

  const { voiceSession, startVoiceInput, stopVoiceInput } = useVoiceInput({
    brainUrl,
    connected: connection === "connected" && (tauriRuntime || (canUseTutorial && !tutorial.busy && !tutorial.needsResume)),
    tauriRuntime,
    onTranscribed: handleVoiceTranscribed,
    onFinished: handleVoiceFinished,
    onActivate: handleVoiceActivate,
    onError: setAudioError,
    onShortcutError: reportShortcutError,
  });

  const handledConnectionEpochRef = useRef(0);

  useEffect(() => {
    if (tauriRuntime || typeof sessionStorage === "undefined") return;
    writeTutorialFlowId(sessionStorage, tutorial.flowId);
  }, [tauriRuntime, tutorial.flowId]);

  useEffect(() => {
    if (tauriRuntime || connection === "connected"
      || (!tutorial.flowId && !tutorial.busy && !tutorial.approval)
      || tutorial.needsResume) return;
    dispatchTutorial({ type: "connection-lost" });
  }, [connection, tauriRuntime, tutorial.approval, tutorial.busy, tutorial.flowId, tutorial.needsResume]);

  useEffect(() => {
    const operationId = tutorial.operation?.id;
    if (tauriRuntime || !operationId || !tutorial.busy) return;
    const timeout = setTimeout(() => dispatchTutorial({
      type: "operation-timeout",
      operationId,
    }), tutorialOperationTimeoutMs(tutorial.operation?.kind ?? "resume"));
    return () => clearTimeout(timeout);
  }, [tauriRuntime, tutorial.busy, tutorial.operation?.id]);

  useEffect(() => {
    if (tauriRuntime || connectionEpoch <= 0 || handledConnectionEpochRef.current === connectionEpoch) return;
    handledConnectionEpochRef.current = connectionEpoch;
    const flowId = tutorialRef.current.flowId;
    if (!flowId) return;
    const operationId = sendTutorialAction({ action: "tutorial_resume", payload: { flow_id: flowId } });
    if (operationId) dispatchTutorial({ type: "operation-requested", operation: { id: operationId, kind: "resume" } });
    else dispatchTutorial({ type: "local-failed", message: "안전한 연결을 만들지 못해 서버 상태를 확인할 수 없어요." });
  }, [connectionEpoch, sendTutorialAction, tauriRuntime]);

  useEffect(() => {
    if (conversationOpen && tauriRuntime) messageInputRef.current?.focus();
    else {
      setAnswerExpanded(false);
      setHistoryOpen(false);
    }
  }, [conversationOpen, tauriRuntime]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (clientSettingsOpen) {
        setClientSettingsOpen(false);
        return;
      }
      if (voiceSession.state === "listening") {
        stopVoiceInput();
        return;
      }
      if (agentDock.open) void closeAgentDock();
      else if (utilityState) void closeUtility();
      else if (isChatPanelOpen()) void changeChatPanelOpen(false);
      setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [agentDock.open, changeChatPanelOpen, clientSettingsOpen, isChatPanelOpen, stopVoiceInput, utilityState, voiceSession.state]);

  function openUtility(panel: UtilityPanelKind) {
    setMenuOpen(false);
    if (isChatPanelOpen()) void changeChatPanelOpen(false);
    dispatchUtility({ type: "open", panel });
    void loadUtilityData(panel);
  }

  async function openAgentDock() {
    setMenuOpen(false);
    if (isChatPanelOpen()) await changeChatPanelOpen(false);
    if (utilityState) await closeUtility();
    if (tauriRuntime && !agentDock.open) await expandWindow();
    dispatchAgentDock({ type: "open" });
    notifyOverlayOpened("agent-dock");
  }

  async function closeAgentDock() {
    if (tauriRuntime) await restoreWindow();
    dispatchAgentDock({ type: "close" });
    notifyOverlayClosed();
  }

  async function previewGoogleWrite(draft: GoogleWriteDraft) {
    if (!googleInvokeUi && draft.executor !== "brain") return;
    dispatchGoogleWrite({ type: "preview", draft });
    await openAgentDock();
  }

  async function approveGoogleWrite() {
    if (googleWrite.status !== "preview" && googleWrite.status !== "failed") return;
    const draft = googleWrite.draft;
    dispatchGoogleWrite({ type: "approve" });
    if (!googleInvokeUi) {
      if (draft.executor !== "brain" || !draft.approvalToken || !approveGoogleWriteOnBrain(draft.approvalToken)) {
        dispatchGoogleWrite({ type: "fail", message: "Brain 연결을 확인한 뒤 다시 승인해 주세요." });
      }
      return;
    }
    try {
      const targets = parseAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
      const receipt = await googleRuntime.create(draft, { calendarId: targets.googleCalendarId, taskListId: targets.googleTaskListId });
      dispatchGoogleWrite({ type: "complete", receipt });
      void loadUtilityData(draft.kind === "calendar" ? "calendar" : "tasks");
    } catch (error) {
      dispatchGoogleWrite({ type: "fail", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function cancelGoogleWrite() {
    if (googleWrite.status === "idle") return;
    const draft = googleWrite.draft;
    if (!googleInvokeUi && draft.executor === "brain" && draft.approvalToken) {
      if (!rejectGoogleWriteOnBrain(draft.approvalToken)) return;
    }
    dispatchGoogleWrite({ type: "cancel", requestId: draft.requestId });
  }

  async function loadUtilityData(panel: UtilityPanelKind) {
    if (!tauriRuntime) { setUtilityData({ kind: "disconnected" }); return; }
    setUtilityData({ kind: "loading" });
    try {
      const status = await googleRuntime.status();
      const access = googleCapability(status.scopes);
      if (!status.connected || (panel === "calendar" ? !access.calendar : !access.tasks)) {
        setUtilityData({ kind: "disconnected" }); return;
      }
      const items = panel === "calendar" ? await googleRuntime.calendar() : await googleRuntime.tasks();
      setUtilityData({ kind: "ready", items });
    } catch (error) {
      setUtilityData({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function toggleUtilitySize() {
    if (!utilityState) return;
    const expanding = utilityState.size === "small";
    if (tauriRuntime) {
      if (expanding) await expandWindow();
      else await restoreWindow();
    }
    dispatchUtility({ type: "toggle-size" });
  }

  async function closeUtility() {
    if (utilityState?.size === "medium" && tauriRuntime) await restoreWindow();
    dispatchUtility({ type: "close" });
  }

  function handleCharacterPointerDown(event: PointerEvent<HTMLElement>) {
    if (utilityState) return;
    beginCharacterDrag(event);
  }

  function handleCharacterPointerMove(event: PointerEvent<HTMLElement>) {
    if (appSettings.gazeTracking) {
      const bounds = event.currentTarget.getBoundingClientRect();
      setGaze(normalizeGazePoint(event.clientX, event.clientY, bounds));
    }
    continueCharacterDrag(event);
  }

  useEffect(() => {
    if (!appSettings.gazeTracking) setGaze(neutralGaze());
  }, [appSettings.gazeTracking]);

  // 오늘 일정을 Brain에 밀어 넣는다. Brain은 Google을 직접 호출하지 않으므로
  // 이미 읽은 클라이언트가 보내주는 것만 안다 (T-013).
  useEffect(() => {
    if (!tauriRuntime || connection !== "connected") return;
    let disposed = false;

    async function pushSchedule() {
      try {
        const status = await googleRuntime.status();
        // 미연결·권한 없음은 빈 배열로 위장하지 않는다. 아무것도 보내지 않는다.
        const events = status.connected && googleCapability(status.scopes).calendar
          ? await googleRuntime.calendar()
          : null;
        if (disposed) return;
        const message = buildScheduleContextMessage(
          events,
          new Date(),
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        if (message) sendScheduleContext(message);
      } catch {
        // 일정 전송 실패는 대화를 막지 않는다. 다음 주기에 다시 시도한다.
      }
    }

    void pushSchedule();
    const timer = setInterval(() => void pushSchedule(), SCHEDULE_PUSH_INTERVAL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [connection, sendScheduleContext, tauriRuntime]);

  /** 입력 문장 하나를 해석해 실행까지 잇는다. 타이핑·음성·제안 수락이 모두 이 경로를 쓴다. */
  function applyTutorialUtterance(text: string) {
    const context = tutorialUtteranceContext(tutorialRef.current, tutorialAvailability);
    const result = parseTutorialUtterance(context, text);
    if (result.kind === "clarify" || result.kind === "unmatched") {
      const nearest = nearestTutorialPhrase(context, normalizeUtterance(text));
      setTutorialSuggestion(nearest
        ? { display: nearest.display, inputKey: tutorialInputKey(tutorialRef.current, connectionEpoch) }
        : null);
      setTutorialInputMessage(nearest
        ? `${result.message} 혹시 «${nearest.display}»인가요? 맞으면 아래 버튼을 눌러 주세요.`
        : result.message);
      return;
    }
    setTutorialSuggestion(null);
    if (result.kind === "selection") {
      dispatchTutorialDraft(result.change);
      setTutorialInputMessage(result.message);
    } else if (result.kind === "action") {
      setTutorialInputMessage("입력을 해석했어요. 실행 결과는 위 단계에서 확인해 주세요.");
      switch (result.intent) {
        case "start": startTutorial(); break;
        case "preferences-default": prepareTutorialPreferences({ ...NEUTRAL_TUTORIAL_PREFERENCES }, 10); break;
        case "preferences-prepare": prepareTutorialPreferences(tutorialDraft.preferences, tutorialDraft.preparationMinutes); break;
        case "approve": resolveTutorialApproval(true); break;
        case "reject": resolveTutorialApproval(false); break;
        case "google-prepare": prepareTutorialGoogle(result.googleKind); break;
        case "google-skip": skipTutorialGoogle(result.googleKind); break;
        case "answer": generateTutorialAnswer(result.comparison); break;
        case "receipt": getTutorialReceipt(); break;
        case "forget": forgetTutorial(); break;
      }
    }
    setInput("");
    inputContextRef.current = null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (tauriRuntime) { sendMessage(input); return; }
    if (voiceSession.state !== "idle") return;
    if (!input.trim()) return;
    if (inputContextRef.current !== tutorialInputKey(tutorialRef.current, connectionEpoch)) {
      setTutorialSuggestion(null);
      setTutorialInputMessage("입력 이후 단계 또는 승인이 바뀌었어요. 현재 미리보기를 확인하고 문장을 새로 입력해 주세요.");
      return;
    }
    applyTutorialUtterance(input);
  }

  /** 제안 수락은 사용자의 명시적 클릭에서만 일어난다. */
  function acceptTutorialSuggestion() {
    const suggestion = tutorialSuggestion;
    if (!suggestion) return;
    setTutorialSuggestion(null);
    if (suggestion.inputKey !== tutorialInputKey(tutorialRef.current, connectionEpoch)) {
      setTutorialInputMessage("제안을 만든 뒤 단계 또는 승인이 바뀌었어요. 현재 미리보기를 확인하고 다시 입력해 주세요.");
      return;
    }
    applyTutorialUtterance(suggestion.display);
  }

  // 연결과 세션 보안은 차단 사유가 다르므로 분리해서 넘긴다.
  const tutorialAvailability = { connected: connection === "connected", sessionSecure: tutorialSessionSecure };

  function tutorialUnavailableMessage(): string {
    return tutorialSessionSecure
      ? "Brain 연결을 확인한 뒤 다시 시도해 주세요. 결과를 성공으로 처리하지 않았어요."
      : "이 브라우저에서는 안전한 탭 세션을 만들 수 없어 체험 action을 보낼 수 없어요.";
  }

  function requestTutorialAction(
    request: TutorialActionRequest,
    operation: Omit<TutorialOperation, "id">,
  ): string | null {
    const state = tutorialRef.current;
    if (!canUseTutorial || state.busy || (state.needsResume && operation.kind !== "resume")) return null;
    const operationId = sendTutorialAction(request);
    if (!operationId) {
      dispatchTutorial({ type: "local-failed", message: tutorialUnavailableMessage() });
      return null;
    }
    const action = { type: "operation-requested" as const, operation: { id: operationId, ...operation } };
    // React가 다시 그리기 전 연속 Enter·버튼 클릭도 같은 busy 경계를 사용한다.
    tutorialRef.current = reduceTutorial(state, action);
    dispatchTutorial(action);
    return operationId;
  }

  function startTutorial() {
    if (tutorialRef.current.flowId) return;
    dispatchTutorialDraft({ type: "reset" });
    requestTutorialAction({ action: "tutorial_start", payload: {} }, { kind: "start" });
  }

  function resumeTutorial() {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    requestTutorialAction({ action: "tutorial_resume", payload: { flow_id: flowId } }, { kind: "resume" });
  }

  function prepareTutorialPreferences(
    preferences: TutorialPreferences,
    preparationMinutes: TutorialPreparationMinutes,
  ) {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    requestTutorialAction({
      action: "tutorial_preferences_prepare",
      payload: { flow_id: flowId, preferences, preparation_minutes: preparationMinutes },
    }, { kind: "preferences-prepare" });
  }

  function resolveTutorialApproval(approved: boolean) {
    const state = tutorialRef.current;
    const flowId = state.flowId;
    const approval = state.approval;
    if (!flowId || !approval || tutorialUtteranceContext(state, tutorialAvailability).blocked
      || approval.operationId !== tutorial.approval?.operationId) return;
    requestTutorialAction({
      action: approved ? "tutorial_approve" : "tutorial_reject",
      payload: {
        flow_id: flowId,
        approval_token: approval.approvalToken,
        request_id: approval.requestId,
      },
    }, { kind: approved ? "approve" : "reject", requestId: approval.requestId });
  }

  function prepareTutorialGoogle(kind: TutorialGoogleKind) {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) {
      dispatchTutorial({ type: "local-failed", message: "브라우저 시간대를 확인할 수 없어 Google 초안을 만들지 않았어요." });
      return;
    }
    requestTutorialAction({
      action: "tutorial_google_prepare",
      payload: { flow_id: flowId, kind, scenario_id: TUTORIAL_SCENARIO_ID, timezone },
    }, { kind: "google-prepare" });
  }

  function skipTutorialGoogle(kind: TutorialGoogleKind) {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    requestTutorialAction({
      action: "tutorial_google_skip",
      payload: { flow_id: flowId, kind },
    }, { kind: "google-skip" });
  }

  function generateTutorialAnswer(comparison: "before" | "after") {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    requestTutorialAction({
      action: "tutorial_answer_generate",
      payload: { flow_id: flowId, comparison, question_id: TUTORIAL_QUESTION_ID },
    }, { kind: "answer", comparison });
  }

  function getTutorialReceipt() {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    requestTutorialAction({ action: "tutorial_receipt_get", payload: { flow_id: flowId } }, { kind: "receipt" });
  }

  function forgetTutorial() {
    const flowId = tutorial.flowId;
    if (!flowId) return;
    requestTutorialAction({ action: "tutorial_forget", payload: { flow_id: flowId } }, { kind: "forget" });
  }

  useEffect(() => {
    if (tauriRuntime || !canUseTutorial || tutorial.busy || tutorial.needsResume || !tutorial.flowId) return;
    if (!tutorialNeedsAutomaticReceipt(tutorial)) return;
    const operationId = sendTutorialAction({
      action: "tutorial_receipt_get",
      payload: { flow_id: tutorial.flowId },
    });
    if (operationId) dispatchTutorial({ type: "operation-requested", operation: { id: operationId, kind: "receipt" } });
  }, [canUseTutorial, sendTutorialAction, tauriRuntime, tutorial.busy, tutorial.error, tutorial.flowId, tutorial.needsResume, tutorial.operation?.kind, tutorial.receipt, tutorial.snapshot?.phase]);

  const latestAnswer = latestTanyaMessage(messages);
  const collapsedAnswer = latestAnswer && shouldCollapseWhisper(latestAnswer.text) && !answerExpanded;

  return (
    <main
      className={`shell utility-${utilitySide} ${utilityState?.size === "medium" || agentDock.open ? "utility-expanded" : ""} ${compactWebLayout ? "web-compact" : ""}`}
      data-layout={compactWebLayout ? "compact-web" : tauriRuntime ? "desktop-app" : "desktop-web"}
    >
      {!compactWebLayout && <section
        className="avatar-panel"
        aria-label="Live2D 영역"
        onPointerDown={handleCharacterPointerDown}
        onPointerMove={handleCharacterPointerMove}
        onPointerUp={finishCharacterDrag}
        onPointerCancel={finishCharacterDrag}
        onPointerLeave={() => setGaze(neutralGaze())}
        onClick={() => {
          if (isDragging()) return;
          if (!conversationOpen) void changeChatPanelOpen(true);
        }}
      >
        {tauriRuntime && connection !== "connected" && <div className="status" role="status">
          <span className={`dot ${connection}`} />
          {connectionStatusText(connection, retryDelay)}
        </div>}
        {!conversationOpen && (shortcutError || settingsApplyError) && <p className="window-error" role="alert">{shortcutError || settingsApplyError}</p>}
        <Live2DStage
          emotion={emotion}
          mouthOpen={mouthOpen}
          gaze={gaze}
          framing={live2dFraming}
          showFirstLoadGuidance={!tauriRuntime}
        />
        {!tauriRuntime && <button
          type="button"
          className="live2d-framing-trigger"
          aria-controls="client-settings-panel"
          aria-expanded={clientSettingsOpen}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setClientSettingsOpen((open) => !open);
          }}
        >모델 화면</button>}
        <SpeechCaption
          captionsEnabled={appSettings.captions}
          chatPanelOpen={conversationOpen}
          speaking={speaking}
          text={captionText || (latestAnswer?.text ?? "")}
        />
        {voiceSession.state === "listening" && <VoiceListeningIndicator />}
        {!conversationOpen && companionState.interaction !== "click-through" && (
          <nav className="presence-bar" aria-label="타냐 빠른 메뉴" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => void changeChatPanelOpen(true)} aria-label="대화 열기">대화</button>
            {tauriRuntime && <button type="button" onClick={() => void lockCompanion()} aria-label="타냐 잠그기">잠금</button>}
            {tauriRuntime && <button type="button" aria-label="더보기" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>•••</button>}
          </nav>
        )}
        {tauriRuntime && menuOpen && !conversationOpen && <nav className="feature-menu" aria-label="기능 메뉴" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => void changeChatPanelOpen(true)}>대화 기록</button>
          <button type="button" disabled>알림함</button>
          <button type="button" onClick={() => openUtility("calendar")}>일정</button>
          <button type="button" onClick={() => openUtility("tasks")}>할 일</button>
          <button type="button" onClick={() => void openAgentDock()}>작업</button>
          <button type="button" onClick={() => { setMenuOpen(false); void openSettingsWindow(); }}>설정</button>
          <button type="button" disabled>종료</button>
        </nav>}
      </section>}

      {!tauriRuntime && clientSettingsOpen && <SettingsPanel
        settings={clientSettings}
        onChange={updateClientSettings}
        onClose={() => setClientSettingsOpen(false)}
      />}

      {utilityState && <div className="utility-layer" onClick={() => void closeUtility()}>
        <div onClick={(event) => event.stopPropagation()}>
          <UtilityPanel state={utilityState} data={utilityData} onCreateDraft={(draft) => void previewGoogleWrite(draft)} onToggleSize={() => void toggleUtilitySize()} onClose={() => void closeUtility()} />
        </div>
      </div>}

      {tauriRuntime && agentDock.open && <div className="agent-dock-layer"><AgentDock state={agentDock} googleWrite={googleWrite} onApproveGoogle={() => void approveGoogleWrite()} onCancelGoogle={cancelGoogleWrite} onClose={() => void closeAgentDock()} /></div>}

      {conversationOpen && <section className="chat-panel" aria-label="타냐와 대화">
        <header className="whisper-header">
          <div>
            <strong>타냐</strong>
            <span>{connection === "connected" ? "듣고 있어" : connectionStatusText(connection, retryDelay)}</span>
            {!tauriRuntime && <span className="web-demo-boundary">{WEB_DEMO_BOUNDARY}</span>}
          </div>
          <div className="endpoint">
            {tauriRuntime && <button type="button" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>기록</button>}
            {shouldShowConversationClose(tauriRuntime) && <button
              type="button"
              title="대화 닫기 (Esc 또는 Ctrl+Space)"
              aria-label="대화 닫기"
              onClick={() => void changeChatPanelOpen(false)}
            >×</button>}
          </div>
        </header>
        {!tauriRuntime ? <div className="messages latest tutorial-surface">
          <TutorialPanel
            connected={connection === "connected"}
            secureSession={tutorialSessionSecure}
            state={tutorial}
            draft={tutorialDraft}
            dispatchDraft={dispatchTutorialDraft}
            onStart={startTutorial}
            onResume={resumeTutorial}
            onPreparePreferences={prepareTutorialPreferences}
            onApprove={() => resolveTutorialApproval(true)}
            onReject={() => resolveTutorialApproval(false)}
            onPrepareGoogle={prepareTutorialGoogle}
            onSkipGoogle={skipTutorialGoogle}
            onGenerateAnswer={generateTutorialAnswer}
            onGetReceipt={getTutorialReceipt}
            onForget={forgetTutorial}
          />
        </div> : historyOpen ? <div className="messages history" aria-label="전체 대화 기록">
          {messages.map((message) => <div key={message.id} className={`bubble ${message.role}`}>
            {message.role === "tanya" && message.route && <span className="llm-route-badge">{describeLlmRoute(message.route, tauriRuntime ? "tauri" : "web")}</span>}
            {message.text}
          </div>)}
        </div> : <div className="messages latest" aria-live="polite">
          {!latestAnswer && (
            <div className="empty demo-empty">
              <p>
              {connection === "connected"
                ? "무슨 이야기를 할까?"
                : compactWebLayout
                  ? "연결을 다시 시도하고 있어요. 잠시만 기다려 주세요."
                  : "Brain 없이도 Live2D는 동작합니다. 연결은 자동으로 다시 시도합니다."}
              </p>
            </div>
          )}
          {latestAnswer && <div className={`bubble tanya latest-answer ${collapsedAnswer ? "collapsed" : ""}`}>
            {latestAnswer.route && <span className="llm-route-badge">{describeLlmRoute(latestAnswer.route, tauriRuntime ? "tauri" : "web")}</span>}
            {latestAnswer.text}
          </div>}
          {latestAnswer && shouldCollapseWhisper(latestAnswer.text) && <button className="more-answer" type="button" onClick={() => setAnswerExpanded((value) => !value)}>{answerExpanded ? "접기" : "더 보기"}</button>}
        </div>}
        {audioError && (
          <p className="audio-error" role="alert">{audioError}</p>
        )}
        {shortcutError && (
          <p className="shortcut-error" role="alert">{shortcutError}</p>
        )}
        {!tauriRuntime && <div className="tutorial-input-guide">
          <p id="tutorial-input-examples">현재 단계 예시 — 눌러서 입력창에 넣을 수 있어요</p>
          <div className="tutorial-example-chips">
            {tutorialExampleChips(tutorialUtteranceContext(tutorial, tutorialAvailability)).map((phrase) => <button
              key={phrase}
              type="button"
              onClick={() => {
                // 넣기만 한다. 실행은 사용자가 내용을 확인하고 전송할 때 일어난다.
                setInput(phrase);
                inputContextRef.current = currentInputKey;
                setTutorialSuggestion(null);
                setTutorialInputMessage("입력창에 넣었어요. 내용을 확인하고 전송해 주세요.");
              }}
            >{phrase}</button>)}
          </div>
          <details><summary>음성 입력 안내{lastTranscript ? " · 최근 인식 결과" : ""}</summary>
            <p>마이크를 누르면 녹음해 Brain에서 글자로 바꿉니다. 인식 결과를 검토한 뒤 전송해 주세요.</p>
            {lastTranscript && <p>최근 인식: {lastTranscript}</p>}
          </details>
          <p role="status">{tutorialInputMessage}</p>
          {tutorialSuggestion && <button
            type="button"
            className="tutorial-suggestion"
            onClick={acceptTutorialSuggestion}
          >«{tutorialSuggestion.display}»로 진행</button>}
        </div>}
        <form ref={tutorialComposerRef} onSubmit={submit}>
          <input
            ref={messageInputRef}
            aria-label={tauriRuntime ? "메시지" : "튜토리얼 메시지"}
            aria-describedby={tauriRuntime ? undefined : "tutorial-input-examples"}
            placeholder={tauriRuntime ? "메시지를 입력하세요" : "현재 단계의 문장을 입력하세요"}
            value={input}
            onChange={(event) => {
              if (!tauriRuntime && (!input.trim() || !event.target.value.trim())) inputContextRef.current = currentInputKey;
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
            disabled={tauriRuntime && connection !== "connected"}
          />
          <button
            type="button"
            className={`voice-button ${voiceSession.state}`}
            disabled={voiceSession.state !== "listening" && (connection !== "connected" || voiceSession.state === "processing" || (!tauriRuntime && (!canUseTutorial || tutorial.busy || tutorial.needsResume)))}
            title={VOICE_BUTTON_LABEL[voiceSession.state].title}
            aria-label={VOICE_BUTTON_LABEL[voiceSession.state].aria}
            onClick={() => voiceSession.state === "listening" ? stopVoiceInput() : void startVoiceInput("button")}
          >
            {/* 텍스트 라벨은 좁은 화면에서 form을 옆으로 밀어내 뺐다.
                무엇인지 알리는 책임은 마이크 도형과 aria-label·title이 진다. */}
            <MicrophoneIcon listening={voiceSession.state === "listening"} />
          </button>
          <button disabled={connection !== "connected" || !input.trim() || (!tauriRuntime && (tutorial.busy || tutorial.needsResume || !canUseTutorial || voiceSession.state !== "idle"))}>전송</button>
        </form>
      </section>}
    </main>
  );
}
