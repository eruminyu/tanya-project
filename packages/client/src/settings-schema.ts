import { defaultBrainUrl, resolveBrainUrl, validateBrainUrl } from "./brain-url";
import type { ClientSettings } from "./client-settings";

export interface LlmRoleSettings { provider: string; model: string; endpoint: string }
export interface AppSettings {
  alwaysOnTop: boolean;
  autoHideFullscreen: boolean;
  gazeTracking: boolean;
  captions: boolean;
  proactiveSuggestions: boolean;
  dndEnabled: boolean;
  interactionShortcut: string;
  pttShortcut: string;
  brainUrl: string;
  googleClientId: string;
  googleCalendarId: string;
  googleTaskListId: string;
  casualLlm: LlmRoleSettings;
  taskLlm: LlmRoleSettings;
}

export interface SettingsChangedPayload {
  appSettings: AppSettings;
  clientSettings: ClientSettings;
}

export const APP_SETTINGS_STORAGE_KEY = "tanya.appSettings.v1";
export const SETTINGS_CHANGED_EVENT = "tanya://settings-changed";
export const BRAIN_RECONNECT_EVENT = "tanya://brain-reconnect";
const DEFAULT_LLM: LlmRoleSettings = { provider: "Brain 기본값", model: "", endpoint: "" };
export const DEFAULT_APP_SETTINGS: AppSettings = {
  alwaysOnTop: true,
  autoHideFullscreen: true,
  gazeTracking: true,
  captions: true,
  proactiveSuggestions: true,
  dndEnabled: false,
  interactionShortcut: "Ctrl+Space",
  pttShortcut: "Alt+V",
  brainUrl: defaultBrainUrl(),
  googleClientId: "",
  googleCalendarId: "primary",
  googleTaskListId: "@default",
  casualLlm: { ...DEFAULT_LLM },
  taskLlm: { ...DEFAULT_LLM },
};

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function llmOr(value: unknown): LlmRoleSettings {
  const item = value && typeof value === "object" ? value as Partial<LlmRoleSettings> : {};
  return {
    provider: stringOr(item.provider, DEFAULT_LLM.provider),
    model: stringOr(item.model, ""),
    endpoint: stringOr(item.endpoint, ""),
  };
}

export function parseAppSettings(value: string | null): AppSettings {
  if (!value) return structuredClone(DEFAULT_APP_SETTINGS);
  try {
    const item = JSON.parse(value) as Partial<AppSettings>;
    return {
      alwaysOnTop: booleanOr(item.alwaysOnTop, DEFAULT_APP_SETTINGS.alwaysOnTop),
      autoHideFullscreen: booleanOr(item.autoHideFullscreen, DEFAULT_APP_SETTINGS.autoHideFullscreen),
      gazeTracking: booleanOr(item.gazeTracking, DEFAULT_APP_SETTINGS.gazeTracking),
      captions: booleanOr(item.captions, DEFAULT_APP_SETTINGS.captions),
      proactiveSuggestions: booleanOr(item.proactiveSuggestions, DEFAULT_APP_SETTINGS.proactiveSuggestions),
      dndEnabled: booleanOr(item.dndEnabled, DEFAULT_APP_SETTINGS.dndEnabled),
      interactionShortcut: stringOr(item.interactionShortcut, DEFAULT_APP_SETTINGS.interactionShortcut),
      pttShortcut: stringOr(item.pttShortcut, DEFAULT_APP_SETTINGS.pttShortcut),
      brainUrl: resolveBrainUrl(stringOr(item.brainUrl, DEFAULT_APP_SETTINGS.brainUrl)),
      googleClientId: stringOr(item.googleClientId, ""),
      googleCalendarId: stringOr(item.googleCalendarId, "primary") || "primary",
      googleTaskListId: stringOr(item.googleTaskListId, "@default") || "@default",
      casualLlm: llmOr(item.casualLlm),
      taskLlm: llmOr(item.taskLlm),
    };
  } catch { return structuredClone(DEFAULT_APP_SETTINGS); }
}

export function serializeAppSettings(settings: AppSettings): string { return JSON.stringify(settings); }

export function parseAppSettingsPayload(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_APP_SETTINGS);
  const payload = value as { appSettings?: unknown };
  return parseAppSettings(JSON.stringify(payload.appSettings ?? value));
}

export function createSettingsChangedPayload(
  appSettings: AppSettings,
  clientSettings: ClientSettings,
): SettingsChangedPayload {
  return { appSettings, clientSettings };
}

/** 통합 이전에 쓰던 별도 저장소 키. 값 승계 후 제거한다. */
export const LEGACY_BRAIN_URL_STORAGE_KEY = "tanya.brainUrl";

/**
 * 옛 `tanya.brainUrl` 키에 남은 사용자 주소를 새 설정 계약으로 승계한다.
 * 새 설정에 이미 사용자가 지정한 주소가 있으면 그쪽을 우선한다.
 */
export function mergeLegacyBrainUrl(settings: AppSettings, legacyValue: string | null): AppSettings {
  if (settings.brainUrl !== defaultBrainUrl()) return settings;
  const legacy = validateBrainUrl(legacyValue ?? "");
  if (!legacy.ok || legacy.url === settings.brainUrl) return settings;
  return { ...settings, brainUrl: legacy.url };
}
