import { normalizeBrainUrl } from "./brain";

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function chooseRecordingMimeType(isSupported: (mime: string) => boolean): string {
  return RECORDING_MIME_TYPES.find(isSupported) ?? "";
}

/**
 * 이보다 짧으면 눌렀다 뗀 실수로 본다. 한국어 한 단어("네", "응")도 이보다는 길다.
 * 이 아래에서는 컨테이너가 잘린 채 전송되어 Brain 디코더가 422로 거절한다 (T-012).
 */
export const MIN_RECORDING_MS = 250;

export type RecordingProblem = "too-short" | "no-audio";

/**
 * 서버로 보낼 가치가 있는 녹음인지 판정한다. 문제가 없으면 null.
 *
 * 길이로 판정하고 크기는 보조로만 쓴다. 바이트 크기는 비트레이트에 좌우되어
 * 유효한 짧은 녹음과 잘린 녹음을 구분하지 못한다 (실측: 0.05초 톤이 이미 822바이트).
 */
export function findRecordingProblem(durationMs: number, byteSize: number): RecordingProblem | null {
  if (durationMs < MIN_RECORDING_MS) return "too-short";
  if (byteSize <= 0) return "no-audio";
  return null;
}

export function describeRecordingProblem(problem: RecordingProblem): string {
  return problem === "too-short"
    ? "녹음이 너무 짧습니다. 버튼을 누른 채로 말해 주세요."
    : "마이크에서 소리가 들어오지 않았습니다. 입력 장치를 확인해 주세요.";
}

/**
 * 인식 결과를 입력창에 쓰던 내용 뒤에 이어붙인다.
 * 받아쓰기를 나눠서 할 수 있게 기존 내용을 버리지 않는다 (T-011).
 */
export function mergeVoiceTranscript(current: string, transcript: string): string {
  const kept = current.trim();
  const heard = transcript.trim();
  if (!heard) return kept;
  return kept ? `${kept} ${heard}` : heard;
}

export function toTranscriptionUrl(brainUrl: string): string {
  return `${normalizeBrainUrl(brainUrl)}/stt/transcriptions?language=ko`;
}

export async function requestTranscription(brainUrl: string, audio: Blob): Promise<string> {
  const response = await fetch(toTranscriptionUrl(brainUrl), {
    method: "POST",
    headers: { "Content-Type": audio.type || "audio/webm" },
    body: audio,
  });
  const payload = await response.json().catch(() => ({})) as { text?: unknown; detail?: unknown };
  if (!response.ok) {
    throw new Error(typeof payload.detail === "string" ? payload.detail : `음성 인식 실패 (${response.status})`);
  }
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("음성을 인식하지 못했습니다.");
  }
  return payload.text.trim();
}
