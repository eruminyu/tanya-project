import { describe, expect, it } from "vitest";
import { createLive2DManifest } from "./live2d-model";

describe("Live2D model manifest", () => {
  it("모델을 설정하지 않으면 자산 경로와 전용 표정을 포함하지 않는다", () => {
    const manifest = createLive2DManifest(undefined);
    expect(manifest.modelUrl).toBe("");
    expect(manifest.expressions).toEqual({});
  });

  it("공백뿐인 모델 설정을 비활성 상태로 정규화한다", () => {
    expect(createLive2DManifest("  ").modelUrl).toBe("");
  });

  it("사용자 모델 경로와 표준 Cubism 파라미터를 사용한다", () => {
    const manifest = createLive2DManifest(" /live2d/user/model.model3.json ");
    expect(manifest.modelUrl).toBe("/live2d/user/model.model3.json");
    expect(manifest.expressions).toEqual({});
    expect(manifest.parameters).toEqual({
      mouthOpen: "ParamMouthOpenY",
      eyeLeftOpen: "ParamEyeLOpen",
      eyeRightOpen: "ParamEyeROpen",
      eyeBallX: "ParamEyeBallX",
      eyeBallY: "ParamEyeBallY",
      angleX: "ParamAngleX",
      angleY: "ParamAngleY",
    });
    expect(manifest.layout.defaultScale).toBeGreaterThan(0);
  });
});
