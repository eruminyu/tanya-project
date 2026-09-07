import { describe, expect, it } from "vitest";
import {
  connectionStatusText,
  extractAgentEvent,
  extractGoogleDraftEvent,
  extractGoogleWriteExecutionEvent,
  extractProactiveSuggestion,
  extractEmotion,
  extractText,
  extractTtsChunk,
  normalizeBrainUrl,
  reconnectDelayMs,
  toWebSocketUrl,
  extractTtsSentence,
  extractLlmRoute,
  extractMemoryCapsuleEvent,
} from "./brain";

const MEMORY_NOW = Date.parse("2026-09-02T12:00:00Z");
const MEMORY_OPERATION_ID = "11111111-1111-4111-8111-111111111111";

const memorySource = {
  type: "explicit_choice",
  label: "준비 시간 선택",
  sessionScoped: true,
  createdAt: "2026-09-02T12:00:00Z",
};

const memoryCapsule = {
  preparationMinutes: 20,
  content: "사용자는 일정 전에 20분의 준비 시간을 선호합니다.",
};

describe("기억 캡슐 이벤트", () => {
  it("서버가 만든 세션 범위 승인 미리보기만 받아들인다", () => {
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_approval_required",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        approvalToken: "approval-1",
        preparationMinutes: 20,
        content: memoryCapsule.content,
        sessionScoped: true,
        source: memorySource,
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toEqual({
      kind: "approval-required",
      operationId: MEMORY_OPERATION_ID,
      draft: {
        approvalToken: "approval-1",
        capsule: memoryCapsule,
        source: memorySource,
        sessionScoped: true,
        expiresAt: "2026-09-02T12:30:00Z",
      },
    });
  });

  it("이미 만료됐거나 고정 문구가 바뀐 승인 미리보기는 버린다", () => {
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_approval_required",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        approvalToken: "approval-1",
        preparationMinutes: 20,
        content: memoryCapsule.content,
        sessionScoped: true,
        source: memorySource,
        expiresAt: "2026-09-02T11:59:59Z",
      },
    }, MEMORY_NOW)).toBeNull();
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_approval_required",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        approvalToken: "approval-1",
        preparationMinutes: 20,
        content: "서버가 임의로 바꾼 문구",
        sessionScoped: true,
        source: memorySource,
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toBeNull();
  });

  it("저장 시각과 고정 출처가 일관된 저장 완료만 성공으로 해석한다", () => {
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_saved",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: memorySource,
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toEqual({
      kind: "saved",
      operationId: MEMORY_OPERATION_ID,
      record: {
        capsule: memoryCapsule,
        source: memorySource,
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    });

    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_saved",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: { ...memorySource, label: "임의 출처" },
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toBeNull();
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_saved",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: memorySource,
        syncedAt: "2026-09-02T12:31:00Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toBeNull();
  });

  it("회상 관련도는 0부터 1 사이만 허용하고 빈 결과를 구분한다", () => {
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_recalled",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: memorySource,
        relevance: 0.92,
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)?.kind).toBe("recalled");
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_recalled",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: memorySource,
        relevance: 1.1,
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toBeNull();
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_recalled",
      payload: { operationId: MEMORY_OPERATION_ID, capsule: null, source: null, relevance: null, syncedAt: null, expiresAt: null },
    }, MEMORY_NOW)).toEqual({ kind: "recalled", operationId: MEMORY_OPERATION_ID, record: null });
  });

  it("삭제·거절과 허용된 안전 오류만 전달한다", () => {
    expect(extractMemoryCapsuleEvent({ type: "event", event: "memory_capsule_forgotten", payload: { operationId: MEMORY_OPERATION_ID } }, MEMORY_NOW))
      .toEqual({ kind: "forgotten", operationId: MEMORY_OPERATION_ID });
    expect(extractMemoryCapsuleEvent({ type: "event", event: "memory_capsule_rejected", payload: { operationId: MEMORY_OPERATION_ID } }, MEMORY_NOW))
      .toEqual({ kind: "rejected", operationId: MEMORY_OPERATION_ID });
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_error",
      payload: { operationId: MEMORY_OPERATION_ID, code: "unavailable", message: "기억 저장소를 사용할 수 없습니다." },
    }, MEMORY_NOW)).toEqual({ kind: "failed", operationId: MEMORY_OPERATION_ID, code: "unavailable", message: "기억 저장소를 사용할 수 없습니다." });
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_error",
      payload: { operationId: MEMORY_OPERATION_ID, code: "internal_trace", message: "민감한 내부 오류" },
    }, MEMORY_NOW)).toBeNull();
  });

  it("payload는 null·배열·숫자·불리언이 아닌 plain object만 허용한다", () => {
    const malformedPayloads = [null, [], 0, 1, false, true];
    for (const payload of malformedPayloads) {
      expect(extractMemoryCapsuleEvent({
        type: "event",
        event: "memory_capsule_forgotten",
        payload: payload as never,
      }, MEMORY_NOW)).toBeNull();
    }
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_forgotten",
      payload: { operationId: MEMORY_OPERATION_ID, extra: true } as never,
    }, MEMORY_NOW)).toBeNull();
  });

  it("UUID v4 operationId와 엄격한 UTC RFC3339 시각만 허용한다", () => {
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_approval_required",
      payload: {
        operationId: "not-an-operation-id",
        approvalToken: "approval-1",
        preparationMinutes: 20,
        content: memoryCapsule.content,
        sessionScoped: true,
        source: memorySource,
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toBeNull();
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_approval_required",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        approvalToken: "approval-1",
        preparationMinutes: 20,
        content: memoryCapsule.content,
        sessionScoped: true,
        source: memorySource,
        expiresAt: "2026-09-02T12:30:00+00:00",
      },
    }, MEMORY_NOW)).toBeNull();
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_saved",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: { ...memorySource, createdAt: "2026-02-30T12:00:00Z" },
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    }, MEMORY_NOW)).toBeNull();
  });

  it("이미 만료된 saved·recalled 결과를 성공으로 표시하지 않는다", () => {
    const expiredSource = { ...memorySource, createdAt: "2026-09-02T11:00:00Z" };
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_saved",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: expiredSource,
        syncedAt: "2026-09-02T11:30:00Z",
        expiresAt: "2026-09-02T11:59:59Z",
      },
    }, MEMORY_NOW)).toBeNull();
    expect(extractMemoryCapsuleEvent({
      type: "event",
      event: "memory_capsule_recalled",
      payload: {
        operationId: MEMORY_OPERATION_ID,
        capsule: memoryCapsule,
        source: expiredSource,
        relevance: 0.9,
        syncedAt: "2026-09-02T11:30:00Z",
        expiresAt: "2026-09-02T11:59:59Z",
      },
    }, MEMORY_NOW)).toBeNull();
  });
});

