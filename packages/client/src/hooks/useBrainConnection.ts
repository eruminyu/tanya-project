import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AgentBrainEvent,
  type BrainEvent,
  type ConnectionState,
  type GoogleDraftEvent,
  type GoogleWriteExecutionEvent,
  type MemoryCapsuleBrainEvent,
  type MemoryCapsuleMinutes,
  type TtsChunk,
  type TtsSentence,
  extractAgentEvent,
  extractEmotion,
  extractGoogleDraftEvent,
  extractGoogleWriteExecutionEvent,
  extractLlmRoute,
  extractMemoryCapsuleEvent,
  extractProactiveSuggestion,
  extractText,
  extractTtsChunk,
  extractTtsSentence,
  reconnectDelayMs,
  toWebSocketUrl,
} from "../brain";
import { normalizeLive2DEmotion, type Live2DEmotion } from "../live2d-emotion";
import type { ScheduleContextMessage } from "../schedule-context";
import type { ConversationMessage } from "../whisper";
import { createMessageId } from "../message-id";
import { createWebchatSessionId, getOrCreateWebchatSessionId, isSecureWebchatSessionId } from "../webchat-session";
import { extractTutorialEvent, type TutorialActionRequest, type TutorialBrainEvent } from "../tutorial";

type BrainConnectionCallbacks = {
  onTtsChunk: (chunk: TtsChunk) => void;
  onTtsSentence: (sentence: TtsSentence) => void;
  onAgentEvent: (event: AgentBrainEvent) => void;
  onGoogleDraft: (event: GoogleDraftEvent) => void;
  onGoogleWriteExecution: (event: GoogleWriteExecutionEvent) => void;
  onMemoryCapsuleEvent: (event: MemoryCapsuleBrainEvent) => void;
  onTutorialEvent: (event: TutorialBrainEvent) => void;
  onProactiveSuggestion: () => void;
  onResetAudio: () => void;
};

