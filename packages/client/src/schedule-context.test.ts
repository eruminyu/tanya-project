import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "./google-integration";
import { SCHEDULE_PUSH_INTERVAL_MS, buildScheduleContextMessage } from "./schedule-context";

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt-1",
  title: "프로젝트 회의",
  startsAt: "2026-09-15T15:00:00+09:00",
  allDay: false,
  ...over,
});

const now = new Date("2026-09-15T14:20:00+09:00");

describe("일정 스냅샷 메시지", () => {
  it("Brain 계약 모양으로 직렬화한다", () => {
    const message = buildScheduleContextMessage([event()], now, "Asia/Seoul");

    expect(message).toEqual({
      type: "context",
      context: {
        now: now.toISOString(),
        timeZone: "Asia/Seoul",
        events: [{
          id: "evt-1",
          title: "프로젝트 회의",
          startsAt: "2026-09-15T15:00:00+09:00",
          allDay: false,
        }],
      },
    });
  });

  it("Google 미연결이면 null을 돌려 아무것도 보내지 않는다", () => {
    expect(buildScheduleContextMessage(null, now, "Asia/Seoul")).toBeNull();
  });

  it("연결됐지만 일정이 없으면 빈 목록을 보낸다", () => {
    const message = buildScheduleContextMessage([], now, "Asia/Seoul");

    expect(message?.context.events).toEqual([]);
  });

  it("CalendarEvent의 필드만 싣는다", () => {
    const noisy = { ...event(), 설명: "외부로 나가면 안 되는 필드" } as CalendarEvent;
    const message = buildScheduleContextMessage([noisy], now, "Asia/Seoul");

    expect(Object.keys(message!.context.events[0])).toEqual(["id", "title", "startsAt", "allDay"]);
  });

  it("전송 주기는 Brain 신선도 한계(30분)보다 짧다", () => {
    expect(SCHEDULE_PUSH_INTERVAL_MS).toBeLessThan(30 * 60 * 1000);
  });
});
