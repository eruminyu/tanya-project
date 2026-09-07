import { describe, expect, it } from "vitest";
import {
  calculateCanvasSize,
  calculateProjectionScale,
  calculateProjectionTransform,
} from "./cubism-layout";

describe("Cubism 캔버스 배치", () => {
  it("세로형 모델은 화면의 가로 폭에 맞춰 투영한다", () => {
    expect(calculateProjectionScale(400, 800, 0.8)).toEqual({ x: 2, y: 1 });
  });

  it("가로형 모델을 세로 화면에 표시할 때는 세로 투영을 보정한다", () => {
    expect(calculateProjectionScale(400, 800, 1.2)).toEqual({ x: 1, y: 0.5 });
  });

  it("가로 화면에서는 X축 투영 범위를 화면 비율에 맞춘다", () => {
    expect(calculateProjectionScale(800, 400, 0.8)).toEqual({ x: 0.5, y: 1 });
  });

  it("사용자 구도와 모델 기본 구도를 투영에 함께 반영한다", () => {
    const transform = calculateProjectionTransform(
      400,
      800,
      0.8,
      { scale: 1.6, offsetX: 0.1, offsetY: -0.58 },
      { defaultScale: 1.25, defaultOffsetX: -0.05, defaultOffsetY: 0.08 },
    );
    expect(transform.x).toBeCloseTo(4);
    expect(transform.y).toBeCloseTo(2);
    expect(transform.offsetX).toBeCloseTo(0.05);
    expect(transform.offsetY).toBeCloseTo(-0.5);
  });

  it("기기 배율의 상한을 적용해 캔버스 픽셀 크기를 계산한다", () => {
    expect(calculateCanvasSize(400, 600, 3)).toEqual({ width: 800, height: 1200 });
  });

  it("유효하지 않은 화면 크기는 최소 1픽셀로 보정한다", () => {
    expect(calculateCanvasSize(0, -1, 1)).toEqual({ width: 1, height: 1 });
  });
});
