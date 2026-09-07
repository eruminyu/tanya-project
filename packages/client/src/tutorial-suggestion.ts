import type { TutorialApprovalPurpose } from "./tutorial";
import { SELECTION_PHRASES, type TutorialUtteranceContext } from "./tutorial-utterance";

/**
 * 현재 단계에서 실행으로 이어질 수 있는 문장 후보.
 *
 * `display`는 사용자에게 그대로 보여줄 문장이고, 매칭에는 공백을 지운 형태를 쓴다.
 * 두 형태가 어긋나면 제안을 수락해도 실행되지 않으므로 테스트로 일관성을 고정한다.
 */
export type TutorialPhraseCandidate = {
  display: string;
  role: "approve" | "reject" | "other";
};

const APPROVE_DISPLAY: Record<TutorialApprovalPurpose, readonly string[]> = {
  preferences: ["이대로 저장해줘", "이 설정으로 저장해줘"],
  calendar: ["이 일정으로 등록해줘", "이 일정 등록해줘"],
  task: ["이대로 만들어줘", "이 할일로 등록해줘"],
};

const REJECT_DISPLAY = [
  "거절할게", "취소할게", "등록하지 마", "저장 안 할래", "저장하지 마", "만들지 마",
];

export function strippedPhrase(display: string): string {
  return display.replace(/[ \t]+/g, "");
}

export function tutorialPhraseCandidates(
  context: TutorialUtteranceContext,
): TutorialPhraseCandidate[] {
  const other = (phrases: readonly string[]): TutorialPhraseCandidate[] =>
    phrases.map((display) => ({ display, role: "other" as const }));

  if (context.approvalPurpose) {
    if (context.phase !== `${context.approvalPurpose}_pending`) return [];
    return [
      ...APPROVE_DISPLAY[context.approvalPurpose]
        .map((display) => ({ display, role: "approve" as const })),
      ...REJECT_DISPLAY.map((display) => ({ display, role: "reject" as const })),
    ];
  }
  if (!context.phase) return other(["체험 시작할게", "체험 시작", "시작할게"]);
  switch (context.phase) {
    case "preferences_pending":
      return other([
        ...SELECTION_PHRASES,
        "기본으로", "기본값으로", "설정 미리보기", "저장 전 미리보기",
      ]);
    case "calendar_pending":
      return other(["캘린더 해볼게", "일정 미리보기", "건너뛸게", "건너뛰기", "만들지 않고 계속"]);
    case "task_pending":
      return other(["할일도 만들어줘", "할일 미리보기", "건너뛸게", "건너뛰기", "만들지 않고 계속"]);
    case "answer_before":
      return other(["답변 보여줘", "답변 생성해줘"]);
    case "receipt_ready":
      return other(context.receiptReady
        ? ["실행 결과 보여줘", "영수증 보여줘", "지금 잊어줘", "지금 잊기"]
        : ["실행 결과 보여줘", "영수증 보여줘"]);
    case "forgotten":
      return other(context.receiptReady
        ? ["실행 결과 보여줘", "영수증 보여줘", "답변 보여줘", "답변 생성해줘"]
        : ["실행 결과 보여줘", "영수증 보여줘"]);
    case "completed":
      return other(["실행 결과 보여줘", "영수증 보여줘"]);
    default:
      return [];
  }
}

/** 표준 Levenshtein 거리. 짧은 고정 문장에만 쓰므로 단순 구현으로 충분하다. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const candidate = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous[j];
      previous[j] = candidate;
    }
  }
  return previous[b.length];
}

/** 길이에 비례한 허용 오차. 짧은 문장일수록 엄격하다. */
export function suggestionThreshold(length: number): number {
  return Math.max(1, Math.floor(length / 3));
}

/**
 * 완전 일치에 실패한 입력을 가장 가까운 문장 하나로 제안한다.
 *
 * **유사도로 실행하지 않는다.** 후보가 유일하게 가까울 때만 제안을 만들고, 실행은
 * 사용자가 제안을 명시적으로 수락해 canonical 문장이 기존 완전 일치 경로로 다시
 * 들어갈 때만 일어난다. 승인과 거절이 함께 가까우면 부정 우선 원칙을 지키기 위해
 * 아무것도 제안하지 않는다.
 */
export function nearestTutorialPhrase(
  context: TutorialUtteranceContext,
  normalized: string,
): TutorialPhraseCandidate | null {
  if (!normalized) return null;
  const limit = suggestionThreshold(normalized.length);
  const scored = tutorialPhraseCandidates(context)
    .map((candidate) => ({
      candidate,
      distance: editDistance(normalized, strippedPhrase(candidate.display)),
    }))
    .sort((left, right) => left.distance - right.distance);

  const best = scored[0];
  if (!best || best.distance === 0 || best.distance > limit) return null;
  // 같은 거리의 후보가 또 있으면 무엇을 뜻하는지 확정할 수 없다.
  if (scored.length > 1 && scored[1].distance === best.distance) return null;
  if (best.candidate.role !== "other") {
    const rival = best.candidate.role === "approve" ? "reject" : "approve";
    const rivalNear = scored.some(({ candidate, distance }) =>
      candidate.role === rival && distance <= limit);
    if (rivalNear) return null;
  }
  return best.candidate;
}

/**
 * 현재 단계에서 눌러 넣을 수 있는 예시 문장.
 *
 * 사용자가 문장을 정확히 말하지 못해도 진행할 수 있어야 한다. 다만 누르면
 * **입력창에 넣기만** 한다. 실행은 사용자가 내용을 보고 전송할 때 일어난다.
 * 목록이 길면 고르기 어려우므로 앞쪽 몇 개만 노출한다.
 */
export function tutorialExampleChips(
  context: TutorialUtteranceContext,
  limit = 4,
): string[] {
  return tutorialPhraseCandidates(context)
    .map((candidate) => candidate.display)
    .slice(0, limit);
}
