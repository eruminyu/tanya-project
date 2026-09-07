"""Phase 6-B: Open-LLM-VTuber 호환 레이어 테스트.

Live2DChannel이 Open-LLM-VTuber 프로토콜을 올바르게 처리하는지 검증한다.

프로토콜 요약:
- 수신: {"type": "text-input", "text": "...", "history_uid": "..."}
- 송신:
  {"type": "control", "text": "conversation-chain-start"}
  {"type": "full-text", "text": "응답 텍스트"}
  {"type": "audio", "audio": "<base64>", "display_text": {...}, "actions": {...}, ...}
  {"type": "backend-synth-complete"}
  {"type": "control", "text": "conversation-chain-end"}
"""
from __future__ import annotations

import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from channels.live2d_channel import Live2DChannel
from core.schemas import EmotionState, EmotionType, TanyaResponse


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_ws(*messages: dict) -> MagicMock:
    """WebSocket mock — 메시지 목록을 순서대로 수신한 뒤 WebSocketDisconnect."""
    from starlette.websockets import WebSocketDisconnect

    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.app = None

    call_count = [0]

    async def _receive():
        idx = call_count[0]
        call_count[0] += 1
        if idx < len(messages):
            return json.dumps(messages[idx])
        raise WebSocketDisconnect()

    sent: list[str] = []

    async def _send(text: str) -> None:
        sent.append(text)

    ws.receive_text = _receive
    ws.send_text = _send
    ws._sent = sent
    return ws


def _make_orchestrator(
    content: str = "안녕!",
    emotion: str = "happy",
    audio_b64: str = "",
) -> AsyncMock:
    orch = MagicMock()
    response = TanyaResponse(
        content=content,
        emotion=EmotionState(type=EmotionType(emotion), intensity=0.8),
        animation_intent="nod",
        audio=audio_b64,
    )
    orch.handle_message = AsyncMock(return_value=response)
    return orch


def _sent_types(ws: MagicMock) -> list[str]:
    return [json.loads(m)["type"] for m in ws._sent]


def _sent_by_type(ws: MagicMock, t: str) -> list[dict]:
    return [json.loads(m) for m in ws._sent if json.loads(m)["type"] == t]


# ---------------------------------------------------------------------------
# 채널 초기화
# ---------------------------------------------------------------------------

class TestLive2DChannelInit:
    def test_stores_orchestrator_and_session_key(self):
        orch = MagicMock()
        ch = Live2DChannel(orchestrator=orch, session_key="live2d:test")
        assert ch._orch is orch
        assert ch._session_key == "live2d:test"

    def test_default_session_key_is_empty_string(self):
        ch = Live2DChannel(orchestrator=MagicMock())
        assert ch._session_key == ""


# ---------------------------------------------------------------------------
# text-input 처리 — 응답 순서
# ---------------------------------------------------------------------------

