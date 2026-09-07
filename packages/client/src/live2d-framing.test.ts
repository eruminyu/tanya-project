import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE2D_FRAMING,
  LIVE2D_FRAMING_PRESETS,
  matchingLive2DFramingPreset,
} from "./live2d-framing";

describe("Live2D 화면 구도", () => {
  it("흉상 구도를 기본값과 첫 프리셋으로 제공한다", () => {
    expect(LIVE2D_FRAMING_PRESETS[0]).toMatchObject({
      id: "bust",
      framing: DEFAULT_LIVE2D_FRAMING,
    });
    expect(DEFAULT_LIVE2D_FRAMING.scale).toBe(3);
    expect(DEFAULT_LIVE2D_FRAMING.offsetY).toBe(-2);
  });

  it("정확한 프리셋만 선택 상태로 판별한다", () => {
    expect(matchingLive2DFramingPreset({ ...DEFAULT_LIVE2D_FRAMING })).toBe("bust");
    expect(matchingLive2DFramingPreset({
      ...DEFAULT_LIVE2D_FRAMING,
      offsetX: 0.2,
    })).toBeNull();
  });
});
