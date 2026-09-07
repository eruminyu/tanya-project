import {
  DEFAULT_LIVE2D_FRAMING,
  LIVE2D_OFFSET_RANGE,
  LIVE2D_SCALE_RANGE,
} from "./live2d-framing";

export interface ClientSettings {
  lipSyncSensitivity: number;
  lipSyncSmoothing: number;
  lipSyncMaxOpen: number;
  live2dScale: number;
  live2dOffsetX: number;
  live2dOffsetY: number;
}

export const CLIENT_SETTINGS_STORAGE_KEY = "tanya.clientSettings.v1";

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  lipSyncSensitivity: 4.5,
  lipSyncSmoothing: 0.5,
  lipSyncMaxOpen: 1,
  live2dScale: DEFAULT_LIVE2D_FRAMING.scale,
  live2dOffsetX: DEFAULT_LIVE2D_FRAMING.offsetX,
  live2dOffsetY: DEFAULT_LIVE2D_FRAMING.offsetY,
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

export function parseClientSettings(value: string | null): ClientSettings {
  if (!value) return { ...DEFAULT_CLIENT_SETTINGS };
  try {
    const parsed = JSON.parse(value) as Partial<ClientSettings>;
    return {
      lipSyncSensitivity: clampNumber(
        parsed.lipSyncSensitivity,
        DEFAULT_CLIENT_SETTINGS.lipSyncSensitivity,
        1,
        10,
      ),
      lipSyncSmoothing: clampNumber(
        parsed.lipSyncSmoothing,
        DEFAULT_CLIENT_SETTINGS.lipSyncSmoothing,
        0,
        1,
      ),
      lipSyncMaxOpen: clampNumber(
        parsed.lipSyncMaxOpen,
        DEFAULT_CLIENT_SETTINGS.lipSyncMaxOpen,
        0.2,
        1,
      ),
      live2dScale: clampNumber(
        parsed.live2dScale,
        DEFAULT_CLIENT_SETTINGS.live2dScale,
        LIVE2D_SCALE_RANGE.min,
        LIVE2D_SCALE_RANGE.max,
      ),
      live2dOffsetX: clampNumber(
        parsed.live2dOffsetX,
        DEFAULT_CLIENT_SETTINGS.live2dOffsetX,
        LIVE2D_OFFSET_RANGE.min,
        LIVE2D_OFFSET_RANGE.max,
      ),
      live2dOffsetY: clampNumber(
        parsed.live2dOffsetY,
        DEFAULT_CLIENT_SETTINGS.live2dOffsetY,
        LIVE2D_OFFSET_RANGE.min,
        LIVE2D_OFFSET_RANGE.max,
      ),
    };
  } catch {
    return { ...DEFAULT_CLIENT_SETTINGS };
  }
}

export function serializeClientSettings(settings: ClientSettings): string {
  return JSON.stringify(settings);
}

export function parseClientSettingsPayload(value: unknown): ClientSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_CLIENT_SETTINGS };
  const payload = value as { clientSettings?: unknown };
  const candidate = payload.clientSettings ?? value;
  return parseClientSettings(JSON.stringify(candidate));
}
