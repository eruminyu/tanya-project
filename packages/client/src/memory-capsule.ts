import type {
  MemoryCapsuleBrainEvent,
  MemoryCapsuleDraft,
  MemoryCapsuleMinutes,
  MemoryCapsuleRecord,
  RecalledMemoryCapsule,
} from "./brain";

export const MEMORY_CAPSULE_MINUTES: readonly MemoryCapsuleMinutes[] = [10, 20, 30];
export const MEMORY_CAPSULE_OPERATION_TIMEOUT_MS = 45_000;

export type MemoryCapsuleOperation = "prepare" | "approve" | "reject" | "recall" | "forget";

export type MemoryCapsulePhase =
  | "idle"
  | "preparing"
  | "approval"
  | "saving"
  | "rejecting"
  | "rejected"
  | "saved"
  | "recalling"
  | "recalled"
  | "empty"
  | "forgetting"
  | "forgotten"
  | "failed";

export type MemoryCapsuleState = {
  phase: MemoryCapsulePhase;
  selectedMinutes?: MemoryCapsuleMinutes;
  draft?: MemoryCapsuleDraft;
  record?: MemoryCapsuleRecord | RecalledMemoryCapsule;
  expectedOperationId?: string;
  retryOperation?: MemoryCapsuleOperation;
  error?: { code: string; message: string };
};

export const initialMemoryCapsuleState: MemoryCapsuleState = { phase: "idle" };

export type MemoryCapsuleAction =
  | { type: "prepare-requested"; minutes: MemoryCapsuleMinutes; operationId: string }
  | { type: "approve-requested"; operationId: string }
  | { type: "reject-requested"; operationId: string }
  | { type: "recall-requested"; operationId: string }
  | { type: "forget-requested"; operationId: string }
  | { type: "brain-event"; event: MemoryCapsuleBrainEvent }
  | { type: "operation-failed"; operationId: string; message: string }
  | { type: "local-failed"; operation: MemoryCapsuleOperation; message: string; minutes?: MemoryCapsuleMinutes }
  | { type: "reset" };

export function pendingMemoryCapsuleOperation(state: MemoryCapsuleState): MemoryCapsuleOperation | null {
  switch (state.phase) {
    case "preparing": return "prepare";
    case "saving": return "approve";
    case "rejecting": return "reject";
    case "recalling": return "recall";
    case "forgetting": return "forget";
    default: return null;
  }
}

function retryAfterPendingFailure(
  state: MemoryCapsuleState,
  code: string = "unavailable",
): MemoryCapsuleOperation {
  switch (state.phase) {
    case "preparing": return "prepare";
    case "saving": return code === "invalid" || code === "expired" ? "prepare" : "recall";
    case "rejecting": return "prepare";
    case "recalling": return "recall";
    case "forgetting": return "forget";
    default: return "prepare";
  }
}

function failPending(
  state: MemoryCapsuleState,
  code: string,
  message: string,
): MemoryCapsuleState {
  return {
    ...state,
    phase: "failed",
    expectedOperationId: undefined,
    retryOperation: retryAfterPendingFailure(state, code),
    error: { code, message },
  };
}

function draftMatchesRecord(draft: MemoryCapsuleDraft, record: MemoryCapsuleRecord): boolean {
  return draft.capsule.preparationMinutes === record.capsule.preparationMinutes
    && draft.capsule.content === record.capsule.content
    && draft.source.type === record.source.type
    && draft.source.label === record.source.label
    && draft.source.sessionScoped === record.source.sessionScoped
    && draft.source.createdAt === record.source.createdAt
    && draft.expiresAt === record.expiresAt;
}

