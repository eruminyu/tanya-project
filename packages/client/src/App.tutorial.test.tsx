import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { TutorialApproval, TutorialState } from "./tutorial";

const harness = vi.hoisted(() => ({
  cursor: 0, slots: [] as any[], tauri: false, connected: true, epoch: 1,
  voice: null as any, brain: null as any,
  send: vi.fn(), sendText: vi.fn(),
}));
vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: () => undefined,
  useState: (initial: any) => {
    const i = harness.cursor++;
    if (!(i in harness.slots)) harness.slots[i] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[i], (value: any) => { harness.slots[i] = typeof value === "function" ? value(harness.slots[i]) : value; }];
  },
  useReducer: (reducer: any, initial: any, init?: any) => {
    const i = harness.cursor++;
    if (!(i in harness.slots)) harness.slots[i] = init ? init(initial) : initial;
    return [harness.slots[i], (action: any) => { harness.slots[i] = reducer(harness.slots[i], action); }];
  },
  useRef: (initial: any) => {
    const i = harness.cursor++;
    if (!(i in harness.slots)) harness.slots[i] = { current: initial };
    return harness.slots[i];
  },
}));
vi.mock("./Live2DStage", () => ({ Live2DStage: () => null }));
vi.mock("./hooks/useCompanionWindow", () => ({ useCompanionWindow: () => ({
  tauriRuntime: harness.tauri, chatPanelOpen: true, companionState: { interaction: "interactive" },
  activateCompanion: vi.fn(), changeChatPanelOpen: vi.fn(),
}) }));
vi.mock("./hooks/useAppSettings", () => ({ useAppSettings: () => ({ appSettings: { brainUrl: "http://localhost:8098" } }) }));
vi.mock("./hooks/useTtsAudio", () => ({ useTtsAudio: () => ({ clientSettings: {}, setAudioError: vi.fn(), resetAudio: vi.fn(), unlockAudio: vi.fn() }) }));
vi.mock("./hooks/useVoiceInput", () => ({ useVoiceInput: (options: any) => {
  harness.voice = options;
  return { voiceSession: { state: "idle" }, startVoiceInput: vi.fn(), stopVoiceInput: vi.fn() };
} }));
vi.mock("./hooks/useBrainConnection", () => ({ useBrainConnection: (options: any) => {
  harness.brain = options;
  return { connection: harness.connected ? "connected" : "disconnected", connectionEpoch: harness.epoch,
    messages: [], canSend: harness.connected, tutorialSessionSecure: true, canUseTutorial: harness.connected,
    sendText: harness.sendText, sendTutorialAction: harness.send };
} }));

import { App } from "./App";
import { TutorialPanel } from "./TutorialPanel";
import { initialTutorialState } from "./tutorial";

