import { describeDiagnosis, describeUrlProblem, validateBrainUrl, type BrainDiagnosis } from "./brain-url";

interface BrainConnectionPanelProps {
  url: string;
  busy: boolean;
  result: BrainDiagnosis | null;
  onUrlChange(value: string): void;
  onTest(): void;
  onReconnect(): void;
  canReconnect: boolean;
}

function resultTone(result: BrainDiagnosis): string {
  return result.kind === "ok" ? "ok" : "fail";
}

export function BrainConnectionPanel({
  url,
  busy,
  result,
  onUrlChange,
  onTest,
  onReconnect,
  canReconnect,
}: BrainConnectionPanelProps) {
  const validation = validateBrainUrl(url);

  return (
    <div className="brain-connection">
      <label className="text-row">
        Brain URL
        <input value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="http://localhost:8098" />
      </label>

      {!validation.ok && (
        <p className="settings-error" role="alert">{describeUrlProblem(validation.reason)}</p>
      )}

      <div className="brain-connection-actions">
        <button type="button" onClick={onTest} disabled={busy || !validation.ok}>
          {busy ? "확인하는 중…" : "연결 테스트"}
        </button>
        <button type="button" onClick={onReconnect} disabled={!canReconnect || !validation.ok}>
          지금 다시 연결
        </button>
      </div>

      {result && (
        <div className={`brain-diagnosis ${resultTone(result)}`} role="status">
          <strong>{describeDiagnosis(result)}</strong>
          {result.kind === "ok" && result.summary.enabled.length > 0 && (
            <span className="brain-feature-list">켜짐 · {result.summary.enabled.join(", ")}</span>
          )}
          {result.kind === "ok" && result.summary.disabled.length > 0 && (
            <span className="brain-feature-list muted">꺼짐 · {result.summary.disabled.join(", ")}</span>
          )}
        </div>
      )}

      <p className="settings-note">
        주소를 바꾸면 대화 연결과 음성 인식이 함께 새 주소를 사용합니다.
      </p>
    </div>
  );
}
