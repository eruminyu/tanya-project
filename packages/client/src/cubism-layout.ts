import type { Live2DFraming } from "./live2d-framing";

export interface ProjectionScale {
  x: number;
  y: number;
}

export interface ProjectionTransform extends ProjectionScale {
  offsetX: number;
  offsetY: number;
}

export interface ModelLayoutDefaults {
  defaultScale: number;
  defaultOffsetX: number;
  defaultOffsetY: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export function calculateProjectionScale(
  width: number,
  height: number,
  modelCanvasWidth: number,
): ProjectionScale {
  if (width <= 0 || height <= 0) return { x: 1, y: 1 };
  if (modelCanvasWidth > 1 && width < height) return { x: 1, y: width / height };
  return { x: height / width, y: 1 };
}

export function calculateProjectionTransform(
  width: number,
  height: number,
  modelCanvasWidth: number,
  framing: Live2DFraming,
  layout: ModelLayoutDefaults,
): ProjectionTransform {
  const viewportScale = calculateProjectionScale(width, height, modelCanvasWidth);
  const framingScale = framing.scale * layout.defaultScale;
  return {
    x: viewportScale.x * framingScale,
    y: viewportScale.y * framingScale,
    offsetX: framing.offsetX + layout.defaultOffsetX,
    offsetY: framing.offsetY + layout.defaultOffsetY,
  };
}

export function calculateCanvasSize(
  clientWidth: number,
  clientHeight: number,
  devicePixelRatio: number,
): CanvasSize {
  const resolution = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
  return {
    width: Math.max(1, Math.round(clientWidth * resolution)),
    height: Math.max(1, Math.round(clientHeight * resolution)),
  };
}
