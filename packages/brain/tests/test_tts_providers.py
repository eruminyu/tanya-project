"""TTS Provider 테스트."""

import pytest


import requests
import json
from unittest.mock import AsyncMock, MagicMock, call, patch

from core.providers.tts_base import TTSProvider
from core.providers.edge_tts_provider import EdgeTTSProvider
from core.providers.aivis_speech_provider import AivisSpeechProvider
from core.providers.fish_speech_provider import FishSpeechProvider
from core.providers.gpt_sovits_provider import GptSovitsProvider
from core.audio import TTSManager
from config.settings import Settings


def _tiny_wav(samples=(0, 600, -400, 0)) -> bytes:
    """검증기를 통과하는 최소 WAV.

    T-046이 무음·비 WAV 응답을 실패로 처리하므로, 가짜 바이트 문자열 대신
    실제 형식을 갖춘 오디오를 써야 한다.
    """
    import struct

    data = struct.pack("<%dh" % len(samples), *samples)
    return (
        b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
        + b"data" + struct.pack("<I", len(data)) + data
    )


class TestTTSProviderInterface:
    """TTSProvider ABC 인터페이스 테스트."""

    def test_cannot_instantiate_abc(self):
        """ABC를 직접 인스턴스화할 수 없다."""
        with pytest.raises(TypeError):
            TTSProvider()


class TestEdgeTTSProvider:
    """EdgeTTSProvider 테스트."""

    def test_provider_name(self):
        provider = EdgeTTSProvider()
        assert provider.provider_name == "edge-tts"

    def test_is_available(self):
        """edge-tts 패키지가 설치되어 있으면 사용 가능."""
        provider = EdgeTTSProvider()
        assert provider.is_available() is True

    def test_default_voice(self):
        provider = EdgeTTSProvider()
        assert provider._default_voice == "ko-KR-SunHiNeural"

    def test_custom_voice(self):
        provider = EdgeTTSProvider(default_voice="en-US-AriaNeural")
        assert provider._default_voice == "en-US-AriaNeural"


class TestFishSpeechProvider:
    def test_provider_name(self):
        provider = FishSpeechProvider("http://127.0.0.1:8080/v1/tts")
        assert provider.provider_name == "fish-speech"

    def test_is_available_uses_health_endpoint(self):
        provider = FishSpeechProvider("http://127.0.0.1:8080/v1/tts")
        with patch("core.providers.fish_speech_provider.requests.get") as mock_get:
            mock_get.return_value.ok = True
            assert provider.is_available() is True
        mock_get.assert_called_once_with(
            "http://127.0.0.1:8080/v1/health", timeout=2.0
        )

    @pytest.mark.asyncio
    async def test_generate_posts_json_and_returns_base64_audio(self):
        provider = FishSpeechProvider(
            "http://127.0.0.1:8080/v1/tts",
            reference_id="tanya",
            timeout_seconds=12.0,
        )
        with patch("core.providers.fish_speech_provider.requests.post") as mock_post:
            mock_post.return_value.content = b"wav-audio"
            mock_post.return_value.raise_for_status.return_value = None
            result = await provider.generate("안녕하세요")

        assert result == "d2F2LWF1ZGlv"
        mock_post.assert_called_once_with(
            "http://127.0.0.1:8080/v1/tts",
            json={
                "text": "안녕하세요",
                "format": "wav",
                "streaming": False,
                "reference_id": "tanya",
            },
            timeout=12.0,
        )

    @pytest.mark.asyncio
    async def test_generate_rejects_empty_audio(self):
        provider = FishSpeechProvider("http://127.0.0.1:8080/v1/tts")
        with patch("core.providers.fish_speech_provider.requests.post") as mock_post:
            mock_post.return_value.content = b""
            mock_post.return_value.raise_for_status.return_value = None
            with pytest.raises(RuntimeError, match="빈 오디오"):
                await provider.generate("안녕하세요")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "error",
        [
            requests.Timeout("timeout"),
            requests.ConnectionError("offline"),
            requests.HTTPError("500 server error"),
        ],
    )
    async def test_generate_propagates_http_failures(self, error):
        provider = FishSpeechProvider("http://127.0.0.1:8080/v1/tts")
        with patch("core.providers.fish_speech_provider.requests.post") as mock_post:
            if isinstance(error, requests.HTTPError):
                mock_post.return_value.raise_for_status.side_effect = error
            else:
                mock_post.side_effect = error
            with pytest.raises(type(error)):
                await provider.generate("안녕하세요")


