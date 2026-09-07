import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: () => undefined,
  useRef: <T>(current: T) => ({ current }),
  useReducer: (_: unknown, initial: unknown) => [initial, vi.fn()],
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../voice-input", () => ({
  chooseRecordingMimeType: () => "audio/webm",
  findRecordingProblem: () => null,
  describeRecordingProblem: () => "녹음 오류",
  requestTranscription: vi.fn(),
}));
import { requestTranscription } from "../voice-input";
import { useVoiceInput } from "./useVoiceInput";

class Recorder {
  static latest: Recorder;
  static failStart = false;
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  constructor() { Recorder.latest = this; }
  start() { if (Recorder.failStart) throw new Error("failed"); this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
}
const options = () => ({ brainUrl: "http://localhost:8098", connected: true, tauriRuntime: false,
  onTranscribed: vi.fn(), onFinished: vi.fn(), onActivate: vi.fn(), onError: vi.fn(), onShortcutError: vi.fn() });
let stopTrack: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks(); Recorder.failStart = false;
  stopTrack = vi.fn();
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", Recorder);
});
afterEach(() => vi.unstubAllGlobals());

describe("공개 마이크 오류와 인식 lifecycle", () => {
  it("MediaRecorder 미지원이면 권한을 요청하지 않고 안내한다", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const callbacks = options();
    await useVoiceInput(callbacks).startVoiceInput("button");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenLastCalledWith(expect.stringContaining("지원"));
  });
  it("getUserMedia 미지원이면 입력 대체 안내를 남긴다", async () => {
    vi.stubGlobal("navigator", {});
    const callbacks = options();
    await useVoiceInput(callbacks).startVoiceInput("button");
    expect(callbacks.onError).toHaveBeenLastCalledWith(expect.stringContaining("키보드"));
  });
  it("권한 거부 뒤 다시 시도할 수 있다", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    const callbacks = options(); const hook = useVoiceInput(callbacks);
    await hook.startVoiceInput("button"); await hook.startVoiceInput("button");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining("denied"));
  });
  it("인식 중 추가 녹음을 차단하고 transcript만 callback에 전달한다", async () => {
    let finish!: (value: string) => void;
    vi.mocked(requestTranscription).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const callbacks = options(); const hook = useVoiceInput(callbacks);
    await hook.startVoiceInput("button"); hook.stopVoiceInput();
    await hook.startVoiceInput("button");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(callbacks.onActivate).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    finish("이 일정으로 등록해줘");
    await vi.waitFor(() => expect(callbacks.onFinished).toHaveBeenCalledTimes(1));
    expect(callbacks.onTranscribed).toHaveBeenCalledWith("이 일정으로 등록해줘");
  });
  it("STT 실패 뒤 오류 안내와 다음 시도가 가능하다", async () => {
    vi.mocked(requestTranscription).mockRejectedValue(new Error("STT unavailable"));
    const callbacks = options(); const hook = useVoiceInput(callbacks);
    await hook.startVoiceInput("button"); hook.stopVoiceInput();
    await vi.waitFor(() => expect(callbacks.onFinished).toHaveBeenCalled());
    expect(callbacks.onError).toHaveBeenCalledWith("STT unavailable");
    await hook.startVoiceInput("button");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
  it("recorder 시작 실패에도 스트림을 닫는다", async () => {
    Recorder.failStart = true;
    await useVoiceInput(options()).startVoiceInput("button");
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});

describe("T-039 녹음 자동 종료", () => {
  /** 모든 샘플을 같은 값으로 채우면 RMS가 그 값이 된다. */
  function stubAudioGraph(levels: number[]) {
    let index = 0;
    const analyser = {
      fftSize: 2048,
      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(levels[Math.min(index, levels.length - 1)]);
        index += 1;
      },
    };
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn();
    const context = {
      createAnalyser: () => analyser,
      createMediaStreamSource: () => ({ connect }),
      close,
    };
    vi.stubGlobal("window", { AudioContext: vi.fn(() => context) });
    return { close, connect };
  }

  afterEach(() => vi.useRealTimers());

  it("말이 끝나고 조용해지면 스스로 멈춘다", async () => {
    vi.useFakeTimers();
    stubAudioGraph([0.3, 0.3, 0.0005]);
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("button");
    expect(Recorder.latest.state).toBe("recording");

    // 말소리 두 번 뒤 계속 무음. hold(1.2초)를 넘기면 종료한다.
    await vi.advanceTimersByTimeAsync(3_000);

    expect(Recorder.latest.state).toBe("inactive");
  });

  it("말하는 동안에는 멈추지 않는다", async () => {
    vi.useFakeTimers();
    stubAudioGraph([0.3]);
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(Recorder.latest.state).toBe("recording");
  });

  it("말소리가 없으면 전사를 요청하지 않고 안내한다", async () => {
    vi.useFakeTimers();
    stubAudioGraph([0.0005]);
    const config = options();
    const hook = useVoiceInput(config);

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(Recorder.latest.state).toBe("inactive");
    expect(requestTranscription).not.toHaveBeenCalled();
    expect(config.onError).toHaveBeenCalledWith(expect.stringContaining("말소리가 들리지 않았어요"));
  });

  it("PTT 경로에는 자동 종료 감시를 붙이지 않는다", async () => {
    // PTT는 키를 떼는 것이 종료 신호이므로 무음 감시가 필요 없다.
    // 이 하네스는 useEffect가 no-op이라 키 유지 상태를 만들 수 없어, 녹음이
    // 시작되지 않는 기존 가드까지 함께 확인한다. 어느 경로로도 오디오 그래프는
    // 연결되지 않아야 한다.
    vi.useFakeTimers();
    const { connect } = stubAudioGraph([0.0005]);
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("ptt");
    await vi.advanceTimersByTimeAsync(8_000);

    expect(connect).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("Web Audio가 없으면 자동 종료 없이 수동 녹음을 유지한다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(8_000);

    expect(Recorder.latest.state).toBe("recording");
    hook.stopVoiceInput();
    expect(Recorder.latest.state).toBe("inactive");
  });

  it("종료하면 AudioContext를 닫는다", async () => {
    vi.useFakeTimers();
    const { close } = stubAudioGraph([0.3, 0.0005]);
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(close).toHaveBeenCalled();
  });
});

describe("T-049 즉시 취소", () => {
  function stubAudioGraph(levels: number[]) {
    let index = 0;
    const analyser = {
      fftSize: 2048,
      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(levels[Math.min(index, levels.length - 1)]);
        index += 1;
      },
    };
    const context = {
      createAnalyser: () => analyser,
      createMediaStreamSource: () => ({ connect: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("window", { AudioContext: vi.fn(() => context) });
  }

  afterEach(() => vi.useRealTimers());

  it("말하기 전에 다시 눌러 취소하면 전사를 요청하지 않는다", async () => {
    // 거의 빈 오디오를 GPU 전사에 보내면 CUDA 오류가 난다. 아예 보내지 않는다.
    vi.useFakeTimers();
    stubAudioGraph([0.0005]);
    const config = options();
    const hook = useVoiceInput(config);

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(300);
    hook.stopVoiceInput();

    expect(requestTranscription).not.toHaveBeenCalled();
    expect(config.onError).toHaveBeenCalledWith(expect.stringContaining("취소"));
  });

  it("말한 뒤 수동으로 멈추면 정상적으로 전사한다", async () => {
    vi.useFakeTimers();
    stubAudioGraph([0.3]);
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(600);
    hook.stopVoiceInput();

    expect(requestTranscription).toHaveBeenCalled();
  });

  it("감시가 없는 경로는 기존대로 전사한다", async () => {
    // Web Audio가 없으면 말소리 여부를 알 수 없다. 막지 않는다.
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const hook = useVoiceInput(options());

    await hook.startVoiceInput("button");
    await vi.advanceTimersByTimeAsync(600);
    hook.stopVoiceInput();

    expect(requestTranscription).toHaveBeenCalled();
  });
});
