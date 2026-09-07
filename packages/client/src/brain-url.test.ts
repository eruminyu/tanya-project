import { describe, expect, it } from "vitest";
import {
  FALLBACK_BRAIN_URL,
  defaultBrainUrl,
  describeDiagnosis,
  resolveBrainUrl,
  runBrainDiagnosis,
  summarizeBrainInfo,
  toDiagnosisUrl,
  validateBrainUrl,
} from "./brain-url";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

describe("Brain URL 검증", () => {
  it("빈 값과 공백만 있는 값을 거부한다", () => {
    expect(validateBrainUrl("")).toEqual({ ok: false, reason: "empty" });
    expect(validateBrainUrl("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("주소 형식이 아니면 거부한다", () => {
    expect(validateBrainUrl("hello")).toEqual({ ok: false, reason: "malformed" });
    expect(validateBrainUrl("http://")).toEqual({ ok: false, reason: "malformed" });
    expect(validateBrainUrl("192.168.10.20:8098")).toEqual({ ok: false, reason: "malformed" });
  });

  it("http와 https가 아닌 스킴을 거부한다", () => {
    expect(validateBrainUrl("ws://192.168.10.20:8098")).toEqual({ ok: false, reason: "unsupported-protocol" });
    expect(validateBrainUrl("javascript:alert(1)")).toEqual({ ok: false, reason: "unsupported-protocol" });
  });

  it("스킴을 빠뜨린 흔한 실수를 스킴 문제로 알린다", () => {
    expect(validateBrainUrl("localhost:8098")).toEqual({ ok: false, reason: "unsupported-protocol" });
  });

  it("유효한 주소는 정규화해서 돌려준다", () => {
    expect(validateBrainUrl("  http://192.168.10.20:8098  ")).toEqual({ ok: true, url: "http://192.168.10.20:8098" });
    expect(validateBrainUrl("http://192.168.10.20:8098///")).toEqual({ ok: true, url: "http://192.168.10.20:8098" });
    expect(validateBrainUrl("HTTP://Brain.Local:8098/")).toEqual({ ok: true, url: "http://brain.local:8098" });
  });

  it("질의 문자열과 프래그먼트를 버린다", () => {
    expect(validateBrainUrl("https://brain.local/api?token=secret#hash")).toEqual({ ok: true, url: "https://brain.local/api" });
  });
});

describe("Brain URL 안전 복원", () => {
  it("유효한 값은 정규화한 그대로 사용한다", () => {
    expect(resolveBrainUrl("http://192.168.10.20:8098/")).toBe("http://192.168.10.20:8098");
  });

  it("잘못된 값은 기본값으로 되돌린다", () => {
    expect(resolveBrainUrl("hello")).toBe(defaultBrainUrl());
    expect(resolveBrainUrl("")).toBe(defaultBrainUrl());
  });

  it("기본값 자체가 언제나 유효하다", () => {
    expect(validateBrainUrl(defaultBrainUrl()).ok).toBe(true);
    expect(validateBrainUrl(FALLBACK_BRAIN_URL).ok).toBe(true);
  });
});

describe("진단 대상 주소", () => {
  it("웹 클라이언트와 충돌하지 않는 상태 API를 진단에 사용한다", () => {
    expect(toDiagnosisUrl("http://192.168.10.20:8098")).toBe("http://192.168.10.20:8098/api/status");
    expect(toDiagnosisUrl("http://192.168.10.20:8098/")).toBe("http://192.168.10.20:8098/api/status");
  });
});

describe("Brain 정보 요약", () => {
  it("켜진 기능과 꺼진 기능을 한국어로 나눈다", () => {
    const summary = summarizeBrainInfo({
      status: "Tanya Brain is running",
      model: "qwen2.5:7b",
      llm_provider: "ollama",
      features: { persona: true, memory: true, emotion: true, proactive: false, stt: true },
    });

    expect(summary.model).toBe("qwen2.5:7b");
    expect(summary.provider).toBe("ollama");
    expect(summary.enabled).toEqual(["페르소나", "기억", "감정", "음성 인식"]);
    expect(summary.disabled).toEqual(["선제 제안"]);
  });

  it("모르는 기능 이름은 원문 그대로 보여준다", () => {
    const summary = summarizeBrainInfo({ features: { brand_new_thing: true } });
    expect(summary.enabled).toEqual(["brand_new_thing"]);
  });

  it("응답이 비어 있거나 형식이 달라도 무너지지 않는다", () => {
    expect(summarizeBrainInfo(null)).toEqual({ status: "", model: "", provider: "", enabled: [], disabled: [] });
    expect(summarizeBrainInfo({ status: 1, features: "nope" })).toEqual({ status: "", model: "", provider: "", enabled: [], disabled: [] });
  });
});

describe("Brain 연결 진단", () => {
  it("네트워크를 쓰기 전에 잘못된 주소를 먼저 걸러낸다", async () => {
    let called = false;
    const result = await runBrainDiagnosis("hello", {
      fetchImpl: async () => { called = true; return jsonResponse(200, {}); },
    });

    expect(result).toEqual({ kind: "invalid-url", reason: "malformed" });
    expect(called).toBe(false);
  });

  it("정상 응답이면 Brain 요약을 담아 성공으로 본다", async () => {
    const result = await runBrainDiagnosis("http://192.168.10.20:8098", {
      fetchImpl: async (input) => {
        expect(String(input)).toBe("http://192.168.10.20:8098/api/status");
        return jsonResponse(200, { model: "qwen2.5:7b", llm_provider: "ollama", features: { memory: true } });
      },
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.summary.model).toBe("qwen2.5:7b");
      expect(result.summary.enabled).toEqual(["기억"]);
    }
  });

  it("응답 본문을 읽지 못해도 성공 판정은 유지한다", async () => {
    const result = await runBrainDiagnosis("http://192.168.10.20:8098", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } } as unknown as Response),
    });

    expect(result).toEqual({ kind: "ok", summary: { status: "", model: "", provider: "", enabled: [], disabled: [] } });
  });

  it("HTTP 오류는 상태 코드와 함께 구분한다", async () => {
    const notFound = await runBrainDiagnosis("http://192.168.10.20:8098", { fetchImpl: async () => jsonResponse(404, {}) });
    const serverError = await runBrainDiagnosis("http://192.168.10.20:8098", { fetchImpl: async () => jsonResponse(500, {}) });

    expect(notFound).toEqual({ kind: "http-error", status: 404 });
    expect(serverError).toEqual({ kind: "http-error", status: 500 });
  });

  it("연결 자체가 실패하면 네트워크 오류로 구분한다", async () => {
    const result = await runBrainDiagnosis("http://192.168.10.20:8098", {
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
    });

    expect(result).toEqual({ kind: "network-error", message: "Failed to fetch" });
  });

  it("응답이 오지 않으면 타임아웃으로 구분한다", async () => {
    const result = await runBrainDiagnosis("http://192.168.10.20:8098", {
      timeoutMs: 5_000,
      fetchImpl: async () => { throw abortError(); },
    });

    expect(result).toEqual({ kind: "timeout", timeoutMs: 5_000 });
  });

  it("중단 신호를 fetch에 전달한다", async () => {
    let received: AbortSignal | undefined;
    await runBrainDiagnosis("http://192.168.10.20:8098", {
      fetchImpl: async (_input, init) => { received = init?.signal ?? undefined; return jsonResponse(200, {}); },
    });

    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });
});

