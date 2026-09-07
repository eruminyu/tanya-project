"""AivisSpeech Engine HTTP API 기반 TTS Provider."""

import asyncio
import base64
from typing import AsyncIterator

import requests

from core.providers.tts_base import TTSProvider


class AivisSpeechProvider(TTSProvider):
    """VOICEVOX 호환 API를 사용하는 AivisSpeech Provider."""

    def __init__(
        self,
        url: str,
        style_id: int,
        timeout_seconds: float = 30.0,
    ):
        self._url = url.rstrip("/")
        self._style_id = style_id
        self._timeout_seconds = timeout_seconds

    @property
    def provider_name(self) -> str:
        return "aivis-speech"

    def is_available(self) -> bool:
        try:
            response = requests.get(f"{self._url}/version", timeout=2.0)
            return response.ok
        except requests.RequestException:
            return False

    def _request_audio(self, text: str, rate: float) -> bytes:
        query_response = requests.post(
            f"{self._url}/audio_query",
            params={"text": text, "speaker": self._style_id},
            timeout=self._timeout_seconds,
        )
        query_response.raise_for_status()
        audio_query = query_response.json()
        audio_query["speedScale"] = max(0.5, min(rate, 2.0))

        synthesis_response = requests.post(
            f"{self._url}/synthesis",
            params={"speaker": self._style_id},
            json=audio_query,
            timeout=self._timeout_seconds,
        )
        synthesis_response.raise_for_status()
        if not synthesis_response.content:
            raise RuntimeError("AivisSpeech가 빈 오디오를 반환했습니다.")
        return synthesis_response.content

    async def generate(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> str:
        audio = await asyncio.to_thread(self._request_audio, text, rate)
        return base64.b64encode(audio).decode("utf-8")

    async def generate_stream(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> AsyncIterator[bytes]:
        yield await asyncio.to_thread(self._request_audio, text, rate)
