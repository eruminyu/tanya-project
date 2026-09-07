import type { AgentDockState } from "./agent-dock";
import type { GoogleWriteState } from "./google-write";

interface AgentDockProps { state: AgentDockState; googleWrite: GoogleWriteState; onApproveGoogle(): void; onCancelGoogle(): void; onClose(): void }
const statusText = { running: "실행 중", waiting: "승인 대기", completed: "완료", failed: "실패" } as const;

export function AgentDock({ state, googleWrite, onApproveGoogle, onCancelGoogle, onClose }: AgentDockProps) {
  return <section className="agent-dock" aria-label="Agent Dock">
    <header className="agent-dock-header"><div><strong>Agent Dock</strong><span>현재 작업 하나만 표시해요</span></div><button type="button" onClick={onClose} aria-label="Agent Dock 닫기">×</button></header>
    {googleWrite.status !== "idle" ? <GoogleWriteCard state={googleWrite} onApprove={onApproveGoogle} onCancel={onCancelGoogle} /> : !state.activity ? <div className="agent-dock-empty"><span className="utility-symbol" aria-hidden="true">◇</span><strong>진행 중인 작업이 없어</strong><p>타냐가 도구를 사용하거나 확인이 필요한 작업을 시작하면 여기에 과정과 결과를 보여줄게.</p></div> : <div className="agent-activity">
      <div className={`agent-status ${state.activity.status}`}>{statusText[state.activity.status]}</div><h2>{state.activity.title}</h2>
      <ol className="agent-timeline"><li className="done"><span />요청을 확인했어요</li><li className={state.activity.status}><span />{state.activity.summary}</li></ol>
      {state.activity.sources.length > 0 && <div className="source-chips" aria-label="출처">{state.activity.sources.map((source) => <span key={source}>{source}</span>)}</div>}
      {state.activity.status === "waiting" && <div className="approval-placeholder"><p>실제 정책과 Google 쓰기 스킬의 보안 연결이 완료된 뒤 승인할 수 있어요.</p><button type="button" disabled>승인 기능 준비 중</button></div>}
    </div>}
  </section>;
}

function GoogleWriteCard({ state, onApprove, onCancel }: { state: Exclude<GoogleWriteState, { status: "idle" }>; onApprove(): void; onCancel(): void }) {
  const label = state.status === "preview" ? "승인 대기" : state.status === "executing" ? "생성 중" : state.status === "completed" ? "완료" : "실패";
  return <div className="agent-activity google-write-preview">
    <div className={`agent-status ${state.status === "completed" ? "completed" : state.status === "failed" ? "failed" : "waiting"}`}>{label}</div>
    <h2>{state.draft.kind === "calendar" ? "일정 생성" : "할 일 생성"}</h2>
    {state.draft.executor === "brain" && <p className="google-demo-boundary">웹 체험판의 공용 데모 계정에 생성됩니다. 내 Google 계정에는 접근하지 않아요.</p>}
    <dl><div><dt>제목</dt><dd>{state.draft.title}</dd></div>{state.draft.kind === "calendar" ? <><div><dt>시작</dt><dd>{new Date(state.draft.startAt).toLocaleString("ko-KR")}</dd></div><div><dt>종료</dt><dd>{new Date(state.draft.endAt).toLocaleString("ko-KR")}</dd></div></> : <div><dt>기한</dt><dd>{state.draft.due ?? "없음"}</dd></div>}</dl>
    {state.status === "failed" && <p className="settings-error">{state.message}</p>}
    {state.status === "completed" && <p className="write-receipt">{state.receipt.duplicate ? "이미 처리한 요청이라 기존 결과를 확인했어요." : "Google에 생성했어요."}</p>}
    {(state.status === "preview" || state.status === "failed") && <div className="write-actions"><button type="button" onClick={onCancel}>취소</button><button className="primary" type="button" onClick={onApprove}>{state.status === "failed" ? "다시 시도" : "승인하고 생성"}</button></div>}
  </div>;
}
