import { describe, expect, it } from "vitest";
import { WEB_DEMO_BOUNDARY, describeLlmRoute } from "./demo-experience";

describe("통합 웹 체험 안내", () => {
  it("개인 계정이 아닌 공용 데모 경계를 숨기지 않는다", () => {
    expect(WEB_DEMO_BOUNDARY).toContain("공용 데모 계정");
    expect(WEB_DEMO_BOUNDARY).toContain("개인 Google 계정");
    expect(WEB_DEMO_BOUNDARY).toContain("Brain 서버 VM");
    expect(WEB_DEMO_BOUNDARY).toContain("로컬 Ollama");
  });

  it("라우팅 정보를 한국어 배지 문구로 바꾼다", () => {
    expect(describeLlmRoute({ mode: "casual", provider: "ollama", execution: "local", fallback: false }))
      .toBe("일상 · 로컬 · Ollama");
    expect(describeLlmRoute({ mode: "task", provider: "ollama", execution: "local", fallback: true }))
      .toBe("작업 · 로컬 폴백 · Ollama");
    expect(describeLlmRoute({ mode: "casual", provider: "ollama", execution: "local", fallback: false }, "web"))
      .toBe("일상 · Brain 서버 로컬 · Ollama");
    expect(describeLlmRoute({ mode: "task", provider: "ollama", execution: "local", fallback: true }, "web"))
      .toBe("작업 · Brain 서버 로컬 폴백 · Ollama");
  });
});
