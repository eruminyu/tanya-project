import type { TutorialApprovalPurpose, TutorialComparison, TutorialGoogleKind, TutorialPhase, TutorialPreferenceDraftAction, TutorialState } from "./tutorial";

/**
 * 입력이 막힌 실제 이유.
 *
 * 하나의 문구로 뭉뚱그리면 사용자는 원인을 구분할 수 없다. 실제로 재연결 대기와
 * resume 확인을 모두 "연결 문제"로 읽게 되어, 기다리면 풀리는 상황에서도
 * 새로고침이나 재시작을 시도하게 된다.
 */
export type TutorialBlockReason =
  | "disconnected"
  | "insecure-session"
  | "busy"
  | "resuming"
  | "approval-expired"
  | "session-expired";

/** 연결과 세션 보안은 원인이 다르므로 분리해서 받는다. */
export type TutorialAvailability = {
  connected: boolean;
  sessionSecure: boolean;
};

const BLOCK_MESSAGES: Record<TutorialBlockReason, string> = {
  disconnected: "연결이 끊겨 다시 연결하는 중이에요. 연결되면 바로 이어서 보낼 수 있어요.",
  "insecure-session": "이 브라우저에서는 안전한 탭 세션을 만들 수 없어 체험을 진행할 수 없어요.",
  busy: "직전 요청을 처리하는 중이에요. 끝나면 다시 입력해 주세요.",
  resuming: "서버에서 지금 단계를 다시 확인하는 중이에요. 잠시 뒤 다시 입력해 주세요.",
  "approval-expired": "승인 시간이 지났어요. 미리보기를 다시 받은 뒤 승인해 주세요. 실행하지 않았어요.",
  "session-expired": "체험 세션이 만료됐어요. 처음부터 다시 시작해 주세요.",
};

export function tutorialBlockMessage(reason: TutorialBlockReason): string {
  return BLOCK_MESSAGES[reason];
}

/** parser에는 승인 비밀값이나 미리보기 본문을 넘기지 않는다. */
export type TutorialUtteranceContext = {
  blocked: TutorialBlockReason | null;
  phase: TutorialPhase | null;
  approvalPurpose: TutorialApprovalPurpose | null;
  receiptReady: boolean;
};

export type TutorialUtteranceResult =
  | { kind: "action"; intent: "start" | "preferences-default" | "preferences-prepare" | "approve" | "reject" | "receipt" | "forget" }
  | { kind: "action"; intent: "google-prepare" | "google-skip"; googleKind: TutorialGoogleKind }
  | { kind: "action"; intent: "answer"; comparison: TutorialComparison }
  | { kind: "selection"; change: TutorialPreferenceDraftAction; message: string }
  | { kind: "clarify" | "unmatched"; message: string };

export function tutorialInputKey(state: TutorialState, connectionEpoch: number): string {
  return JSON.stringify([connectionEpoch, state.flowId, state.snapshot?.phase, state.needsResume,
    state.operation?.id, state.approval?.operationId, state.approval?.requestId, state.receipt?.operationId]);
}

export function tutorialUtteranceContext(state: TutorialState, availability: TutorialAvailability, now = Date.now()): TutorialUtteranceContext {
  const phase = state.snapshot?.phase ?? null;
  const approval = state.approval;
  const validApproval = !approval || (approval.flowId === state.flowId
    && approval.operationId === state.operation?.id
    && approval.requestId === state.operation?.requestId
    && phase === `${approval.purpose}_pending`
    && approval.preview.kind === (approval.purpose === "preferences" ? "tutorial_preferences_store" : approval.purpose)
    && Date.parse(approval.expiresAt) > now);
  const sessionAlive = !state.flowId
    || Boolean(state.snapshot && Date.parse(state.snapshot.expiresAt) > now);
  // 판정 순서는 기존 available 조건과 같다. 근본 원인부터 먼저 알린다.
  const blocked: TutorialBlockReason | null = !availability.sessionSecure ? "insecure-session"
    : !availability.connected ? "disconnected"
      : state.busy ? "busy"
        : state.needsResume ? "resuming"
          : !validApproval ? "approval-expired"
            : !sessionAlive ? "session-expired"
              : null;
  return {
    blocked,
    phase,
    approvalPurpose: approval?.purpose ?? null,
    receiptReady: Boolean(state.receipt && state.receipt.flowId === state.flowId
      && (phase !== "forgotten" || state.receipt.storage.memoryStatus === "forgotten")),
  };
}

