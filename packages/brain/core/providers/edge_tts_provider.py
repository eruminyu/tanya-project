"""edge-tts TTS Provider."""

import base64
import typing
from typing import AsyncIterator

from core.providers.tts_base import TTSProvider


class EdgeTTSProvider(TTSProvider):
    """Microsoft edge-tts 기반 TTS Provider (무료).

    한국어 여성 음성 ko-KR-SunHiNeural이 기본.
    """

    DEFAULT_VOICE = "ko-KR-SunHiNeural"

    def __init__(self, default_voice: str = ""):
        self._default_voice = default_voice or self.DEFAULT_VOICE

    @property
    def provider_name(self) -> str:
        return "edge-tts"

    def is_available(self) -> bool:
        try:
            import edge_tts  # noqa: F401
            return True
        except ImportError:
            return False

    async def generate(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> str:
        import edge_tts

        voice = voice or self._default_voice

        # edge-tts rate/pitch 포맷: "+50%" or "-10Hz"
        rate_str = (
            f"+{int((rate - 1.0) * 100)}%"
            if rate >= 1.0
            else f"{int((rate - 1.0) * 100)}%"
        )
        pitch_str = f"+{int(pitch)}Hz" if pitch >= 0 else f"{int(pitch)}Hz"

        communicate = edge_tts.Communicate(
            text, voice, rate=rate_str, pitch=pitch_str
        )

        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += typing.cast(bytes, chunk["data"])

        return base64.b64encode(audio_data).decode("utf-8")

    async def generate_stream(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> AsyncIterator[bytes]:
        """edge-tts Communicate.stream()을 활용해 오디오 청크를 yield한다."""
        import edge_tts

        voice = voice or self._default_voice
        rate_str = (
            f"+{int((rate - 1.0) * 100)}%"
            if rate >= 1.0
            else f"{int((rate - 1.0) * 100)}%"
        )
        pitch_str = f"+{int(pitch)}Hz" if pitch >= 0 else f"{int(pitch)}Hz"

        communicate = edge_tts.Communicate(
            text, voice, rate=rate_str, pitch=pitch_str
        )

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield typing.cast(bytes, chunk["data"])
