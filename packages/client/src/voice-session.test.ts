import { describe, expect, it } from "vitest";
import { initialVoiceSession, reduceVoiceSession } from "./voice-session";

describe("음성 입력 단일 세션", () => {
  it("어떤 입력 경로든 듣는 세션은 하나만 시작한다", () => {
    const listening = reduceVoiceSession(initialVoiceSession, { type: "start", source: "button" });
    expect(listening).toEqual({ state: "listening", source: "button" });
    expect(reduceVoiceSession(listening, { type: "start", source: "ptt" })).toBe(listening);
  });

  it("중단하면 유휴 상태로 돌아간다", () => {
    const listening = reduceVoiceSession(initialVoiceSession, { type: "start", source: "toggle" });
    expect(reduceVoiceSession(listening, { type: "stop" })).toEqual(initialVoiceSession);
  });
});
