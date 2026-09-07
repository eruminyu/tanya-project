"""Phase 3.5: Orchestrator 통합 + Skills 기초 테스트"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

from action.skills.base import Skill, SkillRegistry
from action.skills.loader import SkillLoader
from core.orchestrator import Orchestrator
from core.schemas import EmotionType


# ---------------------------------------------------------------------------
# Skill ABC + SkillRegistry
# ---------------------------------------------------------------------------

class TestSkillBase:
    def test_skill_is_abstract(self):
        """Skill ABC는 직접 인스턴스화 불가."""
        from abc import ABC
        assert issubclass(Skill, ABC)

    def test_concrete_skill(self):
        class GreetSkill(Skill):
            name = "greet"
            description = "인사 스킬"
            enabled = True

            async def execute(self, payload: dict) -> dict:
                return {"message": f"안녕, {payload.get('name', '사용자')}!"}

        skill = GreetSkill()
        assert skill.name == "greet"
        assert skill.enabled is True

    def test_disabled_skill(self):
        class OffSkill(Skill):
            name = "off"
            description = "비활성 스킬"
            enabled = False

            async def execute(self, payload: dict) -> dict:
                return {}

        skill = OffSkill()
        assert skill.enabled is False

    @pytest.mark.asyncio
    async def test_skill_execute(self):
        class EchoSkill(Skill):
            name = "echo"
            description = "에코"
            enabled = True

            async def execute(self, payload: dict) -> dict:
                return {"echo": payload.get("text", "")}

        skill = EchoSkill()
        result = await skill.execute({"text": "hello"})
        assert result["echo"] == "hello"


class TestSkillRegistry:
    def test_register_and_get(self):
        registry = SkillRegistry()

        class TestSkill(Skill):
            name = "test"
            description = "테스트"
            enabled = True
            async def execute(self, payload): return {}

        registry.register(TestSkill())
        skill = registry.get("test")
        assert skill is not None
        assert skill.name == "test"

    def test_get_missing_returns_none(self):
        registry = SkillRegistry()
        assert registry.get("nonexistent") is None

    def test_list_enabled_skills(self):
        registry = SkillRegistry()

        class S1(Skill):
            name = "s1"
            description = "s1"
            enabled = True
            async def execute(self, p): return {}

        class S2(Skill):
            name = "s2"
            description = "s2"
            enabled = False
            async def execute(self, p): return {}

        registry.register(S1())
        registry.register(S2())
        enabled = registry.list_enabled()
        assert any(s.name == "s1" for s in enabled)
        assert all(s.name != "s2" for s in enabled)

    def test_get_prompt_context(self):
        """활성 스킬 목록을 system prompt 컨텍스트 문자열로 반환."""
        registry = SkillRegistry()

        class WeatherSkill(Skill):
            name = "weather"
            description = "날씨 정보 조회"
            enabled = True
            async def execute(self, p): return {}

        registry.register(WeatherSkill())
        ctx = registry.get_prompt_context()
        assert "weather" in ctx
        assert "날씨 정보 조회" in ctx


# ---------------------------------------------------------------------------
# SkillLoader — SKILL.md 파서
# ---------------------------------------------------------------------------

class TestSkillLoader:
    def test_load_from_markdown(self, tmp_path):
        """YAML frontmatter + 마크다운 지시문 파싱."""
        skill_dir = tmp_path / "greet"
        skill_dir.mkdir()
        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text(
            "---\nname: greet\ndescription: 인사 스킬\nenabled: true\n---\n\n인사를 건넨다.",
            encoding="utf-8",
        )

        loader = SkillLoader(str(tmp_path))
        skills = loader.load()
        assert len(skills) >= 1
        greet = next((s for s in skills if s.name == "greet"), None)
        assert greet is not None
        assert greet.description == "인사 스킬"
        assert greet.enabled is True

    def test_disabled_skill_not_in_enabled(self, tmp_path):
        skill_dir = tmp_path / "off_skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\nname: off_skill\ndescription: 꺼진 스킬\nenabled: false\n---\n\n설명.",
            encoding="utf-8",
        )
        loader = SkillLoader(str(tmp_path))
        skills = loader.load()
        off = next((s for s in skills if s.name == "off_skill"), None)
        assert off is not None
        assert off.enabled is False


# ---------------------------------------------------------------------------
# Orchestrator — 장기 기억 컨텍스트 주입
# ---------------------------------------------------------------------------

class TestOrchestratorMemoryInjection:
    @pytest.mark.asyncio
    async def test_long_term_context_injected_when_enabled(self):
        """enable_long_term_memory=True 시 LLM system_prompt에 기억 컨텍스트 포함."""
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            captured_prompts = []

            async def fake_chat(user_input, system_prompt="", history=None):
                captured_prompts.append(system_prompt)
                return "테스트 응답"

            mock_llm.chat = AsyncMock(side_effect=fake_chat)

            with patch("core.orchestrator.generate_tts_base64", new_callable=AsyncMock) as mock_tts:
                mock_tts.return_value = ""

                with patch("core.orchestrator.get_settings") as mock_gs:
                    settings = MagicMock()
                    settings.enable_persona = False
                    settings.enable_memory = True
                    settings.enable_emotion = False
                    settings.enable_long_term_memory = True
                    settings.memory_short_term_max_turns = 20
                    settings.persona_config_path = "config/persona.yaml"
                    mock_gs.return_value = settings

                    orchestrator = Orchestrator()
                    orchestrator._llm = mock_llm

                    # 장기 기억 mock
                    mock_ltm = MagicMock()
                    mock_ltm.search = AsyncMock(return_value=[
                        MagicMock(content="사용자는 게임을 좋아한다", relevance_score=0.9)
                    ])
                    orchestrator._long_term = mock_ltm

                    await orchestrator.handle_message({"content": "게임 추천해줘"})

                    assert len(captured_prompts) > 0
                    assert "사용자는 게임을 좋아한다" in captured_prompts[-1]

    @pytest.mark.asyncio
    async def test_long_term_disabled_no_injection(self):
        """enable_long_term_memory=False 시 기억 검색 안 함."""
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.chat = AsyncMock(return_value="응답")

            with patch("core.orchestrator.generate_tts_base64", new_callable=AsyncMock) as mock_tts:
                mock_tts.return_value = ""

                with patch("core.orchestrator.get_settings") as mock_gs:
                    settings = MagicMock()
                    settings.enable_persona = False
                    settings.enable_memory = True
                    settings.enable_emotion = False
                    settings.enable_long_term_memory = False
                    settings.memory_short_term_max_turns = 20
                    settings.persona_config_path = "config/persona.yaml"
                    mock_gs.return_value = settings

                    orchestrator = Orchestrator()
                    orchestrator._llm = mock_llm

                    mock_ltm = MagicMock()
                    mock_ltm.search = AsyncMock(return_value=[])
                    orchestrator._long_term = mock_ltm

                    await orchestrator.handle_message({"content": "안녕"})

                    mock_ltm.search.assert_not_called()


# ---------------------------------------------------------------------------
# Orchestrator — LLM 오류 fallback
# ---------------------------------------------------------------------------

class TestOrchestratorLLMFallback:
    @pytest.mark.asyncio
    async def test_llm_error_returns_fallback_response(self):
        """LLM 오류 시 페르소나 일관성 있는 fallback 메시지 반환 (빈 문자열/예외 없음)."""
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.chat = AsyncMock(side_effect=Exception("LLM timeout"))

            with patch("core.orchestrator.generate_tts_base64", new_callable=AsyncMock) as mock_tts:
                mock_tts.return_value = ""

                orchestrator = Orchestrator()
                orchestrator._llm = mock_llm

                response = await orchestrator.handle_message({"content": "안녕"})

                assert response is not None
                assert len(response.content) > 0  # 빈 응답 아님
                assert response.emotion.type == EmotionType.NEUTRAL
