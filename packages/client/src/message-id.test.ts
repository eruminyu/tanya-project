import { describe, expect, it } from "vitest";
import { createMessageId } from "./message-id";

describe("메시지 ID 생성", () => {
  it("보안 컨텍스트에서는 브라우저 UUID를 사용한다", () => {
    expect(createMessageId({ randomUUID: () => "browser-uuid" })).toBe("browser-uuid");
  });

  it("LAN HTTP처럼 randomUUID가 없을 때 로컬 ID를 생성한다", () => {
    expect(createMessageId({ now: () => 1_725_000_000_000, random: () => 0.5 }))
      .toBe("local-m0gcgmio-i");
  });

  it("브라우저 UUID 호출이 실패해도 로컬 ID로 대체한다", () => {
    const id = createMessageId({
      randomUUID: () => { throw new Error("unavailable"); },
      now: () => 42,
      random: () => 0.25,
    });

    expect(id).toBe("local-16-9");
  });
});
