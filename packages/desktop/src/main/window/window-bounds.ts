export interface Bounds {x: number; y: number; width: number; height: number;}
export interface DisplayArea {id: number; workArea: Bounds;}
export interface SavedBounds {version: 1; bounds: Bounds; displayId: number | null;}
export interface FittedBounds {bounds: Bounds; displayId: number; minWidth: number; minHeight: number;}
const MIN_WIDTH = 560, MIN_HEIGHT = 640;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validBounds(value: unknown): value is Bounds {
  return record(value) && Object.keys(value).sort().join() === 'height,width,x,y'
    && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key]) && Math.abs(value[key] as number) <= 10_000_000)
    && (value.width as number) > 0 && (value.height as number) > 0;
}
export function parseSavedBounds(value: unknown): SavedBounds {
  if (!record(value) || Object.keys(value).sort().join() !== 'bounds,displayId,version' || value.version !== 1
    || (value.displayId !== null && !Number.isSafeInteger(value.displayId)) || !validBounds(value.bounds))
    throw new Error('invalid_window_bounds');
  return structuredClone(value) as unknown as SavedBounds;
}
function overlap(a: Bounds, b: Bounds): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function distance(a: Bounds, b: Bounds): number {
  const x = a.x + a.width / 2, y = a.y + a.height / 2;
  return Math.max(b.x - x, 0, x - b.x - b.width) ** 2 + Math.max(b.y - y, 0, y - b.y - b.height) ** 2;
}
/** Electron bounds and workArea are DIP. Do not multiply saved values by scaleFactor. */
export function fitWindowBounds(saved: SavedBounds | null, displays: readonly DisplayArea[], primaryId: number): FittedBounds {
  const usable = displays.filter(display => Number.isSafeInteger(display.id) && validBounds(display.workArea));
  if (!usable.length) throw new Error('display_unavailable');
  const primary = usable.find(display => display.id === primaryId) ?? usable[0]!;
  let target = saved && usable.find(display => display.id === saved.displayId);
  if (!target && saved) {
    target = [...usable].sort((a, b) => overlap(saved.bounds, b.workArea) - overlap(saved.bounds, a.workArea)
      || distance(saved.bounds, a.workArea) - distance(saved.bounds, b.workArea) || Number(b.id === primaryId) - Number(a.id === primaryId))[0];
  }
  target ||= primary;
  const area = target.workArea, minWidth = Math.min(MIN_WIDTH, area.width), minHeight = Math.min(MIN_HEIGHT, area.height);
  const width = Math.min(area.width, Math.max(minWidth, saved?.bounds.width ?? 1120));
  const height = Math.min(area.height, Math.max(minHeight, saved?.bounds.height ?? 780));
  const x = Math.max(area.x, Math.min(area.x + area.width - width, saved?.bounds.x ?? Math.round(area.x + (area.width - width) / 2)));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, saved?.bounds.y ?? Math.round(area.y + (area.height - height) / 2)));
  return {bounds: {x, y, width, height}, displayId: target.id, minWidth, minHeight};
}
