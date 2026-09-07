import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "./client-settings";
import { TtsAudioPlayer, TtsChunkAssembler } from "./tts-audio";

describe("TTS 오디오 청크 조립", () => {
  it("같은 문장 인덱스의 Base64 청크를 하나의 오디오로 합친다", () => {
    const assembler = new TtsChunkAssembler();

    expect(assembler.append({ chunkIndex: 0, data: "YWJj", isLast: false })).toEqual([]);
    expect(assembler.append({ chunkIndex: 0, data: "ZGVm", isLast: false })).toEqual([]);
    expect(assembler.append({ chunkIndex: 1, data: "Z2hp", isLast: false }))
      .toEqual([{ chunkIndex: 0, audio: new Uint8Array([97, 98, 99, 100, 101, 102]) }]);
  });

  it("마지막 이벤트에서 남은 오디오를 비운다", () => {
    const assembler = new TtsChunkAssembler();
    assembler.append({ chunkIndex: 3, data: "dGFueWE=", isLast: false });

    expect(assembler.append({ chunkIndex: 9999, data: "", isLast: true }))
      .toEqual([{ chunkIndex: 3, audio: new Uint8Array([116, 97, 110, 121, 97]) }]);
  });

  it("문장의 마지막 청크를 받으면 다음 문장을 기다리지 않고 비운다", () => {
    const assembler = new TtsChunkAssembler();

    expect(assembler.append({ chunkIndex: 0, data: "d2F2", isLast: true }))
      .toEqual([{ chunkIndex: 0, audio: new Uint8Array([119, 97, 118]) }]);
  });

  it("새 대화를 시작하면 이전 청크를 버린다", () => {
    const assembler = new TtsChunkAssembler();
    assembler.append({ chunkIndex: 0, data: "b2xk", isLast: false });

    assembler.reset();

    expect(assembler.append({ chunkIndex: 0, data: "bmV3", isLast: false })).toEqual([]);
    expect(assembler.append({ chunkIndex: 9999, data: "", isLast: true }))
      .toEqual([{ chunkIndex: 0, audio: new Uint8Array([110, 101, 119]) }]);
  });
});

