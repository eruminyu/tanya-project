export interface GazePoint { x: number; y: number }
export interface GazeBounds { left: number; top: number; width: number; height: number }

const clamp = (value: number) => Math.max(-1, Math.min(value, 1));

export function neutralGaze(): GazePoint {
  return { x: 0, y: 0 };
}

export function normalizeGazePoint(clientX: number, clientY: number, bounds: GazeBounds): GazePoint {
  if (bounds.width <= 0 || bounds.height <= 0) return neutralGaze();
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  return {
    x: clamp((clientX - centerX) / (bounds.width / 2)),
    y: clamp((centerY - clientY) / (bounds.height / 2)),
  };
}
