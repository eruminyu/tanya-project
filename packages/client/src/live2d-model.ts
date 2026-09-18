import type { Live2DEmotion } from "./live2d-emotion";

export interface Live2DModelManifest {
  id: string;
  displayName: string;
  modelUrl: string;
  expressions: Record<Live2DEmotion, string>;
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

export const kirianManifest: Live2DModelManifest = {
  id: "kirian-upperbody-v001",
  displayName: "키리안",
  modelUrl: "/live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json",
  expressions: {
    neutral: "/live2d/kirian/emotions/neutral.exp3.json",
    happy: "/live2d/kirian/emotions/happy.exp3.json",
    sad: "/live2d/kirian/emotions/sad.exp3.json",
    excited: "/live2d/kirian/emotions/excited.exp3.json",
    worried: "/live2d/kirian/emotions/worried.exp3.json",
    annoyed: "/live2d/kirian/emotions/annoyed.exp3.json",
    affectionate: "/live2d/kirian/emotions/affectionate.exp3.json",
  },
  parameters: {
    mouthOpen: "ParamMouthOpenY",
    eyeLeftOpen: "ParamEyeLOpen",
    eyeRightOpen: "ParamEyeROpen",
    eyeBallX: "ParamEyeBallX",
    eyeBallY: "ParamEyeBallY",
    angleX: "ParamAngleX",
    angleY: "ParamAngleY",
  },
  layout: { defaultScale: 0.55, defaultOffsetX: 0, defaultOffsetY: 1.2 },
};
