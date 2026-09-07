import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  APP_SETTINGS_STORAGE_KEY,
  BRAIN_RECONNECT_EVENT,
  LEGACY_BRAIN_URL_STORAGE_KEY,
  mergeLegacyBrainUrl,
  parseAppSettings,
  parseAppSettingsPayload,
  serializeAppSettings,
  SETTINGS_CHANGED_EVENT,
  type AppSettings,
} from "../settings-schema";

function initialAppSettings(): AppSettings {
  const stored = parseAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
  const merged = mergeLegacyBrainUrl(stored, localStorage.getItem(LEGACY_BRAIN_URL_STORAGE_KEY));
  if (merged !== stored) localStorage.setItem(APP_SETTINGS_STORAGE_KEY, serializeAppSettings(merged));
  localStorage.removeItem(LEGACY_BRAIN_URL_STORAGE_KEY);
  return merged;
}

export function useAppSettings(): {
  appSettings: AppSettings;
  reconnectNonce: number;
  settingsApplyError: string;
} {
  const [appSettings, setAppSettings] = useState(initialAppSettings);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [settingsApplyError, setSettingsApplyError] = useState("");
  const tauriRuntime = isTauri();

  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    const apply = (value: unknown) => setAppSettings(parseAppSettingsPayload(value));
    const onStorage = (event: StorageEvent) => {
      if (event.key === APP_SETTINGS_STORAGE_KEY) setAppSettings(parseAppSettings(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    const track = (dispose: () => void) => {
      if (disposed) dispose();
      else disposers.push(dispose);
    };
    const onListenError = (error: unknown) => {
      if (!disposed) setSettingsApplyError(`설정 연결 실패: ${error instanceof Error ? error.message : String(error)}`);
    };
    if (tauriRuntime) {
      void listen<unknown>(SETTINGS_CHANGED_EVENT, ({ payload }) => apply(payload)).then(track).catch(onListenError);
      void listen(BRAIN_RECONNECT_EVENT, () => setReconnectNonce((value) => value + 1)).then(track).catch(onListenError);
    }
    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
      window.removeEventListener("storage", onStorage);
    };
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;
    void getCurrentWindow().setAlwaysOnTop(appSettings.alwaysOnTop)
      .then(() => setSettingsApplyError(""))
      .catch((error: unknown) => setSettingsApplyError(`항상 위 설정 적용 실패: ${error instanceof Error ? error.message : String(error)}`));
  }, [appSettings.alwaysOnTop, tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;
    void invoke("set_auto_hide_fullscreen", { enabled: appSettings.autoHideFullscreen })
      .then(() => setSettingsApplyError(""))
      .catch((error: unknown) => setSettingsApplyError(`전체 화면 자동 숨김 적용 실패: ${error instanceof Error ? error.message : String(error)}`));
  }, [appSettings.autoHideFullscreen, tauriRuntime]);

  return { appSettings, reconnectNonce, settingsApplyError };
}
