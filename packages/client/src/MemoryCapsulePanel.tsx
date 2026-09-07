import type { MemoryCapsuleMinutes } from "./brain";
import {
  MEMORY_CAPSULE_MINUTES,
  memoryCapsuleErrorLabel,
  memoryCapsuleRetryLabel,
  type MemoryCapsuleState,
} from "./memory-capsule";

type MemoryCapsulePanelProps = {
  connected: boolean;
  unavailableMessage?: string;
  state: MemoryCapsuleState;
  onSelect(minutes: MemoryCapsuleMinutes): void;
  onApprove(): void;
  onReject(): void;
  onRecall(): void;
  onForget(): void;
  onRetry(): void;
  onReset(): void;
  onClose(): void;
};

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ChoiceButtons({
  connected,
  onSelect,
}: Pick<MemoryCapsulePanelProps, "connected" | "onSelect">) {
  return <div className="memory-capsule-choices" aria-label="준비 시간 선택">
    {MEMORY_CAPSULE_MINUTES.map((minutes) => <button
      key={minutes}
      type="button"
      disabled={!connected}
      onClick={() => onSelect(minutes)}
    ><strong>{minutes}분</strong><span>준비 시간</span></button>)}
  </div>;
}

function Progress({ children }: { children: string }) {
  return <div className="memory-capsule-progress" role="status">
    <span aria-hidden="true" />
    <p>{children}</p>
  </div>;
}

