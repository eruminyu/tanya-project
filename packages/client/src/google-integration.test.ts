import { describe, expect, it } from "vitest";
import { CALENDAR_LIST_SCOPE, CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE, TASKS_READ_SCOPE, TASKS_WRITE_SCOPE, googleCapability, normalizeCalendarEvents, normalizeGoogleTargets, normalizeTasks } from "./google-integration";

describe("Google 단일 계정 연동", () => {
  it("승인된 scope별 기능을 독립적으로 판정한다", () => {
    expect(googleCapability([CALENDAR_READ_SCOPE])).toEqual({ calendar: true, tasks: false, calendarWrite: false, tasksWrite: false, targetSelection: false });
    expect(googleCapability([CALENDAR_READ_SCOPE, TASKS_READ_SCOPE])).toEqual({ calendar: true, tasks: true, calendarWrite: false, tasksWrite: false, targetSelection: false });
  });

  it("Calendar 목록 권한은 생성 권한과 별도로 판정한다", () => {
    expect(googleCapability([CALENDAR_WRITE_SCOPE, TASKS_WRITE_SCOPE])).toMatchObject({ targetSelection: false });
    expect(googleCapability([CALENDAR_WRITE_SCOPE, TASKS_WRITE_SCOPE, CALENDAR_LIST_SCOPE])).toMatchObject({ targetSelection: true });
  });

  it("Google 대상 목록에서 유효한 ID와 이름만 보존한다", () => {
    expect(normalizeGoogleTargets([{ id: "primary", summary: "내 캘린더" }, { id: 1 }], "summary"))
      .toEqual([{ id: "primary", name: "내 캘린더" }]);
  });

  it("쓰기 scope는 읽기를 포함하되 쓰기 가능 여부를 별도로 표시한다", () => {
    expect(googleCapability([CALENDAR_WRITE_SCOPE, TASKS_WRITE_SCOPE])).toEqual({ calendar: true, tasks: true, calendarWrite: true, tasksWrite: true, targetSelection: false });
    expect(googleCapability([CALENDAR_READ_SCOPE, TASKS_READ_SCOPE])).toEqual({ calendar: true, tasks: true, calendarWrite: false, tasksWrite: false, targetSelection: false });
  });

  it("Calendar 응답을 화면 DTO로 정규화한다", () => {
    expect(normalizeCalendarEvents([{ id: "e1", summary: "회의", start: { dateTime: "2026-08-16T10:00:00+09:00" } }]))
      .toEqual([{ id: "e1", title: "회의", startsAt: "2026-08-16T10:00:00+09:00", allDay: false }]);
  });

  it("Tasks 응답에서 완료되지 않은 항목만 정규화한다", () => {
    expect(normalizeTasks([{ id: "t1", title: "작업", status: "needsAction" }, { id: "t2", title: "완료", status: "completed" }]))
      .toEqual([{ id: "t1", title: "작업", due: null }]);
  });
});
