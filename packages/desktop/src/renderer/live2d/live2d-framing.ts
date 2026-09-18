export interface Live2DFraming {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Live2DFramingPreset {
  id: "bust" | "upper-body" | "full-body";
  label: string;
  description: string;
  framing: Live2DFraming;
}

export const LIVE2D_SCALE_RANGE = { min: 0.8, max: 3.5 } as const;
export const LIVE2D_OFFSET_RANGE = { min: -2.5, max: 2.5 } as const;

export const DEFAULT_LIVE2D_FRAMING: Live2DFraming = {
  scale: 3,
  offsetX: 0,
  offsetY: -2,
};

export const LIVE2D_FRAMING_PRESETS: readonly Live2DFramingPreset[] = [
  {
    id: "bust",
    label: "흉상",
    description: "얼굴부터 가슴까지",
    framing: DEFAULT_LIVE2D_FRAMING,
  },
  {
    id: "upper-body",
    label: "상반신",
    description: "허리 위까지 여유 있게",
    framing: { scale: 2.2, offsetX: 0, offsetY: -1.2 },
  },
  {
    id: "full-body",
    label: "전신",
    description: "모델 전체 보기",
    framing: { scale: 1, offsetX: 0, offsetY: 0 },
  },
] as const;

const MATCH_EPSILON = 0.001;

export function matchingLive2DFramingPreset(
  framing: Live2DFraming,
): Live2DFramingPreset["id"] | null {
  return LIVE2D_FRAMING_PRESETS.find((preset) => (
    Math.abs(preset.framing.scale - framing.scale) < MATCH_EPSILON
    && Math.abs(preset.framing.offsetX - framing.offsetX) < MATCH_EPSILON
    && Math.abs(preset.framing.offsetY - framing.offsetY) < MATCH_EPSILON
  ))?.id ?? null;
}