const APPROVE: Record<TutorialApprovalPurpose, readonly string[]> = {
  preferences: ["이대로저장해줘", "이설정으로저장해줘"],
  calendar: ["이일정으로등록해줘", "이일정등록해줘"],
  task: ["이대로만들어줘", "이할일로등록해줘"],
};
const REJECT = ["거절할게", "취소할게", "등록하지마", "저장안할래", "저장하지마", "만들지마"];
const SELECTIONS: Record<string, TutorialPreferenceDraftAction> = {
  "답변은한번에완결": { type: "select", key: "interaction", value: "complete" },
  "답변은대화하며조정": { type: "select", key: "interaction", value: "interactive" },
  "답변은중립": { type: "select", key: "interaction", value: "neutral" },
  "정보는구체적으로": { type: "select", key: "information", value: "concrete" },
  "정보는큰그림부터": { type: "select", key: "information", value: "big_picture" },
  "정보는중립": { type: "select", key: "information", value: "neutral" },
  "선택은확인된근거": { type: "select", key: "decision", value: "evidence" },
  "선택은현재상황": { type: "select", key: "decision", value: "context" },
  "선택은중립": { type: "select", key: "decision", value: "neutral" },
  "계획은단계대로": { type: "select", key: "planning", value: "structured" },
  "계획은유연하게": { type: "select", key: "planning", value: "flexible" },
  "계획은중립": { type: "select", key: "planning", value: "neutral" },
  "알림은5분전": { type: "minutes", value: 5 },
  "알림은10분전": { type: "minutes", value: 10 },
  "알림은20분전": { type: "minutes", value: 20 },
};

/**
 * 단위(분·시) 바로 앞의 한국어 수사만 숫자로 바꾼다.
 *
 * `이`, `일`, `삼` 같은 한자 수사는 단독으로 쓰면 지시어·명사와 구분되지 않는다.
 * 실제로 `이 일정으로 등록해줘`의 `이`를 2로 바꾸면 승인 문장이 깨진다.
 * 그래서 **반드시 단위 문자가 뒤따르는 경우에만** 치환한다.
 */
const NUMBER_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["삼십", "30"], ["이십", "20"], ["스물", "20"], ["열", "10"], ["아홉", "9"], ["여덟", "8"],
  ["일곱", "7"], ["여섯", "6"], ["다섯", "5"], ["네", "4"], ["넷", "4"], ["세", "3"], ["셋", "3"],
  ["두", "2"], ["둘", "2"], ["한", "1"], ["하나", "1"],
];

/** 파서와 제안 계층이 같은 정규화를 쓰도록 한 곳에 모은다. */
export function normalizeUtterance(raw: string): string {
  // 공백을 먼저 지운 뒤 수사를 치환한다. `열 분 전`처럼 수사와 단위가 떨어져 있어도
  // 같은 결과가 나와야 한다.
  const compact = raw.normalize("NFC").trim().replace(/[.!。！]+$/u, "").replace(/[ 	]+/g, "");
  return normalizeNumberWords(compact);
}

export function normalizeNumberWords(text: string): string {
  let result = text;
  for (const [word, digit] of NUMBER_WORDS) {
    result = result.replace(new RegExp(`${word}(?=[분시])`, "gu"), digit);
  }
  return result;
}

/** 제안 계층이 같은 목록을 쓰도록 노출한다. */
export const SELECTION_PHRASES: readonly string[] = Object.keys(SELECTIONS);

export function tutorialUtteranceExamples(context: TutorialUtteranceContext): string {
  if (context.approvalPurpose) return context.approvalPurpose === "preferences"
    ? "이대로 저장해줘 / 거절할게" : context.approvalPurpose === "calendar"
      ? "이 일정으로 등록해줘 / 등록하지 마" : "이대로 만들어줘 / 취소할게";
  switch (context.phase) {
    case null: return "체험 시작할게";
    case "preferences_pending": return "기본으로 / 정보는 구체적으로 / 알림은 10분 전 / 설정 미리보기";
    case "calendar_pending": return "캘린더 해볼게 / 건너뛸게";
    case "task_pending": return "할 일도 만들어줘 / 건너뛸게";
    case "answer_before": return "답변 보여줘";
    case "receipt_ready": return context.receiptReady ? "지금 잊어줘 / 실행 결과 보여줘" : "실행 결과 보여줘";
    case "forgotten": return context.receiptReady ? "답변 보여줘" : "실행 결과 보여줘";
    case "completed": return "실행 결과 보여줘";
    default: return "서버의 단계 확인을 기다려 주세요.";
  }
}

