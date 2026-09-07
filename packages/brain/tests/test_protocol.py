"""Phase 3.4: Wire Protocol V2 테스트"""
import pytest
from core.protocol import (
    RequestEnvelope,
    ResponseEnvelope,
    EventEnvelope,
    ProtocolHandler,
)


# ---------------------------------------------------------------------------
# RequestEnvelope
# ---------------------------------------------------------------------------

class TestRequestEnvelope:
    def test_required_fields(self):
        req = RequestEnvelope(id="abc-123", action="chat", payload={"content": "hi"})
        assert req.id == "abc-123"
        assert req.type == "req"
        assert req.action == "chat"
        assert req.payload["content"] == "hi"

    def test_type_fixed(self):
        req = RequestEnvelope(id="x", action="tts", payload={})
        assert req.type == "req"

    def test_from_dict(self):
        data = {"id": "1", "type": "req", "action": "chat", "payload": {"content": "안녕"}}
        req = RequestEnvelope(**data)
        assert req.action == "chat"


# ---------------------------------------------------------------------------
# ResponseEnvelope
# ---------------------------------------------------------------------------

class TestResponseEnvelope:
    def test_success_response(self):
        res = ResponseEnvelope(id="abc-123", success=True, payload={"content": "hello"})
        assert res.id == "abc-123"
        assert res.type == "res"
        assert res.success is True
        assert res.error is None

    def test_error_response(self):
        res = ResponseEnvelope(id="abc-123", success=False, error="LLM timeout")
        assert res.success is False
        assert res.error == "LLM timeout"

    def test_type_fixed(self):
        res = ResponseEnvelope(id="x", success=True, payload={})
        assert res.type == "res"


# ---------------------------------------------------------------------------
# EventEnvelope
# ---------------------------------------------------------------------------

class TestEventEnvelope:
    def test_emotion_event(self):
        ev = EventEnvelope(event="emotion_update", payload={"type": "happy", "intensity": 0.8})
        assert ev.type == "event"
        assert ev.event == "emotion_update"
        assert ev.payload["type"] == "happy"

    def test_tts_ready_event(self):
        ev = EventEnvelope(event="tts_ready", payload={"audio": "base64..."})
        assert ev.event == "tts_ready"

    def test_status_event(self):
        ev = EventEnvelope(event="status", payload={"state": "thinking"})
        assert ev.event == "status"

    def test_type_fixed(self):
        ev = EventEnvelope(event="any", payload={})
        assert ev.type == "event"


# ---------------------------------------------------------------------------
# ProtocolHandler — 레거시 vs V2 자동 판별
# ---------------------------------------------------------------------------

class TestProtocolHandler:
    def setup_method(self):
        self.handler = ProtocolHandler()

    def test_legacy_message_detected(self):
        """id 필드 없으면 레거시 프로토콜."""
        legacy = {"type": "text", "content": "안녕"}
        assert self.handler.is_legacy(legacy) is True

    def test_v2_message_detected(self):
        """id 필드 있으면 V2 프로토콜."""
        v2 = {"id": "uuid-1", "type": "req", "action": "chat", "payload": {}}
        assert self.handler.is_legacy(v2) is False

    def test_parse_v2_request(self):
        data = {"id": "req-1", "type": "req", "action": "chat", "payload": {"content": "hi"}}
        req = self.handler.parse_request(data)
        assert isinstance(req, RequestEnvelope)
        assert req.id == "req-1"

    def test_make_response(self):
        res = self.handler.make_response("req-1", success=True, payload={"content": "hi"})
        assert isinstance(res, ResponseEnvelope)
        assert res.id == "req-1"
        assert res.success is True

    def test_make_error_response(self):
        res = self.handler.make_error("req-1", "something went wrong")
        assert res.success is False
        assert res.error == "something went wrong"

    def test_make_event(self):
        ev = self.handler.make_event("emotion_update", {"type": "happy"})
        assert isinstance(ev, EventEnvelope)
        assert ev.event == "emotion_update"

    def test_response_serializes_to_json(self):
        res = self.handler.make_response("req-1", success=True, payload={"content": "hi"})
        json_str = res.model_dump_json()
        assert "req-1" in json_str
        assert "res" in json_str
