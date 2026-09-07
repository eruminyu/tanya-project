import { useEffect, useRef, useState, type Dispatch } from "react";
import { isNarrowViewport } from "./web-layout";
import {
  HANDOFF_NOTICES,
  buildCalendarIcs,
  buildGoogleCalendarUrl,
  calendarHandoffFrom,
  icsFileName,
} from "./calendar-handoff";
import {
  NEUTRAL_TUTORIAL_PREFERENCES,
  reduceTutorialPreferenceDraft,
  type TutorialApproval,
  type TutorialCleanupStatus,
  type TutorialGoogleKind,
  type TutorialGoogleStatus,
  type TutorialPreferenceDraft,
  type TutorialPreferences,
  type TutorialPreferencesPreviewFields,
  type TutorialReceipt,
  type TutorialReceiptGoogleAction,
  type TutorialSource,
  type TutorialState,
} from "./tutorial";

export const TUTORIAL_PREFERENCE_QUESTIONS = [
  {
    key: "interaction",
    legend: "답변은 어떻게 이어가면 좋을까요?",
    hint: "원하는 진행 방식을 골라 주세요.",
    options: [
      { value: "complete", label: "한 번에 완결", detail: "필요한 내용을 한 답변에 정리해요." },
      { value: "interactive", label: "대화하며 조정", detail: "짧게 확인하며 함께 다듬어요." },
      { value: "neutral", label: "중립", detail: "상황에 맞춰 균형 있게 답해요." },
    ],
  },
  {
    key: "information",
    legend: "정보를 어떤 순서로 볼까요?",
    hint: "내용은 같고 보여 주는 순서만 달라져요.",
    options: [
      { value: "concrete", label: "구체적인 것부터", detail: "바로 쓸 수 있는 항목부터 봐요." },
      { value: "big_picture", label: "큰 그림부터", detail: "전체 맥락 뒤에 세부를 봐요." },
      { value: "neutral", label: "중립", detail: "두 방식을 고르게 섞어요." },
    ],
  },
  {
    key: "decision",
    legend: "선택을 도울 때 무엇을 앞세울까요?",
    hint: "추천의 근거를 보여 주는 방식이에요.",
    options: [
      { value: "evidence", label: "확인된 근거", detail: "측정값과 출처를 먼저 봐요." },
      { value: "context", label: "현재 상황", detail: "목표와 맥락을 먼저 고려해요." },
      { value: "neutral", label: "중립", detail: "근거와 상황을 함께 봐요." },
    ],
  },
  {
    key: "planning",
    legend: "계획은 어느 정도로 고정할까요?",
    hint: "진행 중 바꿀 수 있는 여지를 정해요.",
    options: [
      { value: "structured", label: "단계대로", detail: "순서와 완료 조건을 분명히 해요." },
      { value: "flexible", label: "유연하게", detail: "상황에 따라 순서를 바꿔요." },
      { value: "neutral", label: "중립", detail: "기본 순서에 여지를 남겨요." },
    ],
  },
] as const;

type TutorialPanelProps = {
  connected: boolean;
  secureSession: boolean;
  state: TutorialState;
  draft: TutorialPreferenceDraft;
  dispatchDraft: Dispatch<Parameters<typeof reduceTutorialPreferenceDraft>[1]>;
  onStart(): void;
  onResume(): void;
  onPreparePreferences(preferences: TutorialPreferences, preparationMinutes: 5 | 10 | 20): void;
  onApprove(): void;
  onReject(): void;
  onPrepareGoogle(kind: TutorialGoogleKind): void;
  onSkipGoogle(kind: TutorialGoogleKind): void;
  onGenerateAnswer(comparison: "before" | "after"): void;
  onGetReceipt(): void;
  onForget(): void;
};

const PREFERENCE_LABELS: Record<keyof TutorialPreferences, Record<string, string>> = {
  interaction: { complete: "한 번에 완결", interactive: "대화하며 조정", neutral: "중립" },
  information: { concrete: "구체적인 것부터", big_picture: "큰 그림부터", neutral: "중립" },
  decision: { evidence: "확인된 근거", context: "현재 상황", neutral: "중립" },
  planning: { structured: "단계대로", flexible: "유연하게", neutral: "중립" },
};

const PREFERENCE_NAMES: Record<keyof TutorialPreferences, string> = {
  interaction: "답변 진행",
  information: "정보 순서",
  decision: "선택 근거",
  planning: "계획 방식",
};

const PHASE_HEADINGS: Record<string, string> = {
  preferences_pending: "응답 설정 고르기",
  preferences_saved: "응답 설정 저장 확인 중",
  calendar_pending: "Calendar 체험",
  calendar_executing: "Calendar 결과 확인 중",
  calendar_finished: "Calendar 단계 마무리 중",
  task_pending: "Task 체험",
  task_executing: "Task 결과 확인 중",
  task_finished: "Task 단계 마무리 중",
  answer_before: "기억을 사용한 로컬 답변",
  receipt_ready: "실행 영수증",
  forgetting: "VM 기억 삭제 확인 중",
  forgotten: "삭제 후 확인",
  answer_after: "삭제 후 로컬 답변 확인 중",
  completed: "체험 완료",
};

