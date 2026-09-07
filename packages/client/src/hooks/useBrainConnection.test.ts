import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({
  effectCleanup: undefined as void | (() => void),
  effectInitialized: false,
  refCursor: 0,
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  stateValues: [] as unknown[],
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    if (reactState.effectInitialized) return;
    reactState.effectInitialized = true;
    reactState.effectCleanup = effect();
  },
  useLayoutEffect: (effect: () => void) => { effect(); },
  useRef: <T>(initial: T) => {
    const index = reactState.refCursor++;
    if (!reactState.refs[index]) reactState.refs[index] = { current: initial };
    return reactState.refs[index] as { current: T };
  },
  useState: <T>(initial: T | (() => T)) => {
    const index = reactState.stateCursor++;
    if (!(index in reactState.stateValues)) {
      reactState.stateValues[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const setState = (next: T | ((current: T) => T)) => {
      const current = reactState.stateValues[index] as T;
      reactState.stateValues[index] = typeof next === "function"
        ? (next as (value: T) => T)(current)
        : next;
    };
    return [reactState.stateValues[index] as T, setState] as const;
  },
}));

import { useBrainConnection } from "./useBrainConnection";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  send = vi.fn();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

class MockSessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const noop = () => undefined;

function renderHook(overrides: Partial<Parameters<typeof useBrainConnection>[0]> = {}) {
  reactState.refCursor = 0;
  reactState.stateCursor = 0;
  return useBrainConnection({
    brainUrl: "http://localhost:8098",
    dndEnabled: false,
    proactiveSuggestions: true,
    reconnectNonce: 0,
    onTtsChunk: noop,
    onTtsSentence: noop,
    onAgentEvent: noop,
    onGoogleDraft: noop,
    onGoogleWriteExecution: noop,
    onMemoryCapsuleEvent: noop,
    onTutorialEvent: noop,
    onProactiveSuggestion: noop,
    onResetAudio: noop,
    ...overrides,
  });
}

