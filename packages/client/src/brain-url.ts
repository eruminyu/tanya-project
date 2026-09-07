export type BrainUrlProblem = "empty" | "malformed" | "unsupported-protocol";

export type BrainUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: BrainUrlProblem };

export interface BrainInfoSummary {
  status: string;
  model: string;
  provider: string;
  enabled: string[];
  disabled: string[];
}

export type BrainDiagnosis =
  | { kind: "ok"; summary: BrainInfoSummary }
  | { kind: "http-error"; status: number }
  | { kind: "network-error"; message: string }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "invalid-url"; reason: BrainUrlProblem };

export interface DiagnosisDeps {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * 다른 설정이 하나도 없을 때 사용하는 마지막 기본값.
 * 어느 PC에서 실행해도 동작하도록 로컬 Brain을 가리킨다.
 * 원격 Brain(집 VM 등)은 설정 화면에서 주소를 바꾸거나 빌드 시 `VITE_BRAIN_URL`로 주입한다.
 */
export const FALLBACK_BRAIN_URL = "http://localhost:8098";

export const DIAGNOSIS_TIMEOUT_MS = 5_000;

const FEATURE_LABELS: Record<string, string> = {
  persona: "페르소나",
  memory: "기억",
  emotion: "감정",
  action_router: "액션",
  security: "보안",
  finetune_scoring: "파인튜닝 점수",
  auto_finetune: "자동 파인튜닝",
  proactive: "선제 제안",
  stt: "음성 인식",
};

function canonicalize(parsed: URL): string {
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function validateBrainUrl(raw: string): BrainUrlValidation {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported-protocol" };
  }
  if (!parsed.hostname) return { ok: false, reason: "malformed" };

  return { ok: true, url: canonicalize(parsed) };
}

/**
 * 빌드 시 주입된 VITE_BRAIN_URL을 우선하고, 없거나 잘못됐으면 내장 기본값을 쓴다.
 * Brain 주소 기본값 정의는 이 함수 하나뿐이다.
 */
export function defaultBrainUrl(): string {
  const configured = import.meta.env.VITE_BRAIN_URL;
  const validated = validateBrainUrl(typeof configured === "string" ? configured : "");
  return validated.ok ? validated.url : FALLBACK_BRAIN_URL;
}

/** 잘못된 주소가 앱을 사용 불능으로 만들지 않도록 기본값으로 되돌린다. */
export function resolveBrainUrl(raw: string): string {
  const validated = validateBrainUrl(raw);
  return validated.ok ? validated.url : defaultBrainUrl();
}

/** 웹 클라이언트 루트와 분리된 Brain 상태 응답을 읽는다. */
export function toDiagnosisUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/status`;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

export function summarizeBrainInfo(payload: unknown): BrainInfoSummary {
  const empty: BrainInfoSummary = { status: "", model: "", provider: "", enabled: [], disabled: [] };
  if (!payload || typeof payload !== "object") return empty;

  const source = payload as Record<string, unknown>;
  const features = source.features;
  const enabled: string[] = [];
  const disabled: string[] = [];

  if (features && typeof features === "object") {
    for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
      if (typeof value !== "boolean") continue;
      (value ? enabled : disabled).push(FEATURE_LABELS[key] ?? key);
    }
  }

  return {
    status: stringField(source, "status"),
    model: stringField(source, "model"),
    provider: stringField(source, "llm_provider"),
    enabled,
    disabled,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function runBrainDiagnosis(rawUrl: string, deps: DiagnosisDeps = {}): Promise<BrainDiagnosis> {
  const validated = validateBrainUrl(rawUrl);
  if (!validated.ok) return { kind: "invalid-url", reason: validated.reason };

  const fetchImpl = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DIAGNOSIS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(toDiagnosisUrl(validated.url), { signal: controller.signal });
    if (!response.ok) return { kind: "http-error", status: response.status };
    const payload = await response.json().catch(() => null);
    return { kind: "ok", summary: summarizeBrainInfo(payload) };
  } catch (error: unknown) {
    if (isAbortError(error)) return { kind: "timeout", timeoutMs };
    return { kind: "network-error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function describeDiagnosis(result: BrainDiagnosis): string {
  switch (result.kind) {
    case "ok": {
      const { model, provider } = result.summary;
      if (!model) return "연결됨";
      return provider ? `연결됨 · ${model} (${provider})` : `연결됨 · ${model}`;
    }
    case "http-error":
      return `응답은 왔지만 Brain이 아닙니다 (HTTP ${result.status})`;
    case "network-error":
      return "연결하지 못했습니다. 주소와 포트, 서버 상태를 확인해 주세요.";
    case "timeout":
      return `${Math.round(result.timeoutMs / 1_000)}초 안에 응답이 없습니다. 방화벽이나 서버 상태를 확인해 주세요.`;
    case "invalid-url":
      return describeUrlProblem(result.reason);
  }
}

export function describeUrlProblem(reason: BrainUrlProblem): string {
  switch (reason) {
    case "empty":
      return "Brain 주소를 입력해 주세요.";
    case "malformed":
      return `주소 형식이 올바르지 않습니다. 예: ${FALLBACK_BRAIN_URL}`;
    case "unsupported-protocol":
      return "http:// 또는 https:// 로 시작해야 합니다.";
  }
}