class TestLive2DChannelTextInput:
    @pytest.mark.asyncio
    async def test_sends_conversation_chain_start_first(self):
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        first = json.loads(ws._sent[0])
        assert first["type"] == "control"
        assert first["text"] == "conversation-chain-start"

    @pytest.mark.asyncio
    async def test_sends_full_text(self):
        orch = _make_orchestrator(content="반가워!")
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        full_texts = _sent_by_type(ws, "full-text")
        assert len(full_texts) == 1
        assert full_texts[0]["text"] == "반가워!"

    @pytest.mark.asyncio
    async def test_sends_backend_synth_complete(self):
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        types = _sent_types(ws)
        assert "backend-synth-complete" in types

    @pytest.mark.asyncio
    async def test_sends_conversation_chain_end_last(self):
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        last = json.loads(ws._sent[-1])
        assert last["type"] == "control"
        assert last["text"] == "conversation-chain-end"

    @pytest.mark.asyncio
    async def test_message_order_without_audio(self):
        """오디오 없을 때: start → full-text → backend-synth-complete → end."""
        orch = _make_orchestrator(audio_b64="")
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        types = _sent_types(ws)
        assert types == [
            "control",       # conversation-chain-start
            "full-text",
            "backend-synth-complete",
            "control",       # conversation-chain-end
        ]

    @pytest.mark.asyncio
    async def test_message_order_with_audio(self):
        """오디오 있을 때: start → full-text → audio → backend-synth-complete → end."""
        audio_b64 = base64.b64encode(b"fake-wav-bytes").decode()
        orch = _make_orchestrator(audio_b64=audio_b64)
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        types = _sent_types(ws)
        assert types == [
            "control",       # conversation-chain-start
            "full-text",
            "audio",
            "backend-synth-complete",
            "control",       # conversation-chain-end
        ]

    @pytest.mark.asyncio
    async def test_audio_message_structure(self):
        """audio 메시지에 필수 필드가 포함되어 있는지 검증."""
        audio_b64 = base64.b64encode(b"fake-wav-bytes").decode()
        orch = _make_orchestrator(content="테스트", emotion="happy", audio_b64=audio_b64)
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        audio_msgs = _sent_by_type(ws, "audio")
        assert len(audio_msgs) == 1
        msg = audio_msgs[0]
        assert msg["audio"] == audio_b64
        assert "display_text" in msg
        assert msg["display_text"]["name"] == "Tanya"
        assert msg["display_text"]["text"] == "테스트"
        assert "actions" in msg
        assert "expressions" in msg["actions"]
        assert "happy" in msg["actions"]["expressions"]

    @pytest.mark.asyncio
    async def test_orchestrator_receives_text(self):
        """Orchestrator에 올바른 메시지가 전달되는지 확인."""
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕하세요", "history_uid": "uid-123"})

        await ch.handle(ws)

        orch.handle_message.assert_called_once()
        call_arg = orch.handle_message.call_args[0][0]
        assert call_arg.get("message") == "안녕하세요"

    @pytest.mark.asyncio
    async def test_history_uid_used_as_session_hint(self):
        """history_uid가 전달되어도 에러 없이 처리된다."""
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch, session_key="live2d:test")
        ws = _make_ws({"type": "text-input", "text": "안녕", "history_uid": "abc"})

        await ch.handle(ws)  # 예외 없이 완료

        types = _sent_types(ws)
        assert "full-text" in types


# ---------------------------------------------------------------------------
# 지원하지 않는 타입
# ---------------------------------------------------------------------------

class TestLive2DChannelUnsupportedType:
    @pytest.mark.asyncio
    async def test_unsupported_type_returns_error(self):
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "fetch-history-list"})

        await ch.handle(ws)

        errors = _sent_by_type(ws, "error")
        assert len(errors) == 1
        assert "fetch-history-list" in errors[0]["message"]

    @pytest.mark.asyncio
    async def test_interrupt_signal_is_ignored(self):
        """interrupt-signal은 에러 없이 무시된다."""
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "interrupt-signal"})

        await ch.handle(ws)

        types = _sent_types(ws)
        assert "error" not in types

    @pytest.mark.asyncio
    async def test_mic_audio_end_returns_error(self):
        """mic-audio-end는 STT 미구현이므로 error를 반환한다."""
        orch = _make_orchestrator()
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "mic-audio-end", "audio": [0.1, -0.2]})

        await ch.handle(ws)

        errors = _sent_by_type(ws, "error")
        assert len(errors) == 1


# ---------------------------------------------------------------------------
# Orchestrator None 응답 처리
# ---------------------------------------------------------------------------

class TestLive2DChannelNoneResponse:
    @pytest.mark.asyncio
    async def test_none_response_sends_error(self):
        """Orchestrator가 None을 반환하면 에러를 전송한다."""
        orch = MagicMock()
        orch.handle_message = AsyncMock(return_value=None)
        ch = Live2DChannel(orchestrator=orch)
        ws = _make_ws({"type": "text-input", "text": "안녕"})

        await ch.handle(ws)

        errors = _sent_by_type(ws, "error")
        assert len(errors) == 1


# ---------------------------------------------------------------------------
# CORS 설정 검증
# ---------------------------------------------------------------------------

class TestCORSSettings:
    def test_cors_origins_default_empty(self):
        from config.settings import Settings
        s = Settings()
        assert s.cors_origins == []

    def test_cors_origins_set(self):
        from config.settings import Settings
        s = Settings(cors_origins=["http://localhost:3000", "http://192.168.1.100:8080"])
        assert "http://localhost:3000" in s.cors_origins
        assert len(s.cors_origins) == 2