class TestAivisSpeechProvider:
    def test_provider_name(self):
        provider = AivisSpeechProvider("http://127.0.0.1:10101", 1878365379)
        assert provider.provider_name == "aivis-speech"

    def test_is_available_uses_version_endpoint(self):
        provider = AivisSpeechProvider("http://127.0.0.1:10101", 1878365379)
        with patch("core.providers.aivis_speech_provider.requests.get") as mock_get:
            mock_get.return_value.ok = True
            assert provider.is_available() is True
        mock_get.assert_called_once_with(
            "http://127.0.0.1:10101/version", timeout=2.0
        )

    @pytest.mark.asyncio
    async def test_generate_uses_configured_style_and_returns_base64_wav(self):
        provider = AivisSpeechProvider(
            "http://127.0.0.1:10101",
            1878365379,
            timeout_seconds=12.0,
        )
        query_response = MagicMock()
        query_response.json.return_value = {"speedScale": 1.0, "pitchScale": 0.0}
        query_response.raise_for_status.return_value = None
        synthesis_response = MagicMock()
        synthesis_response.content = b"wav-audio"
        synthesis_response.raise_for_status.return_value = None

        with patch(
            "core.providers.aivis_speech_provider.requests.post",
            side_effect=[query_response, synthesis_response],
        ) as mock_post:
            result = await provider.generate("おかえりなさい", rate=1.1)

        assert result == "d2F2LWF1ZGlv"
        assert mock_post.call_args_list == [
            call(
                "http://127.0.0.1:10101/audio_query",
                params={"text": "おかえりなさい", "speaker": 1878365379},
                timeout=12.0,
            ),
            call(
                "http://127.0.0.1:10101/synthesis",
                params={"speaker": 1878365379},
                json={"speedScale": 1.1, "pitchScale": 0.0},
                timeout=12.0,
            ),
        ]

    @pytest.mark.asyncio
    async def test_generate_rejects_empty_audio(self):
        provider = AivisSpeechProvider("http://127.0.0.1:10101", 1878365379)
        query_response = MagicMock()
        query_response.json.return_value = {}
        query_response.raise_for_status.return_value = None
        synthesis_response = MagicMock()
        synthesis_response.content = b""
        synthesis_response.raise_for_status.return_value = None

        with patch(
            "core.providers.aivis_speech_provider.requests.post",
            side_effect=[query_response, synthesis_response],
        ):
            with pytest.raises(RuntimeError, match="빈 오디오"):
                await provider.generate("おかえりなさい")


