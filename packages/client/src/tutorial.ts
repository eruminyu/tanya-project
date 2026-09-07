export const TUTORIAL_FLOW_STORAGE_KEY = "tanya.tutorial.flow-id";
export const TUTORIAL_OPERATION_TIMEOUT_MS = 35_000;
export const TUTORIAL_ANSWER_TIMEOUT_MS = 190_000;
export const TUTORIAL_SCENARIO_ID = "hackathon_demo_v1" as const;
export const TUTORIAL_QUESTION_ID = "demo_preparation_summary_v1" as const;

export type TutorialPhase =
  | "preferences_pending"
  | "preferences_saved"
  | "calendar_pending"
  | "calendar_executing"
  | "calendar_finished"
  | "task_pending"
  | "task_executing"
  | "task_finished"
  | "answer_before"
  | "receipt_ready"
  | "forgetting"
  | "forgotten"
  | "answer_after"
  | "completed";

export type TutorialPreferences = {
  interaction: "complete" | "interactive" | "neutral";
  information: "concrete" | "big_picture" | "neutral";
  decision: "evidence" | "context" | "neutral";
  planning: "structured" | "flexible" | "neutral";
};

export type TutorialPreparationMinutes = 5 | 10 | 20;
export type TutorialGoogleKind = "calendar" | "task";
export type TutorialApprovalPurpose = "preferences" | TutorialGoogleKind;
export type TutorialComparison = "before" | "after";
export type TutorialGoogleStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "rejected"
  | "skipped";
export type TutorialGoogleResultStatus = Exclude<TutorialGoogleStatus, "pending" | "executing">;
export type TutorialCleanupStatus =
  | "not_required"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export const NEUTRAL_TUTORIAL_PREFERENCES: TutorialPreferences = {
  interaction: "neutral",
  information: "neutral",
  decision: "neutral",
  planning: "neutral",
};

export type TutorialPreferenceDraft = {
  step: 0 | 1 | 2 | 3 | 4;
  preferences: TutorialPreferences;
  preparationMinutes: TutorialPreparationMinutes;
};

export type TutorialPreferenceDraftAction =
  | { type: "select"; key: keyof TutorialPreferences; value: string }
  | { type: "minutes"; value: TutorialPreparationMinutes }
  | { type: "next" }
  | { type: "back" }
  | { type: "reset" };

export const initialTutorialPreferenceDraft: TutorialPreferenceDraft = {
  step: 0,
  preferences: { ...NEUTRAL_TUTORIAL_PREFERENCES },
  preparationMinutes: 10,
};

function isPreferenceValue(key: keyof TutorialPreferences, value: string): boolean {
  if (value === "neutral") return true;
  if (key === "interaction") return value === "complete" || value === "interactive";
  if (key === "information") return value === "concrete" || value === "big_picture";
  if (key === "decision") return value === "evidence" || value === "context";
  return value === "structured" || value === "flexible";
}

export function reduceTutorialPreferenceDraft(
  state: TutorialPreferenceDraft,
  action: TutorialPreferenceDraftAction,
): TutorialPreferenceDraft {
  if (action.type === "reset") return { ...initialTutorialPreferenceDraft, preferences: { ...NEUTRAL_TUTORIAL_PREFERENCES } };
  if (action.type === "minutes") return { ...state, preparationMinutes: action.value };
  if (action.type === "select") {
    if (!isPreferenceValue(action.key, action.value)) return state;
    return { ...state, preferences: { ...state.preferences, [action.key]: action.value } } as TutorialPreferenceDraft;
  }
  if (action.type === "next") return { ...state, step: Math.min(4, state.step + 1) as TutorialPreferenceDraft["step"] };
  return { ...state, step: Math.max(0, state.step - 1) as TutorialPreferenceDraft["step"] };
}

export type TutorialCalendarFields = {
  title: string;
  startAt: string;
  endAt: string;
  timeZone: string;
};

export type TutorialTaskFields = {
  title: string;
  due: string;
};

type TutorialDataUse = {
  type:
    | "tutorial_scenario"
    | "proposed_tutorial_preferences"
    | "approved_tutorial_preferences"
    | "approved_calendar_receipt"
    | "approved_task_receipt";
  updatedAt: string;
};

export type TutorialApprovalExplanation = {
  whyNow: { code: "user_requested_tutorial_step"; summary: string };
  dataUsed: TutorialDataUse[];
  processing: { location: "self_hosted_brain_vm"; route: "tutorial_service" };
  exactChange: {
    kind: "tutorial_preferences_store" | "google_calendar_create" | "google_task_create";
    fields: TutorialPreferencesPreviewFields | TutorialCalendarFields | TutorialTaskFields;
  };
  executor:
    | { type: "tutorial_service"; target: "sqlite" }
    | { type: "public_demo_brain"; target: "google" };
  approval: { status: "required"; executesOnApproval: true };
  changeState: "not_executed";
  retention: {
    memoryExpiresAt: string;
    googleCleanupAfterMinutes: 30;
    googleCleanupDueAt: null;
  };
};

export type TutorialPreferencesPreviewFields = TutorialPreferences & {
  preparationMinutes: TutorialPreparationMinutes;
};

export type TutorialApprovalPreview =
  | {
      kind: "tutorial_preferences_store";
      fields: TutorialPreferencesPreviewFields;
      executor: "tutorial_service/sqlite";
      message: string;
      explanation: TutorialApprovalExplanation;
    }
  | {
      kind: "calendar";
      fields: TutorialCalendarFields;
      executor: "public_demo_brain/google";
      accountScope: "shared_demo_account";
      message: string;
      explanation: TutorialApprovalExplanation;
    }
  | {
      kind: "task";
      fields: TutorialTaskFields;
      executor: "public_demo_brain/google";
      accountScope: "shared_demo_account";
      message: string;
      explanation: TutorialApprovalExplanation;
    };

