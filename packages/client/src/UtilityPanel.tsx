import { useState } from "react";
import type { UtilityPanelState } from "./utility-panel";
import type { CalendarEvent, GoogleTask } from "./google-integration";
import { createCalendarDraft, createTaskDraft, type GoogleWriteDraft } from "./google-write";

export type UtilityDataState =
  | { kind: "disconnected" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: CalendarEvent[] | GoogleTask[] };

interface UtilityPanelProps {
  state: Exclude<UtilityPanelState, null>;
  onToggleSize(): void;
  onClose(): void;
  data: UtilityDataState;
  onCreateDraft(draft: GoogleWriteDraft): void;
}

export function UtilityPanel({ state, onToggleSize, onClose, data, onCreateDraft }: UtilityPanelProps) {
  const calendar = state.panel === "calendar";
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [due, setDue] = useState("");
  const [draftError, setDraftError] = useState("");
  function preview() {
    try {
      onCreateDraft(calendar ? createCalendarDraft(title, startAt, endAt) : createTaskDraft(title, due));
      setDraftError("");
    } catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <section className={`utility-panel ${state.size}`} aria-label={calendar ? "일정" : "할 일"}>
      <header className="utility-header">
        <div><strong>{calendar ? "오늘 일정" : "할 일"}</strong><span>Google {calendar ? "Calendar" : "Tasks"}</span></div>
        <div className="utility-actions">
          <button type="button" onClick={() => setCreating((value) => !value)}>{creating ? "취소" : "+ 추가"}</button>
          <button type="button" onClick={onToggleSize} aria-label="패널 크기 전환">{state.size === "small" ? "↗ 크게 보기" : "↙ 작게 보기"}</button>
          <button type="button" onClick={onClose} aria-label="패널 닫기">×</button>
        </div>
      </header>
      {creating && <div className="google-create-form">
        <label>제목<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {calendar ? <><label>시작<input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label><label>종료<input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} /></label></> : <label>기한<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>}
        {draftError && <p role="alert">{draftError}</p>}
        <button type="button" onClick={preview}>초안 검토</button>
      </div>}
      {data.kind === "ready" && data.items.length > 0 ? <ul className="utility-list">
        {data.items.map((item) => <li key={item.id}><strong>{item.title}</strong><span>{calendar ? formatCalendarTime((item as CalendarEvent).startsAt, (item as CalendarEvent).allDay) : formatDue((item as GoogleTask).due)}</span></li>)}
      </ul> : <div className="utility-empty">
        <span className="utility-symbol" aria-hidden="true">{calendar ? "○" : "✓"}</span>
        <strong>{data.kind === "loading" ? "불러오는 중…" : data.kind === "error" ? "불러오지 못했어" : data.kind === "ready" ? (calendar ? "오늘 일정이 없어" : "남은 할 일이 없어") : "Google 계정 연결이 필요해"}</strong>
        <p>{data.kind === "error" ? data.message : data.kind === "disconnected" ? (calendar ? "설정에서 계정을 연결하면 오늘 일정을 볼 수 있어." : "설정에서 계정을 연결하면 할 일을 확인할 수 있어.") : data.kind === "ready" ? "새 항목이 생기면 여기에 표시할게." : "Google에서 안전하게 확인하고 있어."}</p>
      </div>}
    </section>
  );
}

function formatCalendarTime(value: string, allDay: boolean) {
  if (allDay) return "하루 종일";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function formatDue(value: string | null) {
  return value ? new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(value)) : "기한 없음";
}
