export interface PointerPoint { x: number; y: number }

export function isDragIntent(start: PointerPoint, current: PointerPoint, threshold = 6): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}
