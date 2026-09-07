import { describe, expect, it } from "vitest";
import {
  HANDOFF_DESCRIPTION,
  HANDOFF_NOTICES,
  buildCalendarIcs,
  buildGoogleCalendarUrl,
  calendarHandoffFrom,
  escapeIcsText,
  foldIcsLine,
  icsFileName,
  toUtcStamp,
} from "./calendar-handoff";
import type { TutorialReceiptGoogleAction } from "./tutorial";

function action(overrides: Partial<TutorialReceiptGoogleAction> = {}): TutorialReceiptGoogleAction {
  return {
    requestId: "33333333-3333-4333-8333-333333333333",
    providerId: "provider-abc",
    status: "succeeded",
    sentFields: {
      title: "Tanya 해커톤 준비 점검",
      startAt: "2026-09-07T15:00:00+09:00",
      endAt: "2026-09-07T16:00:00+09:00",
      timeZone: "Asia/Seoul",
    },
    createdAt: "2026-09-07T05:00:00Z",
    cleanupDueAt: "2026-09-07T05:30:00Z",
    cleanupStatus: "scheduled",
    ...overrides,
  };
}

describe("handoff 노출 조건", () => {
  it("성공한 Calendar와 전송 필드가 있을 때만 만든다", () => {
    expect(calendarHandoffFrom(action())).not.toBeNull();
  });

  it.each(["failed", "uncertain", "rejected", "skipped"] as const)(
    "%s 상태에서는 만들지 않는다",
    (status) => {
      expect(calendarHandoffFrom(action({ status }))).toBeNull();
    },
  );

  it("forget 뒤 redacted 영수증에서는 만들지 않는다", () => {
    // 삭제 후에는 서버가 sentFields를 null로 준다.
    expect(calendarHandoffFrom(action({ sentFields: null }))).toBeNull();
  });

  it("Task 필드로는 만들지 않는다", () => {
    const task = action({ sentFields: { title: "제출 확인", due: "2026-09-07" } });
    expect(calendarHandoffFrom(task)).toBeNull();
  });

  it("action 자체가 없으면 만들지 않는다", () => {
    expect(calendarHandoffFrom(null)).toBeNull();
    expect(calendarHandoffFrom(undefined)).toBeNull();
  });

  it("시각을 해석할 수 없으면 만들지 않는다", () => {
    const broken = action({
      sentFields: { title: "제목", startAt: "not-a-date", endAt: "also-bad", timeZone: "Asia/Seoul" },
    });
    expect(calendarHandoffFrom(broken)).toBeNull();
  });
});

describe("UTC 변환", () => {
  it("offset 있는 ISO를 UTC basic format으로 바꾼다", () => {
    expect(toUtcStamp("2026-09-07T15:00:00+09:00")).toBe("20260907T060000Z");
  });

  it("DST 경계에서도 순간을 보존한다", () => {
    // 미국 동부 서머타임 종료 직전. UTC로 옮기면 규칙을 다룰 필요가 없다.
    expect(toUtcStamp("2026-11-01T01:30:00-04:00")).toBe("20261101T053000Z");
    expect(toUtcStamp("2026-11-01T01:30:00-05:00")).toBe("20261101T063000Z");
  });

  it("자정 넘김을 올바르게 처리한다", () => {
    expect(toUtcStamp("2026-01-01T08:00:00+09:00")).toBe("20251231T230000Z");
  });
});

describe("RFC 5545 escape", () => {
  it("쉼표·세미콜론·백슬래시를 escape한다", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
  });

  it("백슬래시를 이중 escape하지 않는다", () => {
    // 백슬래시를 먼저 처리하지 않으면 쉼표 escape가 다시 escape된다.
    expect(escapeIcsText("a,b")).toBe("a\\,b");
  });

  it("개행을 리터럴로 바꿔 property 주입을 막는다", () => {
    const injected = escapeIcsText("제목\r\nSUMMARY:가짜\nDESCRIPTION:주입");
    expect(injected).not.toContain("\r");
    expect(injected).not.toContain("\n");
    expect(injected).toContain("\\n");
  });
});

