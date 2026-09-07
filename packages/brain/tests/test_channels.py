"""WebChatChannel 테스트."""

import json
from pathlib import Path
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def _make_mock_websocket(messages: list[dict]) -> MagicMock:
    """테스트용 WebSocket mock 생성. messages를 순서대로 반환하다가 마지막에 disconnect."""
    from fastapi.websockets import WebSocketState
    from starlette.websockets import WebSocketDisconnect

    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_text = AsyncMock()
    ws.close = AsyncMock()

    # 메시지 큐 소진 후 WebSocketDisconnect 발생
    side_effects = [json.dumps(m) for m in messages]

    async def receive_text_side_effect():
        if side_effects:
            return side_effects.pop(0)
        raise WebSocketDisconnect()

    ws.receive_text = receive_text_side_effect
    return ws


def _make_mock_orchestrator(response_text: str = "안녕!") -> MagicMock:
    """테스트용 Orchestrator mock."""
    from core.schemas import TanyaResponse, EmotionState, EmotionType

    orch = MagicMock()
    mock_response = TanyaResponse(
        type="response",
        content=response_text,
        audio="dGVzdA==",
        emotion=EmotionState(type=EmotionType.NEUTRAL, intensity=0.5),
        animation_intent="idle",
    )
    orch.handle_message = AsyncMock(return_value=mock_response)
    return orch


# ---------------------------------------------------------------------------
# WebChatChannel
# ---------------------------------------------------------------------------

