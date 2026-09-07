import type { CalendarEvent } from "./google-integration";

/**
 * 일정 스냅샷 전송 주기.
 * Brain은 30분보다 오래된 스냅샷을 버리므로(SCHEDULE_MAX_AGE) 그 절반으로 잡는다.
 * 한 번 놓쳐도 신선도가 끊기지 않는다.
 */
export const SCHEDULE_PUSH_INTERVAL_MS = 15 * 60 * 1000;

export interface ScheduleContextMessage {
  type: "context";
  context: {
    now: string;
    timeZone: string;
    events: CalendarEvent[];
  };
}

/**
 * 오늘 일정을 Brain 계약 모양으로 직렬화한다 (T-013).
 *
 * `events`가 null이면 **null을 반환해 아무것도 보내지 않는다.** Google 미연결이나
 * 읽기 권한 없음을 빈 배열로 위장하지 않는다 (CONVENTIONS §3 Mock 금지).
 * 연결됐는데 일정이 없는 것은 빈 배열이 맞다 — 그건 사실이다.
 */
export function buildScheduleContextMessage(
  events: readonly CalendarEvent[] | null,
  now: Date,
  timeZone: string,
): ScheduleContextMessage | null {
  if (events === null) return null;
  return {
    type: "context",
    context: {
      now: now.toISOString(),
      timeZone,
      // 필드를 명시해 옮긴다. CalendarEvent에 없는 값이 딸려 나가지 않게 한다.
      events: events.map(({ id, title, startsAt, allDay }) => ({ id, title, startsAt, allDay })),
    },
  };
}