/** 전체 문장 allowlist만 사용한다. 부분 keyword 일치는 실행으로 승격하지 않는다. */
export function parseTutorialUtterance(context: TutorialUtteranceContext, raw: string): TutorialUtteranceResult {
  // 왜 안 되는지 말하지 않으면 사용자가 스스로 규칙을 추측해야 한다.
  // 실제로 "정확히 체험 시작이라는 말이 들어가야 하는 거였구나"를 사용자가 알아냈다.
  const clarify = (heard: string): TutorialUtteranceResult => ({
    kind: "clarify",
    message: `«${heard}»로 들었어요. 이 체험은 안전을 위해 **정해진 문장**만 실행해요.`
      + ` 아래 예시를 눌러 넣거나 그대로 말해 주세요.`,
  });
  if (context.blocked) return { kind: "clarify", message: tutorialBlockMessage(context.blocked) };
  // 질문·인용·복합 문장을 지워서 승인문으로 바꾸지 않는다.
  const text = normalizeUtterance(raw);
  if (REJECT.includes(text)) return context.approvalPurpose && context.phase === `${context.approvalPurpose}_pending`
    ? { kind: "action", intent: "reject" } : clarify(raw.trim());
  if (context.approvalPurpose) {
    if (context.phase === `${context.approvalPurpose}_pending` && APPROVE[context.approvalPurpose].includes(text)) return { kind: "action", intent: "approve" };
    return clarify(raw.trim());
  }
  if (!context.phase && ["체험시작할게", "체험시작", "시작할게"].includes(text)) return { kind: "action", intent: "start" };
  if (context.phase === "preferences_pending") {
    if (Object.hasOwn(SELECTIONS, text)) return { kind: "selection", change: SELECTIONS[text], message: "선택만 바꿨어요. 설정 미리보기로 전체 내용을 확인한 뒤 별도로 저장을 승인해 주세요." };
    if (["기본으로", "기본값으로"].includes(text)) return { kind: "action", intent: "preferences-default" };
    if (["설정미리보기", "저장전미리보기"].includes(text)) return { kind: "action", intent: "preferences-prepare" };
  }
  const googleKind = context.phase === "calendar_pending" ? "calendar" : context.phase === "task_pending" ? "task" : null;
  if (googleKind) {
    if (["건너뛸게", "건너뛰기", "만들지않고계속"].includes(text)) return { kind: "action", intent: "google-skip", googleKind };
    if ((googleKind === "calendar" ? ["캘린더해볼게", "일정미리보기"] : ["할일도만들어줘", "할일미리보기"]).includes(text)) return { kind: "action", intent: "google-prepare", googleKind };
  }
  if (["답변보여줘", "답변생성해줘"].includes(text)) {
    if (context.phase === "answer_before") return { kind: "action", intent: "answer", comparison: "before" };
    if (context.phase === "forgotten" && context.receiptReady) return { kind: "action", intent: "answer", comparison: "after" };
    return clarify(raw.trim());
  }
  if (["실행결과보여줘", "영수증보여줘"].includes(text) && ["receipt_ready", "forgotten", "completed"].includes(context.phase ?? "")) return { kind: "action", intent: "receipt" };
  if (["지금잊어줘", "지금잊기"].includes(text) && context.phase === "receipt_ready" && context.receiptReady) return { kind: "action", intent: "forget" };
  if (/저장|등록|승인|거절|취소|만들|잊|미리보기|건너|시작|답변|결과|영수증|기본|알림|정보|계획|선택|좋아|아마|괜찮/.test(text)) return clarify(raw.trim());
  return {
    kind: "unmatched",
    message: `«${raw.trim()}»는 이 체험에서 지원하지 않는 요청이라 서버로 보내지 않았어요.`
      + ` 안전을 위해 정해진 문장만 실행해요. 아래 예시를 눌러 넣거나 그대로 말해 주세요.`,
  };
}