describe("Agent Dock 이벤트", () => {
  it("승인 이벤트를 안전한 대기 상태로 해석한다", () => {
    expect(extractAgentEvent({ type: "event", event: "approval_required", payload: { skill: "calendar_create", reason: "확인 필요", approval_token: "token" } })).toEqual({ kind: "approval-required", skill: "calendar_create", reason: "확인 필요", approvalToken: "token" });
  });

  it("불완전한 승인 이벤트는 무시한다", () => {
    expect(extractAgentEvent({ type: "event", event: "approval_required", payload: { skill: "calendar_create" } })).toBeNull();
  });
});

describe("선제 제안 이벤트", () => {
  it("유효한 제안 문구를 추출한다", () => {
    expect(extractProactiveSuggestion({
      type: "event",
      event: "proactive_suggestion",
      payload: { text: " 잠깐 쉬는 게 어때? " },
    })).toBe("잠깐 쉬는 게 어때?");
  });

  it("빈 제안은 무시한다", () => {
    expect(extractProactiveSuggestion({
      type: "event",
      event: "proactive_suggestion",
      payload: { text: "  " },
    })).toBeNull();
  });
});

describe("LLM 경로 이벤트", () => {
  it("실제 실행 위치와 폴백 여부를 검증해 추출한다", () => {
    expect(extractLlmRoute({
      type: "event",
      event: "llm_route",
      payload: { mode: "task", provider: "gemini", execution: "cloud", fallback: false },
    })).toEqual({ mode: "task", provider: "gemini", execution: "cloud", fallback: false });
  });

  it("알 수 없는 경로 값은 표시하지 않는다", () => {
    expect(extractLlmRoute({
      type: "event",
      event: "llm_route",
      payload: { mode: "secret", provider: "gemini", execution: "cloud", fallback: false },
    })).toBeNull();
  });
});

