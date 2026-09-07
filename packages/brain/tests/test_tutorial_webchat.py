"""T-027 공개 WebSocket tutorial adapter와 legacy 퇴역 테스트."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from channels.webchat import WebChatChannel
from core.rate_limit import Decision
from tests.test_channels import _make_mock_websocket


def operation_id() -> str:
    return str(uuid.uuid4())


def web_socket(message: dict, *, service=None, decision: Decision | None = None):
    websocket = _make_mock_websocket([message])
    limiter = MagicMock()
    limiter.check.return_value = decision or Decision(True)
    websocket.headers = {"cf-connecting-ip": "203.0.113.7"}
    websocket.client = SimpleNamespace(host="127.0.0.1")
    websocket.app = SimpleNamespace(state=SimpleNamespace(
        tutorial_service=service,
        memory_capsule_service=None,
        proactive_scheduler=None,
        rate_limiter=limiter,
    ))
    return websocket, limiter


@pytest.mark.asyncio
async def test_tutorial_events_are_forwarded_without_general_llm_response():
    operation = operation_id()
    flow = operation_id()
    service = MagicMock()
    service.handle = AsyncMock(return_value=[
        ("tutorial_state", {
            "flowId": flow,
            "operationId": operation,
            "phase": "preferences_pending",
        }),
    ])
    websocket, limiter = web_socket({
        "type": "action",
        "action": "tutorial_resume",
        "payload": {"operation_id": operation, "flow_id": flow},
    }, service=service)
    orchestrator = MagicMock()
    orchestrator.handle_message_stream = MagicMock()

    await WebChatChannel(
        orchestrator=orchestrator,
        session_key="webchat:550e8400-e29b-41d4-a716-446655440000",
    ).handle(websocket)

    service.handle.assert_awaited_once()
    limiter.check.assert_called_once_with("203.0.113.7")
    orchestrator.handle_message_stream.assert_not_called()
    sent = [json.loads(call.args[0]) for call in websocket.send_text.call_args_list]
    assert sent == [{
        "type": "event",
        "event": "tutorial_state",
        "payload": {
            "flowId": flow,
            "operationId": operation,
            "phase": "preferences_pending",
        },
    }]


@pytest.mark.asyncio
async def test_each_tutorial_action_is_rate_limited_before_service():
    operation = operation_id()
    flow = operation_id()
    service = MagicMock()
    service.handle = AsyncMock()
    websocket, _ = web_socket({
        "type": "action",
        "action": "tutorial_resume",
        "payload": {"operation_id": operation, "flow_id": flow},
    }, service=service, decision=Decision(False, "raw limiter detail", 12))

    await WebChatChannel(
        orchestrator=MagicMock(),
        session_key="webchat:550e8400-e29b-41d4-a716-446655440000",
    ).handle(websocket)

    service.handle.assert_not_awaited()
    event = json.loads(websocket.send_text.call_args.args[0])
    assert event["event"] == "tutorial_error"
    assert event["payload"] == {
        "flowId": flow,
        "operationId": operation,
        "code": "rate_limited",
        "message": "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
        "retryAfter": 12,
    }
    assert "raw limiter detail" not in str(event)


@pytest.mark.asyncio
async def test_unconfigured_tutorial_returns_stable_unavailable_error():
    operation = operation_id()
    websocket, _ = web_socket({
        "type": "action",
        "action": "tutorial_start",
        "payload": {"operation_id": operation},
    }, service=None)

    await WebChatChannel(
        orchestrator=MagicMock(),
        session_key="webchat:550e8400-e29b-41d4-a716-446655440000",
    ).handle(websocket)

    event = json.loads(websocket.send_text.call_args.args[0])
    assert event["event"] == "tutorial_error"
    assert event["payload"]["code"] == "unavailable"
    assert event["payload"]["operationId"] == operation


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "legacy_action",
    [
        "memory_capsule_prepare",
        "memory_capsule_approve",
        "memory_capsule_reject",
        "memory_capsule_recall",
        "memory_capsule_forget",
        "google_write_approve",
        "google_write_reject",
    ],
)
async def test_unified_tutorial_retires_legacy_public_actions(legacy_action):
    operation = operation_id()
    service = MagicMock()
    service.handle = AsyncMock()
    websocket, _ = web_socket({
        "type": "action",
        "action": legacy_action,
        "payload": {"operation_id": operation},
    }, service=service)
    orchestrator = MagicMock()
    orchestrator.handle_message_stream = MagicMock()

    await WebChatChannel(
        orchestrator=orchestrator,
        session_key="webchat:550e8400-e29b-41d4-a716-446655440000",
    ).handle(websocket)

    service.handle.assert_not_awaited()
    orchestrator.handle_message_stream.assert_not_called()
    event = json.loads(websocket.send_text.call_args.args[0])
    assert event["event"] == "tutorial_error"
    assert event["payload"]["code"] == "deprecated"
