import { describe, expect, it } from "vitest";
import { neutralGaze, normalizeGazePoint } from "./gaze-tracking";

describe("마우스 시선 추적 좌표", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 600 };

  it("캐릭터 영역 중심은 중립 시선이다", () => {
    expect(normalizeGazePoint(300, 350, bounds)).toEqual({ x: 0, y: 0 });
  });

  it("오른쪽 위 커서를 Live2D 정규화 좌표로 바꾼다", () => {
    expect(normalizeGazePoint(500, 50, bounds)).toEqual({ x: 1, y: 1 });
  });

  it("영역 밖 좌표는 안전하게 제한하고 중립값은 새 객체로 제공한다", () => {
    expect(normalizeGazePoint(-100, 1000, bounds)).toEqual({ x: -1, y: -1 });
    expect(neutralGaze()).toEqual({ x: 0, y: 0 });
  });
});
