export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

// 공개 체험은 사람이 화면 앞에 있는 상황이다. 30초 상한은 휴대폰이 화면 잠금에서
// 돌아왔을 때 그대로 대기 시간이 되므로, 즉시 재연결 경로와 함께 상한을 낮춘다.
const MAX_RECONNECT_DELAY_MS = 8_000;

export type BrainEvent = {
  type?: string;
  event?: string;
  content?: string;
  emotion?: string;
  payload?: {
    text?: string;
    content?: string;
    emotion?: string;
    type?: string;
    intensity?: number;
    message?: string;
    chunk_index?: number;
    data?: string;
    is_last?: boolean;
    skill?: string;
    reason?: string;
    approval_token?: string;
    sources?: unknown;
    kind?: string;
    title?: string;
    startAt?: string;
    endAt?: string;
    due?: string | null;
    requestId?: string;
    providerId?: string;
    approvalToken?: string;
    executor?: string;
    duplicate?: boolean;
    mode?: string;
    provider?: string;
    execution?: string;
    fallback?: boolean;
    operationId?: string;
    preparationMinutes?: number | null;
    capsule?: unknown;
    source?: unknown;
    sessionScoped?: boolean;
    syncedAt?: string | null;
    expiresAt?: string | null;
    relevance?: number | null;
    code?: string;
  };
};

export type LlmRoute = {
  mode: "casual" | "task";
  provider: string;
  execution: "local" | "cloud" | "custom";
  fallback: boolean;
};

export function extractLlmRoute(event: BrainEvent): LlmRoute | null {
  if (event.type !== "event" || event.event !== "llm_route") return null;
  const payload = event.payload;
  if ((payload?.mode !== "casual" && payload?.mode !== "task")
    || (payload.execution !== "local" && payload.execution !== "cloud" && payload.execution !== "custom")
    || typeof payload.provider !== "string" || !payload.provider.trim()
    || typeof payload.fallback !== "boolean") return null;
  return {
    mode: payload.mode,
    provider: payload.provider.trim().toLowerCase(),
    execution: payload.execution,
    fallback: payload.fallback,
  };
}

type GoogleWebApproval = {
  requestId: string;
  approvalToken: string;
  executor: "brain";
};

export type GoogleDraftEvent =
  | ({ kind: "calendar"; title: string; startAt: string; endAt: string } & Partial<GoogleWebApproval>)
  | ({ kind: "task"; title: string; due: string | null } & Partial<GoogleWebApproval>);

export function extractProactiveSuggestion(event: BrainEvent): string | null {
  if (event.type !== "event" || event.event !== "proactive_suggestion") return null;
  const text = event.payload?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

export function extractGoogleDraftEvent(event: BrainEvent): GoogleDraftEvent | null {
  if (event.type !== "event" || event.event !== "google_write_draft" || typeof event.payload?.title !== "string" || !event.payload.title.trim()) return null;
  const approval = event.payload.executor === "brain"
    && typeof event.payload.requestId === "string" && event.payload.requestId
    && typeof event.payload.approvalToken === "string" && event.payload.approvalToken
    ? {
        requestId: event.payload.requestId,
        approvalToken: event.payload.approvalToken,
        executor: "brain" as const,
      }
    : {};
  if (event.payload.kind === "calendar" && typeof event.payload.startAt === "string" && typeof event.payload.endAt === "string") {
    const start = new Date(event.payload.startAt); const end = new Date(event.payload.endAt);
    if (!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf()) && end > start) return { kind: "calendar", title: event.payload.title.trim(), startAt: event.payload.startAt, endAt: event.payload.endAt, ...approval };
  }
  if (event.payload.kind === "task" && (event.payload.due === null || event.payload.due === undefined || typeof event.payload.due === "string")) {
    return { kind: "task", title: event.payload.title.trim(), due: event.payload.due ?? null, ...approval };
  }
  return null;
}

export type GoogleWriteExecutionEvent =
  | { kind: "completed"; receipt: { requestId: string; providerId: string; title: string; duplicate: boolean } }
  | { kind: "cancelled"; requestId: string }
  | { kind: "failed"; message: string };

