import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "./client-settings";
import { createSettingsChangedPayload, DEFAULT_APP_SETTINGS, mergeLegacyBrainUrl, parseAppSettings, parseAppSettingsPayload, serializeAppSettings } from "./settings-schema";
import { defaultBrainUrl, validateBrainUrl } from "./brain-url";

describe("Settings Mode 저장 스키마", () => {
  it("저장값이 없거나 손상되면 안전한 기본값을 사용한다", () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseAppSettings("broken")).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("일반 설정과 역할별 LLM 설정을 복원한다", () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      captions: false,
      gazeTracking: false,
      casualLlm: { provider: "ollama", model: "gemma", endpoint: "http://localhost:11434" },
      taskLlm: { provider: "openai-compatible", model: "task-model", endpoint: "http://localhost:8098" },
    };
    expect(parseAppSettings(serializeAppSettings(settings))).toEqual(settings);
  });

  it("알 수 없는 타입은 기본값으로 보정한다", () => {
    const parsed = parseAppSettings(JSON.stringify({ captions: "yes", alwaysOnTop: 1 }));
    expect(parsed.captions).toBe(DEFAULT_APP_SETTINGS.captions);
    expect(parsed.alwaysOnTop).toBe(DEFAULT_APP_SETTINGS.alwaysOnTop);
  });

  it("Google 대상 목록 기본값과 선택값을 보존한다", () => {
    expect(parseAppSettings(null)).toMatchObject({ googleCalendarId: "primary", googleTaskListId: "@default" });
    const value = { ...DEFAULT_APP_SETTINGS, googleCalendarId: "team@example.com", googleTaskListId: "list-1" };
    expect(parseAppSettings(serializeAppSettings(value))).toMatchObject({ googleCalendarId: "team@example.com", googleTaskListId: "list-1" });
  });

  it("Brain 주소 기본값을 brain-url 한 곳에서만 가져온다", () => {
    expect(DEFAULT_APP_SETTINGS.brainUrl).toBe(defaultBrainUrl());
    expect(validateBrainUrl(DEFAULT_APP_SETTINGS.brainUrl).ok).toBe(true);
  });

  it("손상된 Brain 주소는 기본값으로 되돌린다", () => {
    expect(parseAppSettings(JSON.stringify({ brainUrl: "hello" })).brainUrl).toBe(defaultBrainUrl());
    expect(parseAppSettings(JSON.stringify({ brainUrl: "" })).brainUrl).toBe(defaultBrainUrl());
    expect(parseAppSettings(JSON.stringify({ brainUrl: 8098 })).brainUrl).toBe(defaultBrainUrl());
  });

  it("유효한 Brain 주소는 정규화해서 보존한다", () => {
    expect(parseAppSettings(JSON.stringify({ brainUrl: "  http://brain.local:8098/  " })).brainUrl).toBe("http://brain.local:8098");
    expect(parseAppSettingsPayload({ brainUrl: "https://brain.local/" }).brainUrl).toBe("https://brain.local");
  });

  it("옛 tanya.brainUrl 키에 남은 사용자 주소를 잃지 않고 승계한다", () => {
    const merged = mergeLegacyBrainUrl(DEFAULT_APP_SETTINGS, "http://old-brain.local:8098/");
    expect(merged.brainUrl).toBe("http://old-brain.local:8098");
  });

  it("새 설정에 이미 사용자 주소가 있으면 옛 값을 덮어쓰지 않는다", () => {
    const current = { ...DEFAULT_APP_SETTINGS, brainUrl: "http://new-brain.local:8098" };
    expect(mergeLegacyBrainUrl(current, "http://old-brain.local:8098").brainUrl).toBe("http://new-brain.local:8098");
  });

  it("옛 값이 없거나 손상됐으면 현재 설정을 그대로 둔다", () => {
    expect(mergeLegacyBrainUrl(DEFAULT_APP_SETTINGS, null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(mergeLegacyBrainUrl(DEFAULT_APP_SETTINGS, "  ")).toEqual(DEFAULT_APP_SETTINGS);
    expect(mergeLegacyBrainUrl(DEFAULT_APP_SETTINGS, "hello")).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("다른 Tauri 창에서 전달된 설정 payload도 동일한 규칙으로 검증한다", () => {
    expect(parseAppSettingsPayload({ ...DEFAULT_APP_SETTINGS, alwaysOnTop: false }).alwaysOnTop).toBe(false);
    expect(parseAppSettingsPayload({ appSettings: { ...DEFAULT_APP_SETTINGS, alwaysOnTop: false } }).alwaysOnTop).toBe(false);
    expect(parseAppSettingsPayload({ alwaysOnTop: "no" }).alwaysOnTop).toBe(DEFAULT_APP_SETTINGS.alwaysOnTop);
    expect(parseAppSettingsPayload(null)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("일반 설정과 립싱크 설정을 하나의 변경 이벤트 payload로 묶는다", () => {
    const appSettings = { ...DEFAULT_APP_SETTINGS, captions: false };
    const clientSettings = { ...DEFAULT_CLIENT_SETTINGS, lipSyncSensitivity: 7 };

    expect(createSettingsChangedPayload(appSettings, clientSettings)).toEqual({
      appSettings,
      clientSettings,
    });
  });
});
