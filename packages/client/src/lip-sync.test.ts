import { describe, expect, it } from "vitest";
import { calculateLipSyncLevel, smoothLipSyncLevel } from "./lip-sync";

describe("립싱크 음량 계산", () => {
  it("무음은 입을 닫는다", () => {
    expect(calculateLipSyncLevel(new Uint8Array([128, 128, 128, 128]))).toBe(0);
  });

  it("음성 진폭을 0에서 1 사이 입 벌림 값으로 변환한다", () => {
    const quiet = calculateLipSyncLevel(new Uint8Array([118, 138, 118, 138]));
    const loud = calculateLipSyncLevel(new Uint8Array([48, 208, 48, 208]));

    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
  });

  it("민감도와 최대 입 벌림 설정을 적용한다", () => {
    const samples = new Uint8Array([48, 208, 48, 208]);

    expect(calculateLipSyncLevel(samples, 1, 0.4)).toBeLessThanOrEqual(0.4);
    expect(calculateLipSyncLevel(samples, 8, 1)).toBeGreaterThan(
      calculateLipSyncLevel(samples, 1, 1),
    );
  });

  it("노이즈 바닥보다 작은 신호는 제거한다", () => {
    expect(calculateLipSyncLevel(new Uint8Array([126, 130, 126, 130]))).toBe(0);
  });
});

describe("립싱크 스무딩", () => {
  it("입을 열 때는 빠르게, 닫을 때는 부드럽게 이동한다", () => {
    const opened = smoothLipSyncLevel(0, 1);
    const closing = smoothLipSyncLevel(opened, 0);

    expect(opened).toBeCloseTo(0.65);
    expect(closing).toBeGreaterThan(0);
    expect(closing).toBeLessThan(opened);
  });

  it("부드러움 설정이 높을수록 변화량이 작다", () => {
    expect(smoothLipSyncLevel(0, 1, 0.8)).toBeLessThan(
      smoothLipSyncLevel(0, 1, 0.2),
    );
  });
});