describe("Brain 연결 전송 가능 상태", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactState.effectCleanup = undefined;
    reactState.effectInitialized = false;
    reactState.refs.length = 0;
    reactState.stateValues.length = 0;
    MockWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("sessionStorage", new MockSessionStorage());
    let uuidCounter = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("readyState의 순간적 불일치와 무관하게 connection 상태에서 canSend를 파생한다", () => {
    let result = renderHook();
    const socket = MockWebSocket.instances[0];

    expect(result.connection).toBe("connecting");
    expect(result.canSend).toBe(false);

    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();
    socket.readyState = MockWebSocket.CLOSING;
    result = renderHook();

    expect(result.connection).toBe("connected");
    expect(result.canSend).toBe(true);

    socket.close();
    result = renderHook();

    expect(result.connection).toBe("reconnecting");
    expect(result.canSend).toBe(false);

    reactState.effectCleanup?.();
  });

  it("다시 렌더한 뒤 WebSocket 정리 콜백이 최신 함수를 사용한다", () => {
    const previousResetAudio = vi.fn();
    const latestResetAudio = vi.fn();

    renderHook({ onResetAudio: previousResetAudio });
    renderHook({ onResetAudio: latestResetAudio });
    reactState.effectCleanup?.();

    expect(previousResetAudio).not.toHaveBeenCalled();
    expect(latestResetAudio).toHaveBeenCalledOnce();
  });

  it("자동 재연결과 Brain 설정 변경에도 같은 탭 세션 ID를 재사용한다", () => {
    renderHook();
    const firstSocket = MockWebSocket.instances[0];
    const firstSessionId = new URL(firstSocket.url).searchParams.get("session_id");

    firstSocket.close();
    vi.advanceTimersByTime(1_000);

    const reconnectedSocket = MockWebSocket.instances[1];
    expect(new URL(reconnectedSocket.url).searchParams.get("session_id"))
      .toBe(firstSessionId);

    reactState.effectCleanup?.();
    reactState.effectInitialized = false;
    renderHook({ brainUrl: "https://other-brain.example.com" });

    const settingsReconnect = MockWebSocket.instances[2];
    expect(new URL(settingsReconnect.url).searchParams.get("session_id"))
      .toBe(firstSessionId);
    expect(new URL(settingsReconnect.url).protocol).toBe("wss:");
  });

  it("연결이 열릴 때마다 reconnect epoch를 증가시킨다", () => {
    let result = renderHook();
    const firstSocket = MockWebSocket.instances[0];
    expect(result.connectionEpoch).toBe(0);
    firstSocket.readyState = MockWebSocket.OPEN;
    firstSocket.onopen?.();
    result = renderHook();
    expect(result.connectionEpoch).toBe(1);

    firstSocket.close();
    vi.advanceTimersByTime(1_000);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.readyState = MockWebSocket.OPEN;
    secondSocket.onopen?.();
    result = renderHook();
    expect(result.connectionEpoch).toBe(2);
  });

  it("웹 Google 승인과 거절을 현재 WebSocket으로 전송한다", () => {
    let result = renderHook();
    const socket = MockWebSocket.instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();
    result = renderHook();

    expect(result.approveGoogleWrite("approval-1")).toBe(true);
    expect(result.rejectGoogleWrite("approval-2")).toBe(true);
    expect(socket.send).toHaveBeenNthCalledWith(1, JSON.stringify({
      action: "google_write_approve",
      payload: { approval_token: "approval-1" },
    }));
    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({
      action: "google_write_reject",
      payload: { approval_token: "approval-2" },
    }));
  });

  it("Google 데모 실행 결과를 전용 콜백으로 전달한다", () => {
    const onGoogleWriteExecution = vi.fn();
    renderHook({ onGoogleWriteExecution });
    const socket = MockWebSocket.instances[0];

    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "google_write_result",
      payload: {
        requestId: "request-1",
        providerId: "task-1",
        title: "자료 정리",
        duplicate: false,
      },
    }) });

    expect(onGoogleWriteExecution).toHaveBeenCalledWith({
      kind: "completed",
      receipt: {
        requestId: "request-1",
        providerId: "task-1",
        title: "자료 정리",
        duplicate: false,
      },
    });
  });

  it("기억 캡슐의 선택·승인·거절·회상·삭제를 고정 action 계약으로 전송한다", () => {
    let result = renderHook();
    const socket = MockWebSocket.instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();
    result = renderHook();

    expect(result.memoryCapsuleSessionSecure).toBe(true);
    expect(result.canUseMemoryCapsule).toBe(true);
    const prepareOperationId = result.prepareMemoryCapsule(20);
    const approveOperationId = result.approveMemoryCapsule("approval-1");
    const rejectOperationId = result.rejectMemoryCapsule("approval-2");
    const recallOperationId = result.recallMemoryCapsule();
    const forgetOperationId = result.forgetMemoryCapsule();
    expect(prepareOperationId).toMatch(/-4[0-9a-f]{3}-8[0-9a-f]{3}-/);
    expect(new Set([prepareOperationId, approveOperationId, rejectOperationId, recallOperationId, forgetOperationId]).size).toBe(5);
    expect(socket.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { action: "memory_capsule_prepare", payload: { operation_id: prepareOperationId, preparation_minutes: 20 } },
      { action: "memory_capsule_approve", payload: { operation_id: approveOperationId, approval_token: "approval-1" } },
      { action: "memory_capsule_reject", payload: { operation_id: rejectOperationId, approval_token: "approval-2" } },
      { action: "memory_capsule_recall", payload: { operation_id: recallOperationId } },
      { action: "memory_capsule_forget", payload: { operation_id: forgetOperationId } },
    ]);
  });

  it("tutorial action에 덮어쓸 수 없는 새 operation UUID를 붙인다", () => {
    let result = renderHook();
    const socket = MockWebSocket.instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();
    result = renderHook();

    const flowId = "11111111-1111-4111-8111-111111111111";
    const operationId = result.sendTutorialAction({
      action: "tutorial_resume",
      payload: { flow_id: flowId },
    });

    expect(result.tutorialSessionSecure).toBe(true);
    expect(result.canUseTutorial).toBe(true);
    expect(operationId).toMatch(/^[0-9a-f-]+$/);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: "action",
      action: "tutorial_resume",
      payload: { flow_id: flowId, operation_id: operationId },
    });
  });

  it("Web Crypto 없는 local 세션에서는 일반 대화만 허용하고 기억 action은 차단한다", () => {
    const insecureStorage = new MockSessionStorage();
    insecureStorage.setItem("tanya.webchatSessionId", "local-16-80000000800000008000000080000000");
    vi.stubGlobal("sessionStorage", insecureStorage);
    let result = renderHook();
    const socket = MockWebSocket.instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();
    result = renderHook();

    expect(result.memoryCapsuleSessionSecure).toBe(false);
    expect(result.canUseMemoryCapsule).toBe(false);
    expect(result.tutorialSessionSecure).toBe(false);
    expect(result.canUseTutorial).toBe(false);
    expect(result.prepareMemoryCapsule(20)).toBeNull();
    expect(result.recallMemoryCapsule()).toBeNull();
    expect(result.sendTutorialAction({ action: "tutorial_start", payload: {} })).toBeNull();
    expect(result.sendText("일반 대화는 계속해요")).toBe(true);
    expect(socket.send).toHaveBeenCalledOnce();
  });

  it("기억 캡슐 서버 이벤트를 전용 콜백으로만 전달한다", () => {
    const onMemoryCapsuleEvent = vi.fn();
    renderHook({ onMemoryCapsuleEvent });
    const socket = MockWebSocket.instances[0];

    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "memory_capsule_approval_required",
      payload: {
        operationId: "11111111-1111-4111-8111-111111111111",
        approvalToken: "approval-1",
        preparationMinutes: 20,
        content: "사용자는 일정 전에 20분의 준비 시간을 선호합니다.",
        sessionScoped: true,
        source: {
          type: "explicit_choice",
          label: "준비 시간 선택",
          sessionScoped: true,
          createdAt: "2099-09-02T12:00:00Z",
        },
        expiresAt: "2099-09-02T12:30:00Z",
      },
    }) });

    expect(onMemoryCapsuleEvent).toHaveBeenCalledWith({
      kind: "approval-required",
      operationId: "11111111-1111-4111-8111-111111111111",
      draft: {
        approvalToken: "approval-1",
        capsule: {
          preparationMinutes: 20,
          content: "사용자는 일정 전에 20분의 준비 시간을 선호합니다.",
        },
        source: {
          type: "explicit_choice",
          label: "준비 시간 선택",
          sessionScoped: true,
          createdAt: "2099-09-02T12:00:00Z",
        },
        sessionScoped: true,
        expiresAt: "2099-09-02T12:30:00Z",
      },
    });
  });

  it("tutorial 이벤트를 일반 대화와 섞지 않고 최신 전용 콜백으로 전달한다", () => {
    const previous = vi.fn();
    const latest = vi.fn();
    renderHook({ onTutorialEvent: previous });
    renderHook({ onTutorialEvent: latest });
    const socket = MockWebSocket.instances[0];

    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "tutorial_state",
      payload: {
        flowId: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        phase: "preferences_pending",
        expiresAt: "2026-09-03T12:30:00Z",
        calendarStatus: null,
        taskStatus: null,
        memoryStatus: "empty",
      },
    }) });

    expect(previous).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith({
      kind: "state",
      flowId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      snapshot: {
        phase: "preferences_pending",
        expiresAt: "2026-09-03T12:30:00Z",
        calendarStatus: null,
        taskStatus: null,
        memoryStatus: "empty",
      },
    });
    expect(renderHook().messages).toEqual([]);
  });

  it("malformed tutorial 이벤트는 전용 콜백과 일반 대화를 모두 바꾸지 않는다", () => {
    const onTutorialEvent = vi.fn();
    renderHook({ onTutorialEvent });
    const socket = MockWebSocket.instances[0];
    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "tutorial_state",
      payload: {
        flowId: "wrong-flow",
        operationId: "22222222-2222-4222-8222-222222222222",
        phase: "preferences_pending",
      },
    }) });
    expect(onTutorialEvent).not.toHaveBeenCalled();
    expect(renderHook().messages).toEqual([]);
  });

  it("LLM 경로를 바로 뒤 타냐 답변에 묶는다", () => {
    renderHook();
    const socket = MockWebSocket.instances[0];

    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "llm_route",
      payload: { mode: "casual", provider: "ollama", execution: "local", fallback: false },
    }) });
    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "text_stream",
      payload: { text: "반가워요." },
    }) });

    const result = renderHook();
    expect(result.messages).toEqual([{
      id: expect.any(String),
      role: "tanya",
      text: "반가워요.",
      route: { mode: "casual", provider: "ollama", execution: "local", fallback: false },
    }]);
  });

  it("스트리밍 중 도착한 실제 폴백 경로로 기존 답변 배지를 정정한다", () => {
    renderHook();
    const socket = MockWebSocket.instances[0];

    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "llm_route",
      payload: { mode: "task", provider: "gemini", execution: "cloud", fallback: false },
    }) });
    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "text_stream",
      payload: { text: "답변을 생성하고 " },
    }) });
    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "llm_route",
      payload: { mode: "task", provider: "ollama", execution: "local", fallback: true },
    }) });
    socket.onmessage?.({ data: JSON.stringify({
      type: "event",
      event: "text_stream",
      payload: { text: "있어요." },
    }) });

    const result = renderHook();
    expect(result.messages).toEqual([{
      id: expect.any(String),
      role: "tanya",
      text: "답변을 생성하고 있어요.",
      route: { mode: "task", provider: "ollama", execution: "local", fallback: true },
    }]);
  });
});

