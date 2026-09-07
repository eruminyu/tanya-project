import type { Live2DLoadProgress } from "./live2d-loading";

export function Live2DLoadingIndicator({ progress }: { progress: Live2DLoadProgress }) {
  return (
    <section className="model-loading" role="status" aria-live="polite">
      <strong>타냐를 처음 준비하고 있어요</strong>
      <p>첫 방문은 모델 파일을 내려받느라 조금 시간이 걸릴 수 있어요.</p>
      <div
        className="model-loading-track"
        role="progressbar"
        aria-label="타냐 모델 로딩 진행률"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="model-loading-meta">
        <span>{progress.message}</span>
        <output>{progress.percent}%</output>
      </div>
    </section>
  );
}
