import { describe, expect, it } from "vitest";
import { latestTanyaMessage, shouldCollapseWhisper, whisperSide } from "./whisper";

const messages = [
  { id: "1", role: "tanya" as const, text: "첫 답변" },
  { id: "2", role: "user" as const, text: "질문" },
  { id: "3", role: "tanya" as const, text: "최신 답변" },
];

describe("Whisper 표시 규칙", () => {
  it("최신 타냐 응답 하나를 선택한다", () => {
    expect(latestTanyaMessage(messages)?.id).toBe("3");
  });

  it("긴 답변만 접는다", () => {
    expect(shouldCollapseWhisper("짧은 답변")).toBe(false);
    expect(shouldCollapseWhisper("가".repeat(241))).toBe(true);
  });

  it("오른쪽 공간이 부족하면 왼쪽에 배치한다", () => {
    expect(whisperSide({ left: 700, right: 900 }, 1000, 280)).toBe("left");
    expect(whisperSide({ left: 100, right: 300 }, 1000, 280)).toBe("right");
  });
});
