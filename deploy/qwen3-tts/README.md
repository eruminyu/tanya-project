# Qwen3-TTS 음성 서비스 (Sohee)

Brain의 `SpeechBinding`이 호출하는 유일한 음성 합성 서비스다. Qwen3-TTS CustomVoice 모델의 **기본 제공 한국어 여성 음성 `Sohee`**를 이름으로 선택해 쓰며, 참조 음성·음성 복제·별도 학습 경로는 이 서비스에 존재하지 않는다. 기존 GPT-SoVITS 폴더(`/home/kirian/tts/gpt-sovits-*`), venv, 유닛(`kirian-tts-cpufast`, `kirian-gpt-sovits-*`)은 손대지 않고 **새 포트 19882**에 별도로 올린다. 이전 Supertone 샘플·`ref_affection.wav`·학습 가중치는 이 서비스에서 읽지 않는다.

## 계약

| 요청 | 응답 |
| --- | --- |
| `POST /tts` JSON `{"text","language","speaker","instruct","seed"}` | `200 audio/wav` (16-bit PCM 모노, 모델 샘플레이트 24 kHz) |
| `GET /health` | `{"status":"ready","model","speakers","device"}` |

- `speaker`는 `KIRIAN_QWEN3_TTS_SPEAKERS`(기본 `Sohee`)에 있는 이름만 허용, 그 외 `400 unknown_speaker`.
- `ref_audio_path`·`prompt_text` 같은 추가 필드는 `400 invalid_fields`.
- 합성은 한 번에 하나만 실행된다(잠금). 클라이언트가 끊어도 이미 시작한 생성은 멈추지 않으므로 호출 측(Brain `timeout_seconds` ≤ 90초, 클라이언트 재생 취소)이 시간을 관리한다.
- 엔진 오류는 `500 {"error":"synthesis_failed"}`로만 노출한다.
- 텍스트 전처리(이모지 제거 등)는 Brain `prepare_tts_text`가 담당하고, 여기서는 500자 이하만 받는다.

## 고정 버전 (2026-09-17 확인)

| 구성 | 버전/리비전 | 라이선스 |
| --- | --- | --- |
| `qwen-tts` (PyPI) | 0.1.1 (`transformers==4.57.3`, `accelerate==1.12.0` 고정) | Apache-2.0 |
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | 스냅샷 `85e237c12c027371202489a0ec509ded67b5e4b5` (safetensors 1.81 GB) | Apache-2.0 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 스냅샷 `0c0e3051f131929182e2c023b9537f8b1c68adfe` (safetensors 3.83 GB) | Apache-2.0 |
| 음성 토크나이저 | 각 스냅샷의 `speech_tokenizer/`에 포함 (Qwen3-TTS-Tokenizer-12Hz) | Apache-2.0 |
| torch/torchaudio | 2.11.0+cu128 | BSD-3 |

라이선스 원문은 각 HF 모델 카드(`license: apache-2.0`)와 GitHub `QwenLM/Qwen3-TTS`의 LICENSE에서 확인했다. 프로젝트 고지는 `THIRD_PARTY_NOTICES.md`의 Qwen3-TTS 절에 있다.

## 모델 선택 근거 (집 PC 실측, 서버 값 아님)

측정 환경: Windows 11, RTX 5070 Ti 16 GB, Ryzen 7 9800X3D, flash-attn 없음, `measure.py`(한국어 24~31자 6문장 × 2회, seed 12345). 서버(RTX 3070 Ti 8 GB, Linux)의 값은 아직 없다 — 등록 뒤 같은 `measure.py`로 잰다.

| 모델 | 장치 | 첫 호출 | 지연 중앙값 | 지연 최대 | RTF 중앙값 | 최대 VRAM 할당 |
| --- | --- | --- | --- | --- | --- | --- |
| 1.7B CustomVoice | cuda bf16 | 9.8 s | 7.4 s | 10.7 s | 1.63 | 4,153 MiB (sdpa 4,228) |
| 0.6B CustomVoice | cuda bf16 | 9.8 s | 7.1 s | 11.4 s | 1.29 | 2,305 MiB |
| 0.6B CustomVoice | cpu fp32 | — | 25 s (한 문장) | — | 3.4 | — |

- GPU 사용률이 두 모델 모두 20~30 %에 머물러 이 PC에서는 단계별 호출 오버헤드가 병목이며, 모델 크기가 지연에 거의 영향을 주지 않았다. Linux 서버에서 달라질 수 있어 **서버 실측 전에는 이 값으로 응답 시간을 약속하지 않는다.**
- CPU 경로는 RTF 3.4로 실사용 불가 → 서버에서는 GPU가 필요하다.
- 서버 8 GB 예산: Gemma Q5_K_M 약 3.7 GB + STT 1.1 GB 상주. 1.7B(4.2 GB)는 함께 올릴 수 없고, 0.6B(2.3 GB)는 약 7.1 GB로 들어가지만 여유가 적다(자동 기억 임베딩 1.4 GB까지 쓰는 개인 데스크톱 구성은 Ollama 유휴 언로드에 기대게 된다).
- 따라서 **서버 기본값은 0.6B-CustomVoice**이고, `KIRIAN_QWEN3_TTS_MODEL`로 1.7B를 지정하는 것은 서버에서 STT를 내리는 등 VRAM을 실측으로 확보한 뒤에만 한다.
- 음색 판정: 자동 검증은 WAV 유효성·길이·지연만 본다. 두 모델의 같은 문장 샘플(`.cache/qwen3-tts/wav-0.6b`, `wav-1.7b`)을 사용자가 직접 듣고 고른다. 같은 seed에서 0.6B가 같은 문장을 더 길게(5.8 s vs 5.3 s 등) 말하는 경향이 있었다.

## 서버 설치 (kirian 계정)

```sh
bash deploy/qwen3-tts/install.sh          # venv ~/.venvs/kirian-qwen3-tts, 모델 ~/tts/qwen3-tts/hf, 서비스 파일 복사
# 관리자 1회: 출력된 sudo 3줄 → curl http://127.0.0.1:19882/health
~/.venvs/kirian-qwen3-tts/bin/python ~/tts/qwen3-tts/measure.py --runs 2 --out ~/tts/qwen3-tts/measure.json
nvidia-smi                                # Gemma 로드 상태에서 합계 VRAM 확인
```

`pip` 설치와 모델 다운로드는 외부 네트워크를 쓴다. 기존 GPT-SoVITS 유닛은 `disable`만 하고 파일은 남긴다(별도 결정).

## Brain host 설정 예

```json
"speech": {
  "model": {"provider_id": "qwen3-tts", "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "endpoint_id": "kirian-qwen3-tts-19882"},
  "label": "키리안 목소리 (Qwen3-TTS Sohee)",
  "url": "http://127.0.0.1:19882/tts", "boundary": "local",
  "language": "Korean", "speaker": "Sohee", "instruct": "", "seed": 12345, "timeout_seconds": 90
}
```

데스크톱은 SSH 터널 원격 포트를 19882로 바꾸면 된다(`start-voice-tunnel.mjs --remote-tts-port 19882`).
