import { describe, expect, it } from "vitest";
import { kirianManifest } from "./live2d-model";
import { LIVE2D_EMOTIONS } from "./live2d-emotion";

describe("Live2D model manifest", () => {
  it("현재 모델에 모든 감정과 필수 파라미터를 선언한다", () => {
    expect(Object.keys(kirianManifest.expressions).sort()).toEqual([...LIVE2D_EMOTIONS].sort());
    expect(kirianManifest.modelUrl).toBe("/live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json");
    expect(kirianManifest.parameters.mouthOpen).toBeTruthy();
    expect(kirianManifest.parameters.eyeBallX).toBe("ParamEyeBallX");
    expect(kirianManifest.parameters.eyeBallY).toBe("ParamEyeBallY");
    expect(kirianManifest.parameters.angleX).toBe("ParamAngleX");
    expect(kirianManifest.parameters.angleY).toBe("ParamAngleY");
    expect(kirianManifest.layout.defaultScale).toBeGreaterThan(0);
  });
});