describe("줄 접기", () => {
  it("75 octet 이하는 그대로 둔다", () => {
    expect(foldIcsLine("SUMMARY:짧은 제목")).toBe("SUMMARY:짧은 제목");
  });

  it("긴 한글 줄을 CRLF와 공백으로 잇는다", () => {
    const folded = foldIcsLine(`SUMMARY:${"가".repeat(80)}`);
    expect(folded).toContain("\r\n ");
    for (const segment of folded.split("\r\n")) {
      expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(75);
    }
  });

  it("멀티바이트 문자를 쪼개지 않는다", () => {
    const folded = foldIcsLine(`SUMMARY:${"한글".repeat(60)}`);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"한글".repeat(60)}`);
  });
});

describe("ICS 생성", () => {
  const handoff = calendarHandoffFrom(action())!;
  const ics = buildCalendarIcs(handoff, new Date("2026-09-07T05:10:00Z"));

  it("UTC 시각을 쓰고 VTIMEZONE·TZID를 만들지 않는다", () => {
    expect(ics).toContain("DTSTART:20260907T060000Z");
    expect(ics).toContain("DTEND:20260907T070000Z");
    expect(ics).not.toContain("VTIMEZONE");
    expect(ics).not.toContain("TZID");
  });

  it("CRLF로 끝맺고 필수 구조를 갖춘다", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
  });

  it("설명은 Client 고정 상수를 쓴다", () => {
    // 75 octet 접기로 줄이 나뉘므로 이어 붙인 뒤 비교한다.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`DESCRIPTION:${escapeIcsText(HANDOFF_DESCRIPTION)}`);
  });

  it("내부 식별자를 담지 않는다", () => {
    // provider·request·session·token 어느 것도 파일에 들어가면 안 된다.
    expect(ics).not.toContain("provider-abc");
    expect(ics).not.toContain("33333333-3333-4333-8333-333333333333");
    expect(ics.toLowerCase()).not.toContain("token");
  });

  it("UID는 서버 값이 아니라 로컬에서 만든다", () => {
    const uid = /UID:(.+)/.exec(ics)?.[1] ?? "";
    expect(uid).not.toContain("provider-abc");
    expect(uid).toContain("@tanya.local");
  });

  it("제목의 개행 주입이 새 property가 되지 않는다", () => {
    const evil = calendarHandoffFrom(action({
      sentFields: {
        title: "정상 제목\r\nSUMMARY:주입된 제목",
        startAt: "2026-09-07T15:00:00+09:00",
        endAt: "2026-09-07T16:00:00+09:00",
        timeZone: "Asia/Seoul",
      },
    }))!;
    const injected = buildCalendarIcs(evil);
    const summaryLines = injected.split("\r\n").filter((line) => line.startsWith("SUMMARY:"));
    expect(summaryLines).toHaveLength(1);
  });
});

describe("Google 링크", () => {
  const handoff = calendarHandoffFrom(action())!;
  const url = buildGoogleCalendarUrl(handoff);

  it("UTC 구간을 dates에 넣는다", () => {
    expect(url).toContain("dates=20260907T060000Z%2F20260907T070000Z");
  });

  it("내부 식별자를 URL에 넣지 않는다", () => {
    expect(url).not.toContain("provider-abc");
    expect(url).not.toContain("33333333");
  });

  it("한글 제목을 안전하게 인코딩한다", () => {
    expect(url).not.toContain(" ");
    expect(decodeURIComponent(new URL(url).searchParams.get("text") ?? "")).toBe("Tanya 해커톤 준비 점검");
  });

  it("Google 도메인만 가리킨다", () => {
    expect(new URL(url).origin).toBe("https://calendar.google.com");
  });
});

describe("사용자 안내", () => {
  it("복사본이 자동 삭제되지 않는다는 사실을 알린다", () => {
    // 바로 위에서 30분 자동 삭제를 읽은 사용자가 복사본도 사라진다고 오해하면 안 된다.
    expect(HANDOFF_NOTICES.join(" ")).toContain("직접 삭제");
  });

  it("공용 데모의 30분 삭제와 복사를 구분해 알린다", () => {
    const joined = HANDOFF_NOTICES.join(" ");
    expect(joined).toContain("30분");
    expect(joined).toContain("복사");
  });

  it("파일명에 식별자를 넣지 않는다", () => {
    expect(icsFileName()).toBe("tanya-demo-event.ics");
  });
});
