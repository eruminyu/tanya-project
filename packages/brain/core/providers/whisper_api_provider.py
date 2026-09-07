"""OpenAI Whisper API 기반 클라우드 STT Provider (폴백)."""

import io
from typing import TYPE_CHECKING

try:
    from openai import AsyncOpenAI
except ImportError:
    AsyncOpenAI = None  # type: ignore

from core.providers.stt_base import STTProvider


class WhisperAPIProvider(STTProvider):
    """OpenAI Audio Transcription API (whisper-1) 기반 STT Provider.

    인터넷 연결 필요. faster-whisper 폴백으로 사용.
    """

    def __init__(self, api_key: str, model: str = "whisper-1"):
        self._api_key = api_key
        self._model = model

    @property
    def provider_name(self) -> str:
        return "whisper-api"

    def is_available(self) -> bool:
        return bool(self._api_key)

    async def transcribe(self, audio_bytes: bytes, language: str = "ko") -> str:
        """OpenAI Whisper API로 오디오 bytes를 텍스트 변환."""
        if not self._api_key:
            raise RuntimeError(
                "OpenAI API 키가 설정되지 않았습니다. "
                "`OPENAI_API_KEY` 환경변수를 설정하세요."
            )

        if AsyncOpenAI is None:
            raise RuntimeError(
                "openai 패키지가 설치되지 않았습니다. "
                "`pip install openai`로 설치하세요."
            )

        client = AsyncOpenAI(api_key=self._api_key)
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = "audio.wav"

        transcript = await client.audio.transcriptions.create(
            model=self._model,
            file=audio_file,
            language=language,
        )
        return transcript.text
