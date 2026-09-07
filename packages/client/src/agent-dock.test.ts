import { describe, expect, it } from "vitest";
import { initialAgentDockState, reduceAgentDockState } from "./agent-dock";

describe("Agent Dock", () => {
  it("실제 작업이 없으면 빈 상태로 시작한다", () => {
    expect(initialAgentDockState).toEqual({ open: false, activity: null });
  });

  it("승인 요청은 실행하지 않고 대기 카드로 보관한다", () => {
    const state = reduceAgentDockState(initialAgentDockState, { type: "approval-required", skill: "google_calendar_create", reason: "일정을 생성하려면 승인이 필요합니다.", approvalToken: "token" });
    expect(state.open).toBe(true);
    expect(state.activity).toMatchObject({ status: "waiting", approvalEnabled: false });
  });

  it("실행 결과는 완료 상태와 실제 결과만 기록한다", () => {
    const state = reduceAgentDockState(initialAgentDockState, { type: "skill-result", skill: "calendar", summary: "일정을 확인했습니다.", sources: ["Google Calendar"] });
    expect(state.activity).toMatchObject({ status: "completed", sources: ["Google Calendar"] });
  });

  it("닫기는 작업 기록을 지우지 않는다", () => {
    const completed = reduceAgentDockState(initialAgentDockState, { type: "skill-result", skill: "tasks", summary: "완료", sources: [] });
    expect(reduceAgentDockState(completed, { type: "close" })).toEqual({ ...completed, open: false });
  });
});
