import type { Live2DEmotion } from "./live2d-emotion";

export interface Live2DModelManifest {
  id: string;
  displayName: string;
  modelUrl: string;
  expressions: Partial<Record<Live2DEmotion, string>>;
  parameters: {
    mouthOpen: string;
    eyeLeftOpen: string;
    eyeRightOpen: string;
    eyeBallX: string;
    eyeBallY: string;
    angleX: string;
    angleY: string;
  };
  layout: { defaultScale: number; defaultOffsetX: number; defaultOffsetY: number };
}

export function createLive2DManifest(modelUrl: string | undefined): Live2DModelManifest {
  return {
    id: "user-provided",
    displayName: "타냐",
    modelUrl: modelUrl?.trim() ?? "",
    expressions: {},
    parameters: {
      mouthOpen: "ParamMouthOpenY",
      eyeLeftOpen: "ParamEyeLOpen",
      eyeRightOpen: "ParamEyeROpen",
      eyeBallX: "ParamEyeBallX",
      eyeBallY: "ParamEyeBallY",
      angleX: "ParamAngleX",
      angleY: "ParamAngleY",
    },
    layout: { defaultScale: 1, defaultOffsetX: 0, defaultOffsetY: 0 },
  };
}

// Models are supplied locally by users under terms that permit their intended use.
export const configuredLive2DManifest = createLive2DManifest(import.meta.env.VITE_LIVE2D_MODEL_URL);