class TestWebChatChannel:
    """WebChatChannel 동작 검증."""

    @pytest.mark.asyncio
    async def test_handle_text_message(self):
        """텍스트 메시지를 수신해서 응답을 전송한다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "안녕"}])
        orch = _make_mock_orchestrator("반가워!")
        channel = WebChatChannel(orchestrator=orch)

        await channel.handle(ws)

        ws.accept.assert_called_once()
        ws.send_text.assert_called()

    @pytest.mark.asyncio
    async def test_response_has_content_field(self):
        """WebChat 응답에 content 필드가 있다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "뭐해?"}])
        orch = _make_mock_orchestrator("나? 그냥 있지~")
        channel = WebChatChannel(orchestrator=orch)

        await channel.handle(ws)

        sent = ws.send_text.call_args[0][0]
        parsed = json.loads(sent)
        assert "content" in parsed

    @pytest.mark.asyncio
    async def test_webchat_no_audio_field(self):
        """WebChat 응답에는 audio 필드가 없다 (텍스트 전용)."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "안녕"}])
        orch = _make_mock_orchestrator("안녕!")
        channel = WebChatChannel(orchestrator=orch)

        await channel.handle(ws)

        sent = ws.send_text.call_args[0][0]
        parsed = json.loads(sent)
        assert "audio" not in parsed

    @pytest.mark.asyncio
    async def test_disconnect_no_crash(self):
        """WebSocket 연결 끊겨도 예외 없이 종료된다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([])
        orch = _make_mock_orchestrator()
        channel = WebChatChannel(orchestrator=orch)

        await channel.handle(ws)  # 예외 없어야 함

    @pytest.mark.asyncio
    async def test_webchat_disables_audio_pipeline(self):
        """텍스트 전용 WebChat은 Orchestrator의 TTS 파이프라인을 끈다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "안녕"}])
        orch = MagicMock()
        received = {}

        async def stream(_raw_data, include_audio=True):
            received["include_audio"] = include_audio
            yield ("text", "반가워!")

        orch.handle_message_stream = stream

        await WebChatChannel(orchestrator=orch).handle(ws)

        assert received["include_audio"] is False

    @pytest.mark.asyncio
    async def test_desktop_audio_mode_sends_tts_chunk_events(self):
        """오디오 모드는 TTS 파이프라인을 켜고 Base64 청크를 전송한다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "안녕"}])
        orch = MagicMock()
        received = {}

        async def stream(_raw_data, include_audio=False):
            received["include_audio"] = include_audio
            yield ("text_stream", "반가워")
            yield ("text", "반가워")
            yield ("tts_chunk", (0, b"wave", False))
            yield ("tts_chunk", (9999, b"", True))

        orch.handle_message_stream = stream

        await WebChatChannel(orchestrator=orch, include_audio=True).handle(ws)

        assert received["include_audio"] is True
        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        chunks = [message for message in sent if message.get("event") == "tts_chunk"]
        assert chunks == [
            {
                "type": "event",
                "event": "tts_chunk",
                "payload": {"chunk_index": 0, "data": "d2F2ZQ==", "is_last": False},
            },
            {
                "type": "event",
                "event": "tts_chunk",
                "payload": {"chunk_index": 9999, "data": "", "is_last": True},
            },
        ]

    @pytest.mark.asyncio
    async def test_tts_sentence_event_is_forwarded_to_desktop(self):
        """합성 문장 원문(tts_sentence)을 WebSocket 이벤트로 전달한다 (T-010 자막 동기화)."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "안녕"}])
        orch = MagicMock()

        async def stream(_raw_data, include_audio=False):
            yield ("tts_sentence", {"chunk_index": 0, "text": "반가워! 🎉"})
            yield ("tts_chunk", (0, b"wave", True))
            yield ("tts_chunk", (9999, b"", True))

        orch.handle_message_stream = stream

        await WebChatChannel(orchestrator=orch, include_audio=True).handle(ws)

        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        sentences = [message for message in sent if message.get("event") == "tts_sentence"]
        assert sentences == [
            {
                "type": "event",
                "event": "tts_sentence",
                "payload": {"chunk_index": 0, "text": "반가워! 🎉"},
            },
        ]

    @pytest.mark.asyncio
    async def test_google_write_draft_event_is_forwarded_to_desktop(self):
        """Brain의 안전한 Google 초안을 WebSocket 이벤트로 전달한다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"content": "내일 회의 일정 잡아줘"}])
        orch = MagicMock()

        async def stream(_raw_data, include_audio=False):
            yield ("google_write_draft", {"kind": "task", "title": "자료 정리", "due": None})
            yield ("text", "초안을 만들었어.")

        orch.handle_message_stream = stream
        await WebChatChannel(orchestrator=orch).handle(ws)

        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert {"type": "event", "event": "google_write_draft", "payload": {"kind": "task", "title": "자료 정리", "due": None}} in sent

    @pytest.mark.asyncio
    async def test_llm_route_event_is_forwarded_to_client(self):
        from channels.webchat import WebChatChannel

        route = {
            "mode": "casual",
            "provider": "ollama",
            "execution": "local",
            "fallback": False,
        }

        async def stream(*_args, **_kwargs):
            yield ("llm_route", route)
            yield ("text", "안녕하세요.")

        ws = _make_mock_websocket([{"content": "안녕하세요"}])
        orch = MagicMock()
        orch.handle_message_stream = stream
        await WebChatChannel(orchestrator=orch).handle(ws)

        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert {"type": "event", "event": "llm_route", "payload": route} in sent

    @pytest.mark.asyncio
    @pytest.mark.parametrize("event", ["vision_result", "vision_error"])
    async def test_vision_event_is_forwarded_without_empty_response(self, event):
        from channels.webchat import WebChatChannel

        payload = (
            {
                "content": "로컬 화면 설명",
                "route": {
                    "provider": "ollama",
                    "execution": "local",
                    "fallback": False,
                    "model": "llava:7b",
                },
            }
            if event == "vision_result"
            else {
                "code": "local_vision_unavailable",
                "message": "로컬 화면 분석을 사용할 수 없어 요청을 중단했습니다.",
            }
        )

        async def stream(*_args, **_kwargs):
            yield (event, payload)

        ws = _make_mock_websocket([
            {"type": "vision", "image": "sensitive-base64"}
        ])
        orch = MagicMock()
        orch.handle_message_stream = stream

        await WebChatChannel(orchestrator=orch, allow_vision=True).handle(ws)

        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert {"type": "event", "event": event, "payload": payload} in sent
        assert not any(message.get("type") == "response" for message in sent)
        assert "sensitive-base64" not in str(sent)

    @pytest.mark.asyncio
    async def test_vision_is_rejected_before_public_websocket_reaches_orchestrator(self):
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{
            "type": "vision",
            "image": "sensitive-base64",
        }])
        orch = MagicMock()
        orch.handle_message_stream = MagicMock()

        await WebChatChannel(orchestrator=orch).handle(ws)

        orch.handle_message_stream.assert_not_called()
        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert sent == [{
            "type": "event",
            "event": "vision_error",
            "payload": {
                "code": "vision_transport_untrusted",
                "message": "신뢰된 로컬 화면 연결이 아니어서 이미지 요청을 중단했습니다.",
            },
        }]
        assert "sensitive-base64" not in str(sent)

    @pytest.mark.asyncio
    async def test_google_demo_execution_events_are_forwarded_to_web(self):
        """승인 결과·거절·실패를 웹 클라이언트가 처리할 수 있게 그대로 전달한다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"action": "google_write_approve", "payload": {}}])
        orch = MagicMock()

        async def stream(_raw_data, include_audio=False):
            yield ("google_write_result", {
                "requestId": "request-1",
                "providerId": "task-1",
                "title": "자료 정리",
                "duplicate": False,
            })
            yield ("google_write_cancelled", {"requestId": "request-2"})
            yield ("google_write_error", {"message": "생성 실패"})

        orch.handle_message_stream = stream
        await WebChatChannel(orchestrator=orch).handle(ws)

        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert {"type": "event", "event": "google_write_result", "payload": {
            "requestId": "request-1", "providerId": "task-1",
            "title": "자료 정리", "duplicate": False,
        }} in sent
        assert {"type": "event", "event": "google_write_cancelled", "payload": {
            "requestId": "request-2",
        }} in sent
        assert {"type": "event", "event": "google_write_error", "payload": {
            "message": "생성 실패",
        }} in sent
        assert not any(message.get("type") == "response" for message in sent)

    @pytest.mark.asyncio
    async def test_created_schedule_is_internal_and_immediately_evaluated_after_receipt(self):
        """실제 Calendar 생성 결과를 일정 문맥에 합치되 내부 이벤트는 공개하지 않는다."""
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"action": "google_write_approve", "payload": {}}])
        ws.app = MagicMock()
        scheduler = MagicMock()
        scheduler.evaluate_rule_now = AsyncMock()
        ws.app.state.proactive_scheduler = scheduler
        orch = MagicMock()

        async def stream(_raw_data, include_audio=False):
            yield ("google_write_result", {
                "requestId": "request-1",
                "providerId": "calendar-1",
                "title": "해커톤 데모",
                "duplicate": False,
            })
            yield ("schedule_created", {
                "id": "calendar-1",
                "title": "해커톤 데모",
                "startsAt": "2026-08-31T15:00:00+09:00",
                "allDay": False,
            })

        async def evaluate_after_receipt(_rule_name, **_kwargs):
            sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
            assert any(message.get("event") == "google_write_result" for message in sent)

        scheduler.evaluate_rule_now.side_effect = evaluate_after_receipt
        orch.handle_message_stream = stream

        await WebChatChannel(
            orchestrator=orch, session_key="webchat:test"
        ).handle(ws)

        created = scheduler.upsert_schedule_event.call_args.args[0]
        assert created.id == "calendar-1"
        assert created.title == "해커톤 데모"
        assert scheduler.upsert_schedule_event.call_args.kwargs["session_key"] == "webchat:test"
        scheduler.evaluate_rule_now.assert_awaited_once_with(
            "upcoming_event",
            session_key="webchat:test",
            event_id="calendar-1",
        )
        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert not any(message.get("event") == "schedule_created" for message in sent)

    @pytest.mark.asyncio
    async def test_immediate_proactive_failure_does_not_hide_google_receipt(self):
        from channels.webchat import WebChatChannel

        ws = _make_mock_websocket([{"action": "google_write_approve", "payload": {}}])
        ws.app = MagicMock()
        scheduler = MagicMock()
        scheduler.evaluate_rule_now = AsyncMock(side_effect=RuntimeError("LLM 실패"))
        ws.app.state.proactive_scheduler = scheduler
        orch = MagicMock()

        async def stream(_raw_data, include_audio=False):
            yield ("google_write_result", {"providerId": "calendar-1"})
            yield ("schedule_created", {
                "id": "calendar-1",
                "title": "해커톤 데모",
                "startsAt": "2026-08-31T15:00:00+09:00",
                "allDay": False,
            })

        orch.handle_message_stream = stream
        await WebChatChannel(orchestrator=orch).handle(ws)

        sent = [json.loads(call.args[0]) for call in ws.send_text.call_args_list]
        assert {"type": "event", "event": "google_write_result", "payload": {
            "providerId": "calendar-1",
        }} in sent
        assert not any(message.get("event") == "schedule_created" for message in sent)


class TestWebChatUI:
    def test_minimal_settings_ui_is_present(self):
        html_path = Path(__file__).parents[1] / "static" / "webchat.html"
        html = html_path.read_text(encoding="utf-8")

        assert 'id="settings-modal"' in html
        assert 'id="casual-provider"' in html
        assert 'id="task-provider"' in html
        assert 'id="admin-token"' in html
        assert "/settings/llm" in html

    def test_websocket_scheme_follows_page_protocol(self):
        html_path = Path(__file__).parents[1] / "static" / "webchat.html"
        html = html_path.read_text(encoding="utf-8")

        assert "location.protocol === 'https:' ? 'wss' : 'ws'" in html

    def test_code_fences_use_safe_dom_renderer(self):
        html_path = Path(__file__).parents[1] / "static" / "webchat.html"
        html = html_path.read_text(encoding="utf-8")

        assert "function renderMessageContent" in html
        assert "code.textContent = match[2]" in html
        assert "innerHTML" not in html

    def test_feedback_buttons_require_conversation_id(self):
        html_path = Path(__file__).parents[1] / "static" / "webchat.html"
        html = html_path.read_text(encoding="utf-8")

        assert "if (convId && convId > 0)" in html
