import { useCallback, useEffect, useReducer, useRef } from "react";
import { createSilenceWatcher, timeDomainRms, type SilenceWatcher } from "../voice-silence";
import { listen } from "@tauri-apps/api/event";
import { VOICE_PTT_EVENT } from "../chat-panel";
import {
  initialVoiceSession,
  reduceVoiceSession,
  type VoiceInputSource,
  type VoiceSession,
} from "../voice-session";
import {
  chooseRecordingMimeType,
  describeRecordingProblem,
  findRecordingProblem,
  requestTranscription,
} from "../voice-input";

export function useVoiceInput(options: {
  brainUrl: string;
  connected: boolean;
  tauriRuntime: boolean;
  onTranscribed: (text: string) => void;
  onFinished: () => void;
  onActivate: () => void;
  onError: (message: string) => void;
  onShortcutError: (message: string) => void;
}): {
  voiceSession: VoiceSession;
  startVoiceInput: (source: VoiceInputSource) => Promise<void>;
  stopVoiceInput: () => void;
} {
  const {
    brainUrl,
    connected,
    tauriRuntime,
    onTranscribed,
    onFinished,
    onActivate,
    onError,
    onShortcutError,
  } = options;
  const [voiceSession, dispatchVoice] = useReducer(reduceVoiceSession, initialVoiceSession);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const startingVoiceRef = useRef(false);
  const processingVoiceRef = useRef(false);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const pttHeldRef = useRef(false);
  /** recorder.start() 시각. 눌렀다 뗀 실수를 걸러내는 기준이다 (T-012). */
  const recordingStartedAtRef = useRef(0);
  // 자동 종료용 음량 감시. 브라우저에서만 돌고 서버로 아무것도 보내지 않는다.
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceWatcherRef = useRef<SilenceWatcher | null>(null);
  const autoStopReasonRef = useRef<"silence" | "max-length" | "no-speech" | null>(null);

  const teardownSilenceWatch = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    silenceWatcherRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) void context.close().catch(() => undefined);
  }, []);

  const stopVoiceInput = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  /**
   * 한 번 눌러 녹음한 경우에만 자동 종료를 붙인다.
   *
   * PTT는 키를 떼는 것이 종료 신호이므로 감시하지 않는다. Web Audio를 쓸 수 없는
   * 환경에서는 조용히 건너뛴다. 그때는 기존처럼 수동 종료로 끝낸다.
   */
  const beginSilenceWatch = useCallback((stream: MediaStream, startedAt: number) => {
    const AudioContextCtor = typeof window === "undefined"
      ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    let context: AudioContext;
    try {
      context = new AudioContextCtor();
    } catch {
      return;
    }
    audioContextRef.current = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const watcher = createSilenceWatcher(startedAt);
    silenceWatcherRef.current = watcher;
    silenceTimerRef.current = setInterval(() => {
      if (recorderRef.current?.state !== "recording") return;
      analyser.getFloatTimeDomainData(buffer);
      const decision = watcher.observe(timeDomainRms(buffer), Date.now());
      if (decision === "recording") return;
      autoStopReasonRef.current = decision;
      stopVoiceInput();
    }, 100);
  }, [stopVoiceInput]);

  const startVoiceInput = useCallback(async (source: VoiceInputSource) => {
    if (startingVoiceRef.current || processingVoiceRef.current || recorderRef.current?.state === "recording" || !connectedRef.current) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError("이 브라우저는 마이크 녹음을 지원하지 않아요. 키보드 입력이나 단계 버튼으로 계속할 수 있어요.");
      return;
    }
    startingVoiceRef.current = true;
    if (!tauriRuntime || source === "ptt") onActivate();
    onError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!connectedRef.current || (source === "ptt" && !pttHeldRef.current)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      microphoneStreamRef.current = stream;
      const mimeType = chooseRecordingMimeType((value) => MediaRecorder.isTypeSupported(value));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const audio = new Blob(recordingChunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        const durationMs = Date.now() - recordingStartedAtRef.current;
        const autoStopReason = autoStopReasonRef.current;
        autoStopReasonRef.current = null;
        // 감시를 붙이지 않은 경로(PTT·Web Audio 부재)는 null이라 판정에서 제외한다.
        const watchedSpeech = silenceWatcherRef.current ? silenceWatcherRef.current.heardSpeech() : null;
        teardownSilenceWatch();
        microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
        microphoneStreamRef.current = null;
        recorderRef.current = null;

        // 말소리가 한 번도 없었으면 전사 요청 자체를 하지 않는다. 입력창도 건드리지 않는다.
        // 자동 종료뿐 아니라 사용자가 바로 다시 눌러 취소한 경우도 여기로 온다.
        // 거의 빈 오디오를 서버로 보내면 GPU 전사에서 CUDA 오류가 날 수 있다.
        const heardSpeech = watchedSpeech === null || watchedSpeech;
        if (autoStopReason === "no-speech" || !heardSpeech) {
          onError(autoStopReason === "no-speech"
            ? "말소리가 들리지 않았어요. 마이크를 확인하고 다시 눌러 주세요."
            : "녹음을 취소했어요. 다시 누르고 말해 주세요.");
          dispatchVoice({ type: "stop" });
          onFinished();
          return;
        }

        // 잘리거나 빈 녹음은 보내봐야 Brain 디코더가 422로 거절한다. 여기서 끊고 안내한다.
        const problem = findRecordingProblem(durationMs, audio.size);
        if (problem) {
          onError(describeRecordingProblem(problem));
          dispatchVoice({ type: "stop" });
          onFinished();
          return;
        }

        processingVoiceRef.current = true;
        dispatchVoice({ type: "process" });
        void requestTranscription(brainUrl, audio)
          .then(onTranscribed)
          .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
          .finally(() => {
            processingVoiceRef.current = false;
            dispatchVoice({ type: "stop" });
            onFinished();
          });
      };
      recorder.start();
      recordingStartedAtRef.current = Date.now();
      autoStopReasonRef.current = null;
      // PTT는 키를 떼는 것이 종료 신호다. 버튼으로 시작한 녹음만 자동 종료한다.
      if (source !== "ptt") beginSilenceWatch(stream, recordingStartedAtRef.current);
      dispatchVoice({ type: "start", source });
    } catch (error: unknown) {
      teardownSilenceWatch();
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      recorderRef.current = null;
      dispatchVoice({ type: "stop" });
      onError(error instanceof Error ? `마이크를 시작하지 못했습니다: ${error.message}` : "마이크를 시작하지 못했습니다.");
    } finally {
      startingVoiceRef.current = false;
    }
  }, [beginSilenceWatch, brainUrl, connected, onActivate, onError, onFinished, onTranscribed, tauriRuntime, teardownSilenceWatch]);

  useEffect(() => {
    if (tauriRuntime) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.code === "KeyV" && !event.repeat) {
        event.preventDefault();
        pttHeldRef.current = true;
        void startVoiceInput("ptt");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "KeyV") stopVoiceInput();
      if (event.code === "KeyV") pttHeldRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      pttHeldRef.current = false;
      stopVoiceInput();
    };
  }, [startVoiceInput, stopVoiceInput, tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ pressed: boolean }>(VOICE_PTT_EVENT, ({ payload }) => {
      if (payload.pressed) {
        pttHeldRef.current = true;
        void startVoiceInput("ptt");
      } else {
        pttHeldRef.current = false;
        stopVoiceInput();
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error: unknown) => {
      if (!disposed) onShortcutError(`Alt+V 연결 실패: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
      unlisten?.();
      pttHeldRef.current = false;
      stopVoiceInput();
    };
  }, [onActivate, onShortcutError, startVoiceInput, stopVoiceInput, tauriRuntime]);

  return { voiceSession, startVoiceInput, stopVoiceInput };
}
