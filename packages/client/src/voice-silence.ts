/**
 * 녹음 자동 종료 판정.
 *
 * 브라우저에서 음량만 보고 "이제 그만 녹음할까"를 정한다. 서버 왕복이 없고
 * 어떤 모델도 쓰지 않는다. Brain의 `vad_filter`(Silero VAD)와는 다른 물건이다.
 * 그쪽은 녹음이 끝난 뒤 "어디를 Whisper에 넣을까"를 정한다.
 */

export type SilenceDecision =
  /** 계속 녹음한다. */
  | "recording"
  /** 말이 끝나고 충분히 조용해졌다. 정상 종료. */
  | "silence"
  /** 최대 길이에 도달했다. 안전 종료. */
  | "max-length"
  /** 시작 후 한 번도 말소리가 없었다. */
  | "no-speech";

export type SilenceConfig = {
  /** 0..1로 정규화한 RMS 기준. 이보다 크면 말소리로 본다. */
  rmsThreshold: number;
  /** 마지막 말소리 뒤 이만큼 조용하면 종료한다. */
  holdMs: number;
  /** 아무리 길어도 여기서 끊는다. */
  maxRecordingMs: number;
  /** 시작 후 이 시간 안에 말소리가 없으면 종료한다. */
  noSpeechTimeoutMs: number;
};

/**
 * 기본값.
 *
 * `holdMs`를 너무 짧게 잡으면 문장 사이 숨 쉬는 구간에서 끊긴다.
 * 너무 길게 잡으면 말이 끝나고 한참 기다린다. 1.2초는 그 사이 값이다.
 * `rmsThreshold`는 조용한 실내 잡음(대개 0.005 미만)보다는 크고
 * 작게 말하는 목소리보다는 작게 잡았다.
 */
export const DEFAULT_SILENCE_CONFIG: SilenceConfig = {
  rmsThreshold: 0.015,
  holdMs: 1_200,
  maxRecordingMs: 20_000,
  noSpeechTimeoutMs: 5_000,
};

export type SilenceWatcher = {
  /** 현재 시각의 음량을 넘기고 다음 동작을 받는다. */
  observe(rms: number, at: number): SilenceDecision;
  /** 말소리를 한 번이라도 감지했는지. */
  heardSpeech(): boolean;
};

export function createSilenceWatcher(
  startedAt: number,
  config: SilenceConfig = DEFAULT_SILENCE_CONFIG,
): SilenceWatcher {
  let lastLoudAt: number | null = null;

  return {
    heardSpeech: () => lastLoudAt !== null,
    observe(rms: number, at: number): SilenceDecision {
      if (rms >= config.rmsThreshold) {
        lastLoudAt = at;
        // 최대 길이는 말하는 중에도 적용한다. 무한 녹음을 막는 안전장치다.
        return at - startedAt >= config.maxRecordingMs ? "max-length" : "recording";
      }
      if (at - startedAt >= config.maxRecordingMs) return "max-length";
      if (lastLoudAt === null) {
        return at - startedAt >= config.noSpeechTimeoutMs ? "no-speech" : "recording";
      }
      return at - lastLoudAt >= config.holdMs ? "silence" : "recording";
    },
  };
}

/** 시간 영역 샘플의 RMS를 0..1로 계산한다. */
export function timeDomainRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
