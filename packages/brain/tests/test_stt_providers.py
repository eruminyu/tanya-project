"""Phase 5-C: STT Provider 테스트.

faster-whisper 모델 미설치 시 skip 처리.
OpenAI Whisper API 테스트는 mock 사용.
"""

import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# STTProvider ABC 인터페이스
# ---------------------------------------------------------------------------

class TestSTTProviderInterface:
    """STTProvider ABC 인터페이스 검증."""

    def test_import(self):
        """STTProvider를 import할 수 있어야 한다."""
        from core.providers.stt_base import STTProvider
        assert STTProvider is not None

    def test_is_abstract(self):
        """STTProvider는 추상 클래스여야 한다."""
        from core.providers.stt_base import STTProvider
        import inspect
        assert inspect.isabstract(STTProvider)

    def test_abstract_methods(self):
        """provider_name, is_available, transcribe가 추상 메서드여야 한다."""
        from core.providers.stt_base import STTProvider
        assert "provider_name" in STTProvider.__abstractmethods__
        assert "is_available" in STTProvider.__abstractmethods__
        assert "transcribe" in STTProvider.__abstractmethods__

    def test_concrete_must_implement_all(self):
        """추상 메서드 미구현 시 인스턴스화 불가."""
        from core.providers.stt_base import STTProvider

        class PartialSTT(STTProvider):
            @property
            def provider_name(self) -> str:
                return "partial"
            def is_available(self) -> bool:
                return True
            # transcribe 미구현

        with pytest.raises(TypeError):
            PartialSTT()


# ---------------------------------------------------------------------------
# FasterWhisperProvider
# ---------------------------------------------------------------------------

class TestFasterWhisperProvider:
    """FasterWhisperProvider 동작 검증."""

    def test_import(self):
        """FasterWhisperProvider를 import할 수 있어야 한다."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider
        assert FasterWhisperProvider is not None

    def test_provider_name(self):
        """provider_name은 'faster-whisper'여야 한다."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider
        provider = FasterWhisperProvider()
        assert provider.provider_name == "faster-whisper"

    def test_is_available_false_when_not_installed(self):
        """faster-whisper 미설치 시 is_available()은 False를 반환해야 한다."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider
        with patch.dict("sys.modules", {"faster_whisper": None}):
            provider = FasterWhisperProvider()
            assert provider.is_available() is False

    def test_is_available_true_when_installed(self):
        """faster-whisper 설치 시 is_available()은 True를 반환해야 한다."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider
        mock_fw = MagicMock()
        with patch.dict("sys.modules", {"faster_whisper": mock_fw}):
            provider = FasterWhisperProvider()
            assert provider.is_available() is True

    @pytest.mark.asyncio
    async def test_transcribe_returns_text(self):
        """transcribe()는 인식된 텍스트 문자열을 반환해야 한다."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider

        # faster_whisper mock
        mock_segment = MagicMock()
        mock_segment.text = " 안녕하세요"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], MagicMock())

        mock_fw = MagicMock()
        mock_fw.WhisperModel.return_value = mock_model

        with patch.dict("sys.modules", {"faster_whisper": mock_fw}):
            provider = FasterWhisperProvider(model_size="tiny")
            result = await provider.transcribe(b"fake_audio_bytes", language="ko")

        assert result == "안녕하세요"

    @pytest.mark.asyncio
    async def test_transcribe_strips_whitespace(self):
        """transcribe() 결과의 앞뒤 공백이 제거되어야 한다."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider

        mock_segment1 = MagicMock()
        mock_segment1.text = "  첫 번째 문장  "
        mock_segment2 = MagicMock()
        mock_segment2.text = " 두 번째 문장"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment1, mock_segment2], MagicMock())

        mock_fw = MagicMock()
        mock_fw.WhisperModel.return_value = mock_model

        with patch.dict("sys.modules", {"faster_whisper": mock_fw}):
            provider = FasterWhisperProvider()
            result = await provider.transcribe(b"audio")

        assert result == "첫 번째 문장   두 번째 문장"

    @pytest.mark.asyncio
    async def test_transcribe_raises_when_unavailable(self):
        """faster-whisper 미설치 시 transcribe() 호출 시 RuntimeError 발생."""
        from core.providers.faster_whisper_provider import FasterWhisperProvider

        with patch.dict("sys.modules", {"faster_whisper": None}):
            provider = FasterWhisperProvider()
            with pytest.raises(RuntimeError):
                await provider.transcribe(b"audio")