describe("TTS Web Audio 재생", () => {
  function createAudioContext(options: { decodeError?: Error } = {}) {
    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 4,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteTimeDomainData: vi.fn((data: Uint8Array) => data.fill(128)),
    };
    const source = {
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    const context = {
      state: "suspended",
      destination: {},
      resume: vi.fn(async () => {
        context.state = "running";
      }),
      decodeAudioData: options.decodeError
        ? vi.fn(async () => { throw options.decodeError; })
        : vi.fn(async () => ({ duration: 1 })),
      createBufferSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
    };
    return { context, source, analyser };
  }

  it("사용자 전송 동작에서 AudioContext를 활성화한다", async () => {
    const { context } = createAudioContext();
    const player = new TtsAudioPlayer(undefined, () => context as unknown as AudioContext);

    await player.unlock();

    expect(context.resume).toHaveBeenCalledOnce();
  });

  it("완성된 WAV 청크를 디코딩해 재생한다", async () => {
    const { context, source, analyser } = createAudioContext();
    const player = new TtsAudioPlayer(undefined, () => context as unknown as AudioContext);
    await player.unlock();

    player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: false });
    player.append({ chunkIndex: 9999, data: "", isLast: true });

    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(context.destination);
  });

  it("재생 중 분석한 음량을 립싱크 콜백으로 전달한다", async () => {
    const { context, analyser } = createAudioContext();
    analyser.getByteTimeDomainData.mockImplementation((data: Uint8Array) => {
      data.set([48, 208, 48, 208]);
      return data;
    });
    const onLipSync = vi.fn();
    const player = new TtsAudioPlayer(
      undefined,
      () => context as unknown as AudioContext,
      onLipSync,
    );
    await player.unlock();

    player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: true });

    await vi.waitFor(() => expect(onLipSync).toHaveBeenCalled());
    expect(context.createAnalyser).toHaveBeenCalledOnce();
    expect(onLipSync.mock.calls.some(([level]) => level > 0)).toBe(true);
  });

  it("재생 중 바꾼 립싱크 설정을 다음 분석 주기부터 안전하게 적용한다", async () => {
    vi.useFakeTimers();
    try {
      const { context, source, analyser } = createAudioContext();
      analyser.getByteTimeDomainData.mockImplementation((data: Uint8Array) => {
        data.set([108, 148, 108, 148]);
        return data;
      });
      const onLipSync = vi.fn();
      const player = new TtsAudioPlayer(
        undefined,
        () => context as unknown as AudioContext,
        onLipSync,
        { ...DEFAULT_CLIENT_SETTINGS, lipSyncSensitivity: 1, lipSyncSmoothing: 0, lipSyncMaxOpen: 1 },
      );
      await player.unlock();

      player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: true });
      await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
      const before = onLipSync.mock.calls.at(-1)?.[0] ?? 0;

      player.updateLipSyncSettings({
        ...DEFAULT_CLIENT_SETTINGS,
        lipSyncSensitivity: 10,
        lipSyncSmoothing: 0,
        lipSyncMaxOpen: 1,
      });
      await vi.advanceTimersByTimeAsync(33);

      expect(onLipSync.mock.calls.at(-1)?.[0]).toBeGreaterThan(before);
      source.onended?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("디코딩 실패를 화면에 표시할 콜백으로 전달한다", async () => {
    const { context } = createAudioContext({ decodeError: new Error("decode failed") });
    const onError = vi.fn();
    const player = new TtsAudioPlayer(onError, () => context as unknown as AudioContext);
    await player.unlock();

    player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: false });
    player.append({ chunkIndex: 9999, data: "", isLast: true });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("음성을 재생하지 못했습니다."));
  });

  it("문장 사이에 큐가 비어도 종료 신호 전까지 speaking을 유지한다", async () => {
    const { context, source } = createAudioContext();
    const onSpeakingChange = vi.fn();
    const player = new TtsAudioPlayer(
      undefined,
      () => context as unknown as AudioContext,
      undefined,
      undefined,
      onSpeakingChange,
    );

    // 문장 0 재생 완료 — 아직 종료 신호가 없으므로 합성 지연 공백이다.
    player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: true });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    source.onended?.();
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    expect(onSpeakingChange.mock.calls).toEqual([[true]]); // false로 떨어지지 않는다

    // 다음 문장이 늦게 도착해도 이어서 재생한다.
    player.append({ chunkIndex: 1, data: "UklGRgAAAAA=", isLast: true });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledTimes(2));
    expect(onSpeakingChange.mock.calls).toEqual([[true]]);

    // 종료 신호(빈 data + isLast)가 오고 큐가 소진된 뒤에만 false.
    player.append({ chunkIndex: 9999, data: "", isLast: true });
    expect(onSpeakingChange.mock.calls).toEqual([[true]]); // 아직 재생 중
    source.onended?.();
    await vi.waitFor(() => expect(onSpeakingChange).toHaveBeenLastCalledWith(false));
    expect(onSpeakingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("재생 중인 문장 인덱스를 알리고 종료 신호 후에만 지운다", async () => {
    const { context, source } = createAudioContext();
    const onActiveSentenceChange = vi.fn();
    const player = new TtsAudioPlayer(
      undefined,
      () => context as unknown as AudioContext,
      undefined,
      undefined,
      undefined,
      onActiveSentenceChange,
    );

    player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: true });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    expect(onActiveSentenceChange.mock.calls).toEqual([[0]]);

    // 합성 지연 공백에서는 마지막 문장을 계속 보여준다.
    source.onended?.();
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    expect(onActiveSentenceChange.mock.calls).toEqual([[0]]);

    player.append({ chunkIndex: 2, data: "UklGRgAAAAA=", isLast: true });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledTimes(2));
    expect(onActiveSentenceChange.mock.calls).toEqual([[0], [2]]);

    player.append({ chunkIndex: 9999, data: "", isLast: true });
    source.onended?.();
    await vi.waitFor(() => expect(onActiveSentenceChange).toHaveBeenLastCalledWith(null));
    expect(onActiveSentenceChange.mock.calls).toEqual([[0], [2], [null]]);
  });

  it("reset으로 중단할 때 false를 한 번만 알린다", async () => {
    const { context, source } = createAudioContext();
    const onSpeakingChange = vi.fn();
    const player = new TtsAudioPlayer(
      undefined,
      () => context as unknown as AudioContext,
      undefined,
      undefined,
      onSpeakingChange,
    );

    player.append({ chunkIndex: 0, data: "UklGRgAAAAA=", isLast: true });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());

    player.reset();
    player.reset();

    expect(onSpeakingChange.mock.calls).toEqual([[true], [false]]);
  });
});
