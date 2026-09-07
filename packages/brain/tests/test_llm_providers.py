"""LLM Provider 테스트."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pydantic import ValidationError

from config.settings import Settings
from core.providers.llm_base import LLMProvider
from core.providers.gemini import GeminiProvider
from core.providers.openai_provider import OpenAIProvider
from core.providers.claude import ClaudeProvider
from core.providers.ollama import OllamaProvider
from core.vision import VisionAnalysis, VisionProviderError, VisionUnavailableError


class TestLLMProviderInterface:
    """LLMProvider ABC 인터페이스 테스트."""

    def test_cannot_instantiate_abc(self):
        """ABC를 직접 인스턴스화할 수 없다."""
        with pytest.raises(TypeError):
            LLMProvider()


class TestGeminiProvider:
    """GeminiProvider 테스트."""

    def test_provider_name(self):
        provider = GeminiProvider(api_key="", model_name="test")
        assert provider.provider_name == "gemini"

    def test_not_available_without_key(self):
        provider = GeminiProvider(api_key="", model_name="test")
        assert provider.is_available() is False

    def test_available_with_key(self):
        with patch("langchain_google_genai.ChatGoogleGenerativeAI"):
            provider = GeminiProvider(api_key="fake-key", model_name="test")
            assert provider.is_available() is True

    @pytest.mark.asyncio
    async def test_chat_calls_ainvoke(self):
        with patch("langchain_google_genai.ChatGoogleGenerativeAI") as MockChat:
            mock_client = MockChat.return_value
            mock_response = MagicMock()
            mock_response.content = "안녕~"
            mock_client.ainvoke = AsyncMock(return_value=mock_response)

            provider = GeminiProvider(api_key="fake-key", model_name="test")
            result = await provider.chat("안녕!", system_prompt="테스트")

            assert result == "안녕~"
            mock_client.ainvoke.assert_called_once()

    def test_build_messages_with_history(self):
        history = [
            {"role": "user", "content": "첫번째"},
            {"role": "assistant", "content": "응답"},
        ]
        messages = GeminiProvider._build_messages("현재", "시스템", history)
        # system + 2 history + 1 user = 4
        assert len(messages) == 4


class TestOpenAIProvider:
    """OpenAIProvider 테스트."""

    def test_provider_name(self):
        provider = OpenAIProvider(api_key="", model_name="test")
        assert provider.provider_name == "openai"

    def test_not_available_without_key(self):
        provider = OpenAIProvider(api_key="", model_name="test")
        assert provider.is_available() is False

    def test_available_with_key(self):
        with patch("openai.AsyncOpenAI"):
            provider = OpenAIProvider(api_key="fake-key", model_name="test")
            assert provider.is_available() is True

    def test_build_messages_format(self):
        messages = OpenAIProvider._build_messages("안녕", "시스템", None)
        assert messages[0] == {"role": "system", "content": "시스템"}
        assert messages[1] == {"role": "user", "content": "안녕"}


class TestClaudeProvider:
    """ClaudeProvider 테스트."""

    def test_provider_name(self):
        provider = ClaudeProvider(api_key="", model_name="test")
        assert provider.provider_name == "claude"

    def test_not_available_without_key(self):
        provider = ClaudeProvider(api_key="", model_name="test")
        assert provider.is_available() is False

    def test_available_with_key(self):
        with patch("anthropic.AsyncAnthropic"):
            provider = ClaudeProvider(api_key="fake-key", model_name="test")
            assert provider.is_available() is True

    def test_build_messages_no_system(self):
        """Claude는 system을 별도 파라미터로 받으므로 messages에 포함하지 않는다."""
        messages = ClaudeProvider._build_messages("안녕", None)
        assert len(messages) == 1
        assert messages[0]["role"] == "user"


class TestOllamaProvider:
    """OllamaProvider 테스트."""

    def test_provider_name(self):
        provider = OllamaProvider()
        assert provider.provider_name == "ollama"

    def test_build_messages_with_system_and_history(self):
        history = [
            {"role": "user", "content": "이전"},
            {"role": "assistant", "content": "응답"},
        ]
        messages = OllamaProvider._build_messages("현재", "시스템", history)
        assert len(messages) == 4
        assert messages[0]["role"] == "system"
        assert messages[-1]["role"] == "user"
        assert messages[-1]["content"] == "현재"

    @pytest.mark.asyncio
    async def test_chat_calls_api(self):
        with patch("core.providers.ollama.requests") as mock_requests:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {
                "message": {"content": "응답이야!"}
            }
            mock_requests.post.return_value = mock_response

            provider = OllamaProvider()
            result = await provider.chat("안녕!")

            assert result == "응답이야!"
            mock_requests.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_chat_stream_yields_ollama_ndjson_chunks(self):
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.iter_lines.return_value = [
            b'{"message":{"content":"<ko>\\uc548\\ub155"},"done":false}',
            b'{"message":{"content":"</ko>"},"done":false}',
            b'{"done":true}',
        ]
        response.__enter__.return_value = response
        response.__exit__.return_value = None

        with patch("core.providers.ollama.requests.post", return_value=response) as post:
            provider = OllamaProvider()
            chunks = [chunk async for chunk in provider.chat_stream("안녕")]

        assert chunks == ["<ko>안녕", "</ko>"]
        assert post.call_args.kwargs["json"]["stream"] is True
        assert post.call_args.kwargs["stream"] is True

    @pytest.mark.asyncio
    async def test_analyze_image_returns_non_empty_local_result(self):
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"message": {"content": "로컬 화면 설명"}}

        with patch("core.providers.ollama.requests.post", return_value=response) as post:
            provider = OllamaProvider(
                base_url="http://192.168.10.20:11434",
                model_name="llava:7b",
            )
            result = await provider.analyze_image("sensitive-base64")

        assert result == "로컬 화면 설명"
        assert post.call_args.kwargs["json"]["model"] == "llava:7b"
        assert post.call_args.kwargs["json"]["messages"][-1]["images"] == [
            "sensitive-base64"
        ]

    @pytest.mark.asyncio
    async def test_analyze_image_rejects_empty_content(self):
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"message": {"content": "   "}}

        with patch("core.providers.ollama.requests.post", return_value=response):
            with pytest.raises(VisionProviderError):
                await OllamaProvider(model_name="llava:7b").analyze_image("image")

    @pytest.mark.asyncio
    async def test_analyze_image_rejects_empty_image_before_transport(self):
        with patch("core.providers.ollama.requests.post") as post:
            with pytest.raises(VisionProviderError):
                await OllamaProvider(model_name="llava:7b").analyze_image("   ")

        post.assert_not_called()

    @pytest.mark.asyncio
    async def test_analyze_image_hides_raw_provider_error(self):
        with patch(
            "core.providers.ollama.requests.post",
            side_effect=RuntimeError("sensitive-base64 provider body"),
        ):
            with pytest.raises(VisionProviderError) as exc_info:
                await OllamaProvider(model_name="llava:7b").analyze_image(
                    "sensitive-base64"
                )

        assert "sensitive-base64" not in str(exc_info.value)
        assert exc_info.value.__cause__ is None


class TestLLMManager:
    """LLMManager 통합 테스트."""

    def test_default_provider_is_gemini(self):
        """기본 LLM Provider는 gemini이다."""
        with (
            patch("core.llm.get_settings") as mock_settings,
            patch("core.llm.GeminiProvider") as MockGemini,
        ):
            settings = MagicMock()
            settings.llm_provider = "gemini"
            settings.google_api_key = "fake-key"
            settings.gemini_model_name = "test"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_settings.return_value = settings

            mock_gemini = MockGemini.return_value
            mock_gemini.is_available.return_value = True
            mock_gemini.provider_name = "gemini"

            from core.llm import LLMManager

            manager = LLMManager()
            assert manager.active_provider_name == "gemini"

    def test_fallback_to_ollama(self):
        """Primary Provider가 사용 불가 시 Ollama로 폴백."""
        with (
            patch("core.llm.get_settings") as mock_settings,
            patch("core.llm.GeminiProvider") as MockGemini,
        ):
            settings = MagicMock()
            settings.llm_provider = "gemini"
            settings.google_api_key = ""
            settings.gemini_model_name = "test"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_settings.return_value = settings

            mock_gemini = MockGemini.return_value
            mock_gemini.is_available.return_value = False

            from core.llm import LLMManager

            manager = LLMManager()
            assert manager.active_provider_name == "ollama"

    def test_provider_selection_openai(self):
        """LLM_PROVIDER=openai일 때 OpenAI Provider 선택."""
        with (
            patch("core.llm.get_settings") as mock_settings,
            patch("core.llm.OpenAIProvider") as MockOpenAI,
        ):
            settings = MagicMock()
            settings.llm_provider = "openai"
            settings.openai_api_key = "fake-key"
            settings.openai_model_name = "gpt-4o"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "qwen2.5:7b"
            mock_settings.return_value = settings

            mock_openai = MockOpenAI.return_value
            mock_openai.is_available.return_value = True
            mock_openai.provider_name = "openai"

            from core.llm import LLMManager

            manager = LLMManager()
            assert manager.active_provider_name == "openai"

    @pytest.mark.asyncio
    async def test_vision_uses_only_dedicated_local_provider(self):
        from core.llm import LLMManager

        manager = LLMManager.__new__(LLMManager)
        manager._vision_enabled = True
        local = MagicMock()
        local.provider_name = "ollama"
        local.model_name = "llava:7b"
        local.is_available.return_value = True
        local.analyze_image = AsyncMock(return_value="로컬 분석")
        cloud = MagicMock()
        cloud.provider_name = "gemini"
        cloud.analyze_image = AsyncMock(return_value="클라우드 분석")
        manager._vision_provider = local
        manager._task_provider = cloud
        manager._primary = cloud
        manager._fallback = MagicMock()

        result = await manager.analyze_image("sensitive-base64")

        assert result == VisionAnalysis.local_ollama("로컬 분석", "llava:7b")
        local.analyze_image.assert_awaited_once_with("sensitive-base64", "")
        cloud.analyze_image.assert_not_awaited()
        manager._fallback.analyze_image.assert_not_called()

    @pytest.mark.asyncio
    async def test_vision_is_fail_closed_when_disabled(self):
        from core.llm import LLMManager

        manager = LLMManager.__new__(LLMManager)
        manager._vision_enabled = False
        manager._vision_provider = None
        manager._task_provider = MagicMock()

        with pytest.raises(VisionUnavailableError):
            await manager.analyze_image("sensitive-base64")

        manager._task_provider.analyze_image.assert_not_called()

    @pytest.mark.asyncio
    async def test_vision_is_fail_closed_when_local_provider_unavailable(self):
        from core.llm import LLMManager

        manager = LLMManager.__new__(LLMManager)
        manager._vision_enabled = True
        local = MagicMock()
        local.is_available.return_value = False
        local.analyze_image = AsyncMock()
        manager._vision_provider = local
        manager._task_provider = MagicMock()

        with pytest.raises(VisionUnavailableError):
            await manager.analyze_image("sensitive-base64")

        local.analyze_image.assert_not_awaited()
        manager._task_provider.analyze_image.assert_not_called()

    @pytest.mark.asyncio
    async def test_vision_local_error_never_falls_back_or_exposes_raw_details(self):
        from core.llm import LLMManager

        manager = LLMManager.__new__(LLMManager)
        manager._vision_enabled = True
        local = MagicMock()
        local.is_available.return_value = True
        local.analyze_image = AsyncMock(
            side_effect=VisionProviderError("sensitive-base64 provider body")
        )
        manager._vision_provider = local
        manager._task_provider = MagicMock()
        manager._fallback = MagicMock()

        with pytest.raises(VisionUnavailableError) as exc_info:
            await manager.analyze_image("sensitive-base64")

        assert "sensitive-base64" not in str(exc_info.value)
        assert exc_info.value.__cause__ is None
        manager._task_provider.analyze_image.assert_not_called()
        manager._fallback.analyze_image.assert_not_called()


class TestVisionSettings:
    def test_vision_is_disabled_by_default(self):
        settings = Settings(_env_file=None)

        assert settings.enable_vision is False
        assert settings.vision_configured is False

    def test_vision_rejects_cloud_provider(self):
        with pytest.raises(ValidationError):
            Settings(
                _env_file=None,
                enable_vision=True,
                vision_provider="gemini",
                vision_base_url="https://generativelanguage.googleapis.com",
                vision_model="gemini-vision",
            )

    def test_vision_rejects_public_endpoint(self):
        with pytest.raises(ValidationError):
            Settings(
                _env_file=None,
                enable_vision=True,
                vision_provider="ollama",
                vision_base_url="https://example.com",
                vision_model="llava:7b",
            )

    @pytest.mark.parametrize("missing", ["vision_base_url", "vision_model"])
    def test_enabled_vision_requires_explicit_local_settings(self, missing):
        values = {
            "enable_vision": True,
            "vision_provider": "ollama",
            "vision_base_url": "http://192.168.10.20:11434",
            "vision_model": "llava:7b",
        }
        values[missing] = ""

        with pytest.raises(ValidationError):
            Settings(_env_file=None, **values)

    def test_vision_accepts_private_ollama_endpoint(self):
        settings = Settings(
            _env_file=None,
            enable_vision=True,
            vision_provider="ollama",
            vision_base_url="http://192.168.10.20:11434",
            vision_model="llava:7b",
        )

        assert settings.vision_configured is True


class TestCasualPinnedCall:
    """ADR-0007 — 선제 발화는 분류를 우회해 일상 모드 provider로 나간다."""

    @pytest.mark.asyncio
    async def test_chat_casual_skips_classification(self):
        from core.llm import LLMManager
        from core.mode import TanyaMode

        manager = LLMManager.__new__(LLMManager)
        casual = MagicMock()
        casual.provider_name = "ollama"
        casual.is_available = MagicMock(return_value=True)
        casual.chat = AsyncMock(return_value="로컬 응답")
        task = MagicMock()
        task.provider_name = "gemini"
        task.chat = AsyncMock(return_value="클라우드 응답")
        manager._casual_provider = casual
        manager._task_provider = task
        manager._fallback = casual
        manager._mode_classifier = MagicMock()

        # 100자를 넘겨 분류기라면 TASK로 보낼 프롬프트
        long_prompt = "3시에 프로젝트 회의가 있어. " * 10
        result = await manager.chat_casual(user_input=long_prompt, system_prompt="페르소나")

        assert result == "로컬 응답"
        casual.chat.assert_awaited_once()
        task.chat.assert_not_awaited()
        # 분류기 자체를 부르지 않는다
        manager._mode_classifier.classify.assert_not_called()

    @pytest.mark.asyncio
    async def test_chat_casual_falls_back_when_casual_unavailable(self):
        from core.llm import LLMManager

        manager = LLMManager.__new__(LLMManager)
        casual = MagicMock()
        casual.provider_name = "ollama"
        casual.is_available = MagicMock(return_value=False)
        casual.chat = AsyncMock(side_effect=AssertionError("불가용 provider를 부르면 안 된다"))
        fallback = MagicMock()
        fallback.provider_name = "ollama-fallback"
        fallback.chat = AsyncMock(return_value="폴백 응답")
        manager._casual_provider = casual
        manager._task_provider = MagicMock()
        manager._fallback = fallback
        manager._mode_classifier = MagicMock()

        result = await manager.chat_casual(user_input="안녕")

        assert result == "폴백 응답"
        fallback.chat.assert_awaited_once()


class TestOllamaRequestOptions:
    """T-042: 사고 생성과 컨텍스트 길이를 설정으로 제어한다."""

    @pytest.mark.asyncio
    async def test_chat_sends_think_and_num_ctx(self):
        provider = OllamaProvider(model_name="m", think=False, num_ctx=65536)
        response = MagicMock()
        response.json.return_value = {"message": {"content": "안녕"}}
        response.raise_for_status.return_value = None

        with patch("requests.post", return_value=response) as post:
            assert await provider.chat("안녕") == "안녕"

        payload = post.call_args.kwargs["json"]
        assert payload["think"] is False
        assert payload["options"] == {"num_ctx": 65536}

    @pytest.mark.asyncio
    async def test_num_ctx_zero_keeps_ollama_default(self):
        """0이면 options를 보내지 않아 Ollama 기본값을 그대로 쓴다."""
        provider = OllamaProvider(model_name="m", num_ctx=0)
        response = MagicMock()
        response.json.return_value = {"message": {"content": "ok"}}
        response.raise_for_status.return_value = None

        with patch("requests.post", return_value=response) as post:
            await provider.chat("안녕")

        assert "options" not in post.call_args.kwargs["json"]

    @pytest.mark.asyncio
    async def test_think_enabled_is_forwarded(self):
        provider = OllamaProvider(model_name="m", think=True)
        response = MagicMock()
        response.json.return_value = {"message": {"content": "ok"}}
        response.raise_for_status.return_value = None

        with patch("requests.post", return_value=response) as post:
            await provider.chat("안녕")

        assert post.call_args.kwargs["json"]["think"] is True

    @pytest.mark.asyncio
    async def test_stream_never_emits_thinking_tokens(self):
        """사고 델타는 message.thinking으로 오며 사용자에게 전달되면 안 된다."""
        provider = OllamaProvider(model_name="m", think=True, num_ctx=8192)
        import json as _json

        lines = [
            _json.dumps(chunk).encode("utf-8")
            for chunk in [
                {"message": {"thinking": "사고 과정"}, "done": False},
                {"message": {"content": "안녕"}, "done": False},
                {"message": {"thinking": "더 생각"}, "done": False},
                {"message": {"content": "하세요"}, "done": True},
            ]
        ]
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.iter_lines.return_value = iter(lines)
        response.__enter__ = lambda self_: response
        response.__exit__ = lambda self_, *args: False

        with patch("requests.post", return_value=response) as post:
            chunks = [chunk async for chunk in provider.chat_stream("안녕")]

        assert chunks == ["안녕", "하세요"]
        assert "사고" not in "".join(chunks)
        payload = post.call_args.kwargs["json"]
        assert payload["think"] is True
        assert payload["options"] == {"num_ctx": 8192}
