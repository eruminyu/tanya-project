"""faster-whisper 기반 로컬 STT Provider."""

import io
import asyncio
from typing import Any

from core.providers.stt_base import STTProvider


class FasterWhisperProvider(STTProvider):
    """faster-whisper 라이브러리 기반 로컬 STT Provider.

    완전 오프라인 동작. GPU 가속 지원.
    모델 크기: tiny / base / small / medium / large-v3
    """

    def __init__(
        self,
        model_size: str = "small",
        device: str = "auto",
        compute_type: str = "",
        vad_filter: bool = False,
        initial_prompt: str = "",
    ):
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type.strip()
        self._vad_filter = bool(vad_filter)
        self._initial_prompt = initial_prompt.strip()
        self._model: Any = None

    @property
    def provider_name(self) -> str:
        return "faster-whisper"

    def is_available(self) -> bool:
        try:
            import faster_whisper  # noqa: F401
            return faster_whisper is not None
        except (ImportError, TypeError):
            return False

    def _get_model(self) -> Any:
        """Lazy loading — 최초 호출 시 모델 로드."""
        if self._model is None:
            import faster_whisper
            device = self._device
            compute_type = self._compute_type or (
                "float16" if device in ("cuda", "auto") else "int8"
            )
            self._model = faster_whisper.WhisperModel(
                self._model_size,
                device=device,
                compute_type=compute_type,
            )
        return self._model

    async def transcribe(self, audio_bytes: bytes, language: str = "ko") -> str:
        """오디오 bytes를 faster-whisper로 텍스트 변환."""
        if not self.is_available():
            raise RuntimeError(
                "faster-whisper가 설치되지 않았습니다. "
                "`pip install faster-whisper`로 설치하세요."
            )

        def _sync_transcribe() -> str:
            model = self._get_model()
            audio_file = io.BytesIO(audio_bytes)
            segments, _ = model.transcribe(
                audio_file,
                language=language,
                vad_filter=self._vad_filter,
                # 빈 문자열이면 힌트를 주지 않는다.
                initial_prompt=self._initial_prompt or None,
            )
            return "".join(seg.text for seg in segments).strip()

        return await asyncio.to_thread(_sync_transcribe)
