import { describe, expect, it } from "vitest";
import { parseTutorialUtterance, tutorialBlockMessage, tutorialInputKey, tutorialUtteranceContext, type TutorialBlockReason, type TutorialUtteranceContext } from "./tutorial-utterance";
import { initialTutorialState, type TutorialApproval, type TutorialState } from "./tutorial";

const ready: TutorialUtteranceContext = { blocked: null, phase: null, approvalPurpose: null, receiptReady: false };
const context = (phase: TutorialUtteranceContext["phase"], approvalPurpose: TutorialUtteranceContext["approvalPurpose"] = null): TutorialUtteranceContext => ({ ...ready, phase, approvalPurpose });

describe("공개 튜토리얼 제한 문법", () => {
  it.each([
    [null, "체험 시작할게", { intent: "start" }],
    ["preferences_pending", "기본으로", { intent: "preferences-default" }],
    ["preferences_pending", "설정 미리보기", { intent: "preferences-prepare" }],
    ["calendar_pending", "캘린더 해볼게", { intent: "google-prepare", googleKind: "calendar" }],
    ["calendar_pending", "건너뛸게", { intent: "google-skip", googleKind: "calendar" }],
    ["task_pending", "할 일도 만들어줘", { intent: "google-prepare", googleKind: "task" }],
    ["task_pending", "건너뛸게", { intent: "google-skip", googleKind: "task" }],
    ["answer_before", "답변 보여줘", { intent: "answer", comparison: "before" }],
    ["receipt_ready", "실행 결과 보여줘", { intent: "receipt" }],
    ["forgotten", "실행 결과 보여줘", { intent: "receipt" }],
    ["completed", "실행 결과 보여줘", { intent: "receipt" }],
  ] as const)("%s에서 %s를 기존 의도로 해석한다", (phase, text, action) => {
    expect(parseTutorialUtterance(context(phase), text)).toMatchObject({ kind: "action", ...action });
  });

  it.each([
    ["preferences_pending", "preferences", "이대로 저장해줘"],
    ["calendar_pending", "calendar", "이 일정으로 등록해줘"],
    ["task_pending", "task", "이대로 만들어줘"],
  ] as const)("%s의 명시 승인만 허용한다", (phase, purpose, text) => {
    expect(parseTutorialUtterance(context(phase, purpose), text)).toMatchObject({ kind: "action", intent: "approve" });
    expect(parseTutorialUtterance(context(phase), text).kind).toBe("clarify");
  });

  it.each(["등록하지 마", "거절할게", "취소할게", "저장 안 할래"])("%s는 승인이 아니다", (text) => {
    expect(parseTutorialUtterance(context("calendar_pending", "calendar"), text)).toMatchObject({ kind: "action", intent: "reject" });
  });

  it.each(["좋아", "아마", "괜찮을 것 같아", "등록해줘 그리고 취소할게", "등록하지 마 이 일정으로 등록해줘", "이 일정으로 등록해줘?", "이 일정으로 등록해줘\n지금 잊어줘", "취소하지 마", "이대로 저장해줘 그리고 시작해줘"])("%s는 외부 실행을 만들지 않는다", (text) => {
    expect(parseTutorialUtterance(context("calendar_pending", "calendar"), text).kind).toBe("clarify");
  });

  it("다른 대상의 승인과 preview 중 skip은 실행하지 않는다", () => {
    expect(parseTutorialUtterance(context("calendar_pending", "calendar"), "이대로 저장해줘").kind).toBe("clarify");
    expect(parseTutorialUtterance(context("calendar_pending", "calendar"), "건너뛸게").kind).toBe("clarify");
    expect(parseTutorialUtterance(context("task_pending", "calendar"), "이 일정으로 등록해줘").kind).toBe("clarify");
  });

  it("공백과 마침표만 정규화한다", () => {
    expect(parseTutorialUtterance(context("calendar_pending", "calendar"), "  이  일정으로 등록해줘!  ")).toMatchObject({ kind: "action", intent: "approve" });
  });

  it.each([
    ["알림은 5분 전", { type: "minutes", value: 5 }],
    ["알림은 10분 전", { type: "minutes", value: 10 }],
    ["알림은 20분 전", { type: "minutes", value: 20 }],
    ["정보는 구체적으로", { type: "select", key: "information", value: "concrete" }],
    ["정보는 큰 그림부터", { type: "select", key: "information", value: "big_picture" }],
    ["답변은 한 번에 완결", { type: "select", key: "interaction", value: "complete" }],
    ["답변은 대화하며 조정", { type: "select", key: "interaction", value: "interactive" }],
    ["선택은 확인된 근거", { type: "select", key: "decision", value: "evidence" }],
    ["선택은 현재 상황", { type: "select", key: "decision", value: "context" }],
    ["계획은 단계대로", { type: "select", key: "planning", value: "structured" }],
    ["계획은 유연하게", { type: "select", key: "planning", value: "flexible" }],
  ] as const)("%s는 저장 없이 선택만 바꾼다", (text, change) => {
    expect(parseTutorialUtterance(context("preferences_pending"), text)).toMatchObject({ kind: "selection", change });
    expect(parseTutorialUtterance(context("preferences_pending", "preferences"), text).kind).toBe("clarify");
  });

  it("영수증 확인 뒤에만 잊기와 삭제 후 답변을 허용한다", () => {
    expect(parseTutorialUtterance(context("receipt_ready"), "지금 잊어줘").kind).toBe("clarify");
    expect(parseTutorialUtterance({ ...context("receipt_ready"), receiptReady: true }, "지금 잊어줘")).toMatchObject({ kind: "action", intent: "forget" });
    expect(parseTutorialUtterance(context("forgotten"), "답변 보여줘").kind).toBe("clarify");
    expect(parseTutorialUtterance({ ...context("forgotten"), receiptReady: true }, "답변 보여줘")).toMatchObject({ kind: "action", intent: "answer", comparison: "after" });
  });

  it.each(["preferences_saved", "calendar_executing", "calendar_finished", "task_executing", "task_finished", "forgetting", "answer_after"] as const)("전환 중 %s는 action을 만들지 않는다", (phase) => {
    for (const text of ["체험 시작할게", "이대로 저장해줘", "지금 잊어줘", "실행 결과 보여줘"]) {
      expect(parseTutorialUtterance(context(phase), text).kind).not.toBe("action");
    }
  });

  it("busy·disconnected·stale·resume는 안내만 반환한다", () => {
    expect(parseTutorialUtterance({ ...ready, blocked: "disconnected" }, "체험 시작할게").kind).toBe("clarify");
  });

  it("자유 요청을 LLM으로 전달할 action은 만들지 않는다", () => {
    expect(parseTutorialUtterance(ready, "내일 3시 회의 잡아줘").kind).toBe("unmatched");
  });
});

