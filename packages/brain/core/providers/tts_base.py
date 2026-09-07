"""TTS Provider 추상 기반 클래스."""

from abc import ABC, abstractmethod
from typing import AsyncIterator


class TTSProvider(ABC):
    """모든 TTS Provider가 구현해야 하는 인터페이스.

    각 Provider는 generate() + generate_stream() 메서드를 구현한다.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Provider 이름 (예: 'edge-tts', 'fish-speech')."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Provider가 사용 가능한 상태인지 확인."""
        ...

    @abstractmethod
    async def generate(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> str:
        """텍스트를 음성으로 변환하여 Base64 인코딩된 오디오를 반환한다.

        Args:
            text: 변환할 텍스트
            rate: 말하기 속도 (0.5~2.0, 기본 1.0)
            pitch: 음높이 (-20~+20Hz, 기본 0)
            voice: 사용할 음성 (Provider별 기본값 사용 시 빈 문자열)

        Returns:
            Base64 인코딩된 오디오 데이터
        """
        ...

    @abstractmethod
    async def generate_stream(
        self,
        text: str,
        rate: float = 1.0,
        pitch: float = 0.0,
        voice: str = "",
    ) -> AsyncIterator[bytes]:
        """텍스트를 음성으로 변환하여 오디오 bytes를 청크 단위로 yield한다.

        Args:
            text: 변환할 텍스트
            rate: 말하기 속도 (0.5~2.0, 기본 1.0)
            pitch: 음높이 (-20~+20Hz, 기본 0)
            voice: 사용할 음성 (Provider별 기본값 사용 시 빈 문자열)

        Yields:
            오디오 bytes 청크
        """
        ...