export type TutorialApproval = {
  flowId: string;
  operationId: string;
  requestId: string;
  purpose: TutorialApprovalPurpose;
  approvalToken: string;
  expiresAt: string;
  preview: TutorialApprovalPreview;
};

export type TutorialSnapshot = {
  phase: TutorialPhase;
  expiresAt: string;
  calendarStatus: TutorialGoogleStatus | null;
  taskStatus: TutorialGoogleStatus | null;
  memoryStatus: "empty" | "pending" | "saved" | "forgotten";
};

export type TutorialGoogleResult = {
  flowId: string;
  operationId: string;
  requestId: string;
  kind: TutorialGoogleKind;
  status: TutorialGoogleResultStatus;
  providerId: string | null;
  sentFields: TutorialCalendarFields | TutorialTaskFields | null;
  createdAt: string | null;
  resolvedAt: string;
  cleanupDueAt: string | null;
  cleanupStatus: TutorialCleanupStatus;
};

export type TutorialRoute = {
  provider: "ollama";
  execution: "local";
  fallback: false;
  model: string;
};

export type TutorialSource =
  | { type: "vm_memory"; recordVersion: 1 }
  | {
      type: "google_calendar_receipt" | "google_task_receipt";
      requestId: string;
      providerId: string;
    };

export type TutorialAnswer = {
  comparison: TutorialComparison;
  content: string;
  route: TutorialRoute;
  appliedPreferences: TutorialPreferences | Record<string, never>;
  sources: TutorialSource[];
};

type TutorialReceiptAnswer = {
  route: TutorialRoute;
  sources: TutorialSource[];
};

export type TutorialReceiptGoogleAction = {
  requestId: string;
  providerId: string | null;
  status: TutorialGoogleResultStatus;
  sentFields: TutorialCalendarFields | TutorialTaskFields | null;
  createdAt: string | null;
  cleanupDueAt: string | null;
  cleanupStatus: TutorialCleanupStatus;
};

export type TutorialReceipt = {
  flowId: string;
  operationId: string;
  expiresAt: string;
  explanation: {
    whyNow: { code: "user_started_public_tutorial"; summary: string };
    dataUsed: TutorialDataUse[];
    processing: { location: "self_hosted_brain_vm"; route: "strict_ollama" };
    exactChange: {
      kind: "tutorial_receipt";
      fields: { google: Partial<Record<TutorialGoogleKind, TutorialGoogleResultStatus>> };
    };
    executor: { type: "public_demo_brain"; target: "google" | "sqlite" };
    approval: { status: "approved" | "rejected" | "skipped" | "not_required" };
    changeState: "completed" | "not_run" | "uncertain";
    retention: {
      memoryExpiresAt: string;
      googleCleanupAfterMinutes: 30;
      googleCleanupDueAt: string | null;
    };
  };
  preferences: TutorialPreferencesPreviewFields | null;
  storage: {
    type: "sqlite";
    execution: "self_hosted_brain_vm";
    scope: "session";
    memoryStatus: "empty" | "saved" | "forgotten";
    forgottenAt: string | null;
  };
  answerBefore: TutorialReceiptAnswer | null;
  answerAfter: TutorialReceiptAnswer | null;
  google: Record<TutorialGoogleKind, TutorialReceiptGoogleAction | null>;
  notSentToGoogle: ["preferences", "vm_memory"];
};

export type TutorialForgotten = {
  memoryStatus: "forgotten";
  forgottenAt: string;
  googleCleanup: Record<TutorialGoogleKind, TutorialCleanupStatus>;
};

export type TutorialErrorCode =
  | "invalid"
  | "invalid_phase"
  | "expired"
  | "conflict"
  | "unavailable"
  | "local_model_unavailable"
  | "external_failed"
  | "external_uncertain"
  | "deprecated"
  | "rate_limited";

export type TutorialBrainEvent =
  | { kind: "state"; flowId: string; operationId: string; snapshot: TutorialSnapshot }
  | { kind: "approval-required"; flowId: string; operationId: string; approval: TutorialApproval }
  | { kind: "google-result"; flowId: string; operationId: string; result: TutorialGoogleResult }
  | { kind: "answer-started"; flowId: string; operationId: string; comparison: TutorialComparison }
  | { kind: "answer-completed"; flowId: string; operationId: string; answer: TutorialAnswer }
  | { kind: "receipt"; flowId: string; operationId: string; receipt: TutorialReceipt }
  | { kind: "forgotten"; flowId: string; operationId: string; forgotten: TutorialForgotten }
  | {
      kind: "error";
      flowId: string;
      operationId: string;
      code: TutorialErrorCode;
      message: string;
      retryAfter?: number;
    };

export type TutorialActionRequest =
  | { action: "tutorial_start"; payload: Record<string, never> }
  | { action: "tutorial_resume"; payload: { flow_id: string } }
  | {
      action: "tutorial_preferences_prepare";
      payload: {
        flow_id: string;
        preferences: TutorialPreferences;
        preparation_minutes: TutorialPreparationMinutes;
      };
    }
  | {
      action: "tutorial_approve" | "tutorial_reject";
      payload: { flow_id: string; approval_token: string; request_id: string };
    }
  | {
      action: "tutorial_google_prepare";
      payload: {
        flow_id: string;
        kind: TutorialGoogleKind;
        scenario_id: typeof TUTORIAL_SCENARIO_ID;
        timezone: string;
      };
    }
  | { action: "tutorial_google_skip"; payload: { flow_id: string; kind: TutorialGoogleKind } }
  | {
      action: "tutorial_answer_generate";
      payload: {
        flow_id: string;
        comparison: TutorialComparison;
        question_id: typeof TUTORIAL_QUESTION_ID;
      };
    }
  | { action: "tutorial_receipt_get" | "tutorial_forget"; payload: { flow_id: string } };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isTutorialId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function parseUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value) || !hasValidIsoDateAndTime(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseOffsetTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !OFFSET_TIMESTAMP_PATTERN.test(value) || !hasValidIsoDateAndTime(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function hasValidIsoDateAndTime(value: string): boolean {
  if (!parseDateOnly(value.slice(0, 10))) return false;
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (hour > 23 || minute > 59 || second > 59) return false;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  return !offset || (Number(offset[2]) <= 23 && Number(offset[3]) <= 59);
}

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  return date.getUTCFullYear() === Number(yearText)
    && date.getUTCMonth() + 1 === Number(monthText)
    && date.getUTCDate() === Number(dayText)
    ? value
    : null;
}

function parseNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function parsePreferences(value: unknown): TutorialPreferences | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["interaction", "information", "decision", "planning"])) return null;
  if (value.interaction !== "complete" && value.interaction !== "interactive" && value.interaction !== "neutral") return null;
  if (value.information !== "concrete" && value.information !== "big_picture" && value.information !== "neutral") return null;
  if (value.decision !== "evidence" && value.decision !== "context" && value.decision !== "neutral") return null;
  if (value.planning !== "structured" && value.planning !== "flexible" && value.planning !== "neutral") return null;
  return {
    interaction: value.interaction,
    information: value.information,
    decision: value.decision,
    planning: value.planning,
  };
}

