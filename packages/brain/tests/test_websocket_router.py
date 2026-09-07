"""WebChat reconnect identity 계약 테스트."""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def test_stable_session_id_maps_to_same_webchat_namespace():
    from routers.websocket import webchat_session_key

    identity = "550e8400-e29b-41d4-a716-446655440000"

    assert webchat_session_key(identity) == f"webchat:{identity}"
    assert webchat_session_key(identity) == webchat_session_key(identity)


def test_missing_session_id_gets_connection_scoped_identity():
    from routers.websocket import webchat_session_key

    first = webchat_session_key()
    second = webchat_session_key()

    assert first.startswith("webchat:")
    assert second.startswith("webchat:")
    assert first != second
    assert uuid.UUID(first.removeprefix("webchat:")).version == 4


@pytest.mark.parametrize("identity", ["a" * 16, "Z9_-" * 32])
def test_valid_session_id_boundaries_are_preserved(identity):
    from routers.websocket import webchat_session_key

    assert webchat_session_key(identity) == f"webchat:{identity}"


@pytest.mark.parametrize(
    "identity",
    [
        "too-short",
        "a" * 129,
        "stable-session::cooldown",
        "stable session with spaces",
        "stable/session/with/slashes",
    ],
)
def test_invalid_session_id_cannot_enter_internal_namespace(identity):
    from routers.websocket import webchat_session_key

    with pytest.raises(ValueError):
        webchat_session_key(identity)


@pytest.mark.asyncio
async def test_router_passes_stable_identity_to_channel_and_manager():
    import routers.websocket as websocket_router

    identity = "550e8400-e29b-41d4-a716-446655440000"
    expected_key = f"webchat:{identity}"
    websocket = MagicMock()
    websocket.headers = {}
    websocket.client = None
    websocket.app = SimpleNamespace(state=SimpleNamespace())
    websocket.close = AsyncMock()
    manager = MagicMock()
    orchestrator = object()
    manager.acquire_session.return_value = orchestrator

    with (
        patch.object(websocket_router, "_channel_manager", manager),
        patch.object(websocket_router, "WebChatChannel") as channel_class,
    ):
        channel_class.return_value.handle = AsyncMock()

        await websocket_router.websocket_webchat(
            websocket,
            session_id=identity,
            audio=True,
            proactive=True,
        )

    manager.acquire_session.assert_called_once_with(expected_key)
    channel_class.assert_called_once_with(
        orchestrator=orchestrator,
        session_key=expected_key,
        include_audio=True,
        enable_proactive=True,
        allow_vision=False,
    )
    manager.release_session.assert_called_once_with(expected_key)


@pytest.mark.asyncio
async def test_router_rejects_invalid_session_id_before_allocating_state():
    import routers.websocket as websocket_router

    websocket = MagicMock()
    websocket.close = AsyncMock()
    manager = MagicMock()

    with patch.object(websocket_router, "_channel_manager", manager):
        await websocket_router.websocket_webchat(
            websocket,
            session_id="attacker::" + ("x" * 512),
        )

    websocket.close.assert_awaited_once_with(
        code=1008, reason="올바르지 않은 session_id입니다."
    )
    manager.acquire_session.assert_not_called()
