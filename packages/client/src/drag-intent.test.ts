import { describe, expect, it } from "vitest";
import { isDragIntent } from "./drag-intent";

describe("캐릭터 드래그 의도", () => {
  it("짧은 움직임은 클릭으로 유지한다", () => {
    expect(isDragIntent({ x: 100, y: 100 }, { x: 103, y: 102 })).toBe(false);
  });

  it("임계값을 넘은 움직임은 드래그다", () => {
    expect(isDragIntent({ x: 100, y: 100 }, { x: 108, y: 105 })).toBe(true);
  });
});