describe("Brain 즉시 재연결", () => {
  const listeners: Record<string, Array<() => void>> = {};
  const documentStub = {
    visibilityState: "visible",
    addEventListener: (type: string, handler: () => void) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== handler);
    },
  };

  function fire(type: string) {
    for (const handler of [...(listeners[type] ?? [])]) handler();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reactState.effectCleanup = undefined;
    reactState.effectInitialized = false;
    reactState.refs.length = 0;
    reactState.stateValues.length = 0;
    MockWebSocket.instances.length = 0;
    for (const key of Object.keys(listeners)) delete listeners[key];
    documentStub.visibilityState = "visible";
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("sessionStorage", new MockSessionStorage());
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("window", {
      addEventListener: documentStub.addEventListener,
      removeEventListener: documentStub.removeEventListener,
    });
    let uuidCounter = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("화면이 다시 보이면 백오프를 기다리지 않고 즉시 다시 연결한다", () => {
    renderHook();
    MockWebSocket.instances[0].close();
    expect(MockWebSocket.instances).toHaveLength(1);

    // 백오프 타이머를 진행시키지 않은 상태에서 복귀시킨다.
    fire("visibilitychange");

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("네트워크가 돌아와도 같은 즉시 재연결 경로를 쓴다", () => {
    renderHook();
    MockWebSocket.instances[0].close();

    fire("online");

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("숨김 상태로 바뀐 것만으로는 다시 연결하지 않는다", () => {
    renderHook();
    MockWebSocket.instances[0].close();
    documentStub.visibilityState = "hidden";

    fire("visibilitychange");

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("이미 살아 있는 소켓이 있으면 중복 소켓을 만들지 않는다", () => {
    renderHook();
    const socket = MockWebSocket.instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    fire("visibilitychange");
    fire("online");

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("즉시 재연결 뒤 다시 끊기면 백오프가 1초부터 다시 시작한다", () => {
    renderHook();
    // 백오프를 4초까지 올려 둔다.
    MockWebSocket.instances[0].close();
    vi.advanceTimersByTime(1_000);
    MockWebSocket.instances[1].close();
    vi.advanceTimersByTime(2_000);
    MockWebSocket.instances[2].close();

    fire("visibilitychange");
    const afterImmediate = MockWebSocket.instances.length;

    MockWebSocket.instances[afterImmediate - 1].close();
    vi.advanceTimersByTime(1_000);

    expect(MockWebSocket.instances.length).toBe(afterImmediate + 1);
  });

  it("정리하면 재연결 리스너를 모두 해제한다", () => {
    renderHook();
    expect(listeners.visibilitychange).toHaveLength(1);
    expect(listeners.online).toHaveLength(1);

    reactState.effectCleanup?.();

    expect(listeners.visibilitychange).toHaveLength(0);
    expect(listeners.online).toHaveLength(0);
  });
});
