import type { TutorialCalendarFields, TutorialReceiptGoogleAction } from "./tutorial";

/**
 * 공용 데모 계정에 실제로 만들어진 일정을 방문자가 자기 캘린더로 **복사**하는 경로.
 *
 * 공용 데모의 Google 실행을 다시 부르지 않는다. 이미 성공한 영수증의 전송 필드만
 * 읽어서 로컬에서 ICS 또는 링크를 만든다. 방문자의 OAuth·이메일·계정 식별자는
 * 수집하지 않는다.
 */

/**
 * 설명 본문은 Client 고정 상수다.
 *
 * 서버 영수증의 Calendar 필드는 `title`·`startAt`·`endAt`·`timeZone` 네 개뿐이고
 * description이 없다. 없는 서버 데이터를 추측해 채우지 않는다. 덕분에 내부 식별자가
 * 섞여 들어갈 여지도 사라진다.
 */
export const HANDOFF_DESCRIPTION = "Tanya 공개 체험에서 만든 일정을 내 캘린더로 복사했습니다.";

/** 사용자에게 반드시 보여줘야 하는 문구. 복사본의 수명을 오해하면 안 된다. */
export const HANDOFF_NOTICES = [
  "공용 데모 계정의 일정은 30분 뒤 자동으로 삭제됩니다.",
  "아래 선택지는 같은 내용을 내 캘린더로 복사합니다.",
  "복사한 일정은 내 캘린더에 남습니다. Tanya가 지우지 않으니 직접 삭제해 주세요.",
  "저장과 알림은 내 캘린더 앱에서 최종 확정됩니다.",
] as const;

export type CalendarHandoff = {
  fields: TutorialCalendarFields;
  /** 화면 표시용 원래 시간대. 파일에는 UTC만 들어간다. */
  displayTimeZone: string;
};

/**
 * handoff를 노출할 수 있는 영수증인지 판정한다.
 *
 * 성공한 Calendar 실행이고 서버가 실제 전송 필드를 준 경우에만 참이다.
 * 실패·불확실·거절·건너뜀과, forget 뒤 redaction으로 `sentFields`가 사라진
 * 영수증에서는 노출하지 않는다.
 */
export function calendarHandoffFrom(
  action: TutorialReceiptGoogleAction | null | undefined,
): CalendarHandoff | null {
  if (!action || action.status !== "succeeded") return null;
  const fields = action.sentFields;
  if (!fields || !("startAt" in fields) || !("endAt" in fields)) return null;
  if (!fields.title?.trim() || !fields.startAt || !fields.endAt) return null;
  if (!Number.isFinite(Date.parse(fields.startAt)) || !Number.isFinite(Date.parse(fields.endAt))) return null;
  return { fields, displayTimeZone: fields.timeZone };
}

/**
 * UTC basic format으로 바꾼다. `20260907T060000Z`
 *
 * 원래 시간대를 `TZID`로 남기려면 `VTIMEZONE`에 DST 전환 규칙까지 직접 써야 한다.
 * 그건 Client가 타임존 데이터베이스를 들고 다니는 셈이라 버그가 나기 쉽다.
 * UTC로 고정하면 캘린더 앱이 알아서 방문자의 로컬 시각으로 보여주고, DST 규칙을
 * 우리가 다루지 않아도 된다. 화면에는 원래 시간대를 따로 표시한다.
 */
export function toUtcStamp(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`
    + `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
}

/**
 * RFC 5545 텍스트 escape.
 *
 * 개행을 그대로 두면 새 property로 해석돼 임의의 ICS 필드를 주입할 수 있다.
 * 백슬래시를 먼저 처리해야 뒤따르는 치환이 이중으로 escape되지 않는다.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545의 75 octet 접기. UTF-8 바이트 기준이라 한글에서도 안전하다. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit) {
      chunks.push(current);
      current = char;
      currentBytes = size;
      // 이어지는 줄은 앞에 공백 한 칸이 붙으므로 한 바이트를 양보한다.
      limit = 74;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  chunks.push(current);
  return chunks.join("\r\n ");
}

/** 서버 식별자를 재사용하지 않는 로컬 UID. */
function createUid(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${random}@tanya.local`;
}

export function buildCalendarIcs(handoff: CalendarHandoff, now = new Date()): string {
  const { fields } = handoff;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tanya//public demo handoff//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${createUid()}`,
    `DTSTAMP:${toUtcStamp(now.toISOString())}`,
    `DTSTART:${toUtcStamp(fields.startAt)}`,
    `DTEND:${toUtcStamp(fields.endAt)}`,
    `SUMMARY:${escapeIcsText(fields.title.trim())}`,
    `DESCRIPTION:${escapeIcsText(HANDOFF_DESCRIPTION)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // RFC 5545는 CRLF를 요구한다. 마지막 줄에도 끝맺음을 붙인다.
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/**
 * Google Calendar 사전 입력 화면 주소.
 *
 * 이 경로는 Google이 문서로 보장하는 API가 아니다. 동작하는 한 유지하되
 * 실패해도 ICS만으로 기능이 성립해야 한다. 내부 식별자는 넣지 않는다.
 */
export function buildGoogleCalendarUrl(handoff: CalendarHandoff): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: handoff.fields.title.trim(),
    dates: `${toUtcStamp(handoff.fields.startAt)}/${toUtcStamp(handoff.fields.endAt)}`,
    details: HANDOFF_DESCRIPTION,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** 파일명. 사용자에게 보이는 값이라 식별자를 넣지 않는다. */
export function icsFileName(): string {
  return "tanya-demo-event.ics";
}