export function extractGoogleWriteExecutionEvent(event: BrainEvent): GoogleWriteExecutionEvent | null {
  if (event.type !== "event") return null;
  const payload = event.payload;
  if (event.event === "google_write_result"
    && typeof payload?.requestId === "string"
    && typeof payload.providerId === "string"
    && typeof payload.title === "string"
    && typeof payload.duplicate === "boolean") {
    return {
      kind: "completed",
      receipt: {
        requestId: payload.requestId,
        providerId: payload.providerId,
        title: payload.title,
        duplicate: payload.duplicate,
      },
    };
  }
  if (event.event === "google_write_cancelled" && typeof payload?.requestId === "string") {
    return { kind: "cancelled", requestId: payload.requestId };
  }
  if (event.event === "google_write_error" && typeof payload?.message === "string") {
    return { kind: "failed", message: payload.message };
  }
  return null;
}

export type MemoryCapsuleMinutes = 10 | 20 | 30;

export type MemoryCapsule = {
  preparationMinutes: MemoryCapsuleMinutes;
  content: string;
};

export type MemoryCapsuleSource = {
  type: "explicit_choice";
  label: "준비 시간 선택";
  sessionScoped: true;
  createdAt: string;
};

export type MemoryCapsuleDraft = {
  approvalToken: string;
  capsule: MemoryCapsule;
  source: MemoryCapsuleSource;
  sessionScoped: true;
  expiresAt: string;
};

export type MemoryCapsuleRecord = {
  capsule: MemoryCapsule;
  source: MemoryCapsuleSource;
  syncedAt: string;
  expiresAt: string;
};

export type RecalledMemoryCapsule = {
  capsule: MemoryCapsule;
  source: MemoryCapsuleSource;
  syncedAt: string;
  expiresAt: string;
  relevance: number | null;
};

export type MemoryCapsuleBrainEvent =
  | { kind: "approval-required"; operationId: string; draft: MemoryCapsuleDraft }
  | { kind: "saved"; operationId: string; record: MemoryCapsuleRecord }
  | { kind: "recalled"; operationId: string; record: RecalledMemoryCapsule | null }
  | { kind: "forgotten"; operationId: string }
  | { kind: "rejected"; operationId: string }
  | { kind: "failed"; operationId: string; code: MemoryCapsuleErrorCode; message: string };

export type MemoryCapsuleErrorCode = "unavailable" | "invalid" | "expired" | "storage_error";

function isMemoryCapsuleMinutes(value: unknown): value is MemoryCapsuleMinutes {
  return value === 10 || value === 20 || value === 30;
}

function expectedMemoryCapsuleContent(minutes: MemoryCapsuleMinutes): string {
  return `사용자는 일정 전에 ${minutes}분의 준비 시간을 선호합니다.`;
}

function parseMemoryCapsule(value: unknown): MemoryCapsule | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { preparationMinutes?: unknown; content?: unknown };
  if (!isMemoryCapsuleMinutes(candidate.preparationMinutes)
    || typeof candidate.content !== "string"
    || candidate.content.trim() !== expectedMemoryCapsuleContent(candidate.preparationMinutes)) return null;
  return { preparationMinutes: candidate.preparationMinutes, content: candidate.content.trim() };
}

function parseMemoryCapsuleSource(value: unknown): MemoryCapsuleSource | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    type?: unknown;
    label?: unknown;
    sessionScoped?: unknown;
    createdAt?: unknown;
  };
  const createdAt = parseTimestamp(candidate.createdAt);
  if (candidate.type !== "explicit_choice"
    || candidate.label !== "준비 시간 선택"
    || candidate.sessionScoped !== true
    || !createdAt) return null;
  return {
    type: "explicit_choice",
    label: "준비 시간 선택",
    sessionScoped: true,
    createdAt,
  };
}

const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (year < 1
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second) return null;
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseOperationId(value: unknown): string | null {
  return typeof value === "string" && UUID_V4_PATTERN.test(value) ? value : null;
}

