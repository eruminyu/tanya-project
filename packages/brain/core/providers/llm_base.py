"""LLM Provider 추상 기반 클래스."""

from abc import ABC, abstractmethod
import typing


class LLMProvider(ABC):
    """모든 LLM Provider가 구현해야 하는 인터페이스.

    각 Provider는 chat()과 analyze_image() 메서드를 구현한다.
    """

    _VISION_PROMPT = "지금 화면에 무슨 게임이나 프로그램이 켜져 있어? 짧게 한 문장으로 설명해줘."

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Provider 이름 (예: 'gemini', 'openai')."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Provider가 사용 가능한 상태인지 확인."""
        ...

    @abstractmethod
    async def chat(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> str:
        """대화 메시지를 처리하고 응답 텍스트를 반환한다.

        Args:
            user_input: 사용자 입력 텍스트
            system_prompt: 시스템 프롬프트 (페르소나 등)
            history: 대화 히스토리 [{"role": "user"|"assistant", "content": "..."}]

        Returns:
            LLM 응답 텍스트
        """
        ...

    @abstractmethod
    async def chat_stream(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> typing.AsyncGenerator[str, None]:
        """대화 메시지를 처리하고 스트리밍 형태로 텍스트 청크를 반환한다.

        Args:
            user_input: 사용자 입력 텍스트
            system_prompt: 시스템 프롬프트 (페르소나 등)
            history: 대화 히스토리 [{"role": "user"|"assistant", "content": "..."}]

        Yields:
            생성되는 텍스트 청크 (str)
        """
        ...

    @abstractmethod
    async def analyze_image(
        self, base64_image: str, system_prompt: str = ""
    ) -> str:
        """이미지를 분석하고 설명 텍스트를 반환한다.

        Args:
            base64_image: Base64 인코딩된 이미지
            system_prompt: 시스템 프롬프트

        Returns:
            이미지 분석 텍스트
        """
        ...