describe("Google 자연어 초안 이벤트", () => {
  it("유효한 일정 초안만 받아들인다", () => {
    expect(extractGoogleDraftEvent({ type: "event", event: "google_write_draft", payload: { kind: "calendar", title: "회의", startAt: "2026-08-17T15:00:00+09:00", endAt: "2026-08-17T16:00:00+09:00" } })).toEqual({ kind: "calendar", title: "회의", startAt: "2026-08-17T15:00:00+09:00", endAt: "2026-08-17T16:00:00+09:00" });
  });

  it("종료가 시작보다 빠른 초안은 거부한다", () => {
    expect(extractGoogleDraftEvent({ type: "event", event: "google_write_draft", payload: { kind: "calendar", title: "회의", startAt: "2026-08-17T16:00:00+09:00", endAt: "2026-08-17T15:00:00+09:00" } })).toBeNull();
  });

  it("웹 데모 초안의 서버 승인 계약을 보존한다", () => {
    expect(extractGoogleDraftEvent({
      type: "event",
      event: "google_write_draft",
      payload: {
        kind: "task",
        title: "발표 자료 정리",
        due: null,
        requestId: "request-1",
        approvalToken: "approval-1",
        executor: "brain",
      },
    })).toEqual({
      kind: "task",
      title: "발표 자료 정리",
      due: null,
      requestId: "request-1",
      approvalToken: "approval-1",
      executor: "brain",
    });
  });

  it("Google 데모 실행 결과·거절·실패 이벤트를 검증한다", () => {
    expect(extractGoogleWriteExecutionEvent({
      type: "event",
      event: "google_write_result",
      payload: {
        requestId: "request-1",
        providerId: "task-1",
        title: "발표 자료 정리",
        duplicate: false,
      },
    })).toEqual({
      kind: "completed",
      receipt: {
        requestId: "request-1",
        providerId: "task-1",
        title: "발표 자료 정리",
        duplicate: false,
      },
    });
    expect(extractGoogleWriteExecutionEvent({
      type: "event",
      event: "google_write_cancelled",
      payload: { requestId: "request-2" },
    })).toEqual({ kind: "cancelled", requestId: "request-2" });
    expect(extractGoogleWriteExecutionEvent({
      type: "event",
      event: "google_write_error",
      payload: { message: "생성 실패" },
    })).toEqual({ kind: "failed", message: "생성 실패" });
  });
});