function parsePreferencesPreviewFields(value: unknown): TutorialPreferencesPreviewFields | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["interaction", "information", "decision", "planning", "preparationMinutes"])) return null;
  const preferences = parsePreferences({
    interaction: value.interaction,
    information: value.information,
    decision: value.decision,
    planning: value.planning,
  });
  if (!preferences || (value.preparationMinutes !== 5 && value.preparationMinutes !== 10 && value.preparationMinutes !== 20)) return null;
  return { ...preferences, preparationMinutes: value.preparationMinutes };
}

function parseCalendarFields(value: unknown): TutorialCalendarFields | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["title", "startAt", "endAt", "timeZone"])) return null;
  const title = parseNonemptyString(value.title);
  const startAt = parseOffsetTimestamp(value.startAt);
  const endAt = parseOffsetTimestamp(value.endAt);
  if (!title || !startAt || !endAt || !isIanaTimeZone(value.timeZone)
    || Date.parse(endAt) <= Date.parse(startAt)) return null;
  return { title, startAt, endAt, timeZone: value.timeZone };
}

function parseTaskFields(value: unknown): TutorialTaskFields | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["title", "due"])) return null;
  const title = parseNonemptyString(value.title);
  const due = parseDateOnly(value.due);
  return title && due ? { title, due } : null;
}

function parseFields(kind: TutorialGoogleKind, value: unknown): TutorialCalendarFields | TutorialTaskFields | null {
  return kind === "calendar" ? parseCalendarFields(value) : parseTaskFields(value);
}

function parseDataUsed(value: unknown, receipt: boolean): TutorialDataUse[] | null {
  if (!Array.isArray(value)) return null;
  const allowed = receipt
    ? new Set(["approved_tutorial_preferences", "approved_calendar_receipt", "approved_task_receipt"])
    : new Set(["tutorial_scenario", "proposed_tutorial_preferences", "approved_tutorial_preferences", "approved_calendar_receipt", "approved_task_receipt"]);
  const parsed: TutorialDataUse[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["type", "updatedAt"])
      || typeof item.type !== "string" || !allowed.has(item.type)) return null;
    const updatedAt = parseUtcTimestamp(item.updatedAt);
    if (!updatedAt) return null;
    parsed.push({ type: item.type as TutorialDataUse["type"], updatedAt });
  }
  return parsed;
}

function parseApprovalExplanation(
  value: unknown,
  exactKind: TutorialApprovalExplanation["exactChange"]["kind"],
  fields: TutorialApprovalExplanation["exactChange"]["fields"],
  executor: TutorialApprovalExplanation["executor"],
): TutorialApprovalExplanation | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["whyNow", "dataUsed", "processing", "exactChange", "executor", "approval", "changeState", "retention"])) return null;
  const whyNow = value.whyNow;
  const processing = value.processing;
  const exactChange = value.exactChange;
  const actualExecutor = value.executor;
  const approval = value.approval;
  const retention = value.retention;
  const dataUsed = parseDataUsed(value.dataUsed, false);
  if (!isRecord(whyNow) || !hasOnlyKeys(whyNow, ["code", "summary"])
    || whyNow.code !== "user_requested_tutorial_step" || !parseNonemptyString(whyNow.summary)
    || !dataUsed
    || !isRecord(processing) || !hasOnlyKeys(processing, ["location", "route"])
    || processing.location !== "self_hosted_brain_vm" || processing.route !== "tutorial_service"
    || !isRecord(exactChange) || !hasOnlyKeys(exactChange, ["kind", "fields"])
    || exactChange.kind !== exactKind || !sameJson(exactChange.fields, fields)
    || !isRecord(actualExecutor) || !hasOnlyKeys(actualExecutor, ["type", "target"])
    || actualExecutor.type !== executor.type || actualExecutor.target !== executor.target
    || !isRecord(approval) || !hasOnlyKeys(approval, ["status", "executesOnApproval"])
    || approval.status !== "required" || approval.executesOnApproval !== true
    || value.changeState !== "not_executed"
    || !isRecord(retention) || !hasOnlyKeys(retention, ["memoryExpiresAt", "googleCleanupAfterMinutes", "googleCleanupDueAt"])
    || !parseUtcTimestamp(retention.memoryExpiresAt)
    || retention.googleCleanupAfterMinutes !== 30 || retention.googleCleanupDueAt !== null) return null;
  return {
    whyNow: { code: "user_requested_tutorial_step", summary: String(whyNow.summary).trim() },
    dataUsed,
    processing: { location: "self_hosted_brain_vm", route: "tutorial_service" },
    exactChange: { kind: exactKind, fields },
    executor,
    approval: { status: "required", executesOnApproval: true },
    changeState: "not_executed",
    retention: {
      memoryExpiresAt: String(retention.memoryExpiresAt),
      googleCleanupAfterMinutes: 30,
      googleCleanupDueAt: null,
    },
  };
}