const STATUS_LABELS: Record<TutorialGoogleStatus, string> = {
  pending: "승인 대기",
  executing: "실행 확인 중",
  succeeded: "성공",
  failed: "실패",
  uncertain: "확인 불가 · 자동 재실행 안 함",
  rejected: "거절됨",
  skipped: "건너뜀",
};

const CLEANUP_LABELS: Record<TutorialCleanupStatus, string> = {
  not_required: "정리할 리소스 없음",
  scheduled: "자동 삭제 예약됨",
  running: "자동 삭제 진행 중",
  succeeded: "Google 리소스 삭제 확인",
  failed: "Google 리소스 삭제 실패",
  unknown: "Google 정리 상태 확인 불가",
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DATA_USE_LABELS: Record<string, string> = {
  tutorial_scenario: "고정 튜토리얼 시나리오",
  proposed_tutorial_preferences: "현재 미리보기 설정",
  approved_tutorial_preferences: "승인된 응답 설정",
  approved_calendar_receipt: "확인된 Calendar 영수증",
  approved_task_receipt: "확인된 Task 영수증",
};

function dataUseSummary(items: ReadonlyArray<{ type: string; updatedAt: string }>): string {
  if (items.length === 0) return "추가 데이터 없음";
  return items.map((item) => `${DATA_USE_LABELS[item.type] ?? item.type} · ${formatTimestamp(item.updatedAt)}`).join(" / ");
}

function ExplanationSummary({
  label,
  rows,
}: {
  label: string;
  rows: ReadonlyArray<{ label: string; value: string }>;
}) {
  return <dl className="tutorial-explanation" aria-label={label}>
    {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
  </dl>;
}

function headingFor(state: TutorialState): string {
  if (!state.flowId) return "허락부터 확인하는 Tanya 체험";
  if (!state.snapshot) return "체험 상태 확인";
  return PHASE_HEADINGS[state.snapshot.phase] ?? "Tanya 체험";
}

function statusFor(state: TutorialState, connected: boolean, secureSession: boolean): string {
  if (!secureSession) return "이 브라우저에서는 안전한 탭 세션을 만들 수 없어 체험을 시작할 수 없어요.";
  if (!connected) return state.flowId
    ? "Brain 연결을 기다리고 있어요. 연결되면 서버 상태부터 확인합니다."
    : "Brain 연결을 기다리고 있어요.";
  if (state.busy) return "서버가 확인한 결과를 기다리고 있어요.";
  if (state.needsResume) return "결과를 추정하지 않았어요. 서버 상태를 다시 확인해 주세요.";
  if (!state.flowId) return "준비됨 · 시작 전에는 저장하거나 Google을 변경하지 않아요.";
  if (!state.snapshot) return "같은 탭의 체험 상태를 불러올 준비가 됐어요.";
  return `${headingFor(state)} · 서버 확인 완료`;
}

function PreferenceWizard({
  connected,
  busy,
  draft,
  dispatch,
  onPrepare,
}: {
  connected: boolean;
  busy: boolean;
  draft: TutorialPreferenceDraft;
  dispatch: Dispatch<Parameters<typeof reduceTutorialPreferenceDraft>[1]>;
  onPrepare(preferences: TutorialPreferences, minutes: 5 | 10 | 20): void;
}) {
  // 선택하면 다음 버튼이 화면 밖에 있을 수 있다. 고른 뒤 버튼 줄을 보이게 한다.
  // 이미 보이면 움직이지 않도록 block: "nearest"를 쓴다.
  const actionsRef = useRef<HTMLDivElement>(null);
  const activeQuestion = draft.step === 4 ? null : TUTORIAL_PREFERENCE_QUESTIONS[draft.step];
  const selectionKey = activeQuestion
    ? `${activeQuestion.key}:${draft.preferences[activeQuestion.key]}`
    : `minutes:${draft.preparationMinutes}`;
  const previousSelectionRef = useRef(selectionKey);
  useEffect(() => {
    if (previousSelectionRef.current === selectionKey) return;
    previousSelectionRef.current = selectionKey;
    const node = actionsRef.current;
    if (!node || typeof node.scrollIntoView !== "function") return;
    const reduced = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, [selectionKey]);

  if (draft.step === 4) {
    return <div className="tutorial-preference-step">
      <fieldset>
        <legend>일정 준비 알림은 몇 분 전이 좋을까요?</legend>
        <p>이 값은 체험 시간이나 기억 만료 시간이 아니라 Calendar 초안의 준비 시간이에요.</p>
        <div className="tutorial-radio-list">
          {([5, 10, 20] as const).map((minutes) => <label key={minutes}>
            <input
              type="radio"
              name="tutorial-preparation-minutes"
              value={minutes}
              checked={draft.preparationMinutes === minutes}
              onChange={() => dispatch({ type: "minutes", value: minutes })}
            />
            <span><strong>{minutes}분 전</strong>{minutes === 10 && <small>기본값</small>}</span>
          </label>)}
        </div>
      </fieldset>
      <div className="tutorial-actions split" ref={actionsRef}>
        <button type="button" onClick={() => dispatch({ type: "back" })}>이전</button>
        <button className="primary" type="button" disabled={!connected || busy} onClick={() => onPrepare(draft.preferences, draft.preparationMinutes)}>
          저장 전 미리보기
        </button>
      </div>
    </div>;
  }

  const question = activeQuestion!;
  const selected = draft.preferences[question.key];
  return <div className="tutorial-preference-step">
    {draft.step === 0 && <div className="tutorial-default-path">
      <strong>빠르게 기본값으로 시작</strong>
      <p>네 항목을 모두 중립으로 두고 준비 알림은 10분 전으로 설정해요. 저장 전 미리보기는 그대로 거칩니다.</p>
      <button
        type="button"
        disabled={!connected || busy}
        onClick={() => onPrepare({ ...NEUTRAL_TUTORIAL_PREFERENCES }, 10)}
      >중립 설정으로 미리보기</button>
    </div>}
    {draft.step === 0 && <div className="tutorial-divider"><span>또는 직접 선택</span></div>}
    <fieldset>
      <legend>{question.legend}</legend>
      <p>{question.hint}</p>
      <div className="tutorial-radio-list">
        {question.options.map((option) => <label key={option.value}>
          <input
            type="radio"
            name={`tutorial-${question.key}`}
            value={option.value}
            checked={selected === option.value}
            onChange={() => dispatch({ type: "select", key: question.key, value: option.value })}
          />
          <span><strong>{option.label}</strong><small>{option.detail}</small></span>
        </label>)}
      </div>
    </fieldset>
    <div className="tutorial-actions split" ref={actionsRef}>
      <button type="button" disabled={draft.step === 0} onClick={() => dispatch({ type: "back" })}>이전</button>
      <span>{draft.step + 1} / 4</span>
      <button className="primary" type="button" onClick={() => dispatch({ type: "next" })}>다음</button>
    </div>
  </div>;
}

function PreferenceFields({ fields }: { fields: TutorialPreferencesPreviewFields }) {
  return <dl className="tutorial-facts">
    {(Object.keys(PREFERENCE_NAMES) as Array<keyof TutorialPreferences>).map((key) => <div key={key}>
      <dt>{PREFERENCE_NAMES[key]}</dt><dd>{PREFERENCE_LABELS[key][fields[key]]}</dd>
    </div>)}
    <div><dt>준비 알림</dt><dd>{fields.preparationMinutes}분 전</dd></div>
  </dl>;
}

function ApprovalCard({
  approval,
  connected,
  busy,
  onApprove,
  onReject,
  onResume,
}: {
  approval: TutorialApproval;
  connected: boolean;
  busy: boolean;
  onApprove(): void;
  onReject(): void;
  onResume(): void;
}) {
  const [expired, setExpired] = useState(() => Date.parse(approval.expiresAt) <= Date.now());
  useEffect(() => {
    const expiresAt = Date.parse(approval.expiresAt);
    const remaining = expiresAt - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining + 50);
    return () => clearTimeout(timer);
  }, [approval.expiresAt]);
  const preview = approval.preview;
  const explanation = preview.explanation;
  const exactChange = preview.kind === "tutorial_preferences_store"
    ? "응답 설정을 VM 세션에 저장"
    : preview.kind === "calendar"
      ? "Google Calendar 일정 생성"
      : "Google Task 생성";
  const executor = preview.kind === "tutorial_preferences_store"
    ? "Brain VM Tutorial service → SQLite"
    : "공용 데모 Brain → Google 공용 데모 계정";
  // 버튼 문구가 단계마다 달라야 무엇을 승인하는지 구분된다.
  // 이전에는 calendar와 task가 모두 "표시된 내용만 승인"이라 같은 화면처럼 보였다.
  const approveLabel = preview.kind === "tutorial_preferences_store"
    ? "이 설정 저장하기"
    : preview.kind === "calendar" ? "이 일정 만들기" : "이 할 일 만들기";
  const rejectLabel = preview.kind === "tutorial_preferences_store"
    ? "저장하지 않고 계속"
    : preview.kind === "calendar" ? "일정 만들지 않고 계속" : "할 일 만들지 않고 계속";
  // 대상까지 함께 보여줘야 같은 종류가 반복돼도 구분된다.
  const approvalTarget = preview.kind === "tutorial_preferences_store"
    ? "응답 설정을 이 탭 세션에 저장"
    : preview.kind === "calendar"
      ? `Google 캘린더 일정 «${preview.fields.title}»`
      : `Google 할 일 «${preview.fields.title}»`;
  return <section className="tutorial-approval" aria-label="실행 전 승인 미리보기">
    <div className="tutorial-proof-label"><span aria-hidden="true">○</span> 아직 실행되지 않음</div>
    <p>{preview.message}</p>
    <ExplanationSummary
      label="승인 근거 요약"
      rows={[
        { label: "왜 지금", value: explanation.whyNow.summary },
        { label: "사용 데이터", value: dataUseSummary(explanation.dataUsed) },
        { label: "처리", value: "Self-hosted Brain VM · Tutorial service" },
        { label: "정확한 변경", value: exactChange },
        { label: "실행 주체", value: executor },
        { label: "승인", value: "필수 · 승인해야 실행" },
        { label: "변경 상태", value: "실행 전 · 외부 변경 없음" },
        { label: "보존", value: `VM ${formatTimestamp(explanation.retention.memoryExpiresAt)}까지 · Google 성공 시 30분 후 정리` },
      ]}
    />
    {preview.kind === "tutorial_preferences_store" && <>
      <PreferenceFields fields={preview.fields} />
      <dl className="tutorial-facts">
        <div><dt>저장 위치</dt><dd>Brain VM · 세션 전용 SQLite</dd></div>
        <div><dt>실행 주체</dt><dd>Tutorial service</dd></div>
      </dl>
    </>}
    {preview.kind === "calendar" && <dl className="tutorial-facts">
      <div><dt>종류</dt><dd>Google Calendar 일정 생성</dd></div>
      <div><dt>제목</dt><dd>{preview.fields.title}</dd></div>
      <div><dt>시작</dt><dd><time dateTime={preview.fields.startAt}>{formatTimestamp(preview.fields.startAt)}</time></dd></div>
      <div><dt>종료</dt><dd><time dateTime={preview.fields.endAt}>{formatTimestamp(preview.fields.endAt)}</time></dd></div>
      <div><dt>시간대</dt><dd>{preview.fields.timeZone}</dd></div>
      <div><dt>실행 주체</dt><dd>공용 데모 Brain → Google 공용 데모 계정</dd></div>
    </dl>}
    {preview.kind === "task" && <dl className="tutorial-facts">
      <div><dt>종류</dt><dd>Google Task 생성</dd></div>
      <div><dt>제목</dt><dd>{preview.fields.title}</dd></div>
      <div><dt>마감일</dt><dd><time dateTime={preview.fields.due}>{preview.fields.due}</time></dd></div>
      <div><dt>실행 주체</dt><dd>공용 데모 Brain → Google 공용 데모 계정</dd></div>
    </dl>}
    <div className="tutorial-retention">
      <strong>보존 정책</strong>
      <p>VM의 체험 기억은 {formatTimestamp(preview.explanation.retention.memoryExpiresAt)}에 만료돼요. Google 생성이 성공하면 30분 뒤 자동 삭제를 시도해요.</p>
    </div>
    <details className="tutorial-meta-details">
      <summary>승인 요청 식별 정보</summary>
      <dl className="tutorial-facts">
        <div><dt>Request ID</dt><dd>{approval.requestId}</dd></div>
        <div><dt>승인 만료</dt><dd>{formatTimestamp(approval.expiresAt)}</dd></div>
      </dl>
    </details>
    {expired && <p className="tutorial-inline-warning">승인 시간이 지나 새 미리보기가 필요해요.</p>}
    {/* 승인 화면이 연속으로 이어지면 무엇을 승인하는지 구분되지 않는다.
        실행 대상을 버튼 바로 위에 한 줄로 다시 보여준다. */}
    {!expired && <p className="tutorial-approval-target">
      이번에 실행할 것: <strong>{approvalTarget}</strong>
    </p>}
    {expired
      ? <button className="primary" type="button" disabled={!connected || busy} onClick={onResume}>서버 상태 확인 후 새 미리보기</button>
      : <div className="tutorial-actions split">
        <button type="button" disabled={!connected || busy} onClick={onReject}>{rejectLabel}</button>
        <button
          className="primary"
          type="button"
          disabled={!connected || busy}
          onClick={onApprove}
          title={`${approvalTarget} — 지금 실행합니다`}
        >{approveLabel}</button>
      </div>}
  </section>;
}

function GoogleStatusCard({ kind, status, cleanup }: { kind: TutorialGoogleKind; status?: TutorialGoogleStatus | null; cleanup?: TutorialCleanupStatus }) {
  return <div className={`tutorial-result status-${status ?? "unknown-result"}`}>
    <strong>{kind === "calendar" ? "Calendar" : "Task"}</strong>
    <span>{status ? STATUS_LABELS[status] : "실행 결과 확인 중"}</span>
    {cleanup && <small>정리: {CLEANUP_LABELS[cleanup]}</small>}
  </div>;
}

function GoogleReceiptDetails({
  kind,
  result,
  forgotten,
}: {
  kind: TutorialGoogleKind;
  result: TutorialReceiptGoogleAction;
  forgotten: boolean;
}) {
  const fields = result.sentFields;
  const providerId = result.providerId
    ?? (result.cleanupStatus === "succeeded" ? "자동 삭제 완료 후 제거됨" : "없음");
  const createdAt = result.createdAt
    ? formatTimestamp(result.createdAt)
    : forgotten && result.status === "succeeded" ? "VM 기억 삭제 후 제거됨" : "생성 확인 없음";
  return <section className="tutorial-google-detail">
    <strong>{kind === "calendar" ? "Calendar" : "Task"}</strong>
    <dl className="tutorial-facts">
      <div><dt>상태</dt><dd>{STATUS_LABELS[result.status]}</dd></div>
      <div><dt>Request ID</dt><dd>{result.requestId}</dd></div>
      <div><dt>Provider ID</dt><dd>{providerId}</dd></div>
      <div><dt>생성 시각</dt><dd>{createdAt}</dd></div>
      <div><dt>자동 정리 예정</dt><dd>{result.cleanupDueAt ? formatTimestamp(result.cleanupDueAt) : "해당 없음"}</dd></div>
      <div><dt>정리 상태</dt><dd>{CLEANUP_LABELS[result.cleanupStatus]}</dd></div>
      {fields ? <>
        <div><dt>전송 제목</dt><dd>{fields.title}</dd></div>
        {"startAt" in fields && <>
          <div><dt>전송 시작</dt><dd>{formatTimestamp(fields.startAt)}</dd></div>
          <div><dt>전송 종료</dt><dd>{formatTimestamp(fields.endAt)}</dd></div>
          <div><dt>전송 시간대</dt><dd>{fields.timeZone}</dd></div>
        </>}
        {"due" in fields && <div><dt>전송 마감일</dt><dd>{fields.due}</dd></div>}
      </> : <div><dt>전송 필드</dt><dd>{forgotten && result.status === "succeeded" ? "VM 기억 삭제 후 제거됨" : "Google에 전송되지 않음"}</dd></div>}
    </dl>
  </section>;
}

function sourceLabel(source: TutorialSource): string {
  if (source.type === "vm_memory") return `VM 세션 기억 · recordVersion ${source.recordVersion}`;
  const kind = source.type === "google_calendar_receipt" ? "Calendar" : "Task";
  return `${kind} 영수증 · Request ID ${source.requestId} · Provider ID ${source.providerId}`;
}

function SourceList({ label, sources }: { label: string; sources: TutorialSource[] }) {
  return <div className="tutorial-source-group">
    <span>{label}</span>
    {sources.length > 0
      ? <ul>{sources.map((source) => <li key={sourceLabel(source)}>{sourceLabel(source)}</li>)}</ul>
      : <p>추가 grounding source 없음</p>}
  </div>;
}

/**
 * 성공한 Calendar 실행을 방문자의 개인 캘린더로 복사하는 선택지.
 *
 * 공용 데모의 Google 실행을 다시 부르지 않는다. 명시적인 클릭 전에는 아무것도
 * 열거나 내려받지 않는다. 방문자의 OAuth·이메일은 수집하지 않는다.
 */
function CalendarHandoffCard({ action }: { action: TutorialReceiptGoogleAction | null }) {
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const handoff = calendarHandoffFrom(action);
  if (!handoff) return null;

  function downloadIcs() {
    const ics = buildCalendarIcs(handoff!);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      // iOS Safari는 Blob 다운로드가 조용히 실패하는 경우가 있다. download 속성을
      // 지원하지 않으면 새 탭으로 여는 경로를 대신 안내한다.
      if (typeof link.download !== "string") {
        setFallbackUrl(url);
        setNotice("이 브라우저는 파일 저장을 지원하지 않아요. 아래 링크로 열어서 캘린더에 추가해 주세요.");
        return;
      }
      link.href = url;
      link.download = icsFileName();
      link.rel = "noopener noreferrer";
      link.click();
      setNotice("캘린더 파일을 내려받았어요. 캘린더 앱에서 열어 최종 저장해 주세요.");
      // 링크를 계속 살려둘 이유가 없다. fallback 을 띄운 경우에만 유지한다.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setFallbackUrl(url);
      setNotice("파일 저장이 막혀 있어요. 아래 링크로 열어서 캘린더에 추가해 주세요.");
    }
  }

  return <section className="tutorial-handoff" aria-label="내 캘린더로 복사">
    <strong>내 캘린더로 복사하기</strong>
    <ul className="tutorial-handoff-notice">
      {HANDOFF_NOTICES.map((line) => <li key={line}>{line}</li>)}
    </ul>
    <p className="tutorial-handoff-target">
      {handoff.fields.title} · {formatTimestamp(handoff.fields.startAt)} 시작 · {handoff.displayTimeZone} 기준
    </p>
    <div className="tutorial-handoff-actions">
      <button type="button" onClick={downloadIcs}>캘린더 파일(ICS)로 추가</button>
      <a
        href={buildGoogleCalendarUrl(handoff)}
        target="_blank"
        rel="noopener noreferrer"
      >내 Google Calendar에서 열기</a>
    </div>
    {fallbackUrl && <p className="tutorial-handoff-fallback">
      <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">캘린더 파일 열기</a>
    </p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

function ReceiptCard({ receipt }: { receipt: TutorialReceipt }) {
  const explanation = receipt.explanation;
  const googleResultSummary = (["calendar", "task"] as const)
    .flatMap((kind) => explanation.exactChange.fields.google[kind]
      ? [`${kind === "calendar" ? "Calendar" : "Task"} ${STATUS_LABELS[explanation.exactChange.fields.google[kind]!]}`]
      : [])
    .join(" · ") || "Google 실행 기록 없음";
  const approvalStatus = {
    approved: "승인됨",
    rejected: "거절됨",
    skipped: "건너뜀",
    not_required: "승인 불필요",
  }[explanation.approval.status];
  const changeState = {
    completed: "확정된 실행 결과",
    not_run: "실행되지 않음",
    uncertain: "결과 확인 불가",
  }[explanation.changeState];
  return <section className="tutorial-receipt" aria-label="서버 실행 영수증">
    <header><strong>서버 실행 영수증</strong><span>{receipt.storage.memoryStatus === "forgotten" ? "삭제 후 최소 정보" : "현재 서버 기록"}</span></header>
    <ExplanationSummary
      label="실행 영수증 근거 요약"
      rows={[
        { label: "왜 지금", value: explanation.whyNow.summary },
        { label: "사용 데이터", value: dataUseSummary(explanation.dataUsed) },
        { label: "처리", value: "Self-hosted Brain VM · strict Ollama" },
        { label: "실제 결과", value: googleResultSummary },
        { label: "실행 주체", value: `공용 데모 Brain → ${explanation.executor.target === "google" ? "Google" : "SQLite"}` },
        { label: "승인", value: approvalStatus },
        { label: "변경 상태", value: changeState },
        { label: "보존", value: `VM ${formatTimestamp(explanation.retention.memoryExpiresAt)}까지 · Google ${explanation.retention.googleCleanupDueAt ? `${formatTimestamp(explanation.retention.googleCleanupDueAt)} 정리 예정` : "정리 대상 없음"}` },
      ]}
    />
    <dl className="tutorial-facts">
      <div><dt>처리 위치</dt><dd>Self-hosted Brain VM</dd></div>
      <div><dt>답변 경로</dt><dd>Strict Ollama · local · fallback 없음</dd></div>
      <div><dt>VM 기억</dt><dd>{receipt.storage.memoryStatus === "forgotten" ? "삭제 확인" : receipt.storage.memoryStatus === "saved" ? "세션에 저장됨" : "저장 없음"}</dd></div>
      <div><dt>Google 미전송</dt><dd>{receipt.notSentToGoogle.join(", ")}</dd></div>
    </dl>
    <CalendarHandoffCard action={receipt.google.calendar} />
    <section className="tutorial-sources" aria-label="답변에 사용된 실제 source">
      <strong>답변에 사용된 실제 source</strong>
      {receipt.answerBefore && <SourceList label="삭제 전 답변" sources={receipt.answerBefore.sources} />}
      {receipt.answerAfter && <SourceList label="삭제 후 답변" sources={receipt.answerAfter.sources} />}
      {!receipt.answerBefore && !receipt.answerAfter && <p>영수증에 남은 답변 source 없음</p>}
    </section>
    {receipt.preferences && <details>
      <summary>승인한 응답 설정</summary>
      <PreferenceFields fields={receipt.preferences} />
    </details>}
    <div className="tutorial-result-grid">
      {(["calendar", "task"] as const).map((kind) => {
        const result = receipt.google[kind];
        return result
          ? <GoogleStatusCard key={kind} kind={kind} status={result.status} cleanup={result.cleanupStatus} />
          : <div className="tutorial-result" key={kind}><strong>{kind === "calendar" ? "Calendar" : "Task"}</strong><span>실행 기록 없음</span></div>;
      })}
    </div>
    <details>
      <summary>Google 요청·전송 상세</summary>
      <div className="tutorial-google-details">
        {(["calendar", "task"] as const).map((kind) => {
          const result = receipt.google[kind];
          return result
            ? <GoogleReceiptDetails key={kind} kind={kind} result={result} forgotten={receipt.storage.memoryStatus === "forgotten"} />
            : <div className="tutorial-result" key={kind}><strong>{kind === "calendar" ? "Calendar" : "Task"}</strong><span>실행 기록 없음</span></div>;
        })}
      </div>
    </details>
    <details>
      <summary>경로·작업 식별자·정리 시각</summary>
      <dl className="tutorial-facts">
        <div><dt>Operation ID</dt><dd>{receipt.operationId}</dd></div>
        {receipt.answerBefore && <div><dt>삭제 전 모델</dt><dd>{receipt.answerBefore.route.model}</dd></div>}
        {receipt.answerAfter && <div><dt>삭제 후 모델</dt><dd>{receipt.answerAfter.route.model}</dd></div>}
        <div><dt>기억 만료</dt><dd>{formatTimestamp(receipt.expiresAt)}</dd></div>
        <div><dt>Google 자동 정리</dt><dd>{receipt.explanation.retention.googleCleanupDueAt ? formatTimestamp(receipt.explanation.retention.googleCleanupDueAt) : "해당 없음"}</dd></div>
      </dl>
    </details>
  </section>;
}

function GoogleStep({
  kind,
  state,
  connected,
  onPrepare,
  onSkip,
}: {
  kind: TutorialGoogleKind;
  state: TutorialState;
  connected: boolean;
  onPrepare(kind: TutorialGoogleKind): void;
  onSkip(kind: TutorialGoogleKind): void;
}) {
  const previous = state.google[kind];
  return <>
    {previous && <GoogleStatusCard kind={kind} status={previous.status} cleanup={previous.cleanupStatus} />}
    <div className="tutorial-boundary-card">
      <strong>{kind === "calendar" ? "해커톤 준비 일정" : "발표 준비 Task"}</strong>
      <p>서버가 고정 시나리오와 승인된 설정으로 정확한 초안을 만들어요. 지금은 Google에 아무 변경도 없습니다.</p>
    </div>
    <div className="tutorial-actions split">
      <button type="button" disabled={!connected || state.busy} onClick={() => onSkip(kind)}>만들지 않고 계속</button>
      <button className="primary" type="button" disabled={!connected || state.busy} onClick={() => onPrepare(kind)}>변경 내용 미리보기</button>
    </div>
  </>;
}

export function TutorialPanel({
  connected,
  secureSession,
  state,
  draft,
  dispatchDraft,
  onStart,
  onResume,
  onPreparePreferences,
  onApprove,
  onReject,
  onPrepareGoogle,
  onSkipGoogle,
  onGenerateAnswer,
  onGetReceipt,
  onForget,
}: TutorialPanelProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const phaseKey = state.snapshot?.phase ?? (state.flowId ? "syncing" : "intro");
  const viewKey = `${phaseKey}:${draft.step}:${state.needsResume ? "resume" : "active"}:${state.error?.code ?? ""}:${state.error?.message ?? ""}:${state.approval?.requestId ?? ""}:${state.receipt?.operationId ?? ""}`;
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      bodyRef.current.scrollLeft = 0;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [viewKey]);

  const phase = state.snapshot?.phase;
  const redactedReceipt = state.receipt?.storage.memoryStatus === "forgotten" ? state.receipt : null;
  // 좁은 화면에서는 소개를 접어 체험 영역을 먼저 보여준다. 넓은 화면은 그대로 펼친다.
  // 한 번 정하면 단계가 바뀌어도 사용자의 선택을 유지한다.
  const [introOpen, setIntroOpen] = useState(() => !isNarrowViewport());

  const finalReceiptReady = Boolean(redactedReceipt?.answerAfter);
  return <section className="tutorial-panel" aria-labelledby="tutorial-heading">
    <header className="tutorial-header">
      <div>
        <span className="tutorial-kicker">공개 데모 · 약 5~8분</span>
        <h2 id="tutorial-heading" ref={headingRef} tabIndex={-1}>{headingFor(state)}</h2>
      </div>
      {state.snapshot && <span className="tutorial-phase">{phase === "completed" ? "완료" : "진행 중"}</span>}
    </header>
    <p className="tutorial-status" role="status">{statusFor(state, connected, secureSession)}</p>

    <div className="tutorial-body" ref={bodyRef}>
      {state.error && <div className="tutorial-error" role="alert">
        <strong>결과를 성공으로 처리하지 않았어요</strong>
        <p>{state.error.message}</p>
        {state.error.code === "local_model_unavailable" && <small>Cloud 답변으로 바꾸지 않습니다.</small>}
      </div>}
      {!state.flowId && !state.busy && <>
        <div className="tutorial-boundary-card hero">
          {/* 한 줄 약속은 항상 보인다. 이게 제품의 핵심 주장이라 접지 않는다. */}
          <strong>먼저 보여 주고, 허락받은 것만 실행해요.</strong>
          <button
            type="button"
            className="tutorial-intro-toggle"
            aria-expanded={introOpen}
            aria-controls="tutorial-intro-detail"
            onClick={() => setIntroOpen((open) => !open)}
          >{introOpen ? "설명 접기" : "이 체험이 무엇인지 보기"}</button>
          {/* hidden 은 접근성 트리와 탭 순서에서도 제외한다. 시각적으로만 숨기지 않는다. */}
          <div id="tutorial-intro-detail" hidden={!introOpen}>
            <p>응답 설정은 Brain VM의 이 탭 세션에만 저장됩니다. Google 단계는 공용 데모 계정을 사용하고 개인 Google 계정에는 접근하지 않아요.</p>
            <ul>
              <li>승인 전에는 VM 저장·Google 변경 없음</li>
              <li>답변은 Brain VM의 strict Ollama만 사용</li>
              <li>영수증 확인 뒤 VM 기억을 즉시 삭제 가능</li>
            </ul>
          </div>
        </div>
        <button className="tutorial-start primary" type="button" disabled={!connected || !secureSession} onClick={onStart}>체험 시작</button>
      </>}

      {state.needsResume && state.flowId && !state.busy && <button className="primary" type="button" disabled={!connected} onClick={onResume}>서버 상태부터 확인</button>}

      {!state.needsResume && state.approval && <ApprovalCard approval={state.approval} connected={connected} busy={state.busy} onApprove={onApprove} onReject={onReject} onResume={onResume} />}

      {!state.needsResume && phase === "preferences_pending" && !state.approval && !state.busy && <PreferenceWizard
        connected={connected}
        busy={state.busy}
        draft={draft}
        dispatch={dispatchDraft}
        onPrepare={onPreparePreferences}
      />}
      {!state.needsResume && phase === "preferences_pending" && !state.approval && !state.busy && <details>
        <summary>현재 선택 요약</summary>
        <PreferenceFields fields={{ ...draft.preferences, preparationMinutes: draft.preparationMinutes }} />
      </details>}

      {!state.needsResume && phase === "calendar_pending" && !state.approval && !state.busy && <GoogleStep kind="calendar" state={state} connected={connected} onPrepare={onPrepareGoogle} onSkip={onSkipGoogle} />}
      {!state.needsResume && phase === "task_pending" && !state.approval && !state.busy && <GoogleStep kind="task" state={state} connected={connected} onPrepare={onPrepareGoogle} onSkip={onSkipGoogle} />}

      {!state.needsResume && phase === "answer_before" && !state.busy && <>
        <div className="tutorial-boundary-card"><strong>승인된 근거만 사용</strong><p>VM에 저장된 네 가지 설정과 성공이 확인된 Google 영수증만 로컬 모델에 전달해요.</p></div>
        <button className="primary" type="button" disabled={!connected} onClick={() => onGenerateAnswer("before")}>기억을 사용해 답변 생성</button>
      </>}

      {state.answers.before && (phase === "receipt_ready" || phase === "forgetting") && <article className="tutorial-answer">
        <span>삭제 전 · {state.answers.before.route.model}</span><p>{state.answers.before.content}</p>
      </article>}

      {!state.needsResume && phase === "receipt_ready" && !state.busy && <>
        {state.receipt ? <ReceiptCard receipt={state.receipt} /> : <button className="primary" type="button" disabled={!connected} onClick={onGetReceipt}>서버 영수증 확인</button>}
        {state.receipt && <button className="tutorial-danger" type="button" disabled={!connected} onClick={onForget}>VM 기억 지금 잊기</button>}
      </>}

      {!state.needsResume && phase === "forgotten" && !state.busy && <>
        <div className="tutorial-deletion-proof">
          <strong>✓ VM 기억 삭제 확인</strong>
          <p>응답 설정과 삭제 전 답변 근거는 VM 세션 저장소에서 제거됐어요. Google 정리 상태는 별도로 확인합니다.</p>
        </div>
        {state.forgotten && <div className="tutorial-result-grid">
          <GoogleStatusCard kind="calendar" status={state.google.calendar?.status ?? state.receipt?.google.calendar?.status ?? state.snapshot?.calendarStatus} cleanup={state.forgotten.googleCleanup.calendar} />
          <GoogleStatusCard kind="task" status={state.google.task?.status ?? state.receipt?.google.task?.status ?? state.snapshot?.taskStatus} cleanup={state.forgotten.googleCleanup.task} />
        </div>}
        {redactedReceipt ? <>
          <ReceiptCard receipt={redactedReceipt} />
          <button className="primary" type="button" disabled={!connected} onClick={() => onGenerateAnswer("after")}>삭제된 상태로 다시 답변</button>
        </> : <button className="primary" type="button" disabled={!connected} onClick={onGetReceipt}>삭제 후 영수증 다시 확인</button>}
      </>}

      {!state.needsResume && phase === "completed" && !state.busy && <>
        {(state.answers.before || state.answers.after) && <section className="tutorial-comparison" aria-label="삭제 전후 답변 비교">
          <strong>삭제 전후 답변 비교</strong>
          {state.answers.before
            ? <article className="tutorial-answer">
              <span>삭제 전 · {state.answers.before.route.model}</span><p>{state.answers.before.content}</p>
              <SourceList label="사용 source" sources={state.answers.before.sources} />
            </article>
            : <p className="tutorial-comparison-missing">새로고침 이후라 삭제 전 답변 본문은 복원하지 않아요.</p>}
          {state.answers.after && <article className="tutorial-answer after">
            <span>삭제 후 · {state.answers.after.route.model}</span><p>{state.answers.after.content}</p>
            <SourceList label="사용 source" sources={state.answers.after.sources} />
          </article>}
        </section>}
        {redactedReceipt && <ReceiptCard receipt={redactedReceipt} />}
        {(!redactedReceipt || !redactedReceipt.answerAfter) && <button className="primary" type="button" disabled={!connected} onClick={onGetReceipt}>완료 영수증 다시 확인</button>}
        <div className="tutorial-complete">
          <strong>{finalReceiptReady ? "체험 완료" : "체험 완료 · 영수증 갱신 필요"}</strong>
          <p>{finalReceiptReady
            ? "저장·외부 실행·삭제·로컬 답변의 근거를 서버 영수증으로 확인했어요."
            : "삭제 후 답변은 완료됐어요. 최신 서버 영수증을 다시 확인해 근거를 마무리해 주세요."}</p>
        </div>
      </>}

      {state.busy && <div className="tutorial-wait" aria-hidden="true"><span /><p>확인 중…</p></div>}
    </div>
  </section>;
}
