import { describe, expect, it } from "vitest";
import { initialCompanionState, reduceCompanionState } from "./companion-mode";

describe("companion mode", () => {
  it("기본 상태는 상호작용 가능한 Presence다", () => {
    expect(initialCompanionState).toEqual({ mode: { kind: "presence" }, interaction: "interactive" });
  });

  it("잠금과 해제를 명시적으로 전환한다", () => {
    const locked = reduceCompanionState(initialCompanionState, { type: "lock" });
    expect(locked.interaction).toBe("click-through");
    expect(reduceCompanionState(locked, { type: "activate" }).interaction).toBe("interactive");
  });

  it("드래그는 상호작용 상태에서만 시작한다", () => {
    const locked = reduceCompanionState(initialCompanionState, { type: "lock" });
    expect(reduceCompanionState(locked, { type: "drag-start" })).toBe(locked);
    expect(reduceCompanionState(initialCompanionState, { type: "drag-start" }).interaction).toBe("dragging");
  });

  it("Whisper를 열고 닫으면 단일 모드가 전환된다", () => {
    const whisper = reduceCompanionState(initialCompanionState, { type: "open-whisper" });
    expect(whisper.mode).toEqual({ kind: "whisper", expanded: false });
    expect(reduceCompanionState(whisper, { type: "close-overlay" }).mode).toEqual({ kind: "presence" });
  });

  it("Agent Dock을 열고 닫으면 Presence로 복귀한다", () => {
    const dock = reduceCompanionState(initialCompanionState, { type: "open-agent-dock" });
    expect(dock.mode).toEqual({ kind: "agent-dock" });
    expect(reduceCompanionState(dock, { type: "close-overlay" }).mode).toEqual({ kind: "presence" });
  });
});