function parseApprovalPreview(value: unknown, purpose: TutorialApprovalPurpose): TutorialApprovalPreview | null {
  if (!isRecord(value)) return null;
  const message = parseNonemptyString(value.message);
  if (!message) return null;
  if (purpose === "preferences") {
    if (!hasOnlyKeys(value, ["kind", "fields", "executor", "message", "explanation"])
      || value.kind !== "tutorial_preferences_store" || value.executor !== "tutorial_service/sqlite") return null;
    const fields = parsePreferencesPreviewFields(value.fields);
    if (!fields) return null;
    const explanation = parseApprovalExplanation(
      value.explanation,
      "tutorial_preferences_store",
      fields,
      { type: "tutorial_service", target: "sqlite" },
    );
    return explanation ? { kind: "tutorial_preferences_store", fields, executor: "tutorial_service/sqlite", message, explanation } : null;
  }
  if (!hasOnlyKeys(value, ["kind", "fields", "executor", "accountScope", "message", "explanation"])
    || value.kind !== purpose || value.executor !== "public_demo_brain/google"
    || value.accountScope !== "shared_demo_account") return null;
  const fields = parseFields(purpose, value.fields);
  if (!fields) return null;
  const explanation = parseApprovalExplanation(
    value.explanation,
    purpose === "calendar" ? "google_calendar_create" : "google_task_create",
    fields,
    { type: "public_demo_brain", target: "google" },
  );
  if (!explanation) return null;
  return purpose === "calendar"
    ? { kind: "calendar", fields: fields as TutorialCalendarFields, executor: "public_demo_brain/google", accountScope: "shared_demo_account", message, explanation }
    : { kind: "task", fields: fields as TutorialTaskFields, executor: "public_demo_brain/google", accountScope: "shared_demo_account", message, explanation };
}

function parseRoute(value: unknown): TutorialRoute | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["provider", "execution", "fallback", "model"])
    || value.provider !== "ollama" || value.execution !== "local" || value.fallback !== false) return null;
  const model = parseNonemptyString(value.model);
  return model ? { provider: "ollama", execution: "local", fallback: false, model } : null;
}

function parseSources(value: unknown): TutorialSource[] | null {
  if (!Array.isArray(value)) return null;
  const sources: TutorialSource[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") return null;
    if (item.type === "vm_memory") {
      if (!hasOnlyKeys(item, ["type", "recordVersion"]) || item.recordVersion !== 1) return null;
      sources.push({ type: "vm_memory", recordVersion: 1 });
      continue;
    }
    if (item.type !== "google_calendar_receipt" && item.type !== "google_task_receipt") return null;
    if (!hasOnlyKeys(item, ["type", "requestId", "providerId"]) || !isTutorialId(item.requestId)) return null;
    const providerId = parseNonemptyString(item.providerId);
    if (!providerId) return null;
    sources.push({ type: item.type, requestId: item.requestId, providerId });
  }
  return sources;
}

function isGoogleStatus(value: unknown): value is TutorialGoogleStatus {
  return value === "pending" || value === "executing" || value === "succeeded"
    || value === "failed" || value === "uncertain" || value === "rejected" || value === "skipped";
}

function isGoogleResultStatus(value: unknown): value is TutorialGoogleResultStatus {
  return value === "succeeded" || value === "failed" || value === "uncertain"
    || value === "rejected" || value === "skipped";
}

function isCleanupStatus(value: unknown): value is TutorialCleanupStatus {
  return value === "not_required" || value === "scheduled" || value === "running"
    || value === "succeeded" || value === "failed" || value === "unknown";
}

function parseGoogleResult(payload: UnknownRecord, flowId: string, operationId: string): TutorialGoogleResult | null {
  if (!hasOnlyKeys(payload, ["flowId", "operationId", "requestId", "kind", "status", "providerId", "sentFields", "createdAt", "resolvedAt", "cleanupDueAt", "cleanupStatus"])
    || !isTutorialId(payload.requestId)
    || (payload.kind !== "calendar" && payload.kind !== "task")
    || !isGoogleResultStatus(payload.status) || !isCleanupStatus(payload.cleanupStatus)) return null;
  const resolvedAt = parseUtcTimestamp(payload.resolvedAt);
  if (!resolvedAt) return null;
  const succeeded = payload.status === "succeeded";
  const providerId = payload.providerId === null ? null : parseNonemptyString(payload.providerId);
  const sentFields = payload.sentFields === null ? null : parseFields(payload.kind, payload.sentFields);
  const createdAt = payload.createdAt === null ? null : parseUtcTimestamp(payload.createdAt);
  const cleanupDueAt = payload.cleanupDueAt === null ? null : parseUtcTimestamp(payload.cleanupDueAt);
  if (succeeded) {
    if (!providerId || !sentFields || !createdAt || !cleanupDueAt || payload.cleanupStatus === "unknown" || payload.cleanupStatus === "not_required") return null;
  } else if (payload.providerId !== null || payload.sentFields !== null
    || payload.createdAt !== null || payload.cleanupDueAt !== null) return null;
  if (payload.status === "uncertain" && payload.cleanupStatus !== "unknown") return null;
  if (payload.status !== "uncertain" && !succeeded && payload.cleanupStatus !== "not_required") return null;
  return {
    flowId,
    operationId,
    requestId: payload.requestId,
    kind: payload.kind,
    status: payload.status,
    providerId,
    sentFields,
    createdAt,
    resolvedAt,
    cleanupDueAt,
    cleanupStatus: payload.cleanupStatus,
  };
}

function parseReceiptAnswer(value: unknown): TutorialReceiptAnswer | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["route", "sources"])) return null;
  const route = parseRoute(value.route);
  const sources = parseSources(value.sources);
  return route && sources ? { route, sources } : null;
}

