import { describe, expect, it } from "vitest";
import { shortcutWarning, shortcutWarnings, toggleChatPanel } from "./chat-panel";

describe("toggleChatPanel", () => {
  it("열린 채팅 패널을 닫는다", () => {
    expect(toggleChatPanel(true)).toBe(false);
  });

  it("닫힌 채팅 패널을 연다", () => {
    expect(toggleChatPanel(false)).toBe(true);
  });
});

describe("전역 단축키 상태", () => {
  it("등록 충돌은 앱 종료 대신 사용자 안내로 바꾼다", () => {
    expect(shortcutWarning({ available: false, accelerator: "Ctrl+Space", error: "HotKey already registered" }))
      .toBe("Ctrl+Space 단축키를 사용할 수 없습니다. 캐릭터 클릭이나 메뉴를 이용해 주세요.");
  });

  it("정상 등록에는 경고를 표시하지 않는다", () => {
    expect(shortcutWarning({ available: true, accelerator: "Ctrl+Space" })).toBe("");
  });

  it("여러 단축키 중 실패한 항목만 안내한다", () => {
    expect(shortcutWarnings([
      { available: true, accelerator: "Ctrl+Space" },
      { available: false, accelerator: "Alt+V", error: "HotKey already registered" },
    ])).toBe("Alt+V 단축키를 사용할 수 없습니다. 캐릭터 클릭이나 메뉴를 이용해 주세요.");
  });
});
