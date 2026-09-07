import { describe, expect, it } from "vitest";
import { shouldShowCaption } from "./caption";

const visibleCaption = {
  captionsEnabled: true,
  chatPanelOpen: false,
  speaking: true,
  text: "지금 말하고 있어요.",
};

describe("발화 자막 표시 판정", () => {
  it("모든 표시 조건을 만족하면 자막을 보여준다", () => {
    expect(shouldShowCaption(visibleCaption)).toBe(true);
  });

  it("자막 설정이 꺼져 있으면 숨긴다", () => {
    expect(shouldShowCaption({ ...visibleCaption, captionsEnabled: false })).toBe(false);
  });

  it("대화창이 열려 있으면 숨긴다", () => {
    expect(shouldShowCaption({ ...visibleCaption, chatPanelOpen: true })).toBe(false);
  });

  it("TTS가 재생 중이 아니면 숨긴다", () => {
    expect(shouldShowCaption({ ...visibleCaption, speaking: false })).toBe(false);
  });

  it("텍스트가 비어 있거나 공백뿐이면 숨긴다", () => {
    expect(shouldShowCaption({ ...visibleCaption, text: "" })).toBe(false);
    expect(shouldShowCaption({ ...visibleCaption, text: "  \n  " })).toBe(false);
  });
});
