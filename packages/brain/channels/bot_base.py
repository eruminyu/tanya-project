"""Phase 8: BotChannel — 외부 봇 채널 추상 기반 클래스.

Discord 등 봇 API 기반 채널을 위한 인터페이스.
WebSocket 기반 Channel ABC와는 별개로 관리한다.
"""
from abc import ABC, abstractmethod


class BotChannel(ABC):
    """봇 API 기반 채널 추상 기반 클래스.

    start()/stop() 으로 봇 루프 생명주기를 관리하고,
    send_message()로 능동적 메시지 전송을 지원한다.
    """

    @abstractmethod
    async def start(self) -> None:
        """봇을 시작한다 (폴링/웹훅 루프 등)."""
        ...

    @abstractmethod
    async def stop(self) -> None:
        """봇을 종료한다."""
        ...

    @abstractmethod
    async def send_message(self, chat_id: str | int, text: str) -> None:
        """특정 대화에 능동적으로 메시지를 전송한다."""
        ...
