"""Measure a running kirian-qwen3-tts service with short Korean lines: latency, audio length, WAV validity.

Usage: python measure.py [--url http://127.0.0.1:19882] [--runs 2] [--out results.json]
Reports only what was measured on this machine; GPU memory is read from nvidia-smi when available.
"""
from __future__ import annotations

import argparse
import io
import json
import shutil
import statistics
import subprocess
import time
import urllib.request
import wave

LINES = [
    "안녕, 나는 키리안이야. 오늘 하루는 어땠어?",
    "내일 오후 세 시에 치과 예약을 잡아 둘까?",
    "음, 그건 조금 어려울 것 같아. 다시 한번 말해 줄래?",
    "정말 고마워! 덕분에 기분이 훨씬 나아졌어.",
    "지금 서울은 비가 오고 있어. 우산 꼭 챙겨.",
    "알겠어, 회의는 다음 주 수요일 오전 열 시로 준비할게.",
]


def gpu_memory_mib() -> int | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True, timeout=10)
        return int(out.strip().splitlines()[0])
    except (subprocess.SubprocessError, ValueError):
        return None


def synthesize(url: str, text: str, speaker: str, language: str) -> tuple[float, bytes]:
    payload = json.dumps({"text": text, "language": language, "speaker": speaker, "instruct": "", "seed": 12345}).encode()
    request = urllib.request.Request(url + "/tts", data=payload, headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=300) as response:
        body = response.read()
    return time.perf_counter() - started, body


def audio_seconds(data: bytes) -> float:
    with wave.open(io.BytesIO(data), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:19882")
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--speaker", default="Sohee")
    parser.add_argument("--language", default="Korean")
    parser.add_argument("--out")
    parser.add_argument("--save-dir", help="write each WAV here for listening")
    args = parser.parse_args()
    health = json.loads(urllib.request.urlopen(args.url + "/health", timeout=30).read())
    before = gpu_memory_mib()
    warm = synthesize(args.url, LINES[0], args.speaker, args.language)[0]
    rows = []
    for run in range(args.runs):
        for index, line in enumerate(LINES):
            seconds, data = synthesize(args.url, line, args.speaker, args.language)
            length = audio_seconds(data)
            rows.append({"run": run, "line": index, "chars": len(line), "latency_s": round(seconds, 3), "audio_s": round(length, 3),
                         "rtf": round(seconds / length, 3), "bytes": len(data)})
            if args.save_dir:
                from pathlib import Path
                Path(args.save_dir).mkdir(parents=True, exist_ok=True)
                Path(args.save_dir, f"line{index}-run{run}.wav").write_bytes(data)
    after = gpu_memory_mib()
    latencies = [row["latency_s"] for row in rows]
    summary = {"health": health, "warmup_first_call_s": round(warm, 3), "lines": len(LINES), "runs": args.runs,
               "latency_median_s": round(statistics.median(latencies), 3), "latency_max_s": round(max(latencies), 3),
               "rtf_median": round(statistics.median(row["rtf"] for row in rows), 3),
               "gpu_used_mib_before": before, "gpu_used_mib_after": after, "rows": rows}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