# ---------------------------------------------------------------------------
# WhisperAPIProvider
# ---------------------------------------------------------------------------

class TestWhisperAPIProvider:
    """WhisperAPIProvider (OpenAI Whisper API 폴백) 동작 검증."""

    def test_import(self):
        """WhisperAPIProvider를 import할 수 있어야 한다."""
        from core.providers.whisper_api_provider import WhisperAPIProvider
        assert WhisperAPIProvider is not None

    def test_provider_name(self):
        """provider_name은 'whisper-api'여야 한다."""
        from core.providers.whisper_api_provider import WhisperAPIProvider
        provider = WhisperAPIProvider(api_key="test_key")
        assert provider.provider_name == "whisper-api"

    def test_is_available_false_without_api_key(self):
        """API 키 없으면 is_available()은 False를 반환해야 한다."""
        from core.providers.whisper_api_provider import WhisperAPIProvider
        provider = WhisperAPIProvider(api_key="")
        assert provider.is_available() is False

    def test_is_available_true_with_api_key(self):
        """API 키가 있으면 is_available()은 True를 반환해야 한다."""
        from core.providers.whisper_api_provider import WhisperAPIProvider
        provider = WhisperAPIProvider(api_key="sk-test")
        assert provider.is_available() is True

    @pytest.mark.asyncio
    async def test_transcribe_calls_openai_api(self):
        """transcribe()는 OpenAI Audio API를 호출해야 한다."""
        from core.providers.whisper_api_provider import WhisperAPIProvider

        mock_transcript = MagicMock()
        mock_transcript.text = "인식된 텍스트"

        mock_audio = MagicMock()
        mock_audio.transcriptions = AsyncMock()
        mock_audio.transcriptions.create = AsyncMock(return_value=mock_transcript)

        mock_client = MagicMock()
        mock_client.audio = mock_audio

        with patch("core.providers.whisper_api_provider.AsyncOpenAI", return_value=mock_client):
            provider = WhisperAPIProvider(api_key="sk-test")
            result = await provider.transcribe(b"audio_bytes", language="ko")

        assert result == "인식된 텍스트"

    @pytest.mark.asyncio
    async def test_transcribe_raises_without_key(self):
        """API 키 없이 transcribe() 호출 시 RuntimeError 발생."""
        from core.providers.whisper_api_provider import WhisperAPIProvider
        provider = WhisperAPIProvider(api_key="")
        with pytest.raises(RuntimeError):
            await provider.transcribe(b"audio")


# ---------------------------------------------------------------------------
# Settings STT 필드
# ---------------------------------------------------------------------------

class TestSTTSettings:
    """Settings에 STT 설정 필드가 있어야 한다."""

    def test_settings_has_stt_fields(self):
        """Settings에 STT 관련 필드가 있어야 한다."""
        from config.settings import Settings
        fields = Settings.model_fields
        assert "stt_provider" in fields
        assert "enable_stt" in fields
        assert "stt_model_size" in fields

    def test_stt_default_values(self):
        """STT 설정의 기본값을 확인한다."""
        from config.settings import Settings
        fields = Settings.model_fields
        assert fields["stt_provider"].default == "faster-whisper"
        assert fields["enable_stt"].default is False


