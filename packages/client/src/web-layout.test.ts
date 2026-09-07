import { describe, expect, it } from "vitest";
import {
  NARROW_VIEWPORT_QUERY,
  isNarrowViewport,
  shouldRenderSettingsWindow,
  shouldUseCompactWebLayout,
  shouldUseTauriGoogleUi,
  shouldShowConversation,
  shouldShowConversationClose,
} from "./web-layout";
import { shouldShowCaption } from "./caption";

describe("웹 체험판 레이아웃", () => {
  it("좁은 웹 화면에서도 Live2D 레이아웃을 유지한다", () => {
    expect(shouldUseCompactWebLayout(false, true)).toBe(false);
  });

  it("넓은 웹 화면에서는 Live2D 레이아웃을 유지한다", () => {
    expect(shouldUseCompactWebLayout(false, false)).toBe(false);
  });

  it("Tauri 창은 폭이 좁아도 모바일 폴백으로 바꾸지 않는다", () => {
    expect(shouldUseCompactWebLayout(true, true)).toBe(false);
  });

  it("설정 전용 화면은 Tauri 런타임에서만 연다", () => {
    expect(shouldRenderSettingsWindow(true, true)).toBe(true);
    expect(shouldRenderSettingsWindow(true, false)).toBe(false);
    expect(shouldRenderSettingsWindow(false, true)).toBe(false);
  });

  it("Google invoke UI는 Tauri 런타임에서만 사용한다", () => {
    expect(shouldUseTauriGoogleUi(true)).toBe(true);
    expect(shouldUseTauriGoogleUi(false)).toBe(false);
  });

  it("웹은 첫 방문부터 체험 대화를 보이고 Tauri는 사용자의 패널 상태를 따른다", () => {
    const webConversationOpen = shouldShowConversation(false, false);
    expect(webConversationOpen).toBe(true);
    expect(shouldShowCaption({
      captionsEnabled: true,
      chatPanelOpen: webConversationOpen,
      speaking: true,
      text: "대화창에 표시 중인 답변",
    })).toBe(false);
    expect(shouldShowConversation(true, false)).toBe(false);
    expect(shouldShowConversation(true, true)).toBe(true);
    expect(shouldShowConversationClose(false)).toBe(false);
    expect(shouldShowConversationClose(true)).toBe(true);
  });
});

describe("좁은 화면 판정", () => {
  it("matchMedia가 없으면 좁은 화면으로 보지 않는다", () => {
    expect(isNarrowViewport(undefined)).toBe(false);
  });

  it("CSS와 같은 520px 경계를 쓴다", () => {
    // 두 기준이 어긋나면 CSS는 모바일인데 JS는 아니라고 보는 상태가 생긴다.
    expect(NARROW_VIEWPORT_QUERY).toBe("(max-width: 520px)");
  });

  it("질의 결과를 그대로 따른다", () => {
    expect(isNarrowViewport(() => ({ matches: true }))).toBe(true);
    expect(isNarrowViewport(() => ({ matches: false }))).toBe(false);
  });

  it("matchMedia가 던져도 안전하게 false다", () => {
    expect(isNarrowViewport(() => { throw new Error("unsupported"); })).toBe(false);
  });
});
