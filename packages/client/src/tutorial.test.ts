import { describe, expect, it } from "vitest";
import {
  TUTORIAL_FLOW_STORAGE_KEY,
  TUTORIAL_OPERATION_TIMEOUT_MS,
  extractTutorialEvent,
  initialTutorialState,
  initialTutorialPreferenceDraft,
  reduceTutorialPreferenceDraft,
  reduceTutorial,
  tutorialNeedsAutomaticReceipt,
  tutorialOperationTimeoutMs,
  type TutorialBrainEvent,
} from "./tutorial";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_FLOW_ID = "22222222-2222-4222-8222-222222222222";
const START_OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_OPERATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function envelope(event: string, payload: Record<string, unknown>) {
  return { type: "event", event, payload };
}

function stateEvent(
  operationId = OPERATION_ID,
  flowId = FLOW_ID,
  phase = "calendar_pending",
  memoryStatus: "empty" | "pending" | "saved" | "forgotten" = phase === "preferences_pending" ? "empty" : "saved",
): TutorialBrainEvent {
  const parsed = extractTutorialEvent(envelope("tutorial_state", {
    flowId,
    operationId,
    phase,
    expiresAt: "2026-09-03T12:30:00Z",
    calendarStatus: null,
    taskStatus: null,
    memoryStatus,
  }));
  if (!parsed) throw new Error("state fixture must be valid");
  return parsed;
}

function approvalEvent(operationId = OPERATION_ID, requestId = REQUEST_ID): TutorialBrainEvent {
  const fields = {
    title: "Tanya 해커톤 준비 점검",
    startAt: "2026-09-03T21:10:00+09:00",
    endAt: "2026-09-03T21:40:00+09:00",
    timeZone: "Asia/Seoul",
  };
  const parsed = extractTutorialEvent(envelope("tutorial_approval_required", {
    flowId: FLOW_ID,
    operationId,
    requestId,
    purpose: "calendar",
    approvalToken: "opaque-memory-only-token",
    expiresAt: "2026-09-03T12:02:00Z",
    preview: {
      kind: "calendar",
      fields,
      executor: "public_demo_brain/google",
      accountScope: "shared_demo_account",
      message: "아직 Google에는 변경이 없습니다.",
      explanation: {
        whyNow: { code: "user_requested_tutorial_step", summary: "현재 단계를 요청했어요." },
        dataUsed: [{ type: "approved_tutorial_preferences", updatedAt: "2026-09-03T12:00:00Z" }],
        processing: { location: "self_hosted_brain_vm", route: "tutorial_service" },
        exactChange: { kind: "google_calendar_create", fields },
        executor: { type: "public_demo_brain", target: "google" },
        approval: { status: "required", executesOnApproval: true },
        changeState: "not_executed",
        retention: {
          memoryExpiresAt: "2026-09-03T12:30:00Z",
          googleCleanupAfterMinutes: 30,
          googleCleanupDueAt: null,
        },
      },
    },
  }));
  if (!parsed) throw new Error("approval fixture must be valid");
  return parsed;
}

function googleResultEvent(operationId = OPERATION_ID): TutorialBrainEvent {
  const parsed = extractTutorialEvent(envelope("tutorial_google_result", {
    flowId: FLOW_ID,
    operationId,
    requestId: REQUEST_ID,
    kind: "calendar",
    status: "uncertain",
    providerId: null,
    sentFields: null,
    createdAt: null,
    resolvedAt: "2026-09-03T12:01:00Z",
    cleanupDueAt: null,
    cleanupStatus: "unknown",
  }));
  if (!parsed) throw new Error("result fixture must be valid");
  return parsed;
}

