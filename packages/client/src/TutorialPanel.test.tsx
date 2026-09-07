import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TutorialPanel, TUTORIAL_PREFERENCE_QUESTIONS } from "./TutorialPanel";
import {
  initialTutorialState,
  initialTutorialPreferenceDraft,
  type TutorialApproval,
  type TutorialReceipt,
  type TutorialState,
} from "./tutorial";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const noop = () => undefined;

function renderPanel(state: TutorialState, connected = true, secureSession = true): string {
  return renderToStaticMarkup(<TutorialPanel
    connected={connected}
    secureSession={secureSession}
    state={state}
    draft={initialTutorialPreferenceDraft}
    dispatchDraft={noop}
    onStart={noop}
    onResume={noop}
    onPreparePreferences={noop}
    onApprove={noop}
    onReject={noop}
    onPrepareGoogle={noop}
    onSkipGoogle={noop}
    onGenerateAnswer={noop}
    onGetReceipt={noop}
    onForget={noop}
  />);
}

function withPhase(phase: NonNullable<TutorialState["snapshot"]>["phase"]): TutorialState {
  return {
    ...initialTutorialState(FLOW_ID),
    needsResume: false,
    snapshot: {
      phase,
      expiresAt: "2099-09-03T12:30:00Z",
      calendarStatus: null,
      taskStatus: null,
      memoryStatus: phase === "preferences_pending" ? "empty" : "saved",
    },
  };
}

function calendarApproval(): TutorialApproval {
  const fields = {
    title: "Tanya 해커톤 준비 점검",
    startAt: "2099-09-03T21:10:00+09:00",
    endAt: "2099-09-03T21:40:00+09:00",
    timeZone: "Asia/Seoul",
  };
  return {
    flowId: FLOW_ID,
    operationId: OPERATION_ID,
    requestId: REQUEST_ID,
    purpose: "calendar",
    approvalToken: "must-never-be-rendered",
    expiresAt: "2099-09-03T12:02:00Z",
    preview: {
      kind: "calendar",
      fields,
      executor: "public_demo_brain/google",
      accountScope: "shared_demo_account",
      message: "아직 Google에는 변경이 없습니다.",
      explanation: {
        whyNow: { code: "user_requested_tutorial_step", summary: "현재 단계를 요청했어요." },
        dataUsed: [{ type: "approved_tutorial_preferences", updatedAt: "2099-09-03T12:00:00Z" }],
        processing: { location: "self_hosted_brain_vm", route: "tutorial_service" },
        exactChange: { kind: "google_calendar_create", fields },
        executor: { type: "public_demo_brain", target: "google" },
        approval: { status: "required", executesOnApproval: true },
        changeState: "not_executed",
        retention: {
          memoryExpiresAt: "2099-09-03T12:30:00Z",
          googleCleanupAfterMinutes: 30,
          googleCleanupDueAt: null,
        },
      },
    },
  };
}

function forgottenReceipt(): TutorialReceipt {
  return {
    flowId: FLOW_ID,
    operationId: OPERATION_ID,
    expiresAt: "2099-09-03T12:30:00Z",
    explanation: {
      whyNow: { code: "user_started_public_tutorial", summary: "공개 체험을 시작했어요." },
      dataUsed: [],
      processing: { location: "self_hosted_brain_vm", route: "strict_ollama" },
      exactChange: { kind: "tutorial_receipt", fields: { google: { calendar: "succeeded" } } },
      executor: { type: "public_demo_brain", target: "google" },
      approval: { status: "approved" },
      changeState: "completed",
      retention: {
        memoryExpiresAt: "2099-09-03T12:30:00Z",
        googleCleanupAfterMinutes: 30,
        googleCleanupDueAt: "2099-09-03T12:31:00Z",
      },
    },
    preferences: null,
    storage: {
      type: "sqlite",
      execution: "self_hosted_brain_vm",
      scope: "session",
      memoryStatus: "forgotten",
      forgottenAt: "2099-09-03T12:05:00Z",
    },
    answerBefore: null,
    answerAfter: null,
    google: {
      calendar: {
        requestId: REQUEST_ID,
        providerId: "calendar-resource-1",
        status: "succeeded",
        sentFields: null,
        createdAt: null,
        cleanupDueAt: "2099-09-03T12:31:00Z",
        cleanupStatus: "scheduled",
      },
      task: null,
    },
    notSentToGoogle: ["preferences", "vm_memory"],
  };
}