function parseReceiptExplanation(value: unknown): TutorialReceipt["explanation"] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["whyNow", "dataUsed", "processing", "exactChange", "executor", "approval", "changeState", "retention"])) return null;
  const whyNow = value.whyNow;
  const processing = value.processing;
  const exactChange = value.exactChange;
  const executor = value.executor;
  const approval = value.approval;
  const retention = value.retention;
  const dataUsed = parseDataUsed(value.dataUsed, true);
  if (!isRecord(whyNow) || !hasOnlyKeys(whyNow, ["code", "summary"])
    || whyNow.code !== "user_started_public_tutorial" || !parseNonemptyString(whyNow.summary)
    || !dataUsed
    || !isRecord(processing) || !hasOnlyKeys(processing, ["location", "route"])
    || processing.location !== "self_hosted_brain_vm" || processing.route !== "strict_ollama"
    || !isRecord(exactChange) || !hasOnlyKeys(exactChange, ["kind", "fields"])
    || exactChange.kind !== "tutorial_receipt" || !isRecord(exactChange.fields)
    || !hasOnlyKeys(exactChange.fields, ["google"]) || !isRecord(exactChange.fields.google)
    || Object.keys(exactChange.fields.google).some((key) => key !== "calendar" && key !== "task")
    || Object.values(exactChange.fields.google).some((status) => !isGoogleResultStatus(status))
    || !isRecord(executor) || !hasOnlyKeys(executor, ["type", "target"])
    || executor.type !== "public_demo_brain" || (executor.target !== "google" && executor.target !== "sqlite")
    || !isRecord(approval) || !hasOnlyKeys(approval, ["status"])
    || (approval.status !== "approved" && approval.status !== "rejected" && approval.status !== "skipped" && approval.status !== "not_required")
    || (value.changeState !== "completed" && value.changeState !== "not_run" && value.changeState !== "uncertain")
    || !isRecord(retention) || !hasOnlyKeys(retention, ["memoryExpiresAt", "googleCleanupAfterMinutes", "googleCleanupDueAt"])
    || !parseUtcTimestamp(retention.memoryExpiresAt) || retention.googleCleanupAfterMinutes !== 30
    || (retention.googleCleanupDueAt !== null && !parseUtcTimestamp(retention.googleCleanupDueAt))) return null;
  const google = { ...exactChange.fields.google } as Partial<Record<TutorialGoogleKind, TutorialGoogleResultStatus>>;
  return {
    whyNow: { code: "user_started_public_tutorial", summary: String(whyNow.summary).trim() },
    dataUsed,
    processing: { location: "self_hosted_brain_vm", route: "strict_ollama" },
    exactChange: { kind: "tutorial_receipt", fields: { google } },
    executor: { type: "public_demo_brain", target: executor.target },
    approval: { status: approval.status },
    changeState: value.changeState,
    retention: {
      memoryExpiresAt: String(retention.memoryExpiresAt),
      googleCleanupAfterMinutes: 30,
      googleCleanupDueAt: retention.googleCleanupDueAt === null ? null : String(retention.googleCleanupDueAt),
    },
  };
}

function parseReceiptGoogleAction(
  value: unknown,
  kind: TutorialGoogleKind,
  forgotten: boolean,
): TutorialReceiptGoogleAction | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestId", "providerId", "status", "sentFields", "createdAt", "cleanupDueAt", "cleanupStatus"])
    || !isTutorialId(value.requestId) || !isGoogleResultStatus(value.status) || !isCleanupStatus(value.cleanupStatus)) return null;
  const providerId = value.providerId === null ? null : parseNonemptyString(value.providerId);
  const sentFields = value.sentFields === null ? null : parseFields(kind, value.sentFields);
  const createdAt = value.createdAt === null ? null : parseUtcTimestamp(value.createdAt);
  const cleanupDueAt = value.cleanupDueAt === null ? null : parseUtcTimestamp(value.cleanupDueAt);
  if (value.status === "succeeded") {
    if (!cleanupDueAt || value.cleanupStatus === "unknown" || value.cleanupStatus === "not_required") return null;
    if ((!forgotten && (!providerId || !sentFields || !createdAt))
      || (forgotten && (value.sentFields !== null || value.createdAt !== null))
      || (forgotten && value.cleanupStatus === "succeeded" && value.providerId !== null)
      || (forgotten && value.cleanupStatus !== "succeeded" && !providerId)) return null;
  } else {
    if (value.providerId !== null || value.sentFields !== null
      || value.createdAt !== null || value.cleanupDueAt !== null) return null;
    if (value.status === "uncertain" ? value.cleanupStatus !== "unknown" : value.cleanupStatus !== "not_required") return null;
  }
  return {
    requestId: value.requestId,
    providerId,
    status: value.status,
    sentFields,
    createdAt,
    cleanupDueAt,
    cleanupStatus: value.cleanupStatus,
  };
}