function receiptEvent(operationId = OPERATION_ID, forgotten = false, withAnswerAfter = false): TutorialBrainEvent {
  const parsed = extractTutorialEvent(envelope("tutorial_receipt", {
    flowId: FLOW_ID,
    operationId,
    expiresAt: "2026-09-03T12:30:00Z",
    explanation: {
      whyNow: { code: "user_started_public_tutorial", summary: "공개 체험을 시작했어요." },
      dataUsed: forgotten ? [] : [{ type: "approved_tutorial_preferences", updatedAt: "2026-09-03T12:00:00Z" }],
      processing: { location: "self_hosted_brain_vm", route: "strict_ollama" },
      exactChange: { kind: "tutorial_receipt", fields: { google: { calendar: "succeeded" } } },
      executor: { type: "public_demo_brain", target: "google" },
      approval: { status: "approved" },
      changeState: "completed",
      retention: {
        memoryExpiresAt: "2026-09-03T12:30:00Z",
        googleCleanupAfterMinutes: 30,
        googleCleanupDueAt: "2026-09-03T12:31:00Z",
      },
    },
    preferences: forgotten ? null : {
      interaction: "neutral",
      information: "concrete",
      decision: "evidence",
      planning: "structured",
      preparationMinutes: 10,
    },
    storage: {
      type: "sqlite",
      execution: "self_hosted_brain_vm",
      scope: "session",
      memoryStatus: forgotten ? "forgotten" : "saved",
      forgottenAt: forgotten ? "2026-09-03T12:05:00Z" : null,
    },
    answerBefore: forgotten ? null : {
      route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
      sources: [{ type: "vm_memory", recordVersion: 1 }],
    },
    answerAfter: withAnswerAfter ? {
      route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
      sources: [],
    } : null,
    google: {
      calendar: {
        requestId: REQUEST_ID,
        providerId: "calendar-resource-1",
        status: "succeeded",
        sentFields: forgotten ? null : {
          title: "Tanya 해커톤 준비 점검",
          startAt: "2026-09-03T21:10:00+09:00",
          endAt: "2026-09-03T21:40:00+09:00",
          timeZone: "Asia/Seoul",
        },
        createdAt: forgotten ? null : "2026-09-03T12:01:00Z",
        cleanupDueAt: "2026-09-03T12:31:00Z",
        cleanupStatus: "scheduled",
      },
      task: null,
    },
    notSentToGoogle: ["preferences", "vm_memory"],
  }));
  if (!parsed) throw new Error("receipt fixture must be valid");
  return parsed;
}

