"""TTS 관리자 — Provider 기반 Multi-TTS 지원.

Settings의 tts_provider 설정에 따라 적절한 Provider를 선택한다.
기존 generate_tts_base64() 함수를 하위 호환으로 유지한다.
"""

import logging
from typing import AsyncIterator

from config.settings import get_settings
from core.providers.aivis_speech_provider import AivisSpeechProvider
from core.providers.tts_base import TTSProvider
from core.providers.edge_tts_provider import EdgeTTSProvider
from core.providers.fish_speech_provider import FishSpeechProvider
from core.providers.gpt_sovits_provider import GptSovitsProvider

logger = logging.getLogger(__name__)


class TTSManager:
    """Multi-TTS 관리자.

    Settings의 tts_provider 설정에 따라 적절한 TTS Provider를 선택한다.
    """

    PROVIDER_MAP = {
        "edge-tts": "_create_edge_tts",
        "fish-speech": "_create_fish_speech",
        "aivis-speech": "_create_aivis_speech",
        "gpt-sovits-cpufast": "_create_gpt_sovits_cpufast",
    }

    def __init__(self):
        settings = get_settings()
        self._provider_name = settings.tts_provider
        self._default_voice = settings.tts_voice
        self._fallback_provider = EdgeTTSProvider(default_voice=self._default_voice)
        self._provider = self._create_provider(self._provider_name, settings)

        if self._provider and self._provider.is_available():
            logger.info("TTS Provider: %s ✓", self._provider.provider_name)
        else:
            # edge-tts로 폴백
            logger.warning(
                "TTS Provider: %s 사용 불가, edge-tts 폴백",
                self._provider_name,
            )
            self._provider = self._fallback_provider

    def _create_provider(
        self, name: str, settings
    ) -> TTSProvider | None:
        """설정에 따라 TTS Provider를 생성한다."""
        factory_name = self.PROVIDER_MAP.get(name)
        if factory_name:
            factory = getattr(self, factory_name)
            return factory(settings)
        logger.warning("알 수 없는 TTS Provider: %s", name)
        return None

    @staticmethod
    def _create_edge_tts(settings) -> EdgeTTSProvider:
        return EdgeTTSProvider(default_voice=settings.tts_voice)

    @staticmethod
    def _create_fish_speech(settings) -> FishSpeechProvider:
        return FishSpeechProvider(
            url=settings.fish_speech_url,
            reference_id=settings.fish_speech_reference_id,
            timeout_seconds=settings.fish_speech_timeout_seconds,
        )

    @staticmethod
    def _create_aivis_speech(settings) -> AivisSpeechProvider:
        return AivisSpeechProvider(
            url=settings.aivis_speech_url,
            style_id=settings.aivis_speech_style_id,
            timeout_seconds=settings.aivis_speech_timeout_seconds,
        )

    @staticmethod
    def _create_gpt_sovits_cpufast(settings) -> GptSovitsProvider:
        return GptSovitsProvider(
            url=settings.gpt_sovits_url,
            reference_audio_path=settings.gpt_sovits_reference_audio_path,
            prompt_text=settings.gpt_sovits_prompt_text,
            timeout_seconds=settings.gpt_sovits_timeout_seconds,
            seed=settings.gpt_sovits_seed,
            reference_metadata_path=settings.gpt_sovits_reference_metadata_path,
        )

    async def generate(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> str:
        """텍스트를 음성으로 변환하여 Base64 인코딩된 오디오를 반환한다."""
        voice = voice or self._default_voice
        try:
            return await self._provider.generate(text, rate, pitch, voice)
        except Exception:
            if self._provider is self._fallback_provider:
                raise
            logger.exception(
                "TTS Provider %s 호출 실패, edge-tts로 대체합니다.",
                self._provider.provider_name,
            )
            # 주 provider의 tone(예: GPT-SoVITS의 "cheer")은 edge-tts의 voice 이름이
            # 아니다. 그대로 넘기면 폴백까지 ValueError로 죽어 소리가 아예 나지 않는다.
            return await self._fallback_provider.generate(text, rate, pitch, "")

    async def generate_stream(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> AsyncIterator[bytes]:
        """텍스트를 음성으로 변환하여 오디오 bytes를 청크 단위로 yield한다."""
        voice = voice or self._default_voice
        try:
            async for chunk in self._provider.generate_stream(text, rate, pitch, voice):
                yield chunk
        except Exception:
            if self._provider is self._fallback_provider:
                raise
            logger.exception(
                "TTS Provider %s 스트리밍 실패, edge-tts로 대체합니다.",
                self._provider.provider_name,
            )
            # 폴백에는 주 provider의 tone을 넘기지 않는다. 위 generate와 같은 이유다.
            async for chunk in self._fallback_provider.generate_stream(
                text, rate, pitch, ""
            ):
                yield chunk

    @property
    def active_provider_name(self) -> str:
        """현재 사용 중인 Provider 이름."""
        return self._provider.provider_name


# ─── 하위 호환: 기존 코드가 import하는 함수 유지 ───

_default_manager: TTSManager | None = None


async def generate_tts_base64(
    text: str,
    rate: float = 1.0,
    pitch: float = 0.0,
    voice: str = "ko-KR-SunHiNeural",
) -> str:
    """하위 호환용 TTS 생성 함수.

    기존 코드에서 `from core.audio import generate_tts_base64`로
    사용하던 것을 깨뜨리지 않기 위해 유지한다.
    """
    global _default_manager
    if _default_manager is None:
        _default_manager = TTSManager()
    return await _default_manager.generate(text, rate, pitch, voice)
