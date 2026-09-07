"""Self-hosted Fish Speech HTTP API 기반 TTS Provider."""

import asyncio
import base64
from typing import AsyncIterator

import requests

from core.providers.tts_base import TTSProvider


class FishSpeechProvider(TTSProvider):
    """Fish Speech의 `/v1/tts` 계약을 사용하는 최소 Provider."""

    def __init__(
        self,
        url: str,
        reference_id: str = "",
        timeout_seconds: float = 30.0,
    ):
        self._url = url.rstrip("/")
        self._reference_id = reference_id.strip()
        self._timeout_seconds = timeout_seconds

    @property
    def provider_name(self) -> str:
        return "fish-speech"

    def is_available(self) -> bool:
        try:
            response = requests.get(self._health_url, timeout=2.0)
            return response.ok
        except requests.RequestException:
            return False

    @property
    def _health_url(self) -> str:
        if self._url.endswith("/v1/tts"):
            return f"{self._url[:-len('/v1/tts')]}/v1/health"
        return f"{self._url}/v1/health"

    def _payload(self, text: str, streaming: bool) -> dict[str, object]:
        payload: dict[str, object] = {
            "text": text,
            "format": "wav",
            "streaming": streaming,
        }
        if self._reference_id:
            payload["reference_id"] = self._reference_id
        return payload

    def _request_audio(self, text: str, streaming: bool = False) -> bytes:
        response = requests.post(
            self._url,
            json=self._payload(text, streaming),
            timeout=self._timeout_seconds,
        )
        response.raise_for_status()
        if not response.content:
            raise RuntimeError("Fish Speech가 빈 오디오를 반환했습니다.")
        return response.content

    async def generate(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> str:
        audio = await asyncio.to_thread(self._request_audio, text)
        return base64.b64encode(audio).decode("utf-8")

    async def generate_stream(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> AsyncIterator[bytes]:
        # 최소 계약에서는 완성된 WAV를 한 청크로 전달한다. 실제 저지연
        # 스트리밍은 Live2D 립싱크 단계에서 별도로 최적화한다.
        yield await asyncio.to_thread(self._request_audio, text)
