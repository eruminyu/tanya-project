import re
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from channels.manager import ChannelManager
from channels.webchat import WebChatChannel
from core.rate_limit import client_key

router = APIRouter()

# 싱글턴 ChannelManager — 세션 재사용 담당
# Phase 7: main.py lifespan에서 store가 준비된 뒤 set_channel_manager()로 교체 가능
_channel_manager = ChannelManager()
_STABLE_SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{16,128}")


def webchat_session_key(session_id: str | None = None) -> str:
    """Web transport identity를 scheduler/channel 공용 namespace로 바꾼다.

    클라이언트가 stable ``session_id``를 보내면 재연결 전후 같은 키가 되고,
    생략한 레거시 클라이언트는 연결마다 추측하기 어려운 임시 키를 받는다.
    """
    if not session_id:
        return f"webchat:{uuid.uuid4()}"
    if _STABLE_SESSION_ID_PATTERN.fullmatch(session_id) is None:
        raise ValueError(
            "session_id must be 16..128 ASCII letters, digits, '_' or '-'"
        )
    identity = session_id
    return f"webchat:{identity}"


def set_channel_manager(manager: ChannelManager) -> None:
    """main.py lifespan에서 store가 주입된 ChannelManager로 교체한다."""
    global _channel_manager
    _channel_manager = manager


@router.websocket("/ws/webchat")
async def websocket_webchat(
    websocket: WebSocket,
    session_id: str | None = None,
    audio: bool = False,
    proactive: bool = True,
):
    """WebChat 채널. 데스크톱은 오디오와 선제 제안 사용 여부를 전달한다."""
    try:
        key = webchat_session_key(session_id)
    except ValueError:
        # session id는 proactive cooldown DB namespace에도 들어간다. 임의 장문이나
        # 내부 구분자(`::`)를 허용하지 않고 WebSocket 정책 위반으로 종료한다.
        await websocket.close(code=1008, reason="올바르지 않은 session_id입니다.")
        return

    # T-017: 한 방문자가 연결을 무한히 열어 자원을 점유하는 것을 막는다.
    limiter = getattr(getattr(websocket, "app", None), "state", None)
    limiter = getattr(limiter, "rate_limiter", None) if limiter else None
    client = client_key(websocket.headers, websocket.client.host if websocket.client else None)
    if limiter is not None and not limiter.acquire_connection(client):
        await websocket.close(code=1013, reason="연결이 너무 많아. 잠시 뒤에 다시 시도해줘.")
        return

    manager = _channel_manager
    orchestrator = manager.acquire_session(key)
    try:
        channel = WebChatChannel(
            orchestrator=orchestrator,
            session_key=key,
            include_audio=audio,
            enable_proactive=proactive,
            # 이 공개 endpoint는 Tauri와 WebChat을 구별할 인증 경계가 없다.
            # 전용 로컬 transport가 추가되기 전까지 이미지 입력은 거부한다.
            allow_vision=False,
        )
        await channel.handle(websocket)
    finally:
        manager.release_session(key)
        if limiter is not None:
            limiter.release_connection(client)
