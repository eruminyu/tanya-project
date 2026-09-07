"""STT Provider 추상 기반 클래스."""

from abc import ABC, abstractmethod


class STTProvider(ABC):
    """모든 STT Provider가 구현해야 하는 인터페이스."""

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Provider 이름 (예: 'faster-whisper', 'whisper-api')."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Provider가 사용 가능한 상태인지 확인."""
        ...

    @abstractmethod
    async def transcribe(self, audio_bytes: bytes, language: str = "ko") -> str:
        """오디오 bytes를 텍스트로 변환한다.

        Args:
            audio_bytes: WAV/MP3 오디오 바이너리 데이터
            language: 인식 언어 코드 (기본 'ko')

        Returns:
            인식된 텍스트 문자열
        """
        ...
