import type { GazePoint } from './gaze-tracking.js';
import { DEFAULT_LIVE2D_FRAMING, LIVE2D_OFFSET_RANGE, LIVE2D_SCALE_RANGE, type Live2DFraming } from './live2d-framing.js';

export function finiteClamp(value: number, minimum: number, maximum: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function safeGaze(point: GazePoint): GazePoint {
  return { x: finiteClamp(point.x, -1, 1), y: finiteClamp(point.y, -1, 1) };
}

export function safeFraming(value: Live2DFraming): Live2DFraming {
  return {
    scale: finiteClamp(value.scale, LIVE2D_SCALE_RANGE.min, LIVE2D_SCALE_RANGE.max, DEFAULT_LIVE2D_FRAMING.scale),
    offsetX: finiteClamp(value.offsetX, LIVE2D_OFFSET_RANGE.min, LIVE2D_OFFSET_RANGE.max, DEFAULT_LIVE2D_FRAMING.offsetX),
    offsetY: finiteClamp(value.offsetY, LIVE2D_OFFSET_RANGE.min, LIVE2D_OFFSET_RANGE.max, DEFAULT_LIVE2D_FRAMING.offsetY),
  };
}

export function playbackMouth(level: number, speaking: boolean): number {
  return speaking ? finiteClamp(level, 0, 1) : 0;
}
