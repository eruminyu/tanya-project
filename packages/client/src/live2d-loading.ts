export interface Live2DLoadProgress {
  percent: number;
  message: string;
}

export const INITIAL_LIVE2D_LOAD_PROGRESS: Live2DLoadProgress = {
  percent: 5,
  message: "모델 정보 확인 중",
};

export const MODEL_DATA_LOAD_PROGRESS: Live2DLoadProgress = {
  percent: 10,
  message: "모델 데이터 불러오는 중",
};

export const FINALIZING_LIVE2D_LOAD_PROGRESS: Live2DLoadProgress = {
  percent: 98,
  message: "화면에 타냐를 준비하는 중",
};

function normalizedCompleted(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(Math.floor(completed), 0), total);
}

export function supportAssetLoadProgress(completed: number, total: number): Live2DLoadProgress {
  if (total <= 0) return { percent: 30, message: "표정과 움직임 준비 완료" };
  const safeCompleted = normalizedCompleted(completed, total);
  return {
    percent: Math.round(22 + (safeCompleted / total) * 8),
    message: safeCompleted >= total
      ? "표정과 움직임 준비 완료"
      : `표정과 움직임 ${safeCompleted}/${total} 준비 중`,
  };
}

export function textureLoadProgress(completed: number, total: number): Live2DLoadProgress {
  if (total <= 0) return { percent: 95, message: "모델 이미지 준비 완료" };
  const safeCompleted = normalizedCompleted(completed, total);
  return {
    percent: Math.round(30 + (safeCompleted / total) * 65),
    message: safeCompleted >= total
      ? "모델 이미지 준비 완료"
      : `모델 이미지 ${safeCompleted + 1}/${total} 불러오는 중`,
  };
}