type Node = ReactElement<any>;
let tree: Node;
function render() { harness.cursor = 0; tree = App(); }
function find(predicate: (node: Node) => boolean, value: any = tree): Node {
  if (value && typeof value === "object" && predicate(value)) return value;
  for (const child of [value?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    const result = find(predicate, child);
    if (result) return result;
  }
  return undefined as unknown as Node;
}
const panel = () => find((node) => node.type === TutorialPanel).props;
const input = () => find((node) => node.type === "input" && Boolean(node.props["aria-label"]));
function type(text: string) { input().props.onChange({ target: { value: text } }); render(); }
function submit() { find((node) => node.type === "form").props.onSubmit({ preventDefault: vi.fn() }); }
function setState(state: TutorialState) {
  const i = harness.slots.findIndex((slot) => slot && "snapshot" in Object(slot) && "needsResume" in Object(slot));
  harness.slots[i] = state; render();
}
function atPhase(phase: NonNullable<TutorialState["snapshot"]>["phase"]): TutorialState {
  return { ...initialTutorialState("11111111-1111-4111-8111-111111111111"), needsResume: false,
    snapshot: { phase, expiresAt: "2099-01-01T00:00:00Z", memoryStatus: "saved", calendarStatus: null, taskStatus: null } };
}
function withApproval(): TutorialState {
  return { ...atPhase("calendar_pending"), operation: { id: "op", kind: "google-prepare", requestId: "request" },
    approval: { flowId: "11111111-1111-4111-8111-111111111111", operationId: "op", requestId: "request", purpose: "calendar",
      expiresAt: "2099-01-01T00:00:00Z", approvalToken: "secret", preview: { kind: "calendar" } } as TutorialApproval };
}
beforeEach(() => {
  harness.slots = []; harness.tauri = false; harness.connected = true; harness.epoch = 1;
  harness.send.mockReset().mockReturnValue("22222222-2222-4222-8222-222222222222");
  harness.sendText.mockReset().mockReturnValue(true);
  render();
});

describe("App 공개 입력과 기존 버튼 연결", () => {
  it.each([
    [null, "체험 시작할게", (p: any) => p.onStart()],
    ["preferences_pending", "기본으로", (p: any) => p.onPreparePreferences({ interaction: "neutral", information: "neutral", decision: "neutral", planning: "neutral" }, 10)],
    ["calendar_pending", "캘린더 해볼게", (p: any) => p.onPrepareGoogle("calendar")],
    ["task_pending", "건너뛸게", (p: any) => p.onSkipGoogle("task")],
    ["answer_before", "답변 보여줘", (p: any) => p.onGenerateAnswer("before")],
    ["receipt_ready", "실행 결과 보여줘", (p: any) => p.onGetReceipt()],
  ] as const)("%s에서 채팅과 버튼 payload가 같다", (phase, text, click) => {
    const state = phase ? atPhase(phase) : initialTutorialState();
    setState(state); type(text); submit();
    const typed = harness.send.mock.calls[0]?.[0];
    expect(typed).toBeDefined();
    setState(state); click(panel());
    expect(harness.send.mock.calls[1][0]).toEqual(typed);
    expect(harness.sendText).not.toHaveBeenCalled();
  });

  it("같은 렌더에서 연속 submit과 버튼을 눌러도 요청은 한 건이다", () => {
    type("체험 시작할게"); const click = panel().onStart;
    submit(); submit(); click();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
  it("공개 transcript는 승인 preview가 있어도 자동 전송되지 않는다", () => {
    setState(withApproval());
    harness.voice.onActivate(); harness.voice.onTranscribed("이 일정으로 등록해줘"); render();
    expect(input().props.value).toBe("이 일정으로 등록해줘");
    expect(harness.send).not.toHaveBeenCalled(); expect(harness.sendText).not.toHaveBeenCalled();
    submit();
    expect(harness.send).toHaveBeenCalledWith({ action: "tutorial_approve", payload: { flow_id: withApproval().flowId, request_id: "request", approval_token: "secret" } });
  });
  it("승인 입력과 버튼은 같은 token·request를 결합한다", () => {
    const state = withApproval(); setState(state); type("이 일정으로 등록해줘"); submit();
    const typed = harness.send.mock.calls[0][0];
    setState(state); panel().onApprove();
    expect(harness.send.mock.calls[1][0]).toEqual(typed);
  });
  it("녹음 중 바뀐 승인에 이전 transcript를 사용하지 않는다", () => {
    setState(withApproval()); harness.voice.onActivate();
    harness.epoch++; render();
    harness.voice.onTranscribed("이 일정으로 등록해줘"); render(); submit();
    expect(harness.send).not.toHaveBeenCalled();
  });
  it("오래된 입력은 지우고 다시 입력하기 전까지 실행하지 않는다", () => {
    setState(withApproval()); type("이 일정으로 등록해줘");
    harness.epoch++; render(); submit();
    type("이 일정으로 등록해줘!"); submit();
    expect(harness.send).not.toHaveBeenCalled();
    type(""); type("이 일정으로 등록해줘"); submit();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
  it.each(["좋아", "등록하지 마 이 일정으로 등록해줘", "내일 3시 회의 잡아줘"])("%s는 action과 일반 LLM 전송 모두 0건이다", (text) => {
    setState(withApproval()); type(text); submit();
    expect(harness.send).not.toHaveBeenCalled(); expect(harness.sendText).not.toHaveBeenCalled();
  });
  it.each(["busy", "needsResume", "disconnected"])("%s에서는 입력으로 실행하지 않는다", (reason) => {
    const state = withApproval();
    if (reason === "disconnected") harness.connected = false;
    else state[reason as "busy" | "needsResume"] = true;
    setState(state); type("이 일정으로 등록해줘"); submit();
    expect(harness.send).not.toHaveBeenCalled();
  });
  it("선택을 변경한 뒤 같은 draft로 미리보기를 만든다", () => {
    setState(atPhase("preferences_pending")); type("정보는 구체적으로"); submit(); render();
    expect(harness.send).not.toHaveBeenCalled();
    expect(panel().draft.preferences.information).toBe("concrete");
    type("설정 미리보기"); submit();
    expect(harness.send.mock.calls[0][0].payload.preferences.information).toBe("concrete");
  });
  it("영수증 확인 뒤 잊기 입력과 버튼 payload가 같다", () => {
    const state = atPhase("receipt_ready");
    state.receipt = { flowId: state.flowId, operationId: "receipt", storage: { memoryStatus: "saved" } } as TutorialState["receipt"];
    setState(state); type("지금 잊어줘"); submit();
    const typed = harness.send.mock.calls[0][0];
    expect(typed.action).toBe("tutorial_forget");
    setState(state); panel().onForget();
    expect(harness.send.mock.calls[1][0]).toEqual(typed);
  });
  it("음성 잊기 transcript도 검토 후 전송해야 실행한다", () => {
    const state = atPhase("receipt_ready");
    state.receipt = { flowId: state.flowId, operationId: "receipt", storage: { memoryStatus: "saved" } } as TutorialState["receipt"];
    setState(state); harness.voice.onActivate(); harness.voice.onTranscribed("지금 잊어줘"); render();
    expect(harness.send).not.toHaveBeenCalled();
    submit(); expect(harness.send.mock.calls[0][0].action).toBe("tutorial_forget");
  });
  it("삭제 후 답변은 redacted 영수증을 확인한 상태에서 보낸다", () => {
    const state = atPhase("forgotten");
    state.receipt = { flowId: state.flowId, operationId: "receipt", storage: { memoryStatus: "forgotten" } } as TutorialState["receipt"];
    setState(state); type("답변 보여줘"); submit();
    expect(harness.send.mock.calls[0][0]).toMatchObject({ action: "tutorial_answer_generate", payload: { comparison: "after" } });
  });
  it("Tauri transcript는 기존 일반 메시지로 전송한다", () => {
    harness.tauri = true; render(); harness.voice.onTranscribed("안녕");
    expect(harness.sendText).toHaveBeenCalledWith("안녕"); expect(harness.send).not.toHaveBeenCalled();
  });
  it("한글 조합 중 Enter는 제출을 막는다", () => {
    const event = { key: "Enter", nativeEvent: { isComposing: true }, preventDefault: vi.fn() };
    input().props.onKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("STT 변이 제안 수락 경계", () => {
  const suggestion = () => find((node) =>
    node.type === "button" && node.props?.className === "tutorial-suggestion");

  it("변이 전사는 실행하지 않고 제안만 만든다", () => {
    setState(withApproval());
    type("2일점으로 등록해져");
    submit();

    expect(harness.send).not.toHaveBeenCalled();
    render();
    expect(suggestion()).toBeDefined();
    expect(suggestion().props.children).toContain("이 일정으로 등록해줘");
  });

  it("제안을 눌러야 비로소 승인 요청이 나간다", () => {
    setState(withApproval());
    type("이 일점으로 등록해져");
    submit();
    render();
    expect(harness.send).not.toHaveBeenCalled();

    suggestion().props.onClick();

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.calls[0][0].action).toBe("tutorial_approve");
  });

  it("제안 수락 payload는 버튼 승인과 같다", () => {
    setState(withApproval());
    type("이 일점으로 등록해져"); submit(); render();
    suggestion().props.onClick();
    const accepted = harness.send.mock.calls[0][0];

    setState(withApproval());
    panel().onApprove();

    expect(harness.send.mock.calls[1][0]).toEqual(accepted);
  });

  it("같은 변이를 다시 전송해도 자동 수락되지 않는다", () => {
    setState(withApproval());
    type("2일점으로 등록해져");
    submit(); submit(); submit();

    expect(harness.send).not.toHaveBeenCalled();
  });

  it("제안 뒤 단계가 바뀌면 눌러도 실행하지 않는다", () => {
    setState(withApproval());
    type("이 일점으로 등록해져"); submit(); render();
    const stale = suggestion().props.onClick;

    setState(atPhase("task_pending"));
    stale();

    expect(harness.send).not.toHaveBeenCalled();
  });

  it("임계값 밖 입력에는 제안을 만들지 않는다", () => {
    setState(withApproval());
    type("오늘 날씨 어때"); submit(); render();

    expect(suggestion()).toBeUndefined();
    expect(harness.send).not.toHaveBeenCalled();
  });
});
