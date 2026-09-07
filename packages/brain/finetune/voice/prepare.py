"""Fish Speech용 음성 샘플 전처리.

기존 녹음 또는 생성 음성을 Fish Speech reference/학습 자산으로 변환한다.
- 무음 구간 기준 분할 (긴 파일 → 3~15초 단위 클립)
- 볼륨 정규화
- 검수용 CSV와 Fish Speech `.lab` 대본 템플릿 생성

의존성: pydub, ffmpeg (시스템 설치 필요)

사용 예:
    python -m finetune.voice.prepare \\
        --input_dir raw_audio \\
        --output_dir prepared_audio
"""
from __future__ import annotations

import csv
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_WAV_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a"}


class VoicePreparer:
    """음성 샘플 전처리 도구."""

    def normalize(self, input_path: str, output_path: str, target_dbfs: float = -20.0) -> str:
        """오디오 파일 볼륨을 정규화한다.

        Args:
            input_path: 입력 오디오 파일 경로
            output_path: 출력 파일 경로
            target_dbfs: 목표 dBFS 볼륨 (기본 -20.0)

        Returns:
            출력 파일 경로

        Raises:
            ImportError: pydub 미설치 시
        """
        try:
            from pydub import AudioSegment  # type: ignore
            from pydub import effects as pydub_effects  # type: ignore
        except (ImportError, TypeError):
            raise ImportError(
                "pydub가 설치되지 않았습니다. "
                "'pip install pydub' 및 ffmpeg 설치 후 재시도하세요."
            )

        audio = AudioSegment.from_file(input_path)
        change = target_dbfs - audio.dBFS
        normalized = audio.apply_gain(change)

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        normalized.export(output_path, format="wav")
        logger.info(f"정규화 완료: {output_path} ({change:+.1f} dBFS)")
        return output_path

    def split_by_silence(
        self,
        input_path: str,
        output_dir: str,
        min_silence_ms: int = 500,
        silence_thresh_dbfs: float = -40.0,
        min_clip_ms: int = 3000,
        max_clip_ms: int = 15000,
    ) -> list[str]:
        """무음 구간을 기준으로 오디오를 분할한다.

        Args:
            input_path: 분할할 오디오 파일
            output_dir: 분할된 클립 저장 디렉토리
            min_silence_ms: 무음으로 간주할 최소 지속 시간 (ms)
            silence_thresh_dbfs: 무음 임계값 (dBFS)
            min_clip_ms: 최소 클립 길이 (ms) — 이보다 짧으면 이전 클립과 합침
            max_clip_ms: 최대 클립 길이 (ms) — 이보다 길면 강제 분할

        Returns:
            생성된 클립 파일 경로 목록

        Raises:
            ImportError: pydub 미설치 시
        """
        try:
            from pydub import AudioSegment  # type: ignore
            from pydub.silence import split_on_silence  # type: ignore
        except (ImportError, TypeError):
            raise ImportError(
                "pydub가 설치되지 않았습니다. "
                "'pip install pydub' 및 ffmpeg 설치 후 재시도하세요."
            )

        os.makedirs(output_dir, exist_ok=True)
        audio = AudioSegment.from_file(input_path)
        chunks = split_on_silence(
            audio,
            min_silence_len=min_silence_ms,
            silence_thresh=silence_thresh_dbfs,
            keep_silence=200,
        )

        # 너무 짧은 청크 합치기
        merged: list[AudioSegment] = []
        current: AudioSegment | None = None
        for chunk in chunks:
            if current is None:
                current = chunk
            elif len(current) < min_clip_ms:
                current += chunk
            else:
                merged.append(current)
                current = chunk
        if current is not None:
            merged.append(current)

        # 너무 긴 청크 강제 분할
        final_chunks: list[AudioSegment] = []
        for chunk in merged:
            if len(chunk) <= max_clip_ms:
                final_chunks.append(chunk)
            else:
                step = max_clip_ms
                for start in range(0, len(chunk), step):
                    final_chunks.append(chunk[start:start + step])

        output_paths = []
        stem = Path(input_path).stem
        for i, chunk in enumerate(final_chunks):
            out_path = os.path.join(output_dir, f"{stem}_{i+1:03d}.wav")
            chunk.export(out_path, format="wav")
            output_paths.append(out_path)

        logger.info(f"분할 완료: {len(output_paths)}개 클립 → {output_dir}")
        return output_paths

    def preprocess(self, input_dir: str, output_dir: str) -> list[str]:
        """디렉토리 내 모든 오디오 파일을 정규화 + 분할 처리한다.

        Args:
            input_dir: 원본 오디오 파일 디렉토리
            output_dir: 처리된 클립 출력 디렉토리

        Returns:
            생성된 WAV 파일 경로 목록
        """
        all_outputs: list[str] = []
        for f in sorted(Path(input_dir).iterdir()):
            if f.suffix.lower() not in _WAV_EXTENSIONS:
                continue
            normalized = self.normalize(str(f), str(Path(output_dir) / f.name))
            clips = self.split_by_silence(normalized, output_dir)
            all_outputs.extend(clips)
        return all_outputs

    def generate_transcript_template(self, wav_dir: str) -> str:
        """WAV 파일 목록에서 레이블링 템플릿 CSV를 생성한다.

        텍스트 컬럼은 비워두고 수동으로 기입한다.

        Args:
            wav_dir: WAV 파일이 있는 디렉토리

        Returns:
            생성된 CSV 파일 경로 (wav_dir/labels.csv)
        """
        wav_files = sorted(
            f.name for f in Path(wav_dir).iterdir()
            if f.suffix.lower() == ".wav"
        )
        csv_path = os.path.join(wav_dir, "labels.csv")
        with open(csv_path, "w", encoding="utf-8", newline="") as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(["filename", "text"])
            for wav in wav_files:
                writer.writerow([wav, ""])  # 텍스트는 수동 기입

        logger.info(f"레이블 템플릿 생성: {csv_path} ({len(wav_files)}개 파일)")
        return csv_path

    def generate_lab_templates(self, audio_dir: str) -> list[str]:
        """Fish Speech용 빈 `.lab` 대본 파일을 생성한다.

        각 오디오 파일과 같은 stem의 `.lab` 파일을 만들며 기존 파일은
        덮어쓰지 않는다. 사용자가 실제 발화문을 한 줄로 입력해야 한다.
        """
        lab_paths: list[str] = []
        for audio_path in sorted(Path(audio_dir).iterdir()):
            if audio_path.suffix.lower() not in _WAV_EXTENSIONS:
                continue
            lab_path = audio_path.with_suffix(".lab")
            if not lab_path.exists():
                lab_path.write_text("", encoding="utf-8")
            lab_paths.append(str(lab_path))
        logger.info("Fish Speech .lab 템플릿 생성: %d개", len(lab_paths))
        return lab_paths


# ── CLI 진입점 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="음성 샘플 전처리")
    parser.add_argument("--input_dir", required=True, help="원본 오디오 디렉토리")
    parser.add_argument("--output_dir", required=True, help="출력 디렉토리")
    parser.add_argument("--no_split", action="store_true", help="분할 없이 정규화만")
    args = parser.parse_args()

    prep = VoicePreparer()

    if args.no_split:
        for f in Path(args.input_dir).iterdir():
            if f.suffix.lower() in _WAV_EXTENSIONS:
                prep.normalize(str(f), os.path.join(args.output_dir, f.name))
    else:
        clips = prep.preprocess(args.input_dir, args.output_dir)
        print(f"전처리 완료: {len(clips)}개 클립")

    csv_path = prep.generate_transcript_template(args.output_dir)
    lab_paths = prep.generate_lab_templates(args.output_dir)
    print(f"레이블 템플릿: {csv_path}")
    print(f"Fish Speech .lab 템플릿: {len(lab_paths)}개")
    print("→ 각 .lab 파일에 해당 음성의 실제 발화문을 한 줄로 입력하세요.")
