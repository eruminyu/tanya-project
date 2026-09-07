import { describe, expect, it } from "vitest";
import { shouldIgnoreCursorEvents } from "./interaction-mode";

describe("shouldIgnoreCursorEvents", () => {
  it("Tauri에서 사용자가 잠그면 클릭을 통과시킨다", () => {
    expect(shouldIgnoreCursorEvents("click-through", true)).toBe(true);
  });

  it("Tauri에서 채팅 패널을 열면 상호작용을 허용한다", () => {
    expect(shouldIgnoreCursorEvents("interactive", true)).toBe(false);
  });

  it("브라우저에서는 채팅 패널 상태와 무관하게 상호작용을 허용한다", () => {
    expect(shouldIgnoreCursorEvents("click-through", false)).toBe(false);
  });
});