describe("입력 시점과 현재 승인 결속", () => {
  const state = (): TutorialState => ({
    ...initialTutorialState("11111111-1111-4111-8111-111111111111"),
    needsResume: false,
    snapshot: { phase: "calendar_pending", expiresAt: "2099-01-01T00:00:00Z", calendarStatus: null, taskStatus: null, memoryStatus: "saved" },
    operation: { id: "operation", kind: "google-prepare", requestId: "request" },
    approval: { flowId: "11111111-1111-4111-8111-111111111111", requestId: "request", operationId: "operation", expiresAt: "2099-01-01T00:00:00Z", purpose: "calendar", preview: { kind: "calendar" }, approvalToken: "secret" } as TutorialApproval,
  });
  it("parser context에 token·식별자·preview 본문을 노출하지 않는다", () => {
    expect(tutorialUtteranceContext(state(), { connected: true, sessionSecure: true })).toEqual({ blocked: null, phase: "calendar_pending", approvalPurpose: "calendar", receiptReady: false });
  });
  it.each([
    (s: TutorialState) => { s.busy = true; },
    (s: TutorialState) => { s.needsResume = true; },
    (s: TutorialState) => { s.snapshot!.expiresAt = "2000-01-01T00:00:00Z"; },
    (s: TutorialState) => { s.approval!.expiresAt = "2000-01-01T00:00:00Z"; },
    (s: TutorialState) => { s.approval!.flowId = "other"; },
    (s: TutorialState) => { s.approval!.requestId = "other"; },
    (s: TutorialState) => { s.approval!.operationId = "other"; },
    (s: TutorialState) => { s.approval!.purpose = "task"; },
  ])("복구 또는 잘못 결속된 승인을 차단한다", (mutate) => {
    const s = state(); mutate(s);
    expect(parseTutorialUtterance(tutorialUtteranceContext(s, { connected: true, sessionSecure: true }), "이 일정으로 등록해줘").kind).toBe("clarify");
  });
  it("다른 단계·새 승인·재연결은 기존 입력 key와 다르다", () => {
    const s = state(); const key = tutorialInputKey(s, 1);
    expect(tutorialInputKey(s, 2)).not.toBe(key);
    s.approval = { ...s.approval!, operationId: "resumed-operation" };
    expect(tutorialInputKey(s, 1)).not.toBe(key);
    expect(key).not.toContain("secret");
  });
});

describe("차단 사유 구분", () => {
  const base = (): TutorialState => ({
    ...initialTutorialState(),
    flowId: "11111111-1111-4111-8111-111111111111",
    snapshot: { phase: "calendar_pending", expiresAt: "2099-01-01T00:00:00Z", calendarStatus: null, taskStatus: null, memoryStatus: "saved" },
  });

  it.each<[string, Partial<{ connected: boolean; sessionSecure: boolean }>, (s: TutorialState) => void, TutorialBlockReason]>([
    ["안전하지 않은 세션", { sessionSecure: false }, () => undefined, "insecure-session"],
    ["연결 끊김", { connected: false }, () => undefined, "disconnected"],
    ["이전 요청 진행 중", {}, (s) => { s.busy = true; }, "busy"],
    ["서버 단계 재확인", {}, (s) => { s.needsResume = true; }, "resuming"],
    ["세션 만료", {}, (s) => { s.snapshot!.expiresAt = "2000-01-01T00:00:00Z"; }, "session-expired"],
  ])("%s은 %s로 구분한다", (_label, availability, mutate, expected) => {
    const state = base();
    mutate(state);
    const result = tutorialUtteranceContext(state, { connected: true, sessionSecure: true, ...availability });
    expect(result.blocked).toBe(expected);
  });

  it("사유마다 서로 다른 안내 문구를 준다", () => {
    const reasons: TutorialBlockReason[] = [
      "disconnected", "insecure-session", "busy", "resuming", "approval-expired", "session-expired",
    ];
    const messages = reasons.map(tutorialBlockMessage);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages.every((message) => message.trim().length > 0)).toBe(true);
  });

  it("차단된 입력은 사유 문구를 그대로 안내하고 서버 action을 만들지 않는다", () => {
    const result = parseTutorialUtterance({ ...ready, blocked: "resuming" }, "체험 시작할게");
    expect(result).toEqual({ kind: "clarify", message: tutorialBlockMessage("resuming") });
  });
});
