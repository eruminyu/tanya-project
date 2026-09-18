import type {Bounds} from './window-bounds.js';

const keys = ['x', 'y', 'width', 'height'] as const;
export const sameBounds = (a: Bounds, b: Bounds): boolean => keys.every(key => a[key] === b[key]);
const distance = (a: Bounds, b: Bounds): number => keys.reduce((sum, key) => sum + Math.abs(a[key] - b[key]), 0);
interface WindowPort {getBounds(): Bounds; setBounds(bounds: Bounds): void;}

/** Compensate measured native/DIP round-trip error, never a hard-coded inset.
 * At most three attempts and one best-result restore; stop on oscillation or a
 * changed display/interaction context. Some fractional sizes are unrepresentable.
 */
export function restoreWindowBounds(window: WindowPort, desired: Bounds, stable: () => boolean): boolean {
  let actual = window.getBounds();
  if (sameBounds(actual, desired)) return true;
  let command = {...desired}, bestCommand: Bounds | null = null, bestDistance = Infinity;
  let bestActual = actual;
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!stable()) return false;
    if (keys.some(key => !Number.isSafeInteger(command[key]) || Math.abs(command[key]) > 10_000_000)
      || command.width < 1 || command.height < 1) break;
    const signature = JSON.stringify(command);
    if (tried.has(signature)) break;
    tried.add(signature);
    window.setBounds(command);
    actual = window.getBounds();
    if (!stable()) return false;
    const error = distance(actual, desired);
    if (error < bestDistance) {bestDistance = error; bestCommand = {...command}; bestActual = actual;}
    if (error === 0) return true;
    command = Object.fromEntries(keys.map(key => [key, command[key] + desired[key] - actual[key]])) as unknown as Bounds;
  }
  if (bestCommand && !sameBounds(actual, bestActual) && stable()) window.setBounds(bestCommand);
  return stable() && sameBounds(window.getBounds(), desired);
}
