import { describe, expect, it } from "vitest";
import {
  editDistance,
  tutorialExampleChips,
  nearestTutorialPhrase,
  strippedPhrase,
  suggestionThreshold,
  tutorialPhraseCandidates,
} from "./tutorial-suggestion";
import {
  normalizeUtterance,
  parseTutorialUtterance,
  type TutorialUtteranceContext,
} from "./tutorial-utterance";

const context = (
  phase: TutorialUtteranceContext["phase"],
  approvalPurpose: TutorialUtteranceContext["approvalPurpose"] = null,
  receiptReady = false,
): TutorialUtteranceContext => ({ blocked: null, phase, approvalPurpose, receiptReady });

const calendarApproval = context("calendar_pending", "calendar");

describe("STT 변이 제안", () => {
  // 2026-09-06 실측: 같은 오디오를 whisper small/medium으로 전사한 실제 결과다.
  it.each([
    ["2일점으로 등록해져", "whisper small"],
    ["이 일점으로 등록해져", "whisper medium"],
  ])("%s (%s)를 승인 문장으로 제안한다", (transcript) => {
    const suggestion = nearestTutorialPhrase(calendarApproval, normalizeUtterance(transcript));
    expect(suggestion?.display).toBe("이 일정으로 등록해줘");
    expect(suggestion?.role).toBe("approve");
  });

  it("제안을 만들어도 파서는 여전히 실행하지 않는다", () => {
    const result = parseTutorialUtterance(calendarApproval, "2일점으로 등록해져");
    expect(result.kind).toBe("clarify");
    expect(result).not.toHaveProperty("intent");
  });

  it("제안된 문장을 그대로 넣으면 비로소 승인으로 실행된다", () => {
    const suggestion = nearestTutorialPhrase(calendarApproval, normalizeUtterance("이 일점으로 등록해져"));
    const result = parseTutorialUtterance(calendarApproval, suggestion!.display);
    expect(result).toEqual({ kind: "action", intent: "approve" });
  });

  it("완전 일치하는 입력에는 제안을 만들지 않는다", () => {
    expect(nearestTutorialPhrase(calendarApproval, normalizeUtterance("이 일정으로 등록해줘"))).toBeNull();
  });

  it("임계값 밖 입력에는 제안을 만들지 않는다", () => {
    expect(nearestTutorialPhrase(calendarApproval, normalizeUtterance("오늘 날씨 어때"))).toBeNull();
  });

  it("승인과 거절이 함께 가까우면 아무것도 제안하지 않는다", () => {
    // 부정 우선 원칙을 유사도로 뒤집지 않는다.
    const rigged: TutorialUtteranceContext = calendarApproval;
    const suggestion = nearestTutorialPhrase(rigged, "등록하지");
    // 거절 후보 두 개(등록하지 마 / 만들지 마)가 동시에 가까우면 확정할 수 없다.
    if (suggestion) expect(suggestion.role).not.toBe("approve");
  });

  it("동점 후보가 있으면 제안하지 않는다", () => {
    const candidates = tutorialPhraseCandidates(context("calendar_pending"));
    expect(candidates.map((entry) => entry.display)).toContain("건너뛸게");
    // 건너뛸게 / 건너뛰기와 같은 거리인 입력은 확정할 수 없다.
    expect(nearestTutorialPhrase(context("calendar_pending"), "건너뛸기")).toBeNull();
  });

  it("승인 단계가 아니면 승인 후보를 만들지 않는다", () => {
    const stale = context("preferences_pending", "calendar");
    expect(tutorialPhraseCandidates(stale)).toEqual([]);
    expect(nearestTutorialPhrase(stale, normalizeUtterance("이 일점으로 등록해져"))).toBeNull();
  });

  it("빈 입력에는 제안하지 않는다", () => {
    expect(nearestTutorialPhrase(calendarApproval, "")).toBeNull();
  });
});