function parseReceipt(payload: UnknownRecord, flowId: string, operationId: string): TutorialReceipt | null {
  if (!hasOnlyKeys(payload, ["flowId", "operationId", "expiresAt", "explanation", "preferences", "storage", "answerBefore", "answerAfter", "google", "notSentToGoogle"])) return null;
  const expiresAt = parseUtcTimestamp(payload.expiresAt);
  const explanation = parseReceiptExplanation(payload.explanation);
  if (!expiresAt || !explanation || !isRecord(payload.storage)
    || !hasOnlyKeys(payload.storage, ["type", "execution", "scope", "memoryStatus", "forgottenAt"])
    || payload.storage.type !== "sqlite" || payload.storage.execution !== "self_hosted_brain_vm" || payload.storage.scope !== "session"
    || (payload.storage.memoryStatus !== "empty" && payload.storage.memoryStatus !== "saved" && payload.storage.memoryStatus !== "forgotten")
    || !Array.isArray(payload.notSentToGoogle) || payload.notSentToGoogle.length !== 2
    || payload.notSentToGoogle[0] !== "preferences" || payload.notSentToGoogle[1] !== "vm_memory"
    || !isRecord(payload.google) || !hasOnlyKeys(payload.google, ["calendar", "task"])) return null;
  const forgotten = payload.storage.memoryStatus === "forgotten";
  const forgottenAt = payload.storage.forgottenAt === null ? null : parseUtcTimestamp(payload.storage.forgottenAt);
  if ((payload.storage.forgottenAt !== null && !forgottenAt)
    || (forgotten && !forgottenAt)
    || (!forgotten && payload.storage.forgottenAt !== null)) return null;
  const preferences = payload.preferences === null ? null : parsePreferencesPreviewFields(payload.preferences);
  if ((payload.preferences !== null && !preferences)
    || (forgotten && payload.preferences !== null)
    || (!forgotten && payload.storage.memoryStatus === "saved" && !preferences)) return null;
  const answerBefore = payload.answerBefore === null ? null : parseReceiptAnswer(payload.answerBefore);
  const answerAfter = payload.answerAfter === null ? null : parseReceiptAnswer(payload.answerAfter);
  if ((payload.answerBefore !== null && !answerBefore) || (payload.answerAfter !== null && !answerAfter)
    || (forgotten && answerBefore !== null)
    || (answerAfter !== null && answerAfter.sources.length !== 0)) return null;
  const calendar = payload.google.calendar === null ? null : parseReceiptGoogleAction(payload.google.calendar, "calendar", forgotten);
  const task = payload.google.task === null ? null : parseReceiptGoogleAction(payload.google.task, "task", forgotten);
  if ((payload.google.calendar !== null && !calendar) || (payload.google.task !== null && !task)) return null;
  return {
    flowId,
    operationId,
    expiresAt,
    explanation,
    preferences,
    storage: {
      type: "sqlite",
      execution: "self_hosted_brain_vm",
      scope: "session",
      memoryStatus: payload.storage.memoryStatus,
      forgottenAt,
    },
    answerBefore,
    answerAfter,
    google: { calendar, task },
    notSentToGoogle: ["preferences", "vm_memory"],
  };
}

const PHASES = new Set<TutorialPhase>([
  "preferences_pending", "preferences_saved", "calendar_pending", "calendar_executing",
  "calendar_finished", "task_pending", "task_executing", "task_finished",
  "answer_before", "receipt_ready", "forgetting", "forgotten", "answer_after", "completed",
]);

const ERROR_CODES = new Set<TutorialErrorCode>([
  "invalid", "invalid_phase", "expired", "conflict", "unavailable",
  "local_model_unavailable", "external_failed", "external_uncertain", "deprecated", "rate_limited",
]);

/** 공개 tutorial event만 strict schema로 해석하며 알 수 없는 event는 변경 없이 무시한다. */
export function extractTutorialEvent(value: unknown): TutorialBrainEvent | null {
  if (!isRecord(value) || value.type !== "event" || typeof value.event !== "string" || !isRecord(value.payload)) return null;
  const payload = value.payload;
  if (value.event === "tutorial_error") {
    const keys = Object.keys(payload);
    if (!keys.every((key) => ["flowId", "operationId", "code", "message", "retryAfter"].includes(key))
      || ![4, 5].includes(keys.length)
      || (payload.flowId !== "" && !isTutorialId(payload.flowId))
      || (payload.operationId !== "" && !isTutorialId(payload.operationId))
      || typeof payload.code !== "string" || !ERROR_CODES.has(payload.code as TutorialErrorCode)) return null;
    const message = parseNonemptyString(payload.message);
    if (!message || (payload.retryAfter !== undefined
      && (typeof payload.retryAfter !== "number" || !Number.isFinite(payload.retryAfter) || payload.retryAfter < 0))) return null;
    return {
      kind: "error",
      flowId: payload.flowId as string,
      operationId: payload.operationId as string,
      code: payload.code as TutorialErrorCode,
      message,
      ...(payload.retryAfter === undefined ? {} : { retryAfter: payload.retryAfter as number }),
    };
  }
  if (!isTutorialId(payload.flowId) || !isTutorialId(payload.operationId)) return null;
  const flowId = payload.flowId;
  const operationId = payload.operationId;

  if (value.event === "tutorial_state") {
    if (!hasOnlyKeys(payload, ["flowId", "operationId", "phase", "expiresAt", "calendarStatus", "taskStatus", "memoryStatus"])
      || typeof payload.phase !== "string" || !PHASES.has(payload.phase as TutorialPhase)
      || !parseUtcTimestamp(payload.expiresAt)
      || (payload.calendarStatus !== null && !isGoogleStatus(payload.calendarStatus))
      || (payload.taskStatus !== null && !isGoogleStatus(payload.taskStatus))
      || (payload.memoryStatus !== "empty" && payload.memoryStatus !== "pending" && payload.memoryStatus !== "saved" && payload.memoryStatus !== "forgotten")) return null;
    return {
      kind: "state",
      flowId,
      operationId,
      snapshot: {
        phase: payload.phase as TutorialPhase,
        expiresAt: payload.expiresAt as string,
        calendarStatus: payload.calendarStatus as TutorialGoogleStatus | null,
        taskStatus: payload.taskStatus as TutorialGoogleStatus | null,
        memoryStatus: payload.memoryStatus,
      },
    };
  }

  if (value.event === "tutorial_approval_required") {
    if (!hasOnlyKeys(payload, ["flowId", "operationId", "requestId", "purpose", "approvalToken", "expiresAt", "preview"])
      || !isTutorialId(payload.requestId)
      || (payload.purpose !== "preferences" && payload.purpose !== "calendar" && payload.purpose !== "task")) return null;
    const approvalToken = parseNonemptyString(payload.approvalToken);
    const expiresAt = parseUtcTimestamp(payload.expiresAt);
    const preview = parseApprovalPreview(payload.preview, payload.purpose);
    if (!approvalToken || !expiresAt || !preview) return null;
    const approval: TutorialApproval = {
      flowId,
      operationId,
      requestId: payload.requestId,
      purpose: payload.purpose,
      approvalToken,
      expiresAt,
      preview,
    };
    return { kind: "approval-required", flowId, operationId, approval };
  }

  if (value.event === "tutorial_google_result") {
    const result = parseGoogleResult(payload, flowId, operationId);
    return result ? { kind: "google-result", flowId, operationId, result } : null;
  }

  if (value.event === "tutorial_answer_started") {
    if (!hasOnlyKeys(payload, ["flowId", "operationId", "comparison"])
      || (payload.comparison !== "before" && payload.comparison !== "after")) return null;
    return { kind: "answer-started", flowId, operationId, comparison: payload.comparison };
  }

  if (value.event === "tutorial_answer_completed") {
    if (!hasOnlyKeys(payload, ["flowId", "operationId", "comparison", "content", "route", "appliedPreferences", "sources"])
      || (payload.comparison !== "before" && payload.comparison !== "after")) return null;
    const content = parseNonemptyString(payload.content);
    const route = parseRoute(payload.route);
    const sources = parseSources(payload.sources);
    const appliedPreferences = payload.comparison === "before"
      ? parsePreferences(payload.appliedPreferences)
      : isRecord(payload.appliedPreferences) && hasOnlyKeys(payload.appliedPreferences, []) ? {} : null;
    if (!content || !route || !sources || !appliedPreferences
      || (payload.comparison === "after" && sources.length !== 0)) return null;
    return {
      kind: "answer-completed",
      flowId,
      operationId,
      answer: { comparison: payload.comparison, content, route, appliedPreferences, sources },
    };
  }

  if (value.event === "tutorial_receipt") {
    const receipt = parseReceipt(payload, flowId, operationId);
    return receipt ? { kind: "receipt", flowId, operationId, receipt } : null;
  }

  if (value.event === "tutorial_forgotten") {
    if (!hasOnlyKeys(payload, ["flowId", "operationId", "memoryStatus", "forgottenAt", "googleCleanup"])
      || payload.memoryStatus !== "forgotten" || !parseUtcTimestamp(payload.forgottenAt)
      || !isRecord(payload.googleCleanup) || !hasOnlyKeys(payload.googleCleanup, ["calendar", "task"])
      || !isCleanupStatus(payload.googleCleanup.calendar) || !isCleanupStatus(payload.googleCleanup.task)) return null;
    return {
      kind: "forgotten",
      flowId,
      operationId,
      forgotten: {
        memoryStatus: "forgotten",
        forgottenAt: payload.forgottenAt as string,
        googleCleanup: { calendar: payload.googleCleanup.calendar, task: payload.googleCleanup.task },
      },
    };
  }
  return null;
}

