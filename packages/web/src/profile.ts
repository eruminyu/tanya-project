// Build profiles of the public web demo. `kirian` (default) is the private build with the Kirian rig; `tanya`
// is the portfolio build: renamed, showing a Live2D-distributed sample character (Free Material License,
// served from the server only) so that no Kirian artwork or trial-editor output is published.
import { kirianManifest, type Live2DModelManifest } from '../../desktop/src/renderer/live2d/live2d-model.js';

export interface WebProfile {
  id: 'kirian' | 'tanya';
  brandName: string;
  pageTitle: string;
  /** Directory under /live2d that prepare-assets.mjs ships for this profile. */
  characterDir: 'kirian' | 'hiyori' | 'mao';
  manifest: Live2DModelManifest;
}

// Hiyori Momose — Live2D Inc. sample model (Live2D Free Material License). Standard Cubism parameter ids;
// the expression files are app-authored parameter presets under packages/web/live2d-profiles/hiyori/emotions.
// Kept for a quick swap back (characterDir 'hiyori').
export const hiyoriManifest: Live2DModelManifest = {
  id: 'tanya-hiyori-sample',
  displayName: '타냐',
  modelUrl: '/live2d/hiyori/Hiyori.model3.json',
  expressions: {
    neutral: '/live2d/hiyori/emotions/neutral.exp3.json',
    happy: '/live2d/hiyori/emotions/happy.exp3.json',
    sad: '/live2d/hiyori/emotions/sad.exp3.json',
    excited: '/live2d/hiyori/emotions/excited.exp3.json',
    worried: '/live2d/hiyori/emotions/worried.exp3.json',
    annoyed: '/live2d/hiyori/emotions/annoyed.exp3.json',
    affectionate: '/live2d/hiyori/emotions/affectionate.exp3.json',
  },
  parameters: {
    mouthOpen: 'ParamMouthOpenY', eyeLeftOpen: 'ParamEyeLOpen', eyeRightOpen: 'ParamEyeROpen',
    eyeBallX: 'ParamEyeBallX', eyeBallY: 'ParamEyeBallY', angleX: 'ParamAngleX', angleY: 'ParamAngleY',
  },
  // Full-body sample framed to the upper body on a height basis, so the crop is the same on wide desktop
  // panels and narrow phone screens (fit: 'height'); the stage's default bust framing (3 / -2) multiplies in.
  layout: { defaultScale: 0.7, defaultOffsetX: 0, defaultOffsetY: 0.78, fit: 'height' },
};

// Mao (Nijiiro Mao, pro sample) — Live2D Inc. sample model (Live2D Free Material License; texture downscaled to
// 2048 for the web). Mouth lip-sync uses the model's own LipSync group id (ParamA); presets in live2d-profiles/mao.
const maoManifest: Live2DModelManifest = {
  id: 'tanya-mao-sample',
  displayName: '타냐',
  modelUrl: '/live2d/mao/mao_pro.model3.json',
  expressions: {
    neutral: '/live2d/mao/emotions/neutral.exp3.json',
    happy: '/live2d/mao/emotions/happy.exp3.json',
    sad: '/live2d/mao/emotions/sad.exp3.json',
    excited: '/live2d/mao/emotions/excited.exp3.json',
    worried: '/live2d/mao/emotions/worried.exp3.json',
    annoyed: '/live2d/mao/emotions/annoyed.exp3.json',
    affectionate: '/live2d/mao/emotions/affectionate.exp3.json',
  },
  parameters: {
    mouthOpen: 'ParamA', eyeLeftOpen: 'ParamEyeLOpen', eyeRightOpen: 'ParamEyeROpen',
    eyeBallX: 'ParamEyeBallX', eyeBallY: 'ParamEyeBallY', angleX: 'ParamAngleX', angleY: 'ParamAngleY',
  },
  // Front-facing full-body VTuber model; framed like Hiyori on a height basis (tuned on screen).
  layout: { defaultScale: 0.68, defaultOffsetX: 0, defaultOffsetY: 0.66, fit: 'height' },
};

export const PROFILES: Record<WebProfile['id'], WebProfile> = {
  kirian: { id: 'kirian', brandName: '키리안', pageTitle: '키리안 · 공개 데모', characterDir: 'kirian', manifest: kirianManifest },
  tanya: { id: 'tanya', brandName: '타냐', pageTitle: '타냐 · 공개 데모', characterDir: 'mao', manifest: maoManifest },
};

/** Korean subject/comitative particle by final consonant: josa('키리안','이','가') → '키리안이', josa('타냐','이','가') → '타냐가'. */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.charCodeAt(word.length - 1);
  const hangul = code >= 0xac00 && code <= 0xd7a3;
  return word + (hangul && (code - 0xac00) % 28 !== 0 ? withFinal : withoutFinal);
}

export function resolveProfile(value: string | undefined): WebProfile {
  const id = value && value.length > 0 ? value : 'kirian';
  const profile = (PROFILES as Record<string, WebProfile | undefined>)[id];
  if (!profile) throw new Error('unknown_web_profile:' + id);
  return profile;
}

export const profile = resolveProfile(import.meta.env?.VITE_WEB_PROFILE);