describe("통합 튜토리얼 wire parser", () => {
  it("서버 snapshot을 strict union으로 해석한다", () => {
    const parsed = stateEvent();
    expect(parsed).toMatchObject({
      kind: "state",
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      snapshot: { phase: "calendar_pending", memoryStatus: "saved" },
    });
  });

  it("잘못된 UUID와 알려지지 않은 phase를 거절한다", () => {
    const base = {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      expiresAt: "2026-09-03T12:30:00Z",
      calendarStatus: null,
      taskStatus: null,
      memoryStatus: "empty",
    };
    expect(extractTutorialEvent(envelope("tutorial_state", { ...base, flowId: "not-a-uuid", phase: "preferences_pending" }))).toBeNull();
    expect(extractTutorialEvent(envelope("tutorial_state", { ...base, phase: "invented" }))).toBeNull();
    expect(extractTutorialEvent(envelope("tutorial_state", { ...base, phase: "preferences_pending", expiresAt: "2026-02-31T12:30:00Z" }))).toBeNull();
  });

  it("Ollama local no-fallback와 실제 model이 아닌 완료 이벤트를 거절한다", () => {
    const base = {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      comparison: "before",
      content: "준비 요약",
      appliedPreferences: {
        interaction: "neutral",
        information: "neutral",
        decision: "neutral",
        planning: "neutral",
      },
      sources: [{ type: "vm_memory", recordVersion: 1 }],
    };
    expect(extractTutorialEvent(envelope("tutorial_answer_completed", {
      ...base,
      route: { provider: "openai", execution: "cloud", fallback: false, model: "gpt" },
    }))).toBeNull();
    expect(extractTutorialEvent(envelope("tutorial_answer_completed", {
      ...base,
      route: { provider: "ollama", execution: "local", fallback: true, model: "qwen3:8b" },
    }))).toBeNull();
    expect(extractTutorialEvent(envelope("tutorial_answer_completed", {
      ...base,
      route: { provider: "ollama", execution: "local", fallback: false, model: "" },
    }))).toBeNull();
  });

  it("forgotten receipt에 개인화나 전송 필드가 남으면 거절한다", () => {
    const valid = receiptEvent(OPERATION_ID, true);
    if (valid.kind !== "receipt") throw new Error("receipt fixture must be a receipt");
    const raw = JSON.parse(JSON.stringify({ type: "event", event: "tutorial_receipt", payload: valid.receipt }));
    raw.payload.operationId = OPERATION_ID;
    raw.payload.flowId = FLOW_ID;
    raw.payload.preferences = {
      interaction: "neutral",
      information: "neutral",
      decision: "neutral",
      planning: "neutral",
      preparationMinutes: 10,
    };
    expect(extractTutorialEvent(raw)).toBeNull();
  });

  it("삭제 후 answerAfter에 VM source가 섞인 receipt를 거절한다", () => {
    const valid = receiptEvent(OPERATION_ID, true);
    if (valid.kind !== "receipt") throw new Error("receipt fixture must be a receipt");
    const raw = JSON.parse(JSON.stringify({ type: "event", event: "tutorial_receipt", payload: valid.receipt }));
    raw.payload.answerAfter = {
      route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
      sources: [{ type: "vm_memory", recordVersion: 1 }],
    };
    expect(extractTutorialEvent(raw)).toBeNull();
  });

  it("자동 정리 완료로 provider ID가 제거된 forgotten receipt를 수용한다", () => {
    const valid = receiptEvent(OPERATION_ID, true);
    if (valid.kind !== "receipt") throw new Error("receipt fixture must be a receipt");
    const raw = JSON.parse(JSON.stringify({ type: "event", event: "tutorial_receipt", payload: valid.receipt }));
    raw.payload.google.calendar.providerId = null;
    raw.payload.google.calendar.cleanupStatus = "succeeded";
    const parsed = extractTutorialEvent(raw);
    expect(parsed?.kind).toBe("receipt");
    if (parsed?.kind !== "receipt") throw new Error("cleanup receipt must be valid");
    expect(parsed.receipt.google.calendar).toMatchObject({ providerId: null, cleanupStatus: "succeeded" });
  });

  it("실패 결과의 non-null 비정상 필드를 null로 오인하지 않는다", () => {
    expect(extractTutorialEvent(envelope("tutorial_google_result", {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      kind: "calendar",
      status: "failed",
      providerId: "",
      sentFields: { leak: "must-reject" },
      createdAt: "invalid",
      resolvedAt: "2026-09-03T12:01:00Z",
      cleanupDueAt: "invalid",
      cleanupStatus: "not_required",
    }))).toBeNull();
  });

  it("receipt의 비정상 non-null redaction 필드를 거절한다", () => {
    const forgotten = receiptEvent(OPERATION_ID, true);
    const active = receiptEvent(OPERATION_ID, false);
    if (forgotten.kind !== "receipt" || active.kind !== "receipt") throw new Error("receipt fixtures must be valid");

    const malformedPreferences = JSON.parse(JSON.stringify({ type: "event", event: "tutorial_receipt", payload: forgotten.receipt }));
    malformedPreferences.payload.preferences = { secret: "must-reject" };
    expect(extractTutorialEvent(malformedPreferences)).toBeNull();

    const malformedForgottenAt = JSON.parse(JSON.stringify({ type: "event", event: "tutorial_receipt", payload: active.receipt }));
    malformedForgottenAt.payload.storage.forgottenAt = "invalid";
    expect(extractTutorialEvent(malformedForgottenAt)).toBeNull();

    const malformedGoogle = JSON.parse(JSON.stringify({ type: "event", event: "tutorial_receipt", payload: active.receipt }));
    Object.assign(malformedGoogle.payload.google.calendar, {
      status: "failed",
      providerId: "",
      sentFields: { leak: "must-reject" },
      createdAt: "invalid",
      cleanupDueAt: "invalid",
      cleanupStatus: "not_required",
    });
    expect(extractTutorialEvent(malformedGoogle)).toBeNull();
  });
});

