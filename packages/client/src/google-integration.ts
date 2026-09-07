import { invoke } from "@tauri-apps/api/core";
import type { GoogleWriteDraft, GoogleWriteReceipt } from "./google-write";

export const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const TASKS_READ_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";
export const CALENDAR_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const TASKS_WRITE_SCOPE = "https://www.googleapis.com/auth/tasks";
export const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

export interface GoogleConnection { connected: boolean; scopes: string[]; email?: string }
export interface CalendarEvent { id: string; title: string; startsAt: string; allDay: boolean }
export interface GoogleTask { id: string; title: string; due: string | null }
export interface GoogleTarget { id: string; name: string }

export function googleCapability(scopes: readonly string[]) {
  const calendarWrite = scopes.includes(CALENDAR_WRITE_SCOPE);
  const tasksWrite = scopes.includes(TASKS_WRITE_SCOPE);
  return { calendar: calendarWrite || scopes.includes(CALENDAR_READ_SCOPE), tasks: tasksWrite || scopes.includes(TASKS_READ_SCOPE), calendarWrite, tasksWrite, targetSelection: scopes.includes(CALENDAR_LIST_SCOPE) };
}

export function normalizeGoogleTargets(items: readonly Record<string, unknown>[], nameField: "summary" | "title"): GoogleTarget[] {
  return items.flatMap((item) => typeof item.id === "string" && typeof item[nameField] === "string" ? [{ id: item.id, name: item[nameField] }] : []);
}

export function normalizeCalendarEvents(items: readonly Record<string, unknown>[]): CalendarEvent[] {
  return items.flatMap((item) => {
    const start = item.start as { dateTime?: unknown; date?: unknown } | undefined;
    const startsAt = typeof start?.dateTime === "string" ? start.dateTime : typeof start?.date === "string" ? start.date : null;
    if (typeof item.id !== "string" || !startsAt) return [];
    return [{ id: item.id, title: typeof item.summary === "string" ? item.summary : "제목 없는 일정", startsAt, allDay: !start?.dateTime }];
  });
}

export function normalizeTasks(items: readonly Record<string, unknown>[]): GoogleTask[] {
  return items.flatMap((item) => {
    if (item.status === "completed" || typeof item.id !== "string") return [];
    return [{ id: item.id, title: typeof item.title === "string" ? item.title : "제목 없는 할 일", due: typeof item.due === "string" ? item.due : null }];
  });
}

export const googleRuntime = {
  status: () => invoke<GoogleConnection>("google_status"),
  connect: (clientId: string, writeAccess = false) => invoke<GoogleConnection>("google_connect", { clientId, writeAccess }),
  disconnect: () => invoke<void>("google_disconnect"),
  calendar: () => invoke<Record<string, unknown>[]>("google_calendar_today").then(normalizeCalendarEvents),
  tasks: () => invoke<Record<string, unknown>[]>("google_tasks").then(normalizeTasks),
  calendars: () => invoke<Record<string, unknown>[]>("google_calendars").then((items) => normalizeGoogleTargets(items, "summary")),
  taskLists: () => invoke<Record<string, unknown>[]>("google_task_lists").then((items) => normalizeGoogleTargets(items, "title")),
  create: (draft: GoogleWriteDraft, targets = { calendarId: "primary", taskListId: "@default" }) => draft.kind === "calendar"
    ? invoke<GoogleWriteReceipt>("google_calendar_create", { request: draft, calendarId: targets.calendarId })
    : invoke<GoogleWriteReceipt>("google_task_create", { request: draft, taskListId: targets.taskListId }),
};