class TestFasterWhisperConfiguration:
    """T-041: 모델 크기·장치·정밀도·VAD를 설정으로 다룬다."""

    def _provider(self, **kwargs):
        from core.providers.faster_whisper_provider import FasterWhisperProvider

        return FasterWhisperProvider(**kwargs)

    def test_cpu_defaults_to_int8(self):
        provider = self._provider(model_size="medium", device="cpu")
        fake_model = MagicMock()
        with patch.dict("sys.modules", {"faster_whisper": MagicMock(WhisperModel=fake_model)}):
            provider._get_model()
        assert fake_model.call_args.kwargs["compute_type"] == "int8"
        assert fake_model.call_args.args[0] == "medium"

    def test_cuda_defaults_to_float16(self):
        provider = self._provider(device="cuda")
        fake_model = MagicMock()
        with patch.dict("sys.modules", {"faster_whisper": MagicMock(WhisperModel=fake_model)}):
            provider._get_model()
        assert fake_model.call_args.kwargs["compute_type"] == "float16"

    def test_explicit_compute_type_wins(self):
        """VRAM이 빠듯할 때 int8_float16 같은 값을 직접 지정할 수 있어야 한다."""
        provider = self._provider(device="cuda", compute_type="int8_float16")
        fake_model = MagicMock()
        with patch.dict("sys.modules", {"faster_whisper": MagicMock(WhisperModel=fake_model)}):
            provider._get_model()
        assert fake_model.call_args.kwargs["compute_type"] == "int8_float16"

    @pytest.mark.asyncio
    async def test_vad_filter_is_forwarded(self):
        provider = self._provider(vad_filter=True)
        model = MagicMock()
        model.transcribe.return_value = ([MagicMock(text="안녕하세요")], None)
        provider._model = model
        with patch.object(provider, "is_available", return_value=True):
            assert await provider.transcribe(b"audio") == "안녕하세요"
        assert model.transcribe.call_args.kwargs["vad_filter"] is True
        assert model.transcribe.call_args.kwargs["language"] == "ko"

    @pytest.mark.asyncio
    async def test_vad_filter_defaults_off(self):
        provider = self._provider()
        model = MagicMock()
        model.transcribe.return_value = ([MagicMock(text="네")], None)
        provider._model = model
        with patch.object(provider, "is_available", return_value=True):
            await provider.transcribe(b"audio")
        assert model.transcribe.call_args.kwargs["vad_filter"] is False

    def test_settings_expose_stt_knobs(self):
        from config.settings import Settings

        settings = Settings()
        assert settings.stt_device == "cpu"
        assert settings.stt_compute_type == ""
        assert settings.stt_vad_filter is False


class TestFasterWhisperInitialPrompt:
    """T-047: 고정 어휘 힌트로 인식률을 올린다."""

    def _provider(self, **kwargs):
        from core.providers.faster_whisper_provider import FasterWhisperProvider

        return FasterWhisperProvider(**kwargs)

    @pytest.mark.asyncio
    async def test_initial_prompt_is_forwarded(self):
        provider = self._provider(initial_prompt="체험 시작할게. 지금 잊어줘.")
        model = MagicMock()
        model.transcribe.return_value = ([MagicMock(text="체험 시작할게")], None)
        provider._model = model
        with patch.object(provider, "is_available", return_value=True):
            await provider.transcribe(b"audio")
        assert model.transcribe.call_args.kwargs["initial_prompt"] == "체험 시작할게. 지금 잊어줘."

    @pytest.mark.asyncio
    async def test_empty_prompt_sends_none(self):
        """빈 설정은 힌트를 주지 않는 것과 같아야 한다."""
        provider = self._provider(initial_prompt="   ")
        model = MagicMock()
        model.transcribe.return_value = ([MagicMock(text="네")], None)
        provider._model = model
        with patch.object(provider, "is_available", return_value=True):
            await provider.transcribe(b"audio")
        assert model.transcribe.call_args.kwargs["initial_prompt"] is None

    def test_default_prompt_covers_tutorial_grammar(self):
        """제한 문법 문장이 힌트에 없으면 그 문장은 계속 틀린다."""
        from config.settings import Settings

        prompt = Settings().stt_initial_prompt
        for phrase in ["체험 시작할게", "이 일정으로 등록해줘", "지금 잊어줘", "건너뛸게"]:
            assert phrase in prompt