describe("Brain 재연결 정책", () => {
  it("재시도 간격을 지수 백오프로 늘리고 8초로 제한한다", () => {
    expect([0, 1, 2, 3, 10].map(reconnectDelayMs))
      .toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it("휴대폰 복귀 대기가 길어지지 않도록 상한을 10초 미만으로 유지한다", () => {
    // 상한이 다시 커지면 화면 잠금에서 돌아온 사용자가 그만큼 기다린다.
    expect(reconnectDelayMs(99)).toBeLessThan(10_000);
  });

  it("연결 상태를 사용자용 문구로 변환한다", () => {
    expect(connectionStatusText("connecting")).toBe("Brain에 연결 중");
    expect(connectionStatusText("connected")).toBe("Brain 연결됨");
    expect(connectionStatusText("reconnecting", 4_000)).toBe("4초 후 다시 연결");
    expect(connectionStatusText("disconnected")).toBe("Brain 연결 끊김");
  });
});

describe("Brain 연결 계약", () => {
  it("HTTP 주소를 WebSocket 주소로 변환한다", () => {
    expect(toWebSocketUrl("http://192.168.10.20:8098/"))
      .toBe("ws://192.168.10.20:8098/ws/webchat");
  });

  it("HTTPS 주소는 WSS로 변환한다", () => {
    expect(toWebSocketUrl("https://brain.example.com/api"))
      .toBe("wss://brain.example.com/ws/webchat");
  });

  it("오디오 모드에서는 WebSocket 쿼리를 추가한다", () => {
    expect(toWebSocketUrl("http://192.168.10.20:8098", true))
      .toBe("ws://192.168.10.20:8098/ws/webchat?audio=1&proactive=1");
  });

  it("방해 금지 상태에서는 선제 제안을 요청하지 않는다", () => {
    expect(toWebSocketUrl("http://192.168.10.20:8098", true, false))
      .toBe("ws://192.168.10.20:8098/ws/webchat?audio=1&proactive=0");
  });

  it("탭 세션 ID를 기존 옵션과 함께 안전하게 인코딩한다", () => {
    const url = new URL(toWebSocketUrl(
      "https://brain.example.com/api?ignored=1",
      true,
      false,
      "tab id/?&",
    ));

    expect(Object.fromEntries(url.searchParams)).toEqual({
      audio: "1",
      proactive: "0",
      session_id: "tab id/?&",
    });
  });

  it("주소 끝의 슬래시를 정리한다", () => {
    expect(normalizeBrainUrl(" http://localhost:8098/// "))
      .toBe("http://localhost:8098");
  });

  it("텍스트 스트림 이벤트를 추출한다", () => {
    expect(extractText({ type: "event", event: "text_stream", payload: { text: "안녕" } }))
      .toBe("안녕");
  });

  it("WebChat 최종 응답의 감정을 추출한다", () => {
    expect(extractEmotion({ type: "response", emotion: "happy" })).toBe("happy");
  });

  it("V2 감정 이벤트의 type 필드를 추출한다", () => {
    expect(extractEmotion({
      type: "event",
      event: "emotion_update",
      payload: { type: "worried", intensity: 0.8 },
    })).toBe("worried");
  });

  it("TTS 청크 이벤트를 추출한다", () => {
    expect(extractTtsChunk({
      type: "event",
      event: "tts_chunk",
      payload: { chunk_index: 2, data: "YWJj", is_last: false },
    })).toEqual({ chunkIndex: 2, data: "YWJj", isLast: false });
  });

  it("TTS가 아닌 이벤트는 오디오 청크로 처리하지 않는다", () => {
    expect(extractTtsChunk({ type: "response", content: "안녕" })).toBeNull();
  });
});

describe("TTS 문장 이벤트", () => {
  it("합성 문장 원문과 인덱스를 추출한다", () => {
    const event = {
      type: "event" as const,
      event: "tts_sentence",
      payload: { chunk_index: 2, text: "정말 잘했어! 🎉" },
    };

    expect(extractTtsSentence(event)).toEqual({ chunkIndex: 2, text: "정말 잘했어! 🎉" });
  });

  it("형식이 어긋나면 무시한다", () => {
    expect(extractTtsSentence({ type: "event", event: "tts_chunk", payload: { chunk_index: 0 } })).toBeNull();
    expect(extractTtsSentence({ type: "event", event: "tts_sentence", payload: { chunk_index: "0" as unknown as number, text: "안녕" } })).toBeNull();
    expect(extractTtsSentence({ type: "event", event: "tts_sentence", payload: { chunk_index: 0, text: "  " } })).toBeNull();
  });
});
