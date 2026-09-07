"""Phase 3.6: Action Router + Intent 해석기 테스트"""
import pytest
from unittest.mock import AsyncMock, MagicMock

from action.intent import IntentClassifier, Intent
from action.router import ActionRouter
from action.skills.base import Skill, SkillRegistry


# ---------------------------------------------------------------------------
# Intent
# ---------------------------------------------------------------------------

class TestIntent:
    def test_intent_has_name_and_payload(self):
        intent = Intent(name="weather", payload={"location": "서울"})
        assert intent.name == "weather"
        assert intent.payload["location"] == "서울"

    def test_intent_defaults(self):
        intent = Intent(name="chat")
        assert intent.payload == {}
        assert intent.confidence == 1.0


# ---------------------------------------------------------------------------
# IntentClassifier — 규칙 기반
# ---------------------------------------------------------------------------

class TestIntentClassifier:
    def setup_method(self):
        self.clf = IntentClassifier()

    def test_chat_intent_plain_text(self):
        intent = self.clf.classify("안녕 타냐!")
        assert intent.name == "chat"

    def test_unknown_falls_back_to_chat(self):
        intent = self.clf.classify("xyzxyz 알 수 없는 내용")
        assert intent.name == "chat"

    def test_custom_rule_registered(self):
        """커스텀 규칙 등록 및 매칭."""
        def rule(text: str):
            if "날씨" in text:
                return Intent(name="weather", payload={})
            return None

        clf = IntentClassifier(rules=[rule])
        intent = clf.classify("오늘 날씨 어때?")
        assert intent.name == "weather"

    def test_first_matching_rule_wins(self):
        """규칙은 등록 순서대로 평가, 첫 번째 매칭이 우선."""
        def rule1(text):
            return Intent(name="first") if "테스트" in text else None

        def rule2(text):
            return Intent(name="second") if "테스트" in text else None

        clf = IntentClassifier(rules=[rule1, rule2])
        intent = clf.classify("테스트 입력")
        assert intent.name == "first"


# ---------------------------------------------------------------------------
# ActionRouter
# ---------------------------------------------------------------------------

class TestActionRouter:
    def setup_method(self):
        self.registry = SkillRegistry()
        self.router = ActionRouter(registry=self.registry)

    @pytest.mark.asyncio
    async def test_route_chat_returns_none(self):
        """chat intent는 스킬 실행 없이 None 반환 (Orchestrator가 LLM 처리)."""
        intent = Intent(name="chat", payload={"text": "안녕"})
        result = await self.router.route(intent)
        assert result is None

    @pytest.mark.asyncio
    async def test_route_known_skill(self):
        """등록된 스킬이 실행된다."""
        class PingSkill(Skill):
            name = "ping"
            description = "핑"
            enabled = True
            async def execute(self, payload): return {"pong": True}

        self.registry.register(PingSkill())
        intent = Intent(name="ping", payload={})
        result = await self.router.route(intent)
        assert result is not None
        assert result["pong"] is True

    @pytest.mark.asyncio
    async def test_route_unknown_skill_returns_none(self):
        """등록되지 않은 스킬 이름 → None 반환."""
        intent = Intent(name="nonexistent_skill", payload={})
        result = await self.router.route(intent)
        assert result is None

    @pytest.mark.asyncio
    async def test_route_disabled_skill_returns_none(self):
        """비활성 스킬은 실행되지 않는다."""
        class OffSkill(Skill):
            name = "off"
            description = "꺼짐"
            enabled = False
            async def execute(self, payload): return {"should": "not run"}

        self.registry.register(OffSkill())
        intent = Intent(name="off", payload={})
        result = await self.router.route(intent)
        assert result is None

    @pytest.mark.asyncio
    async def test_route_skill_exception_returns_none(self):
        """스킬 실행 중 예외 발생 시 None 반환 (라우터는 crash 안 함)."""
        class BrokenSkill(Skill):
            name = "broken"
            description = "오류 스킬"
            enabled = True
            async def execute(self, payload):
                raise RuntimeError("skill error")

        self.registry.register(BrokenSkill())
        intent = Intent(name="broken", payload={})
        result = await self.router.route(intent)
        assert result is None
