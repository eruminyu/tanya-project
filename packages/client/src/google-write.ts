import { createMessageId } from "./message-id";

export type GoogleWriteApproval = { executor: "brain"; approvalToken: string };

export type GoogleWriteDraft =
  | ({ kind: "calendar"; requestId: string; title: string; startAt: string; endAt: string } & Partial<GoogleWriteApproval>)
  | ({ kind: "task"; requestId: string; title: string; due: string | null } & Partial<GoogleWriteApproval>);

export type GoogleWriteReceipt = { requestId: string; providerId: string; title: string; duplicate: boolean };

export type GoogleWriteState =
  | { status: "idle" }
  | { status: "preview"; draft: GoogleWriteDraft }
  | { status: "executing"; draft: GoogleWriteDraft }
  | { status: "completed"; draft: GoogleWriteDraft; receipt: GoogleWriteReceipt }
  | { status: "failed"; draft: GoogleWriteDraft; message: string };

export const initialGoogleWriteState: GoogleWriteState = { status: "idle" };
type IdFactory = () => string;

function requireTitle(title: string): string {
  const value = title.trim();
  if (!value) throw new Error("제목을 입력해 주세요.");
  return value;
}

export function createCalendarDraft(title: string, startAt: string, endAt: string, id: IdFactory = createMessageId, approval?: GoogleWriteApproval): GoogleWriteDraft {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (!startAt || Number.isNaN(start.valueOf())) throw new Error("일정 시작 시간을 확인해 주세요.");
  if (!endAt || Number.isNaN(end.valueOf()) || end <= start) throw new Error("일정 종료 시간은 시작보다 뒤여야 합니다.");
  return { kind: "calendar", requestId: id(), title: requireTitle(title), startAt: start.toISOString(), endAt: end.toISOString(), ...(approval ?? {}) };
}

export function createTaskDraft(title: string, due: string, id: IdFactory = createMessageId, approval?: GoogleWriteApproval): GoogleWriteDraft {
  return { kind: "task", requestId: id(), title: requireTitle(title), due: due || null, ...(approval ?? {}) };
}

export function reduceGoogleWriteState(state: GoogleWriteState, action: { type: "preview"; draft: GoogleWriteDraft } | { type: "approve" } | { type: "complete"; receipt: GoogleWriteReceipt } | { type: "fail"; message: string } | { type: "cancel"; requestId?: string }): GoogleWriteState {
  switch (action.type) {
    case "preview": return { status: "preview", draft: action.draft };
    case "approve": return state.status === "preview" || state.status === "failed" ? { status: "executing", draft: state.draft } : state;
    case "complete": return state.status === "executing" && state.draft.requestId === action.receipt.requestId ? { status: "completed", draft: state.draft, receipt: action.receipt } : state;
    case "fail": return state.status === "executing" ? { status: "failed", draft: state.draft, message: action.message } : state;
    case "cancel": return action.requestId && state.status !== "idle" && state.draft.requestId !== action.requestId ? state : { status: "idle" };
  }
}