function activeReceipt(): TutorialReceipt {
  const receipt = forgottenReceipt();
  return {
    ...receipt,
    explanation: {
      ...receipt.explanation,
      dataUsed: [{ type: "approved_tutorial_preferences", updatedAt: "2099-09-03T12:00:00Z" }],
    },
    preferences: {
      interaction: "neutral",
      information: "concrete",
      decision: "evidence",
      planning: "structured",
      preparationMinutes: 10,
    },
    storage: { ...receipt.storage, memoryStatus: "saved", forgottenAt: null },
    answerBefore: {
      route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
      sources: [
        { type: "vm_memory", recordVersion: 1 },
        { type: "google_calendar_receipt", requestId: REQUEST_ID, providerId: "calendar-resource-1" },
      ],
    },
    google: {
      ...receipt.google,
      calendar: {
        ...receipt.google.calendar!,
        sentFields: {
          title: "Tanya 해커톤 준비 점검",
          startAt: "2099-09-03T21:10:00+09:00",
          endAt: "2099-09-03T21:40:00+09:00",
          timeZone: "Asia/Seoul",
        },
        createdAt: "2099-09-03T12:01:00Z",
      },
    },
  };
}

describe("단일 TutorialPanel", () => {
  it("첫 화면에 권한 경계와 하나의 시작 CTA만 제공한다", () => {
    const html = renderPanel(initialTutorialState());
    expect(html).toContain("먼저 보여 주고, 허락받은 것만 실행해요");
    expect(html).toContain("공용 데모 계정");
    expect(html).toContain("strict Ollama");
    expect(html).toContain("체험 시작");
    expect(html).not.toContain("aria-live");
    expect((html.match(/role=\"status\"/g) ?? [])).toHaveLength(1);
  });

  it("네 문항 모두 중립 선택을 갖고 현재 문항은 native fieldset과 radio로 표시한다", () => {
    expect(TUTORIAL_PREFERENCE_QUESTIONS).toHaveLength(4);
    expect(TUTORIAL_PREFERENCE_QUESTIONS.every((question) => question.options.some((option) => option.value === "neutral"))).toBe(true);
    const html = renderPanel(withPhase("preferences_pending"));
    expect(html).toContain("<fieldset>");
    expect(html).toContain('type="radio"');
    expect(html).toContain("중립 설정으로 미리보기");
    expect(html).not.toMatch(/MBTI|성격 진단/);
  });

  it("Google 승인 전에 정확한 필드·실행 주체·자동 삭제 정책을 보이고 token은 숨긴다", () => {
    const html = renderPanel({ ...withPhase("calendar_pending"), approval: calendarApproval() });
    expect(html).toContain("아직 Google에는 변경이 없습니다");
    expect(html).toContain("Tanya 해커톤 준비 점검");
    expect(html).toContain("Asia/Seoul");
    expect(html).toContain("공용 데모 Brain → Google 공용 데모 계정");
    expect(html).toContain("성공하면 30분 뒤 자동 삭제");
    expect(html).toContain("왜 지금");
    expect(html).toContain("사용 데이터");
    expect(html).toContain("Self-hosted Brain VM · Tutorial service");
    expect(html).toContain("승인해야 실행");
    expect(html).toContain("실행 전 · 외부 변경 없음");
    expect(html).toContain("Request ID");
    // T-050: 버튼이 무엇을 승인하는지 말해야 한다.
    expect(html).toContain("이 일정 만들기");
    expect(html).toContain("Google 캘린더 일정 «Tanya 해커톤 준비 점검»");
    expect(html).not.toContain("must-never-be-rendered");
  });

  it("만료된 승인은 실행 버튼 대신 서버 상태 확인으로 복구한다", () => {
    const approval = calendarApproval();
    approval.expiresAt = "2000-01-01T00:00:00Z";
    const html = renderPanel({ ...withPhase("calendar_pending"), approval });
    expect(html).toContain("서버 상태 확인 후 새 미리보기");
    expect(html).not.toContain("표시된 내용만 승인");
    expect(html).not.toContain("거절하고 계속");
  });

  it("확인 불가 결과를 성공과 구분하고 자동 재실행하지 않는다고 표시한다", () => {
    const state = withPhase("task_pending");
    state.google.task = {
      flowId: FLOW_ID,
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      kind: "task",
      status: "uncertain",
      providerId: null,
      sentFields: null,
      createdAt: null,
      resolvedAt: "2099-09-03T12:01:00Z",
      cleanupDueAt: null,
      cleanupStatus: "unknown",
    };
    const html = renderPanel(state);
    expect(html).toContain("확인 불가 · 자동 재실행 안 함");
    expect(html).toContain("Google 정리 상태 확인 불가");
  });

  it("삭제 후 영수증에는 과거 설정·전송 필드를 렌더하지 않는다", () => {
    const state = withPhase("forgotten");
    state.snapshot = { ...state.snapshot!, memoryStatus: "forgotten" };
    state.receipt = forgottenReceipt();
    const html = renderPanel(state);
    expect(html).toContain("VM 기억 삭제 확인");
    expect(html).toContain("삭제 후 최소 정보");
    expect(html).toContain("실행 영수증 근거 요약");
    expect(html).toContain("Request ID");
    expect(html).toContain("Provider ID");
    expect(html).toContain("Operation ID");
    expect(html).toContain("VM 기억 삭제 후 제거됨");
    expect(html).not.toContain("승인한 응답 설정");
    expect(html).not.toContain("Tanya 해커톤 준비 점검");
  });

  it("삭제 전 영수증 상세에 실제 요청 식별자와 전송 필드를 표시한다", () => {
    const state = withPhase("receipt_ready");
    state.receipt = activeReceipt();
    const html = renderPanel(state);
    expect(html).toContain("Google 요청·전송 상세");
    expect(html).toContain(REQUEST_ID);
    expect(html).toContain("calendar-resource-1");
    expect(html).toContain("Tanya 해커톤 준비 점검");
    expect(html).toContain("Asia/Seoul");
    expect(html).toContain("Operation ID");
    expect(html).toContain("답변에 사용된 실제 source");
    expect(html).toContain("VM 세션 기억 · recordVersion 1");
    expect(html).toContain(`Calendar 영수증 · Request ID ${REQUEST_ID} · Provider ID calendar-resource-1`);
  });

  it("forgotten 단계는 확인된 snapshot 상태를 skipped로 바꾸지 않는다", () => {
    const state = withPhase("forgotten");
    state.snapshot = { ...state.snapshot!, memoryStatus: "forgotten", calendarStatus: "succeeded" };
    state.forgotten = {
      memoryStatus: "forgotten",
      forgottenAt: "2099-09-03T12:05:00Z",
      googleCleanup: { calendar: "scheduled", task: "not_required" },
    };
    const html = renderPanel(state);
    expect(html).toContain("성공");
    expect(html).toContain("자동 삭제 예약됨");
    expect(html).toContain("실행 결과 확인 중");
    expect(html).not.toContain("건너뜀");
  });

  it("완료 화면에서 삭제 전후 답변을 함께 비교한다", () => {
    const state = withPhase("completed");
    state.answers = {
      before: {
        comparison: "before",
        content: "승인된 기억을 사용한 답변",
        route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
        appliedPreferences: { interaction: "neutral", information: "concrete", decision: "evidence", planning: "structured" },
        sources: [
          { type: "vm_memory", recordVersion: 1 },
          { type: "google_calendar_receipt", requestId: REQUEST_ID, providerId: "calendar-resource-1" },
        ],
      },
      after: {
        comparison: "after",
        content: "기억을 삭제한 기본 답변",
        route: { provider: "ollama", execution: "local", fallback: false, model: "qwen3:8b" },
        appliedPreferences: {},
        sources: [],
      },
    };
    const html = renderPanel(state);
    expect(html).toContain("삭제 전후 답변 비교");
    expect(html).toContain("승인된 기억을 사용한 답변");
    expect(html).toContain("기억을 삭제한 기본 답변");
    expect(html).toContain("Calendar 영수증");
    expect(html).toContain("추가 grounding source 없음");
    expect(html).toContain("체험 완료 · 영수증 갱신 필요");
    expect(html).toContain("완료 영수증 다시 확인");
  });

  it("상태 문장 하나와 오류 alert만 별도 live semantics로 둔다", () => {
    const state = {
      ...withPhase("answer_before"),
      error: { code: "local_model_unavailable" as const, message: "로컬 답변 모델을 사용할 수 없습니다." },
    };
    const html = renderPanel(state);
    expect((html.match(/role=\"status\"/g) ?? [])).toHaveLength(1);
    expect((html.match(/role=\"alert\"/g) ?? [])).toHaveLength(1);
    expect(html).toContain("Cloud 답변으로 바꾸지 않습니다");
    expect(html).not.toContain("aria-live");
  });

  it("timeout 뒤에는 side effect 버튼을 숨기고 resume만 허용한다", () => {
    const state: TutorialState = {
      ...withPhase("calendar_pending"),
      needsResume: true,
      error: { code: "timeout", message: "응답 시간을 넘겼어요." },
    };
    const html = renderPanel(state);
    expect(html).toContain("서버 상태부터 확인");
    expect(html).not.toContain("변경 내용 미리보기");
    expect(html).not.toContain("만들지 않고 계속");
  });
});

describe("T-040 첫 화면 정보 밀도", () => {
  it("한 줄 약속과 시작 버튼은 접히지 않는다", () => {
    const html = renderPanel(initialTutorialState());
    expect(html).toContain("먼저 보여 주고, 허락받은 것만 실행해요.");
    expect(html).toContain("체험 시작");
  });

  it("소개 상세는 접근 가능한 disclosure로 감싼다", () => {
    const html = renderPanel(initialTutorialState());
    // 시각적으로만 숨기면 탭 순서에 남아 스크린리더가 읽는다. hidden 이어야 한다.
    expect(html).toContain("aria-expanded");
    expect(html).toContain('aria-controls="tutorial-intro-detail"');
    expect(html).toContain('id="tutorial-intro-detail"');
  });

  it("접힘 여부와 무관하게 설명 문구 자체는 존재한다", () => {
    const html = renderPanel(initialTutorialState());
    expect(html).toContain("공용 데모 계정을 사용하고");
    expect(html).toContain("승인 전에는 VM 저장·Google 변경 없음");
  });

  it("승인 미리보기는 어떤 경우에도 접히지 않는다", () => {
    // consent-first 계약: 사용자가 실행을 판단하는 정보는 항상 펼쳐져 있어야 한다.
    const html = renderPanel({ ...withPhase("calendar_pending"), approval: calendarApproval() });
    expect(html).not.toContain('id="tutorial-intro-detail"');
    expect(html).not.toContain("aria-expanded");
  });

  it("영수증 화면에도 접기 토글이 끼어들지 않는다", () => {
    const html = renderPanel({ ...withPhase("receipt_ready"), receipt: activeReceipt() });
    expect(html).not.toContain("tutorial-intro-toggle");
  });
});

describe("T-037 내 캘린더로 복사", () => {
  function receiptWithCalendar(status: "succeeded" | "failed" | "uncertain", sent = true) {
    const base = activeReceipt();
    return {
      ...base,
      google: {
        ...base.google,
        calendar: {
          requestId: REQUEST_ID,
          providerId: "provider-abc",
          status,
          sentFields: sent
            ? { title: "Tanya 해커톤 준비 점검", startAt: "2026-09-07T15:00:00+09:00", endAt: "2026-09-07T16:00:00+09:00", timeZone: "Asia/Seoul" }
            : null,
          createdAt: "2026-09-07T05:00:00Z",
          cleanupDueAt: "2026-09-07T05:30:00Z",
          cleanupStatus: "scheduled" as const,
        },
      },
    };
  }

  it("성공한 Calendar 영수증에만 복사 선택지가 뜬다", () => {
    const html = renderPanel({ ...withPhase("receipt_ready"), receipt: receiptWithCalendar("succeeded") });
    expect(html).toContain("내 캘린더로 복사하기");
    expect(html).toContain("캘린더 파일(ICS)로 추가");
    expect(html).toContain("내 Google Calendar에서 열기");
  });

  it.each(["failed", "uncertain"] as const)("%s 상태에는 뜨지 않는다", (status) => {
    const html = renderPanel({ ...withPhase("receipt_ready"), receipt: receiptWithCalendar(status) });
    expect(html).not.toContain("내 캘린더로 복사하기");
  });

  it("forget 뒤 redacted 영수증에는 뜨지 않는다", () => {
    const html = renderPanel({ ...withPhase("forgotten"), receipt: receiptWithCalendar("succeeded", false) });
    expect(html).not.toContain("내 캘린더로 복사하기");
  });

  it("복사본이 자동 삭제되지 않는다고 알린다", () => {
    const html = renderPanel({ ...withPhase("receipt_ready"), receipt: receiptWithCalendar("succeeded") });
    expect(html).toContain("직접 삭제");
    expect(html).toContain("30분");
  });

  it("새 탭 링크에 noopener noreferrer를 붙인다", () => {
    const html = renderPanel({ ...withPhase("receipt_ready"), receipt: receiptWithCalendar("succeeded") });
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("Google 링크에 내부 식별자를 넣지 않는다", () => {
    // 영수증 본문은 실제 실행 증거로 providerId를 정당하게 보여준다.
    // 여기서 확인할 것은 방문자가 외부로 들고 나가는 링크다.
    const html = renderPanel({ ...withPhase("receipt_ready"), receipt: receiptWithCalendar("succeeded") });
    const href = /href="(https:\/\/calendar\.google\.com[^"]*)"/.exec(html)?.[1] ?? "";
    expect(href).not.toBe("");
    expect(href).not.toContain("provider-abc");
    expect(href).not.toContain(REQUEST_ID.slice(0, 8));
    expect(href.toLowerCase()).not.toContain("token");
  });
});

describe("T-050 승인 대상 명시", () => {
  it("종류마다 승인 버튼 문구가 다르다", () => {
    // 이전에는 calendar와 task가 모두 "표시된 내용만 승인"이라
    // 승인 화면이 연속되면 같은 화면처럼 보였다.
    const calendar = renderPanel({ ...withPhase("calendar_pending"), approval: calendarApproval() });
    expect(calendar).toContain("이 일정 만들기");
    expect(calendar).not.toContain("표시된 내용만 승인");
    expect(calendar).not.toContain("이 할 일 만들기");
  });

  it("거절 버튼도 무엇을 거절하는지 말한다", () => {
    const calendar = renderPanel({ ...withPhase("calendar_pending"), approval: calendarApproval() });
    expect(calendar).toContain("일정 만들지 않고 계속");
  });

  it("실행 대상을 버튼 바로 위에 다시 보여준다", () => {
    const calendar = renderPanel({ ...withPhase("calendar_pending"), approval: calendarApproval() });
    expect(calendar).toContain("이번에 실행할 것");
    expect(calendar).toContain("tutorial-approval-target");
  });

  it("만료된 승인에는 실행 대상 줄을 띄우지 않는다", () => {
    const stale = calendarApproval();
    const expired = { ...withPhase("calendar_pending"), approval: { ...stale, expiresAt: "2000-01-01T00:00:00Z" } };
    const html = renderPanel(expired);
    expect(html).toContain("새 미리보기");
    expect(html).not.toContain("이번에 실행할 것");
  });
});

describe("T-052 입력 도움과 선택 흐름", () => {
  it("설정 단계에도 다음 버튼 줄이 있다", () => {
    const html = renderPanel(withPhase("preferences_pending"));
    expect(html).toContain("tutorial-actions split");
    expect(html).toContain("다음");
  });

  it("준비 알림 단계에는 미리보기 버튼이 있다", () => {
    const html = renderPanel(withPhase("preferences_pending"));
    expect(html).toContain("1 / 4");
  });
});
