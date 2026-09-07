import { describe, expect, it } from "vitest";
import { expansionLayout, initialUtilityState, reduceUtilityState, utilitySide } from "./utility-panel";

describe("Utility panel", () => {
  it("새 패널을 열면 기존 패널을 교체한다", () => {
    const calendar = reduceUtilityState(initialUtilityState, { type: "open", panel: "calendar" });
    const tasks = reduceUtilityState(calendar, { type: "open", panel: "tasks" });
    expect(tasks).toEqual({ panel: "tasks", size: "small" });
  });

  it("확대 상태에서 패널을 바꾸면 크기를 유지한다", () => {
    const calendar = { panel: "calendar", size: "medium" } as const;
    expect(reduceUtilityState(calendar, { type: "open", panel: "tasks" }))
      .toEqual({ panel: "tasks", size: "medium" });
  });

  it("소형과 중형 크기를 전환한다", () => {
    const opened = reduceUtilityState(initialUtilityState, { type: "open", panel: "calendar" });
    expect(reduceUtilityState(opened, { type: "toggle-size" })?.size).toBe("medium");
  });

  it("오른쪽 공간이 부족하면 왼쪽으로 반전한다", () => {
    expect(utilitySide({ left: 720, right: 920 }, 1000, 320)).toBe("left");
    expect(utilitySide({ left: 80, right: 280 }, 1000, 320)).toBe("right");
  });

  it("닫으면 열린 패널이 없어진다", () => {
    const opened = reduceUtilityState(initialUtilityState, { type: "open", panel: "tasks" });
    expect(reduceUtilityState(opened, { type: "close" })).toBeNull();
  });

  it("오른쪽 공간이 부족하면 창을 왼쪽으로 확장한다", () => {
    expect(expansionLayout({ windowX: 800, compactWidth: 440, expandedWidth: 780, monitorLeft: 0, monitorRight: 1280 }))
      .toEqual({ side: "left", expandedX: 460 });
  });

  it("오른쪽 공간이 충분하면 현재 위치를 유지한다", () => {
    expect(expansionLayout({ windowX: 300, compactWidth: 440, expandedWidth: 780, monitorLeft: 0, monitorRight: 1920 }))
      .toEqual({ side: "right", expandedX: 300 });
  });
});
