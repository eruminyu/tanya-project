"""GPT-SoVITS CPUFast HTTP API 기반 TTS Provider."""

import asyncio
import base64
import json
from pathlib import Path
from typing import AsyncIterator

import requests

from core.providers.tts_base import TTSProvider


def _pcm_payload(content: bytes) -> bytes:
    """WAV의 data 청크 본문을 돌려준다. 찾지 못하면 빈 바이트."""
    marker = content.find(b"data", 12)
    if marker == -1:
        return b""
    return content[marker + 8:]


def ensure_audible_wav(content: bytes) -> bytes:
    """합성 실패를 성공으로 통과시키지 않는다.

    GPT-SoVITS는 내부 예외가 나도 HTTP 200을 돌려준다. 실제로 관측된 실패 응답은
    두 종류였다.

    1. `{"message":"tts failed","Exception":"..."}` 형태의 JSON 오류 본문
    2. RIFF 헤더는 멀쩡하고 PCM이 전부 0x00인 무음 WAV

    둘 다 본문이 비어 있지 않아 기존의 `if not content` 검사를 통과했다.
    그 결과 오류 로그도 없이 타냐가 말을 하지 않는 것처럼 보였다.

    무음 판정은 **완전한 디지털 무음일 때만** 실패로 본다. 조용한 발화를 잘못
    실패시키지 않기 위해 진폭 임계값을 쓰지 않는다.
    """
    if not content:
        raise RuntimeError("GPT-SoVITS가 빈 오디오를 반환했습니다.")

    head = content.lstrip()[:1]
    if head in (b"{", b"["):
        detail = content[:300].decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"GPT-SoVITS가 오디오 대신 오류 본문을 반환했습니다: {detail}"
        )

    if content[:4] != b"RIFF" or content[8:12] != b"WAVE":
        raise RuntimeError(
            "GPT-SoVITS 응답이 WAV 형식이 아닙니다. "
            f"앞부분: {content[:16]!r}"
        )

    payload = _pcm_payload(content)
    if not payload:
        raise RuntimeError("GPT-SoVITS WAV에 data 청크가 없습니다.")
    # strip은 C 레벨이라 큰 오디오에서도 빠르다.
    if not payload.strip(b"\x00"):
        raise RuntimeError(
            "GPT-SoVITS가 무음 오디오를 반환했습니다. "
            "합성이 내부에서 실패했을 수 있으니 서버 로그를 확인하세요."
        )
    return content


class GptSovitsProvider(TTSProvider):
    """한국어 타냐 V2Pro 체크포인트를 사용하는 CPUFast Provider."""

    def __init__(
        self,
        url: str,
        reference_audio_path: str,
        prompt_text: str,
        timeout_seconds: float = 45.0,
        seed: int = 12345,
        reference_metadata_path: str = "",
    ):
        self._url = url.rstrip("/")
        self._reference_audio_path = reference_audio_path
        self._prompt_text = prompt_text
        self._timeout_seconds = timeout_seconds
        self._seed = seed
        self._reference_profiles = self._load_reference_profiles(
            reference_metadata_path
        )

    @staticmethod
    def _load_reference_profiles(metadata_path: str) -> dict[str, tuple[str, str]]:
        if not metadata_path:
            return {}

        path = Path(metadata_path)
        try:
            metadata = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            return {}

        profiles: dict[str, tuple[str, str]] = {}
        for tone, profile in metadata.items():
            if not isinstance(profile, dict):
                continue
            relative_path = profile.get("path")
            prompt_text = profile.get("text")
            if not isinstance(relative_path, str) or not isinstance(prompt_text, str):
                continue
            direct_candidate = path.parent / relative_path
            parent_candidate = path.parent.parent / relative_path
            resolved_path = (
                parent_candidate if parent_candidate.exists() else direct_candidate
            )
            profiles[tone] = (str(resolved_path), prompt_text)
        return profiles

    @property
    def provider_name(self) -> str:
        return "gpt-sovits-cpufast"

    @property
    def _health_url(self) -> str:
        api_root = self._url.rsplit("/", maxsplit=1)[0]
        return f"{api_root}/openapi.json"

    def is_available(self) -> bool:
        try:
            response = requests.get(self._health_url, timeout=2.0)
            return response.ok
        except requests.RequestException:
            return False

    def _payload(self, text: str, rate: float, tone: str = "") -> dict[str, object]:
        reference_audio_path, prompt_text = self._reference_profiles.get(
            tone,
            (self._reference_audio_path, self._prompt_text),
        )
        return {
            "text": text,
            "text_lang": "ko",
            "ref_audio_path": reference_audio_path,
            "prompt_text": prompt_text,
            "prompt_lang": "ko",
            "text_split_method": "cut5",
            "batch_size": 1,
            "media_type": "wav",
            "streaming_mode": False,
            "parallel_infer": True,
            "vits_parallel_infer": False,
            "speed_factor": max(0.5, min(rate, 2.0)),
            "seed": self._seed,
        }

    def _request_audio(self, text: str, rate: float, tone: str = "") -> bytes:
        response = requests.post(
            self._url,
            json=self._payload(text, rate, tone),
            timeout=self._timeout_seconds,
        )
        response.raise_for_status()
        return ensure_audible_wav(response.content)

    async def generate(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> str:
        audio = await asyncio.to_thread(self._request_audio, text, rate, voice)
        return base64.b64encode(audio).decode("utf-8")

    async def generate_stream(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> AsyncIterator[bytes]:
        yield await asyncio.to_thread(self._request_audio, text, rate, voice)
