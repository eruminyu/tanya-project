"""Phase 4-B: 승인 흐름 테스트 (ApprovalStore + Orchestrator ActionRouter 연동)."""

import asyncio
import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# ApprovalStore 단위 테스트
# ---------------------------------------------------------------------------

class TestApprovalStore:
    """ApprovalStore — token 생성 / 조회 / 소비 / 만료."""

    def test_import(self):
        from core.approval import ApprovalStore
        assert ApprovalStore is not None

    def test_create_returns_token(self):
        from core.approval import ApprovalStore
        store = ApprovalStore()
        token = store.create(skill="shell", payload={"cmd": "ls"})
        assert isinstance(token, str)
        assert len(token) > 8

    def test_consume_valid_token_returns_entry(self):
        from core.approval import ApprovalStore
        store = ApprovalStore()
        token = store.create(skill="shell", payload={"cmd": "ls"})
        entry = store.consume(token)
        assert entry is not None
        assert entry["skill"] == "shell"
        assert entry["payload"] == {"cmd": "ls"}

    def test_consume_removes_token(self):
        """consume 후 동일 토큰 재사용 불가."""
        from core.approval import ApprovalStore
        store = ApprovalStore()
        token = store.create(skill="shell", payload={})
        store.consume(token)
        assert store.consume(token) is None

    def test_consume_unknown_token_returns_none(self):
        from core.approval import ApprovalStore
        store = ApprovalStore()
        assert store.consume("no-such-token") is None

    def test_expired_token_returns_none(self):
        from core.approval import ApprovalStore
        store = ApprovalStore(ttl_seconds=0)  # 즉시 만료
        token = store.create(skill="shell", payload={})
        time.sleep(0.01)  # 만료 대기
        assert store.consume(token) is None

    def test_multiple_tokens_independent(self):
        from core.approval import ApprovalStore
        store = ApprovalStore()
        t1 = store.create(skill="shell", payload={"id": 1})
        t2 = store.create(skill="file_write", payload={"id": 2})
        e2 = store.consume(t2)
        e1 = store.consume(t1)
        assert e1["skill"] == "shell"
        assert e2["skill"] == "file_write"

    def test_cleanup_expired(self):
        """만료된 토큰은 cleanup 후 사라진다."""
        from core.approval import ApprovalStore
        store = ApprovalStore(ttl_seconds=0)
        store.create(skill="shell", payload={})
        time.sleep(0.01)
        store.cleanup()
        assert len(store._tokens) == 0


# ---------------------------------------------------------------------------
# Orchestrator ActionRouter 연동 — approval_required yield
# ---------------------------------------------------------------------------