function hasOnlyKeys(payload: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * 공개 웹의 기억 캡슐 전용 이벤트만 엄격히 해석한다. 서버는 CouchDB와
 * 검색 인덱스 동기화를 모두 확인한 뒤에만 saved 이벤트를 보낸다.
 */
export function extractMemoryCapsuleEvent(
  event: BrainEvent,
  now: number = Date.now(),
): MemoryCapsuleBrainEvent | null {
  if (event.type !== "event") return null;
  const payloadValue: unknown = event.payload;
  if (!isPlainObject(payloadValue)) return null;
  const payload = payloadValue as NonNullable<BrainEvent["payload"]>;
  const operationId = parseOperationId(payload.operationId);
  if (!operationId) return null;

  if (event.event === "memory_capsule_approval_required") {
    const preparationMinutes = payload.preparationMinutes;
    const content = payload.content;
    const source = parseMemoryCapsuleSource(payload.source);
    const expiresAt = parseTimestamp(payload.expiresAt);
    if (!isMemoryCapsuleMinutes(preparationMinutes)
      || typeof content !== "string"
      || content.trim() !== expectedMemoryCapsuleContent(preparationMinutes)
      || !source || !expiresAt || new Date(expiresAt).valueOf() <= now
      || new Date(source.createdAt).valueOf() > new Date(expiresAt).valueOf()
      || payload.sessionScoped !== true
      || typeof payload.approvalToken !== "string" || !payload.approvalToken.trim()
    ) return null;
    return {
      kind: "approval-required",
      operationId,
      draft: {
        approvalToken: payload.approvalToken.trim(),
        capsule: { preparationMinutes, content: content.trim() },
        source,
        sessionScoped: true,
        expiresAt,
      },
    };
  }

  if (event.event === "memory_capsule_saved") {
    const capsule = parseMemoryCapsule(payload.capsule);
    const source = parseMemoryCapsuleSource(payload.source);
    const syncedAt = parseTimestamp(payload.syncedAt);
    const expiresAt = parseTimestamp(payload.expiresAt);
    if (!capsule || !source || !syncedAt || !expiresAt
      || new Date(expiresAt).valueOf() <= now
      || new Date(source.createdAt).valueOf() > new Date(syncedAt).valueOf()
      || new Date(syncedAt).valueOf() > new Date(expiresAt).valueOf()) return null;
    return {
      kind: "saved",
      operationId,
      record: {
        capsule,
        source,
        syncedAt,
        expiresAt,
      },
    };
  }

  if (event.event === "memory_capsule_recalled") {
    if (payload.capsule === null
      && payload.source === null
      && payload.relevance === null
      && payload.syncedAt === null
      && payload.expiresAt === null) return { kind: "recalled", operationId, record: null };
    const capsule = parseMemoryCapsule(payload.capsule);
    const source = parseMemoryCapsuleSource(payload.source);
    const syncedAt = parseTimestamp(payload.syncedAt);
    const expiresAt = parseTimestamp(payload.expiresAt);
    const relevance = payload.relevance;
    if (!capsule || !source || !syncedAt || !expiresAt
      || new Date(expiresAt).valueOf() <= now
      || new Date(source.createdAt).valueOf() > new Date(syncedAt).valueOf()
      || new Date(syncedAt).valueOf() > new Date(expiresAt).valueOf()
      || (relevance !== null && (typeof relevance !== "number"
        || !Number.isFinite(relevance) || relevance < 0 || relevance > 1))) return null;
    return {
      kind: "recalled",
      operationId,
      record: {
        capsule,
        source,
        syncedAt,
        expiresAt,
        relevance,
      },
    };
  }

  if (event.event === "memory_capsule_forgotten") {
    return hasOnlyKeys(payload, ["operationId"]) ? { kind: "forgotten", operationId } : null;
  }

  if (event.event === "memory_capsule_rejected") {
    return hasOnlyKeys(payload, ["operationId"]) ? { kind: "rejected", operationId } : null;
  }
  if (event.event === "memory_capsule_error"
    && (payload.code === "unavailable" || payload.code === "invalid"
      || payload.code === "expired" || payload.code === "storage_error")
    && typeof payload.message === "string" && payload.message.trim()) {
    return { kind: "failed", operationId, code: payload.code, message: payload.message.trim() };
  }
  return null;
}

export type AgentBrainEvent =
  | { kind: "approval-required"; skill: string; reason: string; approvalToken: string }
  | { kind: "skill-result"; skill: string; summary: string; sources: string[] }
  | { kind: "failed"; skill: string; message: string };

export function extractAgentEvent(event: BrainEvent): AgentBrainEvent | null {
  if (event.type !== "event") return null;
  const payload = event.payload;
  if (event.event === "approval_required" && typeof payload?.skill === "string" && typeof payload.approval_token === "string") {
    return { kind: "approval-required", skill: payload.skill, reason: typeof payload.reason === "string" ? payload.reason : "사용자 승인이 필요합니다.", approvalToken: payload.approval_token };
  }
  if (event.event === "skill_result" && payload) {
    const sources = Array.isArray(payload.sources) ? payload.sources.filter((value): value is string => typeof value === "string") : [];
    return { kind: "skill-result", skill: typeof payload.skill === "string" ? payload.skill : "agent_task", summary: typeof payload.message === "string" ? payload.message : "작업을 완료했습니다.", sources };
  }
  if (event.event === "error" && typeof payload?.message === "string") return { kind: "failed", skill: "agent_task", message: payload.message };
  return null;
}

export type TtsChunk = {
  chunkIndex: number;
  data: string;
  isLast: boolean;
};

export function normalizeBrainUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function reconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(1_000 * 2 ** safeAttempt, MAX_RECONNECT_DELAY_MS);
}

