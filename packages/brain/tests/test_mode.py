"""Phase 3.7: 일상/작업 모드 전환 테스트"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from core.mode import ModeClassifier, TanyaMode
from core.llm import LLMManager
from config.settings import Settings
from config.llm_profiles import LLMProfile, LLMProfiles, LLMProfileStore


# ---------------------------------------------------------------------------
# TanyaMode
# ---------------------------------------------------------------------------

class TestTanyaMode:
    def test_modes_exist(self):
        assert TanyaMode.CASUAL is not None
        assert TanyaMode.TASK is not None

    def test_mode_values(self):
        assert TanyaMode.CASUAL.value == "casual"
        assert TanyaMode.TASK.value == "task"


# ---------------------------------------------------------------------------
# ModeClassifier — 규칙 기반 분류
# ---------------------------------------------------------------------------

class TestModeClassifier:
    def setup_method(self):
        self.clf = ModeClassifier()

    # 일상 모드 분류
    def test_short_greeting_is_casual(self):
        assert self.clf.classify("안녕!") == TanyaMode.CASUAL

    def test_short_chit_chat_is_casual(self):
        assert self.clf.classify("오늘 뭐 먹었어?") == TanyaMode.CASUAL

    # 작업 모드 키워드
    def test_code_keyword_is_task(self):
        assert self.clf.classify("이 코드 좀 고쳐줘") == TanyaMode.TASK

    def test_analyze_keyword_is_task(self):
        assert self.clf.classify("이 데이터 분석해줘") == TanyaMode.TASK

    def test_implement_keyword_is_task(self):
        assert self.clf.classify("로그인 기능 구현해줘") == TanyaMode.TASK

    def test_error_keyword_is_task(self):
        assert self.clf.classify("에러 왜 나는 거야?") == TanyaMode.TASK

    def test_explain_keyword_is_task(self):
        assert self.clf.classify("이 알고리즘 설명해줘") == TanyaMode.TASK

    # 길이 기반 (100자 초과 → task)
    def test_long_text_is_task(self):
        long_text = "안녕 " * 40  # 120자 이상
        assert self.clf.classify(long_text) == TanyaMode.TASK

    def test_short_text_under_threshold_is_casual(self):
        short_text = "안녕하세요!"  # 100자 미만
        # 키워드 없으면 casual
        assert self.clf.classify(short_text) == TanyaMode.CASUAL


# ---------------------------------------------------------------------------
# LLMManager 모드별 Provider 선택
# ---------------------------------------------------------------------------

class TestLLMModeSelection:
    @pytest.fixture(autouse=True)
    def _disable_real_ollama_probe(self):
        with patch("core.providers.ollama.OllamaProvider.is_available", return_value=False):
            yield

    def test_settings_define_independent_llm_profiles(self):
        settings = Settings(_env_file=None)

        assert settings.enable_emotion is True
        assert settings.casual_llm_provider == "ollama"
        assert settings.casual_llm_model == ""
        assert settings.casual_llm_base_url == ""
        assert settings.casual_llm_api_key == ""
        assert settings.task_llm_provider == "gemini"
        assert settings.task_llm_model == ""
        assert settings.task_llm_base_url == ""
        assert settings.task_llm_api_key == ""

    def test_route_description_exposes_actual_local_casual_provider(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            casual = MagicMock(provider_name="ollama")
            casual.is_available.return_value = True
            manager._casual_provider = casual

            route = manager.describe_conversation_route("오늘 기분이 어때?")

            assert route == {
                "mode": "casual",
                "provider": "ollama",
                "execution": "local",
                "fallback": False,
            }

    def test_route_description_reports_local_fallback_instead_of_unavailable_cloud(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            task = MagicMock(provider_name="gemini")
            task.is_available.return_value = False
            fallback = MagicMock(provider_name="ollama")
            fallback.is_available.return_value = True
            manager._task_provider = task
            manager._fallback = fallback

            route = manager.describe_conversation_route("이 코드를 분석해 줘")

            assert route == {
                "mode": "task",
                "provider": "ollama",
                "execution": "local",
                "fallback": True,
            }

    def test_route_description_preserves_vllm_identity_as_local(self):
        with (
            patch("core.llm.get_settings") as mock_gs,
            patch("core.llm.OpenAIProvider") as mock_openai,
        ):
            mock_gs.return_value = Settings(
                _env_file=None,
                task_llm_provider="vllm",
                task_llm_base_url="http://local-vllm:8000/v1",
            )
            mock_openai.return_value.is_available.return_value = True
            manager = LLMManager()

            route = manager.describe_conversation_route("이 코드를 분석해 줘")

            assert route == {
                "mode": "task",
                "provider": "vllm",
                "execution": "local",
                "fallback": False,
            }

    def test_route_description_preserves_openai_compatible_as_custom(self):
        with (
            patch("core.llm.get_settings") as mock_gs,
            patch("core.llm.OpenAIProvider") as mock_openai,
        ):
            mock_gs.return_value = Settings(
                _env_file=None,
                task_llm_provider="openai-compatible",
                task_llm_model="custom-model",
                task_llm_base_url="https://model.example/v1",
                task_llm_api_key="test-key",
            )
            mock_openai.return_value.is_available.return_value = True
            manager = LLMManager()

            route = manager.describe_conversation_route("이 코드를 분석해 줘")

            assert route == {
                "mode": "task",
                "provider": "openai-compatible",
                "execution": "custom",
                "fallback": False,
            }

    def test_casual_profile_uses_its_own_ollama_model_and_endpoint(self):
        with patch("core.llm.get_settings") as mock_gs:
            settings = Settings(
                _env_file=None,
                casual_llm_provider="ollama",
                casual_llm_model="llama3.3:70b",
                casual_llm_base_url="http://local-llm:11434",
            )
            mock_gs.return_value = settings

            manager = LLMManager()
            provider = manager.select_provider(TanyaMode.CASUAL)

            assert provider._model_name == "llama3.3:70b"
            assert provider._base_url == "http://local-llm:11434"

    def test_task_profile_uses_its_own_commercial_model_and_api_key(self):
        with (
            patch("core.llm.get_settings") as mock_gs,
            patch("core.llm.GeminiProvider") as mock_gemini,
        ):
            settings = Settings(
                _env_file=None,
                task_llm_provider="gemini",
                task_llm_model="gemini-custom",
                task_llm_api_key="task-key",
            )
            mock_gs.return_value = settings

            manager = LLMManager()
            manager.select_provider(TanyaMode.TASK)

            mock_gemini.assert_any_call(
                api_key="task-key",
                model_name="gemini-custom",
            )

    def test_task_profile_supports_openai_compatible_endpoint(self):
        with (
            patch("core.llm.get_settings") as mock_gs,
            patch("core.llm.OpenAIProvider") as mock_openai,
        ):
            settings = Settings(
                _env_file=None,
                task_llm_provider="openai-compatible",
                task_llm_model="custom-model",
                task_llm_base_url="http://model-server:8000/v1",
                task_llm_api_key="optional-key",
            )
            mock_gs.return_value = settings

            manager = LLMManager()
            provider = manager.select_provider(TanyaMode.TASK)

            assert provider is mock_openai.return_value
            mock_openai.assert_any_call(
                api_key="optional-key",
                model_name="custom-model",
                base_url="http://model-server:8000/v1",
            )

    def test_saved_profiles_override_environment_defaults(self, tmp_path):
        profile_path = tmp_path / "llm_profiles.json"
        LLMProfileStore(profile_path).save(
            LLMProfiles(
                casual=LLMProfile(
                    provider="ollama",
                    model="saved-casual-model",
                    base_url="http://saved-ollama:11434",
                ),
                task=LLMProfile(
                    provider="openai-compatible",
                    model="saved-task-model",
                    base_url="http://saved-task:8000/v1",
                    api_key="saved-key",
                ),
            )
        )

        with (
            patch("core.llm.get_settings") as mock_gs,
            patch("core.llm.OpenAIProvider") as mock_openai,
        ):
            mock_gs.return_value = Settings(
                _env_file=None,
                llm_profiles_path=str(profile_path),
            )

            manager = LLMManager()
            casual = manager.select_provider(TanyaMode.CASUAL)
            task = manager.select_provider(TanyaMode.TASK)

            assert casual._model_name == "saved-casual-model"
            assert casual._base_url == "http://saved-ollama:11434"
            assert task is mock_openai.return_value
            mock_openai.assert_any_call(
                api_key="saved-key",
                model_name="saved-task-model",
                base_url="http://saved-task:8000/v1",
            )

    def test_casual_mode_uses_casual_provider(self):
        """casual 모드에서 casual_llm_provider를 사용한다."""
        with patch("core.llm.get_settings") as mock_gs:
            settings = MagicMock()
            settings.llm_provider = "ollama"
            settings.casual_llm_provider = "ollama"
            settings.task_llm_provider = "gemini"
            settings.mode_auto_detect = True
            settings.google_api_key = ""
            settings.gemini_model_name = "gemini-flash"
            settings.openai_api_key = ""
            settings.openai_model_name = "gpt-4o"
            settings.anthropic_api_key = ""
            settings.claude_model_name = "claude-sonnet"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_gs.return_value = settings

            manager = LLMManager()
            provider = manager.select_provider(TanyaMode.CASUAL)
            assert provider is not None
            assert "ollama" in provider.provider_name.lower()

    def test_task_mode_uses_task_provider(self):
        """task 모드에서 task_llm_provider를 사용한다."""
        with patch("core.llm.get_settings") as mock_gs:
            settings = MagicMock()
            settings.llm_provider = "ollama"
            settings.casual_llm_provider = "ollama"
            settings.task_llm_provider = "gemini"
            settings.mode_auto_detect = True
            settings.google_api_key = ""
            settings.gemini_model_name = "gemini-flash"
            settings.openai_api_key = ""
            settings.openai_model_name = "gpt-4o"
            settings.anthropic_api_key = ""
            settings.claude_model_name = "claude-sonnet"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_gs.return_value = settings

            manager = LLMManager()
            provider = manager.select_provider(TanyaMode.TASK)
            assert provider is not None
            assert "gemini" in provider.provider_name.lower()

    @pytest.mark.asyncio
    async def test_chat_routes_casual_message_to_casual_provider(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            casual = MagicMock()
            casual.is_available.return_value = True
            casual.chat = AsyncMock(return_value="일상 응답")
            task = MagicMock()
            task.is_available.return_value = True
            task.chat = AsyncMock(return_value="작업 응답")
            manager._casual_provider = casual
            manager._task_provider = task

            result = await manager.chat("오늘 뭐 먹었어?")

            assert result == "일상 응답"
            casual.chat.assert_awaited_once()
            task.chat.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_chat_stream_routes_task_message_to_task_provider(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            casual = MagicMock()
            casual.is_available.return_value = True
            task = MagicMock()
            task.is_available.return_value = True

            async def task_stream(*_args, **_kwargs):
                yield "작업"
                yield " 응답"

            task.chat_stream = task_stream
            manager._casual_provider = casual
            manager._task_provider = task

            chunks = [chunk async for chunk in manager.chat_stream("이 코드 분석해줘")]

            assert chunks == ["작업", " 응답"]

    @pytest.mark.asyncio
    async def test_chat_stream_resolves_initial_route_only_once(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            task = MagicMock(provider_name="gemini")
            # 재조회하면 unavailable로 바뀌는 provider로 기존 race를 재현한다.
            task.is_available.side_effect = [True, False]

            async def task_stream(*_args, **_kwargs):
                yield "클라우드 응답"

            task.chat_stream = task_stream
            manager._task_provider = task
            routes = []

            chunks = [
                chunk
                async for chunk in manager.chat_stream(
                    "이 코드 분석해줘",
                    on_route_change=routes.append,
                )
            ]

            assert chunks == ["클라우드 응답"]
            assert task.is_available.call_count == 1
            assert routes == [
                {
                    "mode": "task",
                    "provider": "gemini",
                    "execution": "cloud",
                    "fallback": False,
                }
            ]

    @pytest.mark.asyncio
    async def test_chat_stream_reports_runtime_fallback_before_ollama_chunk(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            task = MagicMock(provider_name="gemini")
            task.is_available.return_value = True
            fallback = MagicMock(provider_name="ollama")
            fallback.is_available.return_value = True
            timeline = []

            async def failing_task_stream(*_args, **_kwargs):
                yield "클라우드 일부"
                raise RuntimeError("stream disconnected")

            async def fallback_stream(*_args, **_kwargs):
                timeline.append(("chunk", "로컬 폴백"))
                yield "로컬 폴백"

            def on_route_change(route):
                timeline.append(("route", route))

            task.chat_stream = failing_task_stream
            fallback.chat_stream = fallback_stream
            manager._task_provider = task
            manager._fallback = fallback

            chunks = [
                chunk
                async for chunk in manager.chat_stream(
                    "이 코드 분석해줘",
                    on_route_change=on_route_change,
                )
            ]

            assert chunks == ["클라우드 일부", "로컬 폴백"]
            assert timeline == [
                (
                    "route",
                    {
                        "mode": "task",
                        "provider": "gemini",
                        "execution": "cloud",
                        "fallback": False,
                    },
                ),
                (
                    "route",
                    {
                        "mode": "task",
                        "provider": "ollama",
                        "execution": "local",
                        "fallback": True,
                    },
                ),
                ("chunk", "로컬 폴백"),
            ]

    @pytest.mark.asyncio
    async def test_manual_mode_overrides_auto_classification(self):
        with patch("core.llm.get_settings") as mock_gs:
            mock_gs.return_value = Settings(_env_file=None)
            manager = LLMManager()
            casual = MagicMock()
            casual.is_available.return_value = True
            casual.chat = AsyncMock(return_value="일상 응답")
            task = MagicMock()
            task.is_available.return_value = True
            task.chat = AsyncMock(return_value="작업 응답")
            manager._casual_provider = casual
            manager._task_provider = task
            manager.set_mode(TanyaMode.TASK)

            result = await manager.chat("안녕")

            assert result == "작업 응답"
            task.chat.assert_awaited_once()


# ---------------------------------------------------------------------------
# 수동 모드 전환
# ---------------------------------------------------------------------------

class TestManualModeSwitch:
    def test_set_mode_casual(self):
        with patch("core.llm.get_settings") as mock_gs:
            settings = MagicMock()
            settings.llm_provider = "ollama"
            settings.casual_llm_provider = "ollama"
            settings.task_llm_provider = "gemini"
            settings.mode_auto_detect = True
            settings.google_api_key = ""
            settings.gemini_model_name = "gemini-flash"
            settings.openai_api_key = ""
            settings.openai_model_name = "gpt-4o"
            settings.anthropic_api_key = ""
            settings.claude_model_name = "claude-sonnet"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_gs.return_value = settings

            manager = LLMManager()
            manager.set_mode(TanyaMode.CASUAL)
            assert manager.current_mode == TanyaMode.CASUAL

    def test_set_mode_task(self):
        with patch("core.llm.get_settings") as mock_gs:
            settings = MagicMock()
            settings.llm_provider = "ollama"
            settings.casual_llm_provider = "ollama"
            settings.task_llm_provider = "gemini"
            settings.mode_auto_detect = True
            settings.google_api_key = ""
            settings.gemini_model_name = "gemini-flash"
            settings.openai_api_key = ""
            settings.openai_model_name = "gpt-4o"
            settings.anthropic_api_key = ""
            settings.claude_model_name = "claude-sonnet"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_gs.return_value = settings

            manager = LLMManager()
            manager.set_mode(TanyaMode.TASK)
            assert manager.current_mode == TanyaMode.TASK

    def test_set_mode_disables_auto_detect(self):
        """수동으로 모드 설정 시 auto_detect가 비활성화된다."""
        with patch("core.llm.get_settings") as mock_gs:
            settings = MagicMock()
            settings.llm_provider = "ollama"
            settings.casual_llm_provider = "ollama"
            settings.task_llm_provider = "gemini"
            settings.mode_auto_detect = True
            settings.google_api_key = ""
            settings.gemini_model_name = "gemini-flash"
            settings.openai_api_key = ""
            settings.openai_model_name = "gpt-4o"
            settings.anthropic_api_key = ""
            settings.claude_model_name = "claude-sonnet"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_gs.return_value = settings

            manager = LLMManager()
            manager.set_mode(TanyaMode.TASK)
            assert manager.auto_detect is False
