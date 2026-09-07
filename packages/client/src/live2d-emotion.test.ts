import { describe, expect, it } from "vitest";
import { normalizeLive2DEmotion } from "./live2d-emotion";

describe("Live2D 감정 정규화", () => {
  it.each([
    ["happy", "happy"],
    ["joy", "happy"],
    ["sad", "sad"],
    ["excited", "excited"],
    ["surprised", "excited"],
    ["worried", "worried"],
    ["anxious", "worried"],
    ["annoyed", "annoyed"],
    ["angry", "annoyed"],
    ["affectionate", "affectionate"],
    ["love", "affectionate"],
  ])("%s를 %s 표정으로 매핑한다", (input, expected) => {
    expect(normalizeLive2DEmotion(input)).toBe(expected);
  });

  it("알 수 없거나 비어 있는 감정은 neutral로 처리한다", () => {
    expect(normalizeLive2DEmotion("confused")).toBe("neutral");
    expect(normalizeLive2DEmotion(undefined)).toBe("neutral");
  });
});
