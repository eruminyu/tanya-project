import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "../client-settings";
import { SETTINGS_CHANGED_EVENT } from "../settings-schema";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  stateSetters: [] as ReturnType<typeof vi.fn>[],
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => { effect(); },
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(initial: T | (() => T)) => {
    const setter = vi.fn();
    mocks.stateSetters.push(setter);
    return [typeof initial === "function" ? (initial as () => T)() : initial, setter];
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return Promise.resolve(vi.fn());
  }),
}));

vi.mock("../tts-audio", () => ({
  TtsAudioPlayer: vi.fn(),
}));

import { useTtsAudio } from "./useTtsAudio";

describe("TTS 오디오 설정 동기화", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.stateSetters.length = 0;
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("설정 변경 이벤트를 받으면 죽어 있던 ClientSettings setter를 호출한다", () => {
    useTtsAudio();
    const changed = { ...DEFAULT_CLIENT_SETTINGS, lipSyncSensitivity: 8 };

    mocks.listeners.get(SETTINGS_CHANGED_EVENT)?.({
      payload: { appSettings: {}, clientSettings: changed },
    });

    expect(mocks.stateSetters[2]).toHaveBeenCalledWith(changed);
  });

  it("웹 화면에서 바꾼 ClientSettings를 같은 저장 state에 반영한다", () => {
    const hook = useTtsAudio();
    const changed = { ...DEFAULT_CLIENT_SETTINGS, live2dScale: 1.3 };

    hook.updateClientSettings(changed);

    expect(mocks.stateSetters[2]).toHaveBeenCalledWith(changed);
  });
});
