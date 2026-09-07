import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryCapsulePanel } from "./MemoryCapsulePanel";
import { initialMemoryCapsuleState, type MemoryCapsuleState } from "./memory-capsule";

const noop = () => undefined;

function renderPanel(state: MemoryCapsuleState, connected = true): string {
  return renderToStaticMarkup(<MemoryCapsulePanel
    connected={connected}
    state={state}
    onSelect={noop}
    onApprove={noop}
    onReject={noop}
    onRecall={noop}
    onForget={noop}
    onRetry={noop}
    onReset={noop}
    onClose={noop}
  />);
}

const capsule = {
  preparationMinutes: 20 as const,
  content: "사용자는 일정 전에 20분의 준비 시간을 선호합니다.",
};

const source = {
  type: "explicit_choice" as const,
  label: "준비 시간 선택" as const,
  sessionScoped: true as const,
  createdAt: "2026-09-02T12:00:00Z",
};

describe("1분 기억 체험 패널", () => {
  it("자유 입력 없이 10·20·30분 선택만 제공한다", () => {
    const html = renderPanel(initialMemoryCapsuleState);
    expect(html).toContain("10분");
    expect(html).toContain("20분");
    expect(html).toContain("30분");
    expect(html).toContain("개인정보나 자유 입력은 받지 않아요");
    expect(html).toContain("이 세션에 저장된 기억 확인");
    expect(html).not.toContain("<input");
  });

  it("서버 승인 미리보기에 아직 저장되지 않았음과 자동 만료를 표시한다", () => {
    const html = renderPanel({
      phase: "approval",
      selectedMinutes: 20,
      draft: {
        approvalToken: "approval-1",
        capsule,
        source,
        sessionScoped: true,
        expiresAt: "2026-09-02T12:30:00Z",
      },
    });
    expect(html).toContain("승인하기 전에는 어디에도 저장되지 않아요");
    expect(html).toContain("자동 만료");
    expect(html).toContain("준비 시간 선택");
    expect(html).toContain("승인하고 기억하기");
  });

  it("연결이 끊긴 승인 미리보기에서는 승인과 취소를 모두 차단한다", () => {
    const html = renderPanel({
      phase: "approval",
      selectedMinutes: 20,
      draft: {
        approvalToken: "approval-1",
        capsule,
        source,
        sessionScoped: true,
        expiresAt: "2099-09-02T12:30:00Z",
      },
    }, false);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>취소<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>승인하고 기억하기<\/button>/);
  });

  it("실제 saved 이벤트 이후에만 저장소·인덱스 완료 증거를 표시한다", () => {
    const html = renderPanel({
      phase: "saved",
      selectedMinutes: 20,
      record: {
        capsule,
        source,
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    });
    expect(html).toContain("저장과 검색 동기화 완료");
    expect(html).toContain("CouchDB 원본");
    expect(html).toContain("sqlite-vec");
    expect(html).toContain("기억을 회상해 보기");
  });

  it("저장소 오류와 비보안 세션은 성공처럼 표시하지 않는다", () => {
    const failed = renderPanel({
      phase: "failed",
      selectedMinutes: 20,
      draft: {
        approvalToken: "approval-1",
        capsule,
        source,
        sessionScoped: true,
        expiresAt: "2099-09-02T12:30:00Z",
      },
      retryOperation: "recall",
      error: { code: "unavailable", message: "기억 저장소가 아직 연결되지 않았습니다." },
    }, false);
    expect(failed).toContain("기억 저장소가 아직 연결되지 않았습니다");
    expect(failed).toContain("보존된 선택: 20분");
    expect(failed).toContain("기억 상태 다시 확인");
    expect(failed).not.toContain("저장과 검색 동기화 완료");
  });

  it("회상한 출처와 즉시 삭제 동작을 함께 보여준다", () => {
    const html = renderPanel({
      phase: "recalled",
      selectedMinutes: 20,
      record: {
        capsule,
        source,
        relevance: 0.92,
        syncedAt: "2026-09-02T12:00:01Z",
        expiresAt: "2026-09-02T12:30:00Z",
      },
    });
    expect(html).toContain("타냐가 기억을 다시 찾았어요");
    expect(html).toContain("준비 시간 선택");
    expect(html).toContain("검색 관련도 92%");
    expect(html).toContain("지금 잊기");
  });
});
