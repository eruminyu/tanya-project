import { describe, expect, it } from "vitest";
import {
  createWebchatSessionId,
  getOrCreateWebchatSessionId,
  isSecureWebchatSessionId,
} from "./webchat-session";

class MemorySessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("WebChat 탭 세션 ID", () => {
  it("같은 탭 저장소에서는 재사용하고 독립 저장소는 분리한다", () => {
    const tabA = new MemorySessionStorage();
    const tabB = new MemorySessionStorage();
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";

    expect(getOrCreateWebchatSessionId({ storage: tabA, randomUUID: () => firstId }))
      .toBe(firstId);
    expect(getOrCreateWebchatSessionId({ storage: tabA, randomUUID: () => secondId }))
      .toBe(firstId);
    expect(getOrCreateWebchatSessionId({ storage: tabB, randomUUID: () => secondId }))
      .toBe(secondId);
  });

  it("randomUUID가 없으면 getRandomValues로 v4 UUID를 만든다", () => {
    const sessionId = createWebchatSessionId({
      randomUUID: null,
      fillRandomBytes: (bytes) => {
        bytes.forEach((_value, index) => { bytes[index] = index; });
      },
    });

    expect(sessionId).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("Web Crypto가 없어도 저장 가능한 길이의 ID를 만들고 다음 마운트에서 재사용한다", () => {
    const storage = new MemorySessionStorage();
    const first = getOrCreateWebchatSessionId({
      storage,
      randomUUID: null,
      fillRandomBytes: null,
      now: () => 42,
      random: () => 0.5,
    });
    const reused = getOrCreateWebchatSessionId({
      storage,
      randomUUID: null,
      fillRandomBytes: null,
      now: () => 99,
      random: () => 0.25,
    });

    expect(first).toBe("local-16-80000000800000008000000080000000");
    expect(first.length).toBeGreaterThanOrEqual(16);
    expect(reused).toBe(first);
    expect(isSecureWebchatSessionId(first)).toBe(false);
  });

  it("기억 캡슐에는 Web Crypto에서 만든 UUID v4 세션만 허용한다", () => {
    expect(isSecureWebchatSessionId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isSecureWebchatSessionId("local-16-80000000800000008000000080000000")).toBe(false);
    expect(isSecureWebchatSessionId("user-controlled-session-id")).toBe(false);
  });
});