export function useBrainConnection(options: {
  brainUrl: string;
  dndEnabled: boolean;
  proactiveSuggestions: boolean;
  reconnectNonce: number;
  onTtsChunk: (chunk: TtsChunk) => void;
  onTtsSentence: (sentence: TtsSentence) => void;
  onAgentEvent: (event: AgentBrainEvent) => void;
  onGoogleDraft: (event: GoogleDraftEvent) => void;
  onGoogleWriteExecution: (event: GoogleWriteExecutionEvent) => void;
  onMemoryCapsuleEvent: (event: MemoryCapsuleBrainEvent) => void;
  onTutorialEvent: (event: TutorialBrainEvent) => void;
  onProactiveSuggestion: () => void;
  onResetAudio: () => void;
}): {
  connection: ConnectionState;
  retryDelay: number | undefined;
  messages: ConversationMessage[];
  emotion: Live2DEmotion;
  connectionEpoch: number;
  canSend: boolean;
  memoryCapsuleSessionSecure: boolean;
  canUseMemoryCapsule: boolean;
  tutorialSessionSecure: boolean;
  canUseTutorial: boolean;
  sendText: (text: string) => boolean;
  sendScheduleContext: (message: ScheduleContextMessage) => boolean;
  approveGoogleWrite: (approvalToken: string) => boolean;
  rejectGoogleWrite: (approvalToken: string) => boolean;
  prepareMemoryCapsule: (minutes: MemoryCapsuleMinutes) => string | null;
  approveMemoryCapsule: (approvalToken: string) => string | null;
  rejectMemoryCapsule: (approvalToken: string) => string | null;
  recallMemoryCapsule: () => string | null;
  forgetMemoryCapsule: () => string | null;
  sendTutorialAction: (request: TutorialActionRequest) => string | null;
} {
  const {
    brainUrl,
    dndEnabled,
    proactiveSuggestions,
    reconnectNonce,
    onTtsChunk,
    onTtsSentence,
    onAgentEvent,
    onGoogleDraft,
    onGoogleWriteExecution,
    onMemoryCapsuleEvent,
    onTutorialEvent,
    onProactiveSuggestion,
    onResetAudio,
  } = options;
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [retryDelay, setRetryDelay] = useState<number>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [emotion, setEmotion] = useState<Live2DEmotion>("neutral");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  if (sessionIdRef.current === null) {
    sessionIdRef.current = getOrCreateWebchatSessionId();
  }
  const webchatSessionId = sessionIdRef.current;
  const memoryCapsuleSessionSecure = isSecureWebchatSessionId(webchatSessionId);
  const streamIdRef = useRef<string | null>(null);
  const pendingRouteRef = useRef<ConversationMessage["route"]>(undefined);
  const callbacksRef = useRef<BrainConnectionCallbacks>({
    onTtsChunk,
    onTtsSentence,
    onAgentEvent,
    onGoogleDraft,
    onGoogleWriteExecution,
    onMemoryCapsuleEvent,
    onTutorialEvent,
    onProactiveSuggestion,
    onResetAudio,
  });
  useLayoutEffect(() => {
    callbacksRef.current = {
      onTtsChunk,
      onTtsSentence,
      onAgentEvent,
      onGoogleDraft,
      onGoogleWriteExecution,
      onMemoryCapsuleEvent,
      onTutorialEvent,
      onProactiveSuggestion,
      onResetAudio,
    };
  });

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function connect() {
      if (!active) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      let socket: WebSocket;
      try {
        const proactiveAllowed = proactiveSuggestions && !dndEnabled;
        socket = new WebSocket(toWebSocketUrl(
          brainUrl,
          true,
          proactiveAllowed,
          webchatSessionId,
        ));
      } catch {
        setRetryDelay(undefined);
        setConnection("disconnected");
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        if (!active || socketRef.current !== socket) return;
        attempt = 0;
        setRetryDelay(undefined);
        setConnection("connected");
        setConnectionEpoch((current) => current + 1);
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (!active || socketRef.current !== socket) return;
        const delay = reconnectDelayMs(attempt++);
        setRetryDelay(delay);
        setConnection("reconnecting");
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, delay);
      };
      socket.onmessage = ({ data }) => {
        let rawEvent: unknown;
        try {
          rawEvent = JSON.parse(String(data));
        } catch {
          return;
        }
        const tutorialEvent = extractTutorialEvent(rawEvent);
        if (tutorialEvent) {
          callbacksRef.current.onTutorialEvent(tutorialEvent);
          return;
        }
        const event = rawEvent as BrainEvent;
        const proactiveSuggestion = extractProactiveSuggestion(event);
        if (proactiveSuggestion) {
          setMessages((current) => [
            ...current,
            { id: createMessageId(), role: "tanya", text: proactiveSuggestion },
          ]);
          callbacksRef.current.onProactiveSuggestion();
          return;
        }
        const llmRoute = extractLlmRoute(event);
        if (llmRoute) {
          pendingRouteRef.current = llmRoute;
          const activeStreamId = streamIdRef.current;
          if (activeStreamId !== null) {
            setMessages((current) => current.map((message) =>
              message.id === activeStreamId ? { ...message, route: llmRoute } : message
            ));
          }
          return;
        }
        const agentEvent = extractAgentEvent(event);
        if (agentEvent) callbacksRef.current.onAgentEvent(agentEvent);
        const googleDraft = extractGoogleDraftEvent(event);
        if (googleDraft) callbacksRef.current.onGoogleDraft(googleDraft);
        const googleWriteExecution = extractGoogleWriteExecutionEvent(event);
        if (googleWriteExecution) callbacksRef.current.onGoogleWriteExecution(googleWriteExecution);
        const memoryCapsuleEvent = extractMemoryCapsuleEvent(event);
        if (memoryCapsuleEvent) callbacksRef.current.onMemoryCapsuleEvent(memoryCapsuleEvent);
        const ttsChunk = extractTtsChunk(event);
        if (ttsChunk) callbacksRef.current.onTtsChunk(ttsChunk);

        const ttsSentence = extractTtsSentence(event);
        if (ttsSentence) callbacksRef.current.onTtsSentence(ttsSentence);
        const nextEmotion = extractEmotion(event);
        if (nextEmotion !== null) setEmotion(normalizeLive2DEmotion(nextEmotion));
        const text = extractText(event);
        if (text === null) return;
        if (event.type === "event" && event.event === "text_stream") {
          const id = streamIdRef.current ?? createMessageId();
          const route = pendingRouteRef.current;
          streamIdRef.current = id;
          setMessages((current) => {
            const found = current.some((message) => message.id === id);
            return found
              ? current.map((message) => message.id === id ? { ...message, text: message.text + text } : message)
              : [...current, { id, role: "tanya", text, route }];
          });
        } else {
          const id = streamIdRef.current ?? createMessageId();
          const route = pendingRouteRef.current;
          streamIdRef.current = null;
          setMessages((current) => {
            const found = current.some((message) => message.id === id);
            return found
              ? current.map((message) => message.id === id ? { ...message, text } : message)
              : [...current, { id, role: "tanya", text, route }];
          });
          pendingRouteRef.current = undefined;
        }
      };
    }

    /**
     * 화면 복귀·네트워크 복구 시 백오프를 기다리지 않고 즉시 다시 연결한다.
     *
     * 휴대폰은 화면이 꺼지거나 앱이 전환되면 페이지를 정지시킨다. 그동안 재시도가 실패하며
     * 백오프가 상한까지 올라가므로, 사용자가 돌아왔을 때 남은 대기 시간이 그대로 체감된다.
     * 이미 살아 있는 소켓이 있으면 아무것도 하지 않아 중복 연결을 만들지 않는다.
     */
    function reconnectNow() {
      if (!active) return;
      const socket = socketRef.current;
      if (socket
        && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      attempt = 0;
      setRetryDelay(undefined);
      connect();
    }

    function handleVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        reconnectNow();
      }
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", reconnectNow);
    }

    connect();
    return () => {
      active = false;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", reconnectNow);
      }
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      socketRef.current?.close();
      callbacksRef.current.onResetAudio();
    };
  }, [brainUrl, dndEnabled, proactiveSuggestions, reconnectNonce]);

  const sendText = useCallback((text: string): boolean => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    streamIdRef.current = null;
    pendingRouteRef.current = undefined;
    setMessages((current) => [...current, { id: createMessageId(), role: "user", text }]);
    socketRef.current.send(JSON.stringify({
      type: "text",
      content: text,
      context: {
        now: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }));
    return true;
  }, []);

  /** 일정 스냅샷을 보낸다. 대화가 아니므로 messages에 남기지 않고 응답도 오지 않는다 (T-013). */
  const sendScheduleContext = useCallback((message: ScheduleContextMessage): boolean => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const sendGoogleWriteAction = useCallback((action: "google_write_approve" | "google_write_reject", approvalToken: string): boolean => {
    if (socketRef.current?.readyState !== WebSocket.OPEN || !approvalToken) return false;
    socketRef.current.send(JSON.stringify({
      action,
      payload: { approval_token: approvalToken },
    }));
    return true;
  }, []);

  const approveGoogleWrite = useCallback(
    (approvalToken: string) => sendGoogleWriteAction("google_write_approve", approvalToken),
    [sendGoogleWriteAction],
  );
  const rejectGoogleWrite = useCallback(
    (approvalToken: string) => sendGoogleWriteAction("google_write_reject", approvalToken),
    [sendGoogleWriteAction],
  );

  const sendMemoryCapsuleAction = useCallback((
    action: "memory_capsule_prepare" | "memory_capsule_approve" | "memory_capsule_reject" | "memory_capsule_recall" | "memory_capsule_forget",
    payload: Record<string, unknown>,
  ): string | null => {
    if (!memoryCapsuleSessionSecure || socketRef.current?.readyState !== WebSocket.OPEN) return null;
    const operationId = createWebchatSessionId();
    if (!isSecureWebchatSessionId(operationId)) return null;
    socketRef.current.send(JSON.stringify({
      action,
      payload: { operation_id: operationId, ...payload },
    }));
    return operationId;
  }, [memoryCapsuleSessionSecure]);

  const prepareMemoryCapsule = useCallback((minutes: MemoryCapsuleMinutes): string | null => {
    if (minutes !== 10 && minutes !== 20 && minutes !== 30) return null;
    return sendMemoryCapsuleAction("memory_capsule_prepare", { preparation_minutes: minutes });
  }, [sendMemoryCapsuleAction]);
  const approveMemoryCapsule = useCallback(
    (approvalToken: string) => approvalToken
      ? sendMemoryCapsuleAction("memory_capsule_approve", { approval_token: approvalToken })
      : null,
    [sendMemoryCapsuleAction],
  );
  const rejectMemoryCapsule = useCallback(
    (approvalToken: string) => approvalToken
      ? sendMemoryCapsuleAction("memory_capsule_reject", { approval_token: approvalToken })
      : null,
    [sendMemoryCapsuleAction],
  );
  const recallMemoryCapsule = useCallback(
    () => sendMemoryCapsuleAction("memory_capsule_recall", {}),
    [sendMemoryCapsuleAction],
  );
  const forgetMemoryCapsule = useCallback(
    () => sendMemoryCapsuleAction("memory_capsule_forget", {}),
    [sendMemoryCapsuleAction],
  );

  const sendTutorialAction = useCallback((request: TutorialActionRequest): string | null => {
    if (!memoryCapsuleSessionSecure || socketRef.current?.readyState !== WebSocket.OPEN) return null;
    const operationId = createWebchatSessionId();
    if (!isSecureWebchatSessionId(operationId)) return null;
    socketRef.current.send(JSON.stringify({
      type: "action",
      action: request.action,
      payload: { ...request.payload, operation_id: operationId },
    }));
    return operationId;
  }, [memoryCapsuleSessionSecure]);

  return {
    connection,
    retryDelay,
    messages,
    emotion,
    connectionEpoch,
    canSend: connection === "connected",
    memoryCapsuleSessionSecure,
    canUseMemoryCapsule: connection === "connected" && memoryCapsuleSessionSecure,
    tutorialSessionSecure: memoryCapsuleSessionSecure,
    canUseTutorial: connection === "connected" && memoryCapsuleSessionSecure,
    sendText,
    sendScheduleContext,
    approveGoogleWrite,
    rejectGoogleWrite,
    prepareMemoryCapsule,
    approveMemoryCapsule,
    rejectMemoryCapsule,
    recallMemoryCapsule,
    forgetMemoryCapsule,
    sendTutorialAction,
  };
}