export type TutorialOperationKind =
  | "start"
  | "resume"
  | "preferences-prepare"
  | "approve"
  | "reject"
  | "google-prepare"
  | "google-skip"
  | "answer"
  | "receipt"
  | "forget";

export type TutorialOperation = {
  id: string;
  kind: TutorialOperationKind;
  requestId?: string;
  comparison?: TutorialComparison;
};

export function tutorialOperationTimeoutMs(kind: TutorialOperationKind): number {
  return kind === "answer" ? TUTORIAL_ANSWER_TIMEOUT_MS : TUTORIAL_OPERATION_TIMEOUT_MS;
}

export type TutorialUiError = {
  code: TutorialErrorCode | "connection" | "timeout" | "client";
  message: string;
  retryAfter?: number;
};

export type TutorialState = {
  flowId: string | null;
  snapshot: TutorialSnapshot | null;
  operation: TutorialOperation | null;
  busy: boolean;
  needsResume: boolean;
  approval: TutorialApproval | null;
  google: Partial<Record<TutorialGoogleKind, TutorialGoogleResult>>;
  answers: Partial<Record<TutorialComparison, TutorialAnswer>>;
  receipt: TutorialReceipt | null;
  forgotten: TutorialForgotten | null;
  error: TutorialUiError | null;
};

/** 완료/삭제 전환 뒤 서버의 최신 redacted receipt를 한 번 더 조회해야 하는지 판정한다. */
export function tutorialNeedsAutomaticReceipt(
  state: Pick<TutorialState, "snapshot" | "operation" | "receipt" | "error">,
): boolean {
  if (state.error) return false;
  if (state.operation?.kind === "receipt") return false;
  const stableReceiptPhase = state.snapshot?.phase === "forgotten"
    || state.snapshot?.phase === "completed";
  if (stableReceiptPhase && state.operation?.kind === "resume") return true;
  if (state.snapshot?.phase === "forgotten") {
    return state.receipt?.storage.memoryStatus !== "forgotten";
  }
  if (state.snapshot?.phase === "completed") {
    return state.receipt?.storage.memoryStatus !== "forgotten"
      || state.receipt.answerAfter === null;
  }
  return false;
}

export type TutorialReducerAction =
  | { type: "operation-requested"; operation: TutorialOperation }
  | { type: "brain-event"; event: TutorialBrainEvent }
  | { type: "connection-lost" }
  | { type: "operation-timeout"; operationId: string }
  | { type: "local-failed"; message: string }
  | { type: "dismiss-error" };

export function initialTutorialState(flowId: string | null = null): TutorialState {
  return {
    flowId: isTutorialId(flowId) ? flowId : null,
    snapshot: null,
    operation: null,
    busy: false,
    needsResume: isTutorialId(flowId),
    approval: null,
    google: {},
    answers: {},
    receipt: null,
    forgotten: null,
    error: null,
  };
}

