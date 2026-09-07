import { describe, expect, it } from "vitest";
import {
  INITIAL_LIVE2D_LOAD_PROGRESS,
  supportAssetLoadProgress,
  textureLoadProgress,
} from "./live2d-loading";

describe("Live2D 로딩 진행률", () => {
  it("처음에는 모델 정보를 확인한다고 안내한다", () => {
    expect(INITIAL_LIVE2D_LOAD_PROGRESS).toEqual({
      percent: 5,
      message: "모델 정보 확인 중",
    });
  });

  it("표정과 움직임 자산 진행률은 22~30% 범위에서 실제 완료 개수를 반영한다", () => {
    expect(supportAssetLoadProgress(0, 8)).toEqual({
      percent: 22,
      message: "표정과 움직임 0/8 준비 중",
    });
    expect(supportAssetLoadProgress(4, 8).percent).toBe(26);
    expect(supportAssetLoadProgress(8, 8).percent).toBe(30);
  });

  it("텍스처는 실제 완료 개수에 따라 30~95%를 채우고 다음 파일을 안내한다", () => {
    expect(textureLoadProgress(0, 4)).toEqual({
      percent: 30,
      message: "모델 이미지 1/4 불러오는 중",
    });
    expect(textureLoadProgress(2, 4)).toEqual({
      percent: 63,
      message: "모델 이미지 3/4 불러오는 중",
    });
    expect(textureLoadProgress(4, 4)).toEqual({
      percent: 95,
      message: "모델 이미지 준비 완료",
    });
  });

  it("잘못된 완료 개수도 게이지 범위를 벗어나지 않는다", () => {
    expect(textureLoadProgress(-1, 4).percent).toBe(30);
    expect(textureLoadProgress(10, 4).percent).toBe(95);
    expect(textureLoadProgress(0, 0).percent).toBe(95);
  });
});
