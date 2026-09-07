import { describe, expect, it } from "vitest";
import {
  MEMORY_CAPSULE_OPERATION_TIMEOUT_MS,
  initialMemoryCapsuleState,
  memoryCapsuleErrorLabel,
  pendingMemoryCapsuleOperation,
  reduceMemoryCapsule,
} from "./memory-capsule";

const PREPARE_ID = "11111111-1111-4111-8111-111111111111";
const APPROVE_ID = "22222222-2222-4222-8222-222222222222";
const RECALL_ID = "33333333-3333-4333-8333-333333333333";
const FORGET_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";

const draft = {
  approvalToken: "approval-1",
  capsule: {
    preparationMinutes: 20 as const,
    content: "사용자는 일정 전에 20분의 준비 시간을 선호합니다.",
  },
  source: {
    type: "explicit_choice" as const,
    label: "준비 시간 선택" as const,
    sessionScoped: true as const,
    createdAt: "2099-09-02T12:00:00Z",
  },
  sessionScoped: true as const,
  expiresAt: "2099-09-02T12:30:00Z",
};

const record = {
  capsule: draft.capsule,
  source: draft.source,
  syncedAt: "2099-09-02T12:00:01Z",
  expiresAt: draft.expiresAt,
};

function approvalState() {
  const preparing = reduceMemoryCapsule(initialMemoryCapsuleState, {
    type: "prepare-requested",
    minutes: 20,
    operationId: PREPARE_ID,
  });
  return reduceMemoryCapsule(preparing, {
    type: "brain-event",
    event: { kind: "approval-required", operationId: PREPARE_ID, draft },
  });
}

function savedState() {
  const saving = reduceMemoryCapsule(approvalState(), {
    type: "approve-requested",
    operationId: APPROVE_ID,
  });
  return reduceMemoryCapsule(saving, {
    type: "brain-event",
    event: { kind: "saved", operationId: APPROVE_ID, record },
  });
}

