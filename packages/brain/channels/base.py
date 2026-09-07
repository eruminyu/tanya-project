"""Phase 6-A: Channel ABC."""

from abc import ABC, abstractmethod
from fastapi import WebSocket


class Channel(ABC):
    """채널 추상 기반 클래스.

    각 채널(Unity, WebChat 등)은 이 인터페이스를 구현한다.
    WebSocket 연결 수락부터 종료까지의 전체 생명주기를 handle()에서 담당한다.
    """

    @abstractmethod
    async def handle(self, websocket: WebSocket) -> None:
        """WebSocket 연결 전체 생명주기를 처리한다."""
        ...