describe("진단 결과 문구", () => {
  it("네 가지 결과를 서로 다른 조치가 떠오르는 문장으로 설명한다", () => {
    expect(describeDiagnosis({ kind: "ok", summary: { status: "", model: "qwen2.5:7b", provider: "ollama", enabled: [], disabled: [] } }))
      .toBe("연결됨 · qwen2.5:7b (ollama)");
    expect(describeDiagnosis({ kind: "http-error", status: 404 })).toBe("응답은 왔지만 Brain이 아닙니다 (HTTP 404)");
    expect(describeDiagnosis({ kind: "network-error", message: "Failed to fetch" })).toBe("연결하지 못했습니다. 주소와 포트, 서버 상태를 확인해 주세요.");
    expect(describeDiagnosis({ kind: "timeout", timeoutMs: 5_000 })).toBe("5초 안에 응답이 없습니다. 방화벽이나 서버 상태를 확인해 주세요.");
  });

  it("모델 정보가 없으면 연결 사실만 알린다", () => {
    expect(describeDiagnosis({ kind: "ok", summary: { status: "", model: "", provider: "", enabled: [], disabled: [] } })).toBe("연결됨");
  });

  it("잘못된 주소는 이유별로 다르게 알린다", () => {
    expect(describeDiagnosis({ kind: "invalid-url", reason: "empty" })).toBe("Brain 주소를 입력해 주세요.");
    expect(describeDiagnosis({ kind: "invalid-url", reason: "malformed" })).toBe(`주소 형식이 올바르지 않습니다. 예: ${FALLBACK_BRAIN_URL}`);
    expect(describeDiagnosis({ kind: "invalid-url", reason: "unsupported-protocol" })).toBe("http:// 또는 https:// 로 시작해야 합니다.");
  });
});