export function MemoryCapsulePanel({
  connected,
  unavailableMessage,
  state,
  onSelect,
  onApprove,
  onReject,
  onRecall,
  onForget,
  onRetry,
  onReset,
  onClose,
}: MemoryCapsulePanelProps) {
  const record = state.record;
  return <section className="memory-capsule-panel" aria-label="기억 체험">
    <header>
      <div><strong>기억 체험</strong><span>약 1분 · 선택형 정보만 사용</span></div>
      <button type="button" onClick={onClose} aria-label="기억 체험 닫기">×</button>
    </header>
    <div className="memory-capsule-body">
      <p className="memory-capsule-boundary">
        개인정보나 자유 입력은 받지 않아요. 고른 준비 시간만 이 탭의 세션 기억으로 저장하고, 만료되거나 직접 지우면 검색에서도 제외돼요.
      </p>
      {!connected && <p className="memory-capsule-unavailable" role="alert">
        {unavailableMessage ?? "Brain 연결이 없어 지금은 저장할 수 없어요. 연결되면 선택 버튼이 활성화됩니다."}
      </p>}

      {state.phase === "idle" && <>
        <div className="memory-capsule-step"><span>1</span><div><strong>얼마나 미리 준비할까요?</strong><p>하나를 고르면 저장 전에 내용을 먼저 보여드려요.</p></div></div>
        <ChoiceButtons connected={connected} onSelect={onSelect} />
        <button className="memory-existing-button" type="button" disabled={!connected} onClick={onRecall}>
          이 세션에 저장된 기억 확인
        </button>
      </>}

      {state.phase === "preparing" && <Progress>저장하지 않고 승인 미리보기를 준비하고 있어요.</Progress>}

      {state.phase === "approval" && state.draft && <div className="memory-capsule-preview">
        <div className="memory-capsule-step"><span>2</span><div><strong>저장 전 확인</strong><p>승인하기 전에는 어디에도 저장되지 않아요.</p></div></div>
        <blockquote>{state.draft.capsule.content}</blockquote>
        <dl>
          <div><dt>범위</dt><dd>현재 웹 체험 세션만</dd></div>
          <div><dt>출처</dt><dd>{state.draft.source.label} · {formatTimestamp(state.draft.source.createdAt)}</dd></div>
          <div><dt>자동 만료</dt><dd>{formatTimestamp(state.draft.expiresAt)}</dd></div>
        </dl>
        <div className="memory-capsule-actions"><button type="button" onClick={onReject} disabled={!connected}>취소</button><button className="primary" type="button" onClick={onApprove} disabled={!connected}>승인하고 기억하기</button></div>
      </div>}

      {state.phase === "saving" && <Progress>CouchDB에 저장하고 sqlite-vec · FTS5 검색 인덱스를 동기화하고 있어요.</Progress>}
      {state.phase === "rejecting" && <Progress>승인 요청을 안전하게 취소하고 있어요.</Progress>}

      {(state.phase === "saved" || state.phase === "recalled") && record && <div className="memory-capsule-result">
        <div className="memory-capsule-step"><span>{state.phase === "saved" ? "3" : "4"}</span><div>
          <strong>{state.phase === "saved" ? "저장과 검색 동기화 완료" : "타냐가 기억을 다시 찾았어요"}</strong>
          <p>{record.capsule.content}</p>
        </div></div>
        {state.phase === "saved" && <div className="memory-storage-proof" aria-label="저장 동기화 결과">
          <span>✓ CouchDB 원본</span><span>✓ sqlite-vec</span><span>✓ FTS5</span>
        </div>}
        <div className="memory-source-card">
          <span>출처</span><strong>{record.source.label}</strong><small>{formatTimestamp(record.source.createdAt)} · 이 세션에서 직접 선택</small>
        </div>
        {"relevance" in record && record.relevance !== null && <p className="memory-relevance">검색 관련도 {Math.round(record.relevance * 100)}%</p>}
        <p className="memory-expiry">동기화 {formatTimestamp(record.syncedAt)} · 만료 {formatTimestamp(record.expiresAt)}</p>
        <div className="memory-capsule-actions">
          <button type="button" onClick={onForget} disabled={!connected}>지금 잊기</button>
          {state.phase === "saved" && <button className="primary" type="button" onClick={onRecall} disabled={!connected}>기억을 회상해 보기</button>}
        </div>
      </div>}

      {state.phase === "recalling" && <Progress>이 세션의 미만료 기억을 RAG 검색으로 찾고 있어요.</Progress>}
      {state.phase === "forgetting" && <Progress>CouchDB 원본과 검색 인덱스에서 지우고 있어요.</Progress>}

      {state.phase === "forgotten" && <div className="memory-capsule-finish" role="status">
        <strong>기억을 모두 지웠어요</strong>
        <p>CouchDB 원본과 sqlite-vec · FTS5 검색 인덱스의 삭제를 확인했어요.</p>
        <button type="button" onClick={onReset}>다시 체험하기</button>
      </div>}

      {state.phase === "rejected" && <div className="memory-capsule-finish" role="status">
        <strong>저장하지 않았어요</strong><p>승인 토큰도 취소되어 다시 사용할 수 없어요.</p>
        <button type="button" onClick={onReset}>다시 선택하기</button>
      </div>}

      {state.phase === "empty" && <div className="memory-capsule-finish">
        <strong>회상할 기억이 없어요</strong><p>이 세션에서 저장된 미만료 기억을 찾지 못했어요.</p>
        <button type="button" onClick={onReset}>새로 기억하기</button>
      </div>}

      {state.phase === "failed" && state.error && <div className="memory-capsule-error" role="alert">
        <strong>{memoryCapsuleErrorLabel(state.error.code)}</strong><p>{state.error.message}</p>
        {(state.record || state.draft) && <p className="memory-error-context">
          보존된 선택: {(state.record ?? state.draft)?.capsule.preparationMinutes}분 · 결과를 성공으로 확정하지 않았어요.
        </p>}
        <div className="memory-capsule-error-actions">
          <button type="button" onClick={onReset}>처음부터</button>
          {state.retryOperation && <button type="button" disabled={!connected} onClick={onRetry}>{memoryCapsuleRetryLabel(state.retryOperation)}</button>}
        </div>
      </div>}
    </div>
  </section>;
}