function eventMatches(state: TutorialState, event: TutorialBrainEvent): boolean {
  if (!state.operation || event.operationId !== state.operation.id) return false;
  if (state.flowId) return event.flowId === state.flowId;
  return state.operation.kind === "start"
    && (event.kind === "state" || (event.kind === "error" && event.flowId === ""));
}

function approvalMatchesPhase(approval: TutorialApproval, snapshot: TutorialSnapshot | null): boolean {
  if (!snapshot) return false;
  return (approval.purpose === "preferences" && snapshot.phase === "preferences_pending")
    || (approval.purpose === "calendar" && snapshot.phase === "calendar_pending")
    || (approval.purpose === "task" && snapshot.phase === "task_pending");
}

/** 서버가 확인한 event만 적용하고 성공을 Client에서 추정하지 않는다. */
export function reduceTutorial(state: TutorialState, action: TutorialReducerAction): TutorialState {
  if (action.type === "operation-requested") {
    if (!isTutorialId(action.operation.id)) return state;
    return {
      ...state,
      operation: action.operation,
      busy: true,
      needsResume: false,
      approval: null,
      error: null,
    };
  }
  if (action.type === "connection-lost") {
    if (!state.flowId && !state.operation) return state;
    return {
      ...state,
      operation: null,
      busy: false,
      needsResume: Boolean(state.flowId),
      approval: null,
      error: { code: "connection", message: "Brain 연결이 끊겨 결과를 확정하지 않았어요. 연결되면 서버 상태부터 다시 확인합니다." },
    };
  }
  if (action.type === "operation-timeout") {
    if (state.operation?.id !== action.operationId || !state.busy) return state;
    return {
      ...state,
      operation: null,
      busy: false,
      needsResume: Boolean(state.flowId),
      approval: null,
      error: { code: "timeout", message: "응답 시간이 지나 결과를 확정하지 않았어요. 서버 상태를 다시 확인해 주세요." },
    };
  }
  if (action.type === "local-failed") {
    return {
      ...state,
      operation: null,
      busy: false,
      needsResume: Boolean(state.flowId),
      approval: null,
      error: { code: "client", message: action.message },
    };
  }
  if (action.type === "dismiss-error") return { ...state, error: null };

  const event = action.event;
  if (!eventMatches(state, event)) return state;
  if (event.kind === "error") {
    if (state.flowId && event.flowId !== state.flowId) return state;
    if (event.code === "expired") {
      return {
        ...initialTutorialState(),
        error: { code: event.code, message: event.message, ...(event.retryAfter === undefined ? {} : { retryAfter: event.retryAfter }) },
      };
    }
    return {
      ...state,
      operation: null,
      busy: false,
      needsResume: Boolean(state.flowId) && (state.operation?.kind === "resume"
        || (event.code !== "local_model_unavailable" && event.code !== "rate_limited")),
      approval: null,
      error: { code: event.code, message: event.message, ...(event.retryAfter === undefined ? {} : { retryAfter: event.retryAfter }) },
    };
  }
  if (event.kind === "state") {
    const approvalStillApplies = state.approval && approvalMatchesPhase(state.approval, event.snapshot)
      ? state.approval
      : null;
    return {
      ...state,
      flowId: state.flowId ?? event.flowId,
      snapshot: event.snapshot,
      busy: false,
      needsResume: false,
      approval: approvalStillApplies,
      error: null,
    };
  }
  if (event.kind === "approval-required") {
    if ((state.operation?.kind !== "preferences-prepare"
      && state.operation?.kind !== "google-prepare"
      && state.operation?.kind !== "resume")
      || (state.operation.requestId !== undefined && state.operation.requestId !== event.approval.requestId)
      || !approvalMatchesPhase(event.approval, state.snapshot)) return state;
    return {
      ...state,
      operation: state.operation ? { ...state.operation, requestId: event.approval.requestId } : null,
      busy: false,
      needsResume: false,
      approval: event.approval,
      error: null,
    };
  }
  if (event.kind === "google-result") {
    if (!state.operation || (state.operation.kind !== "approve" && state.operation.kind !== "reject" && state.operation.kind !== "google-skip")) return state;
    if (state.operation.requestId && state.operation.requestId !== event.result.requestId) return state;
    return {
      ...state,
      operation: { ...state.operation, requestId: event.result.requestId },
      google: { ...state.google, [event.result.kind]: event.result },
      approval: null,
      error: null,
    };
  }
  if (event.kind === "answer-started") {
    if (state.operation?.kind !== "answer"
      || (state.operation.comparison && state.operation.comparison !== event.comparison)) return state;
    return state;
  }
  if (event.kind === "answer-completed") {
    if (state.operation?.kind !== "answer"
      || (state.operation.comparison && state.operation.comparison !== event.answer.comparison)) return state;
    return {
      ...state,
      answers: { ...state.answers, [event.answer.comparison]: event.answer },
      error: null,
    };
  }
  if (event.kind === "receipt") {
    if (state.operation?.kind !== "receipt" && state.operation?.kind !== "resume") return state;
    return { ...state, receipt: event.receipt, busy: false, needsResume: false, error: null };
  }
  if (event.kind === "forgotten") {
    if (state.operation?.kind !== "forget") return state;
    return { ...state, forgotten: event.forgotten, approval: null, error: null };
  }
  return state;
}

export function readTutorialFlowId(storage: Pick<Storage, "getItem">): string | null {
  try {
    const value = storage.getItem(TUTORIAL_FLOW_STORAGE_KEY);
    return isTutorialId(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeTutorialFlowId(storage: Pick<Storage, "setItem" | "removeItem">, flowId: string | null): void {
  try {
    if (isTutorialId(flowId)) storage.setItem(TUTORIAL_FLOW_STORAGE_KEY, flowId);
    else storage.removeItem(TUTORIAL_FLOW_STORAGE_KEY);
  } catch {
    // 저장소가 차단돼도 현재 탭 메모리의 flow는 계속 사용할 수 있다.
  }
}
