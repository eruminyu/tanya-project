"""Phase 6-B: Open-LLM-VTuber 호환 WebSocket 라우터.

/ws/live2d 엔드포인트를 통해 Open-LLM-VTuber 웹 클라이언트를 타냐 서버에 연결한다.
"""
import uuid

from fastapi import APIRouter, WebSocket

from channels.live2d_channel import Live2DChannel
from channels.manager import ChannelManager

router = APIRouter()

_channel_manager = ChannelManager()


def set_channel_manager(manager: ChannelManager) -> None:
    """main.py lifespan에서 store가 주입된 ChannelManager로 교체한다."""
    global _channel_manager
    _channel_manager = manager


@router.websocket("/ws/live2d")
async def websocket_live2d(websocket: WebSocket, session_id: str | None = None):
    """Open-LLM-VTuber 호환 채널 — /ws/live2d."""
    key = f"live2d:{session_id or uuid.uuid4().hex}"
    orchestrator = _channel_manager.get_or_create(key)
    channel = Live2DChannel(orchestrator=orchestrator, session_key=key)
    try:
        await channel.handle(websocket)
    finally:
        _channel_manager.remove(key)