describe("제안 후보와 파서의 일관성", () => {
  const contexts: TutorialUtteranceContext[] = [
    context(null),
    context("preferences_pending"),
    context("calendar_pending"),
    context("task_pending"),
    context("answer_before"),
    context("receipt_ready", null, true),
    context("forgotten", null, true),
    context("completed"),
    context("preferences_pending", "preferences"),
    context("calendar_pending", "calendar"),
    context("task_pending", "task"),
  ];

  it("모든 후보 문장은 실제로 파서를 통과한다", () => {
    const rejected: string[] = [];
    for (const entry of contexts) {
      for (const candidate of tutorialPhraseCandidates(entry)) {
        const result = parseTutorialUtterance(entry, candidate.display);
        if (result.kind === "clarify" || result.kind === "unmatched") {
          rejected.push(`${entry.phase ?? "null"}/${entry.approvalPurpose ?? "-"}: ${candidate.display}`);
        }
      }
    }
    // 표시 문장과 매칭 문장이 어긋나면 제안을 수락해도 아무 일이 일어나지 않는다.
    expect(rejected).toEqual([]);
  });

  it("후보가 하나라도 있는 단계에서는 제안 경로가 살아 있다", () => {
    for (const entry of contexts) {
      expect(tutorialPhraseCandidates(entry).length).toBeGreaterThan(0);
    }
  });
});

describe("수사 정규화", () => {
  it.each([
    ["알림은 열 분 전", "알림은10분전"],
    ["알림은 다섯 분 전", "알림은5분전"],
    ["알림은 이십 분 전", "알림은20분전"],
  ])("%s를 %s로 정규화한다", (input, expected) => {
    expect(normalizeUtterance(input)).toBe(expected);
  });

  it("단위가 없는 지시어는 절대 숫자로 바꾸지 않는다", () => {
    // `이 일정으로 등록해줘`의 `이`를 2로 바꾸면 승인 문장이 깨진다.
    expect(normalizeUtterance("이 일정으로 등록해줘")).toBe("이일정으로등록해줘");
    expect(parseTutorialUtterance(calendarApproval, "이 일정으로 등록해줘"))
      .toEqual({ kind: "action", intent: "approve" });
  });

  it("정규화한 선택 문장이 그대로 실행된다", () => {
    expect(parseTutorialUtterance(context("preferences_pending"), "알림은 열 분 전"))
      .toEqual({ kind: "selection", change: { type: "minutes", value: 10 }, message: expect.any(String) });
  });
});

describe("거리 계산", () => {
  it("같은 문자열의 거리는 0이다", () => {
    expect(editDistance("등록해줘", "등록해줘")).toBe(0);
  });

  it("치환·삽입·삭제를 각각 1로 센다", () => {
    expect(editDistance("등록해줘", "등록해져")).toBe(1);
    expect(editDistance("등록해", "등록해줘")).toBe(1);
    expect(editDistance("등록해줘요", "등록해줘")).toBe(1);
  });

  it("임계값은 길이에 비례하고 최소 1이다", () => {
    expect(suggestionThreshold(1)).toBe(1);
    expect(suggestionThreshold(9)).toBe(3);
    expect(suggestionThreshold(30)).toBe(10);
  });

  it("표시 문장에서 공백만 제거한다", () => {
    expect(strippedPhrase("이 일정으로 등록해줘")).toBe("이일정으로등록해줘");
  });
});

describe("예시 칩", () => {
  it("현재 단계의 문장을 개수 제한해 돌려준다", () => {
    const chips = tutorialExampleChips(context("calendar_pending"));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(4);
    expect(chips).toContain("캘린더 해볼게");
  });

  it("승인 단계에서는 승인·거절 문장을 준다", () => {
    const chips = tutorialExampleChips(calendarApproval);
    expect(chips).toContain("이 일정으로 등록해줘");
  });

  it("칩 문장은 실제로 파서를 통과한다", () => {
    // 눌러 넣었는데 전송이 안 되면 더 혼란스럽다.
    for (const entry of [context(null), context("calendar_pending"), calendarApproval]) {
      for (const phrase of tutorialExampleChips(entry)) {
        const result = parseTutorialUtterance(entry, phrase);
        expect(result.kind).not.toBe("clarify");
        expect(result.kind).not.toBe("unmatched");
      }
    }
  });
});

describe("실패 안내", () => {
  it("들은 문장을 되돌려주고 규칙을 설명한다", () => {
    const result = parseTutorialUtterance(context(null), "체험 좀 해볼까");
    expect(result.kind).not.toBe("action");
    expect("message" in result && result.message).toContain("체험 좀 해볼까");
    expect("message" in result && result.message).toContain("정해진 문장");
  });
});