export function reduceMemoryCapsule(
  state: MemoryCapsuleState,
  action: MemoryCapsuleAction,
): MemoryCapsuleState {
  switch (action.type) {
    case "prepare-requested":
      return {
        phase: "preparing",
        selectedMinutes: action.minutes,
        expectedOperationId: action.operationId,
      };
    case "approve-requested":
      return state.draft && (state.phase === "approval"
        || (state.phase === "failed" && state.retryOperation === "approve"))
        ? {
            ...state,
            phase: "saving",
            expectedOperationId: action.operationId,
            retryOperation: undefined,
            error: undefined,
          }
        : state;
    case "reject-requested":
      return state.draft && (state.phase === "approval"
        || (state.phase === "failed" && state.retryOperation === "reject"))
        ? {
            ...state,
            phase: "rejecting",
            expectedOperationId: action.operationId,
            retryOperation: undefined,
            error: undefined,
          }
        : state;
    case "recall-requested":
      return state.phase === "idle" || state.phase === "saved" || state.phase === "recalled"
        || state.phase === "empty"
        || (state.phase === "failed" && state.retryOperation === "recall")
        ? {
            ...state,
            phase: "recalling",
            expectedOperationId: action.operationId,
            retryOperation: undefined,
            error: undefined,
          }
        : state;
    case "forget-requested":
      return state.record && (state.phase === "saved" || state.phase === "recalled"
        || (state.phase === "failed" && state.retryOperation === "forget"))
        ? {
            ...state,
            phase: "forgetting",
            expectedOperationId: action.operationId,
            retryOperation: undefined,
            error: undefined,
          }
        : state;
    case "local-failed":
      return {
        ...state,
        phase: "failed",
        selectedMinutes: action.minutes ?? state.selectedMinutes,
        expectedOperationId: undefined,
        retryOperation: action.operation,
        error: { code: "unavailable", message: action.message },
      };
    case "operation-failed":
      return state.expectedOperationId === action.operationId && pendingMemoryCapsuleOperation(state)
        ? failPending(state, "unavailable", action.message)
        : state;
    case "reset":
      return initialMemoryCapsuleState;
    case "brain-event": {
      const event = action.event;
      if (event.operationId !== state.expectedOperationId) return state;
      if (event.kind === "failed") {
        return pendingMemoryCapsuleOperation(state)
          ? failPending(state, event.code, event.message)
          : state;
      }
      if (event.kind === "approval-required") {
        if (state.phase !== "preparing"
          || event.draft.capsule.preparationMinutes !== state.selectedMinutes) return state;
        return {
          phase: "approval",
          selectedMinutes: state.selectedMinutes,
          draft: event.draft,
        };
      }
      if (event.kind === "saved") {
        if (state.phase !== "saving" || !state.draft
          || !draftMatchesRecord(state.draft, event.record)) return state;
        return {
          phase: "saved",
          selectedMinutes: event.record.capsule.preparationMinutes,
          draft: state.draft,
          record: event.record,
        };
      }
      if (event.kind === "recalled") {
        if (state.phase !== "recalling") return state;
        if (!event.record) {
          return {
            phase: "empty",
            selectedMinutes: state.selectedMinutes,
            draft: state.draft,
          };
        }
        return {
          phase: "recalled",
          selectedMinutes: event.record.capsule.preparationMinutes,
          draft: state.draft,
          record: event.record,
        };
      }
      if (event.kind === "forgotten") {
        return state.phase === "forgetting" ? { phase: "forgotten" } : state;
      }
      if (event.kind === "rejected") {
        return state.phase === "rejecting" ? { phase: "rejected" } : state;
      }
      return state;
    }
  }
}

export function memoryCapsuleErrorLabel(code: string): string {
  switch (code) {
    case "unavailable": return "기억 저장소를 사용할 수 없어요";
    case "invalid": return "요청을 확인할 수 없어요";
    case "expired": return "승인 시간이 지났어요";
    case "storage_error": return "저장소 동기화에 실패했어요";
    default: return "기억 체험을 완료하지 못했어요";
  }
}

export function memoryCapsuleRetryLabel(operation: MemoryCapsuleOperation): string {
  switch (operation) {
    case "prepare": return "같은 시간으로 다시 요청";
    case "approve": return "승인 다시 보내기";
    case "reject": return "취소 다시 보내기";
    case "recall": return "기억 상태 다시 확인";
    case "forget": return "삭제 다시 확인";
  }
}
