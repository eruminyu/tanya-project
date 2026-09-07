import { describe, expect, it } from "vitest";
import {
  MIN_RECORDING_MS,
  chooseRecordingMimeType,
  describeRecordingProblem,
  findRecordingProblem,
  mergeVoiceTranscript,
  toTranscriptionUrl,
} from "./voice-input";

describe("음성 입력 전송", () => {
  it("Brain 주소를 STT 변환 주소로 바꾼다", () => {
    expect(toTranscriptionUrl("http://192.168.10.20:8098/"))
      .toBe("http://192.168.10.20:8098/stt/transcriptions?language=ko");
  });

  it("WebM Opus를 우선하고 지원 형식이 없으면 브라우저 기본값을 쓴다", () => {
    expect(chooseRecordingMimeType((mime) => mime === "audio/webm;codecs=opus"))
      .toBe("audio/webm;codecs=opus");
    expect(chooseRecordingMimeType(() => false)).toBe("");
  });
});

describe("인식 결과와 입력창 내용 병합", () => {
  it("입력창이 비어 있으면 인식 결과만 남긴다", () => {
    expect(mergeVoiceTranscript("", "안녕 타냐")).toBe("안녕 타냐");
    expect(mergeVoiceTranscript("   ", "안녕 타냐")).toBe("안녕 타냐");
  });

  it("입력창에 쓰던 내용이 있으면 뒤에 이어붙인다", () => {
    expect(mergeVoiceTranscript("오늘 일정", "알려줘")).toBe("오늘 일정 알려줘");
    expect(mergeVoiceTranscript("  오늘 일정  ", "  알려줘  ")).toBe("오늘 일정 알려줘");
  });

  it("인식 결과가 비면 입력창 내용을 그대로 둔다", () => {
    expect(mergeVoiceTranscript("오늘 일정", "   ")).toBe("오늘 일정");
    expect(mergeVoiceTranscript("", "")).toBe("");
  });
});

describe("보낼 가치가 있는 녹음인지 판정", () => {
  it("눌렀다 뗀 수준으로 짧으면 거른다", () => {
    expect(findRecordingProblem(0, 0)).toBe("too-short");
    expect(findRecordingProblem(120, 900)).toBe("too-short");
    expect(findRecordingProblem(MIN_RECORDING_MS - 1, 4000)).toBe("too-short");
  });

  it("최소 길이를 채우면 통과시킨다", () => {
    expect(findRecordingProblem(MIN_RECORDING_MS, 1800)).toBeNull();
    expect(findRecordingProblem(3000, 12000)).toBeNull();
  });

  it("길이는 충분한데 오디오가 비면 마이크 문제로 구분한다", () => {
    expect(findRecordingProblem(3000, 0)).toBe("no-audio");
  });

  it("문제별로 다른 안내를 준다", () => {
    expect(describeRecordingProblem("too-short")).toContain("짧");
    expect(describeRecordingProblem("no-audio")).toContain("마이크");
    expect(describeRecordingProblem("too-short")).not.toBe(describeRecordingProblem("no-audio"));
  });
});