describe("기억 캡슐 상태", () => {
  it("선택부터 승인·저장·회상·삭제까지 일치하는 operationId 응답으로만 완료한다", () => {
    let state = approvalState();
    expect(state.phase).toBe("approval");
    expect(state.expectedOperationId).toBeUndefined();

    state = reduceMemoryCapsule(state, { type: "approve-requested", operationId: APPROVE_ID });
    expect(pendingMemoryCapsuleOperation(state)).toBe("approve");
    state = reduceMemoryCapsule(state, {
      type: "brain-event",
      event: { kind: "saved", operationId: APPROVE_ID, record },
    });
    expect(state.phase).toBe("saved");

    state = reduceMemoryCapsule(state, { type: "recall-requested", operationId: RECALL_ID });
    state = reduceMemoryCapsule(state, {
      type: "brain-event",
      event: { kind: "recalled", operationId: RECALL_ID, record: { ...record, relevance: 0.92 } },
    });
    expect(state.phase).toBe("recalled");
    state = reduceMemoryCapsule(state, { type: "forget-requested", operationId: FORGET_ID });
    state = reduceMemoryCapsule(state, {
      type: "brain-event",
      event: { kind: "forgotten", operationId: FORGET_ID },
    });
    expect(state).toEqual({ phase: "forgotten" });
  });

  it("새로고침 직후 idle에서도 기존 세션 기억을 회상할 수 있다", () => {
    let state = reduceMemoryCapsule(initialMemoryCapsuleState, {
      type: "recall-requested",
      operationId: RECALL_ID,
    });
    expect(state.phase).toBe("recalling");
    state = reduceMemoryCapsule(state, {
      type: "brain-event",
      event: { kind: "recalled", operationId: RECALL_ID, record: { ...record, relevance: 0.87 } },
    });
    expect(state).toMatchObject({ phase: "recalled", record: { capsule: draft.capsule } });
  });

  it("45초 timeout·연결 끊김 뒤 늦은 응답과 이전 operation 응답을 무시한다", () => {
    expect(MEMORY_CAPSULE_OPERATION_TIMEOUT_MS).toBe(45_000);
    const preparing = reduceMemoryCapsule(initialMemoryCapsuleState, {
      type: "prepare-requested",
      minutes: 20,
      operationId: PREPARE_ID,
    });
    const timedOut = reduceMemoryCapsule(preparing, {
      type: "operation-failed",
      operationId: PREPARE_ID,
      message: "응답 시간이 지났어요.",
    });
    expect(timedOut).toMatchObject({ phase: "failed", retryOperation: "prepare" });
    expect(reduceMemoryCapsule(timedOut, {
      type: "brain-event",
      event: { kind: "approval-required", operationId: PREPARE_ID, draft },
    })).toBe(timedOut);

    const retried = reduceMemoryCapsule(timedOut, {
      type: "prepare-requested",
      minutes: 20,
      operationId: OTHER_ID,
    });
    expect(reduceMemoryCapsule(retried, {
      type: "brain-event",
      event: { kind: "approval-required", operationId: PREPARE_ID, draft },
    })).toBe(retried);
  });

  it("저장 응답의 operationId·선택·출처가 현재 draft와 다르면 성공으로 덮지 않는다", () => {
    const saving = reduceMemoryCapsule(approvalState(), {
      type: "approve-requested",
      operationId: APPROVE_ID,
    });
    expect(reduceMemoryCapsule(saving, {
      type: "brain-event",
      event: { kind: "saved", operationId: OTHER_ID, record },
    })).toBe(saving);

    const mismatchedRecord = {
      ...record,
      capsule: {
        preparationMinutes: 30 as const,
        content: "사용자는 일정 전에 30분의 준비 시간을 선호합니다.",
      },
    };
    expect(reduceMemoryCapsule(saving, {
      type: "brain-event",
      event: { kind: "saved", operationId: APPROVE_ID, record: mismatchedRecord },
    })).toBe(saving);

    const completed = reduceMemoryCapsule(saving, {
      type: "brain-event",
      event: { kind: "saved", operationId: APPROVE_ID, record },
    });
    expect(completed.phase).toBe("saved");
    expect(reduceMemoryCapsule(completed, {
      type: "brain-event",
      event: { kind: "saved", operationId: APPROVE_ID, record },
    })).toBe(completed);
  });

  it("오류는 현재 pending phase와 operationId가 맞을 때만 적용한다", () => {
    const preparing = reduceMemoryCapsule(initialMemoryCapsuleState, {
      type: "prepare-requested",
      minutes: 20,
      operationId: PREPARE_ID,
    });
    expect(reduceMemoryCapsule(preparing, {
      type: "brain-event",
      event: { kind: "failed", operationId: OTHER_ID, code: "storage_error", message: "이전 오류" },
    })).toBe(preparing);

    const failed = reduceMemoryCapsule(preparing, {
      type: "brain-event",
      event: { kind: "failed", operationId: PREPARE_ID, code: "storage_error", message: "동기화에 실패했습니다." },
    });
    expect(failed).toMatchObject({
      phase: "failed",
      selectedMinutes: 20,
      retryOperation: "prepare",
      error: { code: "storage_error", message: "동기화에 실패했습니다." },
    });
    expect(memoryCapsuleErrorLabel("storage_error")).toContain("동기화");
  });

  it("실패 시 draft·record를 보존하고 불확실한 저장은 재승인 대신 회상으로 확인한다", () => {
    const saving = reduceMemoryCapsule(approvalState(), {
      type: "approve-requested",
      operationId: APPROVE_ID,
    });
    const uncertainSave = reduceMemoryCapsule(saving, {
      type: "operation-failed",
      operationId: APPROVE_ID,
      message: "연결이 끊겼습니다.",
    });
    expect(uncertainSave).toMatchObject({ phase: "failed", draft, retryOperation: "recall" });

    const deleting = reduceMemoryCapsule(savedState(), {
      type: "forget-requested",
      operationId: FORGET_ID,
    });
    const failedDelete = reduceMemoryCapsule(deleting, {
      type: "operation-failed",
      operationId: FORGET_ID,
      message: "삭제 결과를 확인하지 못했습니다.",
    });
    expect(failedDelete).toMatchObject({ phase: "failed", record, retryOperation: "forget" });
    expect(reduceMemoryCapsule(failedDelete, {
      type: "brain-event",
      event: { kind: "forgotten", operationId: FORGET_ID },
    })).toBe(failedDelete);
  });

  it("회상 결과가 없으면 저장된 것처럼 보이지 않는다", () => {
    const recalling = reduceMemoryCapsule(initialMemoryCapsuleState, {
      type: "recall-requested",
      operationId: RECALL_ID,
    });
    expect(reduceMemoryCapsule(recalling, {
      type: "brain-event",
      event: { kind: "recalled", operationId: RECALL_ID, record: null },
    })).toEqual({ phase: "empty", selectedMinutes: undefined, draft: undefined });
  });
});