export function connectionStatusText(state: ConnectionState, retryDelayMs?: number): string {
  switch (state) {
    case "connecting":
      return "Brain에 연결 중";
    case "connected":
      return "Brain 연결됨";
    case "reconnecting":
      return `${Math.ceil((retryDelayMs ?? 0) / 1_000)}초 후 다시 연결`;
    case "disconnected":
      return "Brain 연결 끊김";
  }
}

export function toWebSocketUrl(
  baseUrl: string,
  includeAudio = false,
  includeProactive = true,
  sessionId?: string,
): string {
  const url = new URL(normalizeBrainUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/webchat";
  const params = new URLSearchParams();
  if (includeAudio) params.set("audio", "1");
  if (includeAudio || !includeProactive) {
    params.set("proactive", includeProactive ? "1" : "0");
  }
  if (sessionId) params.set("session_id", sessionId);
  url.search = params.toString();
  url.hash = "";
  return url.toString();
}

export type TtsSentence = {
  chunkIndex: number;
  text: string;
};

/** 합성 중인 문장의 원문 — 발화 자막을 재생 위치와 맞추는 데 쓴다 (T-010). */
export function extractTtsSentence(event: BrainEvent): TtsSentence | null {
  if (event.type !== "event" || event.event !== "tts_sentence") return null;
  const chunkIndex = event.payload?.chunk_index;
  const text = event.payload?.text;
  if (typeof chunkIndex !== "number" || typeof text !== "string" || !text.trim()) {
    return null;
  }
  return { chunkIndex, text: text.trim() };
}

export function extractTtsChunk(event: BrainEvent): TtsChunk | null {
  if (event.type !== "event" || event.event !== "tts_chunk") return null;
  const chunkIndex = event.payload?.chunk_index;
  const data = event.payload?.data;
  const isLast = event.payload?.is_last;
  if (typeof chunkIndex !== "number" || typeof data !== "string" || typeof isLast !== "boolean") {
    return null;
  }
  return { chunkIndex, data, isLast };
}

export function extractText(event: BrainEvent): string | null {
  if (event.type === "event" && event.event === "text_stream") {
    return event.payload?.text ?? "";
  }
  if (event.type === "response") return event.content ?? "";
  if (event.type === "res" && event.payload?.content) return event.payload.content;
  return null;
}

export function extractEmotion(event: BrainEvent): string | null {
  if (event.type === "event" && event.event === "emotion_update") {
    return event.payload?.emotion ?? event.payload?.type ?? "neutral";
  }
  if (event.type === "response") return event.emotion ?? null;
  return null;
}
