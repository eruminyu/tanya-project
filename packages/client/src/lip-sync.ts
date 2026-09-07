const SILENCE_THRESHOLD = 0.025;
const DEFAULT_INPUT_GAIN = 4.5;

export function calculateLipSyncLevel(
  samples: Uint8Array,
  sensitivity = DEFAULT_INPUT_GAIN,
  maxOpen = 1,
): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    squareSum += normalized * normalized;
  }
  const rms = Math.sqrt(squareSum / samples.length);
  if (rms <= SILENCE_THRESHOLD) return 0;
  return Math.min(maxOpen, (rms - SILENCE_THRESHOLD) * sensitivity);
}

export function smoothLipSyncLevel(
  current: number,
  target: number,
  smoothing = 0.5,
): number {
  const safeSmoothing = Math.max(0, Math.min(smoothing, 1));
  const factor = target > current
    ? 0.9 - safeSmoothing * 0.5
    : 0.5 - safeSmoothing * 0.44;
  const next = current + (target - current) * factor;
  return next < 0.01 ? 0 : next;
}