class TestOrchestratorActionRouter:
    """Orchestrator.handle_message_stream이 ActionRouter와 연동된다."""

    def test_orchestrator_has_action_router_attr(self):
        from core.orchestrator import Orchestrator
        with patch("core.orchestrator.LLMManager"), \
             patch("core.orchestrator.MemoryEngine"), \
             patch("core.orchestrator.EmotionEngine"):
            orc = Orchestrator()
            assert hasattr(orc, "_action_router")

    def test_orchestrator_has_approval_store_attr(self):
        from core.orchestrator import Orchestrator
        with patch("core.orchestrator.LLMManager"), \
             patch("core.orchestrator.MemoryEngine"), \
             patch("core.orchestrator.EmotionEngine"):
            orc = Orchestrator()
            assert hasattr(orc, "_approval_store")

    @pytest.mark.asyncio
    async def test_skill_intent_yields_approval_required_when_policy_requires(self):
        """REQUIRE_APPROVAL 스킬 → approval_required 이벤트 yield."""
        from core.orchestrator import Orchestrator

        with patch("core.orchestrator.LLMManager"), \
             patch("core.orchestrator.MemoryEngine"), \
             patch("core.orchestrator.EmotionEngine"), \
             patch("core.orchestrator.get_settings") as mock_settings:
            settings = MagicMock()
            settings.enable_emotion = False
            settings.enable_memory = False
            settings.enable_long_term_memory = False
            settings.enable_action_router = True
            settings.enable_finetune_scoring = False
            settings.enable_security = False
            settings.enable_persona = False
            mock_settings.return_value = settings

            orc = Orchestrator()

            # ActionRouter가 approval_required 반환하도록 mock
            mock_router = AsyncMock()
            mock_router.route.return_value = {
                "approval_required": True,
                "skill": "shell",
                "reason": "위험한 스킬",
            }
            orc._action_router = mock_router

            # IntentClassifier가 "shell" intent 분류하도록 mock
            mock_classifier = MagicMock()
            from action.intent import Intent
            mock_classifier.classify.return_value = Intent(name="shell", payload={"cmd": "ls"})
            orc._intent_classifier = mock_classifier

            events = []
            raw_data = {"id": "req-1", "type": "req", "action": "chat",
                        "payload": {"message": "ls 실행해줘"}}
            async for ev_type, data in orc.handle_message_stream(raw_data):
                events.append((ev_type, data))

            event_types = [e[0] for e in events]
            assert "approval_required" in event_types

    @pytest.mark.asyncio
    async def test_approval_required_event_contains_token(self):
        """approval_required 이벤트에 approval_token이 포함된다."""
        from core.orchestrator import Orchestrator

        with patch("core.orchestrator.LLMManager"), \
             patch("core.orchestrator.MemoryEngine"), \
             patch("core.orchestrator.EmotionEngine"), \
             patch("core.orchestrator.get_settings") as mock_settings:
            settings = MagicMock()
            settings.enable_emotion = False
            settings.enable_memory = False
            settings.enable_long_term_memory = False
            settings.enable_action_router = True
            settings.enable_finetune_scoring = False
            settings.enable_security = False
            settings.enable_persona = False
            mock_settings.return_value = settings

            orc = Orchestrator()

            mock_router = AsyncMock()
            mock_router.route.return_value = {
                "approval_required": True,
                "skill": "shell",
                "reason": "위험한 스킬",
            }
            orc._action_router = mock_router

            mock_classifier = MagicMock()
            from action.intent import Intent
            mock_classifier.classify.return_value = Intent(name="shell", payload={})
            orc._intent_classifier = mock_classifier

            events = []
            raw_data = {"id": "req-1", "type": "req", "action": "chat",
                        "payload": {"message": "테스트"}}
            async for ev_type, data in orc.handle_message_stream(raw_data):
                events.append((ev_type, data))

            ar_events = [d for t, d in events if t == "approval_required"]
            assert len(ar_events) == 1
            assert "approval_token" in ar_events[0]

    @pytest.mark.asyncio
    async def test_approve_action_executes_skill(self):
        """approve 액션 → ApprovalStore에서 토큰 소비 + 스킬 실행."""
        from core.orchestrator import Orchestrator
        from core.approval import ApprovalStore

        with patch("core.orchestrator.LLMManager"), \
             patch("core.orchestrator.MemoryEngine"), \
             patch("core.orchestrator.EmotionEngine"):
            orc = Orchestrator()

            # ApprovalStore에 토큰 미리 등록
            store = ApprovalStore()
            token = store.create(skill="shell", payload={"cmd": "ls"})
            orc._approval_store = store

            # ActionRouter mock — 실제 스킬 실행 결과 반환
            mock_router = AsyncMock()
            mock_router.route.return_value = {"output": "file1.txt"}
            orc._action_router = mock_router

            events = []
            raw_data = {
                "id": "req-2",
                "type": "req",
                "action": "approve",
                "payload": {"approval_token": token},
            }
            async for ev_type, data in orc.handle_message_stream(raw_data):
                events.append((ev_type, data))

            event_types = [e[0] for e in events]
            assert "skill_result" in event_types

    @pytest.mark.asyncio
    async def test_approve_invalid_token_yields_error(self):
        """approve 액션 + 유효하지 않은 토큰 → error yield."""
        from core.orchestrator import Orchestrator

        with patch("core.orchestrator.LLMManager"), \
             patch("core.orchestrator.MemoryEngine"), \
             patch("core.orchestrator.EmotionEngine"):
            orc = Orchestrator()

            events = []
            raw_data = {
                "id": "req-3",
                "type": "req",
                "action": "approve",
                "payload": {"approval_token": "invalid-token"},
            }
            async for ev_type, data in orc.handle_message_stream(raw_data):
                events.append((ev_type, data))

            event_types = [e[0] for e in events]
            assert "error" in event_types


# ---------------------------------------------------------------------------
# protocol.py — approval_required 이벤트 팩토리
# ---------------------------------------------------------------------------

class TestProtocolApprovalEvent:
    """ProtocolHandler.make_approval_event() 팩토리 테스트."""

    def test_make_approval_event_exists(self):
        from core.protocol import ProtocolHandler
        ph = ProtocolHandler()
        assert hasattr(ph, "make_approval_event")

    def test_make_approval_event_structure(self):
        from core.protocol import ProtocolHandler
        ph = ProtocolHandler()
        ev = ph.make_approval_event(
            skill="shell",
            reason="위험한 스킬",
            approval_token="tok123",
        )
        assert ev.event == "approval_required"
        assert ev.payload["skill"] == "shell"
        assert ev.payload["reason"] == "위험한 스킬"
        assert ev.payload["approval_token"] == "tok123"
