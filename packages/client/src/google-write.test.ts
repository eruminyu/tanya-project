import { describe, expect, it } from "vitest";
import { createCalendarDraft, createTaskDraft, initialGoogleWriteState, reduceGoogleWriteState } from "./google-write";

describe("Google 쓰기 초안", () => {
  it("빈 제목은 생성 초안으로 만들지 않는다", () => {
    expect(() => createTaskDraft("  ", "")).toThrow("제목");
  });

  it("일정 종료는 시작보다 뒤여야 한다", () => {
    expect(() => createCalendarDraft("회의", "2026-08-16T15:00", "2026-08-16T14:00")).toThrow("종료");
  });

  it("Brain의 시간대 포함 일정도 Google 실행 전에 UTC RFC3339로 정규화한다", () => {
    expect(createCalendarDraft("회의", "2026-08-17T15:00:00+09:00", "2026-08-17T16:00:00+09:00", () => "fixed-id")).toEqual({
      kind: "calendar", requestId: "fixed-id", title: "회의",
      startAt: "2026-08-17T06:00:00.000Z", endAt: "2026-08-17T07:00:00.000Z",
    });
  });

  it("초안마다 재시도에도 유지되는 요청 ID를 만든다", () => {
    const draft = createTaskDraft("자료 정리", "2026-08-17", () => "fixed-id");
    expect(draft).toEqual({ kind: "task", requestId: "fixed-id", title: "자료 정리", due: "2026-08-17" });
  });

  it("명시적 승인 전에는 실행 상태가 되지 않는다", () => {
    const draft = createTaskDraft("자료 정리", "", () => "fixed-id");
    const preview = reduceGoogleWriteState(initialGoogleWriteState, { type: "preview", draft });
    expect(preview.status).toBe("preview");
    expect(reduceGoogleWriteState(preview, { type: "approve" }).status).toBe("executing");
  });

  it("서버 승인 메타데이터를 가진 웹 초안을 보존한다", () => {
    const draft = createTaskDraft("자료 정리", "", () => "request-1", {
      executor: "brain",
      approvalToken: "approval-1",
    });

    expect(draft).toEqual({
      kind: "task",
      requestId: "request-1",
      title: "자료 정리",
      due: null,
      executor: "brain",
      approvalToken: "approval-1",
    });
  });

  it("이전 요청의 늦은 결과로 현재 초안을 완료하지 않는다", () => {
    const draft = createTaskDraft("새 요청", "", () => "request-new");
    const executing = reduceGoogleWriteState(
      reduceGoogleWriteState(initialGoogleWriteState, { type: "preview", draft }),
      { type: "approve" },
    );

    expect(reduceGoogleWriteState(executing, {
      type: "complete",
      receipt: { requestId: "request-old", providerId: "task-old", title: "이전 요청", duplicate: false },
    })).toEqual(executing);
  });
});
