import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TtsChunk, TtsSentence } from "../brain";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  parseClientSettings,
  parseClientSettingsPayload,
  serializeClientSettings,
  type ClientSettings,
} from "../client-settings";
import { SETTINGS_CHANGED_EVENT } from "../settings-schema";
import { TtsAudioPlayer } from "../tts-audio";

function initialClientSettings(): ClientSettings {
  return parseClientSettings(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY));
}

export function useTtsAudio(): {
  clientSettings: ClientSettings;
  updateClientSettings: (settings: ClientSettings) => void;
  mouthOpen: number;
  audioError: string;
  setAudioError: (message: string) => void;
  appendTtsChunk: (chunk: TtsChunk) => void;
  appendTtsSentence: (sentence: TtsSentence) => void;
  resetAudio: () => void;
  unlockAudio: () => Promise<void>;
  speaking: boolean;
  captionText: string;
} {
  const [audioError, setAudioError] = useState("");
  const [mouthOpen, setMouthOpen] = useState(0);
  const [clientSettings, setClientSettings] = useState(initialClientSettings);
  const [speaking, setSpeaking] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const audioPlayerRef = useRef<TtsAudioPlayer | null>(null);
  /** chunk_index → 합성 문장 원문. tts_sentence 이벤트가 채우고 재생 위치가 읽는다 (T-010). */
  const sentencesRef = useRef(new Map<number, string>());
  const clientSettingsRef = useRef(clientSettings);
  clientSettingsRef.current = clientSettings;
  const tauriRuntime = isTauri();

  const ensureAudioPlayer = useCallback((): TtsAudioPlayer => {
    audioPlayerRef.current ??= new TtsAudioPlayer(
      setAudioError,
      undefined,
      setMouthOpen,
      clientSettingsRef.current,
      setSpeaking,
      (chunkIndex) => {
        // 문장 이벤트가 없던 구버전 Brain에서는 빈 문자열이 되고, 자막은 전문으로 폴백한다.
        setCaptionText(chunkIndex === null ? "" : sentencesRef.current.get(chunkIndex) ?? "");
      },
    );
    return audioPlayerRef.current;
  }, []);

  useEffect(() => {
    let disposed = false;
    let disposeTauriListener: (() => void) | undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key === CLIENT_SETTINGS_STORAGE_KEY) {
        setClientSettings(parseClientSettings(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    if (tauriRuntime) {
      void listen<unknown>(SETTINGS_CHANGED_EVENT, ({ payload }) => {
        setClientSettings(parseClientSettingsPayload(payload));
      }).then((dispose) => {
        if (disposed) dispose();
        else disposeTauriListener = dispose;
      }).catch((error: unknown) => {
        if (!disposed) {
          setAudioError(`립싱크 설정 연결 실패: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    return () => {
      disposed = true;
      disposeTauriListener?.();
      window.removeEventListener("storage", onStorage);
    };
  }, [tauriRuntime]);

  useEffect(() => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      serializeClientSettings(clientSettings),
    );
    audioPlayerRef.current?.updateLipSyncSettings(clientSettings);
  }, [clientSettings]);

  const appendTtsChunk = useCallback((chunk: TtsChunk) => {
    ensureAudioPlayer().append(chunk);
  }, [ensureAudioPlayer]);

  const appendTtsSentence = useCallback((sentence: TtsSentence) => {
    sentencesRef.current.set(sentence.chunkIndex, sentence.text);
  }, []);

  const resetAudio = useCallback(() => {
    audioPlayerRef.current?.reset();
    sentencesRef.current.clear();
    setCaptionText("");
  }, []);

  const unlockAudio = useCallback(async () => {
    await ensureAudioPlayer().unlock();
  }, [ensureAudioPlayer]);

  const updateClientSettings = useCallback((settings: ClientSettings) => {
    setClientSettings(settings);
  }, []);

  return {
    clientSettings,
    updateClientSettings,
    mouthOpen,
    audioError,
    setAudioError,
    appendTtsChunk,
    appendTtsSentence,
    resetAudio,
    unlockAudio,
    speaking,
    captionText,
  };
}
