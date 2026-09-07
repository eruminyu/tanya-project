import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENCE_CONFIG,
  createSilenceWatcher,
  timeDomainRms,
  type SilenceConfig,
} from "./voice-silence";

const LOUD = 0.2;
const QUIET = 0.001;
const config: SilenceConfig = DEFAULT_SILENCE_CONFIG;

describe("녹음 자동 종료", () => {
  it("말하는 동안에는 계속 녹음한다", () => {
    const watcher = createSilenceWatcher(0);
    for (let t = 100; t <= 3_000; t += 100) {
      expect(watcher.observe(LOUD, t)).toBe("recording");
    }
    expect(watcher.heardSpeech()).toBe(true);
  });

  it("말이 끝나고 hold 시간이 지나면 종료한다", () => {
    const watcher = createSilenceWatcher(0);
    watcher.observe(LOUD, 500);
    expect(watcher.observe(QUIET, 500 + config.holdMs - 1)).toBe("recording");
    expect(watcher.observe(QUIET, 500 + config.holdMs)).toBe("silence");
  });

  it("문장 사이 짧은 숨은 종료로 보지 않는다", () => {
    const watcher = createSilenceWatcher(0);
    watcher.observe(LOUD, 300);
    expect(watcher.observe(QUIET, 800)).toBe("recording");
    expect(watcher.observe(LOUD, 900)).toBe("recording");
    // 두 번째 발화 뒤부터 다시 센다.
    expect(watcher.observe(QUIET, 900 + config.holdMs - 1)).toBe("recording");
    expect(watcher.observe(QUIET, 900 + config.holdMs)).toBe("silence");
  });

  it("시작 후 말이 없으면 오래 기다리지 않는다", () => {
    const watcher = createSilenceWatcher(0);
    expect(watcher.observe(QUIET, config.noSpeechTimeoutMs - 1)).toBe("recording");
    expect(watcher.observe(QUIET, config.noSpeechTimeoutMs)).toBe("no-speech");
    expect(watcher.heardSpeech()).toBe(false);
  });

  it("계속 말해도 최대 길이에서 끊는다", () => {
    const watcher = createSilenceWatcher(0);
    for (let t = 100; t < config.maxRecordingMs; t += 500) {
      expect(watcher.observe(LOUD, t)).toBe("recording");
    }
    expect(watcher.observe(LOUD, config.maxRecordingMs)).toBe("max-length");
  });

  it("조용한 상태로 최대 길이에 닿아도 끊는다", () => {
    // no-speech가 먼저 걸리는 것이 정상이지만, 임계값을 크게 바꿔도 무한 녹음은 없어야 한다.
    const watcher = createSilenceWatcher(0, { ...config, noSpeechTimeoutMs: 60_000 });
    expect(watcher.observe(QUIET, config.maxRecordingMs)).toBe("max-length");
  });

  it("임계값 경계에서 말소리로 인정한다", () => {
    const watcher = createSilenceWatcher(0);
    expect(watcher.observe(config.rmsThreshold, 100)).toBe("recording");
    expect(watcher.heardSpeech()).toBe(true);
  });

  it("기본값은 사람이 말하는 리듬을 견딜 만큼 넉넉하다", () => {
    // 값이 조용히 좁아지면 문장 중간에 끊기는 회귀가 생긴다.
    expect(config.holdMs).toBeGreaterThanOrEqual(1_000);
    expect(config.maxRecordingMs).toBeGreaterThanOrEqual(10_000);
    expect(config.noSpeechTimeoutMs).toBeLessThan(config.maxRecordingMs);
  });
});

describe("RMS 계산", () => {
  it("무음은 0이다", () => {
    expect(timeDomainRms(new Float32Array(128))).toBe(0);
  });

  it("빈 버퍼는 0이다", () => {
    expect(timeDomainRms(new Float32Array(0))).toBe(0);
  });

  it("일정한 진폭의 RMS는 그 진폭이다", () => {
    const samples = new Float32Array(64).fill(0.5);
    expect(timeDomainRms(samples)).toBeCloseTo(0.5, 6);
  });

  it("부호는 결과에 영향을 주지 않는다", () => {
    const alternating = Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.3 : -0.3));
    expect(timeDomainRms(alternating)).toBeCloseTo(0.3, 6);
  });
});