class TestGptSovitsProvider:
    def test_provider_name(self):
        provider = GptSovitsProvider(
            "http://127.0.0.1:9881/tts",
            "/opt/gpt-sovits/ref_audio/ref_affection.wav",
            "자기야, 오늘도 진짜 수고 많았어. 푹 쉬어.",
        )
        assert provider.provider_name == "gpt-sovits-cpufast"

    def test_is_available_uses_openapi_endpoint(self):
        provider = GptSovitsProvider(
            "http://127.0.0.1:9881/tts",
            "/tmp/ref.wav",
            "참조 문장",
        )
        with patch("core.providers.gpt_sovits_provider.requests.get") as mock_get:
            mock_get.return_value.ok = True
            assert provider.is_available() is True
        mock_get.assert_called_once_with(
            "http://127.0.0.1:9881/openapi.json", timeout=2.0
        )

    @pytest.mark.asyncio
    async def test_generate_posts_korean_v2pro_payload_and_returns_base64_wav(self):
        provider = GptSovitsProvider(
            "http://127.0.0.1:9881/tts",
            "/opt/demo/ref.wav",
            "자기야, 푹 쉬어.",
            timeout_seconds=45.0,
            seed=12345,
        )
        with patch("core.providers.gpt_sovits_provider.requests.post") as mock_post:
            mock_post.return_value.content = _tiny_wav()
            mock_post.return_value.raise_for_status.return_value = None
            result = await provider.generate("오늘도 수고했어.", rate=1.2)

        assert result == "UklGRiwAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQgAAAAAAFgCcP4AAA=="
        mock_post.assert_called_once_with(
            "http://127.0.0.1:9881/tts",
            json={
                "text": "오늘도 수고했어.",
                "text_lang": "ko",
                "ref_audio_path": "/opt/demo/ref.wav",
                "prompt_text": "자기야, 푹 쉬어.",
                "prompt_lang": "ko",
                "text_split_method": "cut5",
                "batch_size": 1,
                "media_type": "wav",
                "streaming_mode": False,
                "parallel_infer": True,
                "vits_parallel_infer": False,
                "speed_factor": 1.2,
                "seed": 12345,
            },
            timeout=45.0,
        )

    @pytest.mark.asyncio
    async def test_generate_rejects_empty_audio(self):
        provider = GptSovitsProvider(
            "http://127.0.0.1:9881/tts", "/tmp/ref.wav", "참조 문장"
        )
        with patch("core.providers.gpt_sovits_provider.requests.post") as mock_post:
            mock_post.return_value.content = b""
            mock_post.return_value.raise_for_status.return_value = None
            with pytest.raises(RuntimeError, match="빈 오디오"):
                await provider.generate("안녕하세요")

    @pytest.mark.asyncio
    async def test_generate_selects_reference_profile_from_voice_tone(self, tmp_path):
        metadata_path = tmp_path / "ref_audio_meta.json"
        metadata_path.write_text(
            json.dumps(
                {
                    "cheer": {
                        "path": "ref_audio/ref_cheer.wav",
                        "text": "거봐, 내가 할 수 있다고 했잖아.",
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        provider = GptSovitsProvider(
            "http://127.0.0.1:9881/tts",
            "/opt/demo/ref_audio/ref_affection.wav",
            "자기야, 푹 쉬어.",
            reference_metadata_path=str(metadata_path),
        )

        with patch("core.providers.gpt_sovits_provider.requests.post") as mock_post:
            mock_post.return_value.content = _tiny_wav()
            mock_post.return_value.raise_for_status.return_value = None
            await provider.generate("정말 잘했어!", voice="cheer")

        payload = mock_post.call_args.kwargs["json"]
        assert payload["ref_audio_path"] == str(tmp_path / "ref_audio/ref_cheer.wav")
        assert payload["prompt_text"] == "거봐, 내가 할 수 있다고 했잖아."


class TestTTSManager:
    """TTSManager 통합 테스트."""

    def test_settings_default_provider_is_edge_tts(self):
        """8GB GPU MVP의 기본 TTS는 GPU를 사용하지 않는 edge-tts이다."""
        assert Settings.model_fields["tts_provider"].default == "edge-tts"

    def test_default_provider_is_edge_tts(self):
        """기본 TTS Provider는 edge-tts이다."""
        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "edge-tts"
            settings.tts_voice = "ko-KR-SunHiNeural"
            mock_settings.return_value = settings

            from core.audio import TTSManager

            manager = TTSManager()
            assert manager.active_provider_name == "edge-tts"

    def test_fish_speech_provider_is_selected(self):
        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "fish-speech"
            settings.tts_voice = "ko-KR-SunHiNeural"
            settings.fish_speech_url = "http://127.0.0.1:8080/v1/tts"
            settings.fish_speech_reference_id = "tanya"
            settings.fish_speech_timeout_seconds = 30.0
            mock_settings.return_value = settings

            with patch.object(FishSpeechProvider, "is_available", return_value=True):
                from core.audio import TTSManager

                manager = TTSManager()
        assert manager.active_provider_name == "fish-speech"

    def test_aivis_speech_provider_is_selected(self):
        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "aivis-speech"
            settings.tts_voice = ""
            settings.aivis_speech_url = "http://127.0.0.1:10101"
            settings.aivis_speech_style_id = 1878365379
            settings.aivis_speech_timeout_seconds = 30.0
            mock_settings.return_value = settings

            with patch.object(AivisSpeechProvider, "is_available", return_value=True):
                manager = TTSManager()

        assert manager.active_provider_name == "aivis-speech"

    def test_gpt_sovits_cpufast_provider_is_selected(self):
        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "gpt-sovits-cpufast"
            settings.tts_voice = "ko-KR-SunHiNeural"
            settings.gpt_sovits_url = "http://127.0.0.1:9881/tts"
            settings.gpt_sovits_reference_audio_path = "/opt/demo/ref.wav"
            settings.gpt_sovits_prompt_text = "자기야, 푹 쉬어."
            settings.gpt_sovits_timeout_seconds = 45.0
            settings.gpt_sovits_seed = 12345
            settings.gpt_sovits_reference_metadata_path = "/opt/demo/meta.json"
            mock_settings.return_value = settings

            with patch.object(GptSovitsProvider, "is_available", return_value=True):
                manager = TTSManager()

        assert manager.active_provider_name == "gpt-sovits-cpufast"

    @pytest.mark.asyncio
    async def test_runtime_failure_falls_back_to_edge_tts(self):
        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "fish-speech"
            settings.tts_voice = "ko-KR-SunHiNeural"
            settings.fish_speech_url = "http://127.0.0.1:8080/v1/tts"
            settings.fish_speech_reference_id = "tanya"
            settings.fish_speech_timeout_seconds = 30.0
            mock_settings.return_value = settings

            with patch.object(FishSpeechProvider, "is_available", return_value=True):
                manager = TTSManager()
            manager._provider.generate = AsyncMock(side_effect=RuntimeError("offline"))
            manager._fallback_provider.generate = AsyncMock(return_value="fallback")

            result = await manager.generate("안녕하세요")

        assert result == "fallback"

    def test_fallback_to_edge_tts(self):
        """알 수 없는 Provider는 edge-tts로 폴백."""
        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "unknown-provider"
            settings.tts_voice = "ko-KR-SunHiNeural"
            mock_settings.return_value = settings

            from core.audio import TTSManager

            manager = TTSManager()
            assert manager.active_provider_name == "edge-tts"


class TestGptSovitsSilentFailure:
    """T-046: 합성 실패를 성공으로 통과시키지 않는다.

    2026-09-06 GPU 전환 작업 중 GPT-SoVITS가 내부 예외로 실패했는데도
    HTTP 200과 함께 JSON 오류 본문 또는 전부 0인 PCM WAV를 돌려줬다.
    기존 `if not content` 검사는 둘 다 통과시켜, 오류 로그도 없이
    타냐가 말을 하지 않는 것처럼 보였다.
    """

    @staticmethod
    def _wav(samples):
        import struct

        data = struct.pack("<%dh" % len(samples), *samples)
        return (
            b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
            + b"data" + struct.pack("<I", len(data)) + data
        )

    def test_real_audio_passes(self):
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        content = self._wav([0, 0, 900, -700, 0, 120])
        assert ensure_audible_wav(content) == content

    def test_very_short_audio_passes(self):
        """조용하거나 짧다는 이유로 잘못 실패시키면 안 된다."""
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        content = self._wav([1])
        assert ensure_audible_wav(content) == content

    def test_json_error_body_raises_with_reason(self):
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        body = b'{"message":"tts failed","Exception":"TorchCodec is required"}'
        with pytest.raises(RuntimeError) as excinfo:
            ensure_audible_wav(body)
        # 디버깅을 위해 서버가 준 원인이 남아야 한다.
        assert "TorchCodec" in str(excinfo.value)

    def test_all_zero_pcm_raises(self):
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        with pytest.raises(RuntimeError, match="무음"):
            ensure_audible_wav(self._wav([0] * 500))

    def test_non_wav_body_raises(self):
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        with pytest.raises(RuntimeError, match="WAV"):
            ensure_audible_wav(b"not a wav at all" * 4)

    def test_empty_body_raises(self):
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        with pytest.raises(RuntimeError):
            ensure_audible_wav(b"")

    def test_missing_data_chunk_raises(self):
        from core.providers.gpt_sovits_provider import ensure_audible_wav

        header_only = b"RIFF" + b"\x00\x00\x00\x00" + b"WAVEfmt " + b"\x10" * 20
        with pytest.raises(RuntimeError, match="data"):
            ensure_audible_wav(header_only)

    def test_request_audio_rejects_silent_response(self):
        """provider 경로 전체에서도 무음이 실패로 올라온다."""
        from unittest.mock import MagicMock, patch

        from core.providers.gpt_sovits_provider import GptSovitsProvider

        provider = GptSovitsProvider(
            url="http://127.0.0.1:9881/tts",
            reference_audio_path="/tmp/ref.wav",
            prompt_text="참조 문장",
        )
        response = MagicMock()
        response.content = self._wav([0] * 200)
        response.raise_for_status.return_value = None
        with patch("requests.post", return_value=response):
            with pytest.raises(RuntimeError, match="무음"):
                provider._request_audio("안녕", 1.0)


class TestTtsFallbackVoice:
    """T-047: 폴백에 주 provider의 tone을 넘기지 않는다.

    2026-09-06 운영에서 GPT-SoVITS가 실패했을 때 tone `cheer`가 edge-tts로 그대로
    넘어가 `ValueError: Invalid voice 'cheer'`로 폴백까지 죽었다. 그 결과 소리가
    아예 나지 않았다.
    """

    def _manager(self, failing, fallback):
        from core.audio import TTSManager

        manager = TTSManager.__new__(TTSManager)
        manager._provider = failing
        manager._fallback_provider = fallback
        manager._default_voice = "ko-KR-SunHiNeural"
        manager._provider_name = "gpt-sovits-cpufast"
        return manager

    @pytest.mark.asyncio
    async def test_generate_fallback_drops_tone(self):
        from unittest.mock import AsyncMock, MagicMock

        failing = MagicMock()
        failing.provider_name = "gpt-sovits-cpufast"
        failing.generate = AsyncMock(side_effect=RuntimeError("400"))
        fallback = MagicMock()
        fallback.generate = AsyncMock(return_value="ok")

        manager = self._manager(failing, fallback)
        assert await manager.generate("안녕", 1.0, 0.0, "cheer") == "ok"
        assert fallback.generate.call_args.args[3] == ""

    @pytest.mark.asyncio
    async def test_stream_fallback_drops_tone(self):
        from unittest.mock import MagicMock

        async def boom(*_args):
            raise RuntimeError("400")
            yield b""

        async def ok(*_args):
            yield b"audio"

        failing = MagicMock()
        failing.provider_name = "gpt-sovits-cpufast"
        failing.generate_stream = boom
        fallback = MagicMock()
        captured = {}

        async def fallback_stream(text, rate, pitch, voice):
            captured["voice"] = voice
            yield b"audio"

        fallback.generate_stream = fallback_stream
        manager = self._manager(failing, fallback)
        chunks = [chunk async for chunk in manager.generate_stream("안녕", 1.0, 0.0, "cheer")]
        assert chunks == [b"audio"]
        assert captured["voice"] == ""