describe("통합 튜토리얼 reducer", () => {
  it("개인화 문항을 뒤로 이동해도 앞선 선택을 보존한다", () => {
    let draft = reduceTutorialPreferenceDraft(initialTutorialPreferenceDraft, {
      type: "select",
      key: "interaction",
      value: "interactive",
    });
    draft = reduceTutorialPreferenceDraft(draft, { type: "next" });
    draft = reduceTutorialPreferenceDraft(draft, { type: "back" });
    expect(draft.step).toBe(0);
    expect(draft.preferences.interaction).toBe("interactive");
  });

  it("start operation과 맞는 첫 snapshot에서만 flow를 결합한다", () => {
    let state = initialTutorialState();
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: START_OPERATION_ID, kind: "start" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(START_OPERATION_ID, OTHER_FLOW_ID, "preferences_pending") });
    expect(state.flowId).toBe(OTHER_FLOW_ID);
    expect(state.snapshot?.phase).toBe("preferences_pending");

    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OTHER_OPERATION_ID, FLOW_ID, "calendar_pending") });
    expect(state.flowId).toBe(OTHER_FLOW_ID);
    expect(state.snapshot?.phase).toBe("preferences_pending");
  });

  it("flow, operation, request가 맞는 복수 Google 이벤트를 모두 적용한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "approve", requestId: REQUEST_ID },
    });
    state = reduceTutorial(state, { type: "brain-event", event: googleResultEvent() });
    expect(state.google.calendar?.status).toBe("uncertain");
    expect(state.busy).toBe(true);
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OPERATION_ID, FLOW_ID, "task_pending") });
    expect(state.snapshot?.phase).toBe("task_pending");
    expect(state.busy).toBe(false);

    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OTHER_OPERATION_ID, FLOW_ID, "answer_before") });
    expect(state.snapshot?.phase).toBe("task_pending");
  });

  it("resume의 state 다음 approval을 같은 operation에서 적용한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "resume" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OPERATION_ID, FLOW_ID, "calendar_pending") });
    state = reduceTutorial(state, { type: "brain-event", event: approvalEvent(OPERATION_ID) });
    expect(state.approval?.requestId).toBe(REQUEST_ID);
    expect(state.operation).toMatchObject({ id: OPERATION_ID, kind: "resume", requestId: REQUEST_ID });
  });

  it("resume의 state 다음 receipt를 같은 operation에서 적용한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "resume" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OPERATION_ID, FLOW_ID, "receipt_ready") });
    state = reduceTutorial(state, { type: "brain-event", event: receiptEvent(OPERATION_ID) });
    expect(state.receipt?.operationId).toBe(OPERATION_ID);
    expect(state.busy).toBe(false);
    expect(state.needsResume).toBe(false);
  });

  it("timeout 뒤 같은 operation의 늦은 결과와 state를 모두 무시한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "approve", requestId: REQUEST_ID },
    });
    state = reduceTutorial(state, { type: "operation-timeout", operationId: OPERATION_ID });
    state = reduceTutorial(state, { type: "brain-event", event: googleResultEvent(OPERATION_ID) });
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OPERATION_ID, FLOW_ID, "task_pending") });
    expect(state.google.calendar).toBeUndefined();
    expect(state.snapshot).toBeNull();
    expect(state.needsResume).toBe(true);
  });

  it("다른 request 결과와 연결 손실 뒤 늦은 approval을 무시한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: START_OPERATION_ID, kind: "resume" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(START_OPERATION_ID) });
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "google-prepare" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: approvalEvent() });
    expect(state.approval?.requestId).toBe(REQUEST_ID);

    state = reduceTutorial(state, {
      type: "brain-event",
      event: approvalEvent(OPERATION_ID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    });
    expect(state.approval?.requestId).toBe(REQUEST_ID);

    state = reduceTutorial(state, { type: "connection-lost" });
    expect(state.approval).toBeNull();
    expect(state.operation).toBeNull();
    expect(state.needsResume).toBe(true);
    state = reduceTutorial(state, { type: "brain-event", event: approvalEvent() });
    expect(state.approval).toBeNull();
  });

  it("안정 단계에서 연결이 끊겨도 다음 연결은 resume을 먼저 요구한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "resume" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: stateEvent(OPERATION_ID, FLOW_ID, "completed") });
    expect(state.busy).toBe(false);
    expect(state.needsResume).toBe(false);
    state = reduceTutorial(state, { type: "connection-lost" });
    expect(state.operation).toBeNull();
    expect(state.needsResume).toBe(true);
  });

  it("새 receipt를 merge하지 않고 교체해 forget 뒤 상세를 복원하지 않는다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "receipt" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: receiptEvent() });
    expect(state.receipt?.preferences?.preparationMinutes).toBe(10);
    expect(state.receipt?.google.calendar?.sentFields).not.toBeNull();

    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OTHER_OPERATION_ID, kind: "receipt" },
    });
    state = reduceTutorial(state, { type: "brain-event", event: receiptEvent(OTHER_OPERATION_ID, true) });
    expect(state.receipt?.preferences).toBeNull();
    expect(state.receipt?.answerBefore).toBeNull();
    expect(state.receipt?.google.calendar?.sentFields).toBeNull();
  });

  it("삭제 후 답변 완료 시 최신 receipt를 한 번 조회하고 answerAfter가 오면 멈춘다", () => {
    const staleReceiptEvent = receiptEvent(OPERATION_ID, true);
    if (staleReceiptEvent.kind !== "receipt") throw new Error("stale receipt fixture must be a receipt");
    let state: ReturnType<typeof initialTutorialState> = {
      ...initialTutorialState(FLOW_ID),
      needsResume: false,
      snapshot: {
        phase: "forgotten" as const,
        expiresAt: "2026-09-03T12:30:00Z",
        calendarStatus: "succeeded" as const,
        taskStatus: null,
        memoryStatus: "forgotten" as const,
      },
      receipt: staleReceiptEvent.receipt,
    };
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "answer", comparison: "after" },
    });
    const answer = extractTutorialEvent(envelope("tutorial_answer_completed", {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      comparison: "after",
      content: "기억 없이 만든 답변",
      route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
      appliedPreferences: {},
      sources: [],
    }));
    if (!answer) throw new Error("answer fixture must be valid");
    state = reduceTutorial(state, { type: "brain-event", event: answer });
    state = reduceTutorial(state, {
      type: "brain-event",
      event: stateEvent(OPERATION_ID, FLOW_ID, "completed", "forgotten"),
    });
    expect(tutorialNeedsAutomaticReceipt(state)).toBe(true);

    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OTHER_OPERATION_ID, kind: "receipt" },
    });
    expect(tutorialNeedsAutomaticReceipt(state)).toBe(false);
    const receiptRequestedState = state;
    const rateLimited = extractTutorialEvent(envelope("tutorial_error", {
      flowId: FLOW_ID,
      operationId: OTHER_OPERATION_ID,
      code: "rate_limited",
      message: "잠시 뒤 다시 확인해 주세요.",
      retryAfter: 30,
    }));
    if (!rateLimited) throw new Error("rate limit fixture must be valid");
    const limitedState = reduceTutorial(state, { type: "brain-event", event: rateLimited });
    expect(limitedState.error).toMatchObject({ code: "rate_limited", retryAfter: 30 });
    expect(limitedState.needsResume).toBe(false);
    expect(tutorialNeedsAutomaticReceipt(limitedState)).toBe(false);

    state = receiptRequestedState;
    state = reduceTutorial(state, {
      type: "brain-event",
      event: receiptEvent(OTHER_OPERATION_ID, true, true),
    });
    expect(state.receipt?.answerAfter?.sources).toEqual([]);
    expect(tutorialNeedsAutomaticReceipt(state)).toBe(false);
  });

  it("최종 단계 resume 뒤에는 기존 영수증과 무관하게 최신 receipt를 한 번 조회한다", () => {
    const currentReceiptEvent = receiptEvent(OPERATION_ID, true, true);
    if (currentReceiptEvent.kind !== "receipt") throw new Error("current receipt fixture must be a receipt");
    let state: ReturnType<typeof initialTutorialState> = {
      ...initialTutorialState(FLOW_ID),
      needsResume: false,
      snapshot: {
        phase: "completed",
        expiresAt: "2026-09-03T12:30:00Z",
        calendarStatus: "succeeded",
        taskStatus: null,
        memoryStatus: "forgotten",
      },
      receipt: currentReceiptEvent.receipt,
    };
    expect(tutorialNeedsAutomaticReceipt(state)).toBe(false);
    state = reduceTutorial(state, { type: "connection-lost" });
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OTHER_OPERATION_ID, kind: "resume" },
    });
    state = reduceTutorial(state, {
      type: "brain-event",
      event: stateEvent(OTHER_OPERATION_ID, FLOW_ID, "completed", "forgotten"),
    });
    expect(tutorialNeedsAutomaticReceipt(state)).toBe(true);

    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: START_OPERATION_ID, kind: "receipt" },
    });
    expect(tutorialNeedsAutomaticReceipt(state)).toBe(false);
  });

  it("resume가 rate limit되면 이전 snapshot을 신뢰하지 않고 resume 요구를 유지한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "resume" },
    });
    const rateLimited = extractTutorialEvent(envelope("tutorial_error", {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      code: "rate_limited",
      message: "잠시 뒤 다시 확인해 주세요.",
      retryAfter: 30,
    }));
    if (!rateLimited) throw new Error("rate limit fixture must be valid");
    state = reduceTutorial(state, { type: "brain-event", event: rateLimited });
    expect(state).toMatchObject({ busy: false, needsResume: true, operation: null });
  });

  it("expired 오류는 flow와 메모리 token을 제거한다", () => {
    let state = initialTutorialState(FLOW_ID);
    state = reduceTutorial(state, {
      type: "operation-requested",
      operation: { id: OPERATION_ID, kind: "resume" },
    });
    const parsed = extractTutorialEvent(envelope("tutorial_error", {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      code: "expired",
      message: "튜토리얼 세션이 만료되었습니다.",
    }));
    if (!parsed) throw new Error("error fixture must be valid");
    state = reduceTutorial(state, { type: "brain-event", event: parsed });
    expect(state).toMatchObject({ flowId: null, snapshot: null, approval: null, busy: false });
  });

  it("flow 저장소 key는 승인 token을 암시하지 않는 단일 capability key다", () => {
    expect(TUTORIAL_FLOW_STORAGE_KEY).toBe("tanya.tutorial.flow-id");
    expect(TUTORIAL_FLOW_STORAGE_KEY).not.toMatch(/token|approval/i);
  });

  it("로컬 답변에는 일반 action보다 긴 서버 timeout 여유를 둔다", () => {
    expect(tutorialOperationTimeoutMs("answer")).toBeGreaterThan(180_000);
    expect(tutorialOperationTimeoutMs("resume")).toBe(TUTORIAL_OPERATION_TIMEOUT_MS);
  });
});
