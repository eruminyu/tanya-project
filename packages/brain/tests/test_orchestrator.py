import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from core.orchestrator import Orchestrator
from core.schemas import EmotionType
from core.vision import VisionAnalysis, VisionUnavailableError


class TestOrchestratorParsing:
    """Orchestrator의 메시지 파싱 로직 테스트."""

    def setup_method(self):
        # LLM 초기화를 mock으로 우회
        with patch("core.orchestrator.LLMManager"):
            self.orchestrator = Orchestrator()

    def test_parse_text_message(self):
        msg = self.orchestrator._parse_message({"content": "안녕!"})
        assert msg.type == "text"
        assert msg.content == "안녕!"

    def test_parse_vision_message(self):
        msg = self.orchestrator._parse_message(
            {"type": "vision", "image": "base64data"}
        )
        assert msg.type == "vision"
        assert msg.image == "base64data"

    def test_parse_text_with_explicit_type(self):
        msg = self.orchestrator._parse_message(
            {"type": "text", "content": "명시적 텍스트"}
        )
        assert msg.type == "text"
        assert msg.content == "명시적 텍스트"

    def test_parse_legacy_format(self):
        """기존 클라이언트의 {"content": "..."} 형식 호환."""
        msg = self.orchestrator._parse_message({"content": "레거시 형식"})
        assert msg.type == "text"
        assert msg.content == "레거시 형식"


class TestOrchestratorPersona:
    """페르소나 로딩 테스트."""

    _PRIVATE_RELATIONSHIP_TERMS = (
        "테스트사용자",
        "예시별명",
        "자기야",
        "여보야",
        "연인",
    )

    def test_persona_loaded(self):
        with patch("core.orchestrator.LLMManager"):
            orchestrator = Orchestrator()
            # persona.yaml이 존재하면 프롬프트가 비어있지 않아야 함
            assert "타냐" in orchestrator.persona_prompt

    def test_persona_is_safe_for_first_time_public_visitors(self):
        with patch("core.orchestrator.LLMManager"):
            prompt = Orchestrator().persona_prompt

        assert "데스크톱 메이트" in prompt
        assert "명시적인 승인" in prompt
        assert "완료했다고 말하지" in prompt
        for term in self._PRIVATE_RELATIONSHIP_TERMS:
            assert term not in prompt

    def test_persona_disabled(self):
        with (
            patch("core.orchestrator.LLMManager"),
            patch("core.orchestrator.get_settings") as mock_settings,
        ):
            settings = MagicMock()
            settings.enable_persona = False
            settings.enable_memory = True
            settings.memory_short_term_max_turns = 20
            settings.google_api_key = ""
            settings.gemini_model_name = "test"
            settings.ollama_base_url = "http://localhost:11434"
            settings.local_llm_model = "test"
            settings.persona_config_path = "config/persona.yaml"
            mock_settings.return_value = settings

            orchestrator = Orchestrator()
            assert orchestrator.persona_prompt == ""


@pytest.mark.asyncio
class TestOrchestratorFlow:
    """Orchestrator 전체 플로우 통합 테스트 (LLM mock)."""

    async def test_text_message_flow(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.chat = AsyncMock(return_value="안녕 사용자~ ❤️")
            mock_llm.analyze_image = AsyncMock()

            with patch("core.orchestrator.generate_tts_base64", new_callable=AsyncMock) as mock_tts:
                mock_tts.return_value = "fake_audio_base64"

                orchestrator = Orchestrator()
                orchestrator._llm = mock_llm

                response = await orchestrator.handle_message({"content": "안녕!"})

                assert response is not None
                assert response.content == "안녕 사용자~ ❤️"
                assert response.audio == "fake_audio_base64"
                assert response.emotion.type == EmotionType.NEUTRAL

    async def test_vision_message_returns_none(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.analyze_image = AsyncMock(
                return_value=VisionAnalysis.local_ollama("게임 화면", "llava:7b")
            )

            orchestrator = Orchestrator()
            orchestrator._llm = mock_llm

            response = await orchestrator.handle_message(
                {"type": "vision", "image": "base64img"}
            )

            assert response is None
            assert orchestrator._last_vision_analysis == "게임 화면"
            assert orchestrator._last_vision_route == {
                "provider": "ollama",
                "execution": "local",
                "fallback": False,
                "model": "llava:7b",
            }

    async def test_vision_message_fails_closed_without_local_provider(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.analyze_image = AsyncMock(side_effect=VisionUnavailableError())

            orchestrator = Orchestrator()
            orchestrator._llm = mock_llm

            with pytest.raises(VisionUnavailableError):
                await orchestrator.handle_message(
                    {"type": "vision", "image": "sensitive-base64"}
                )

            assert orchestrator._last_vision_analysis == ""
            assert orchestrator._last_vision_route is None

    async def test_vision_message_without_image_fails_closed(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.analyze_image = AsyncMock()
            orchestrator = Orchestrator()
            orchestrator._llm = mock_llm

            with pytest.raises(VisionUnavailableError):
                await orchestrator.handle_message({"type": "vision"})

            mock_llm.analyze_image.assert_not_called()
            assert orchestrator._last_vision_analysis == ""
            assert orchestrator._last_vision_route is None

    async def test_memory_saves_conversation(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.chat = AsyncMock(return_value="응답이야!")

            with patch("core.orchestrator.generate_tts_base64", new_callable=AsyncMock) as mock_tts:
                mock_tts.return_value = ""

                orchestrator = Orchestrator()
                orchestrator._llm = mock_llm

                await orchestrator.handle_message({"content": "첫번째 대화"})
                await orchestrator.handle_message({"content": "두번째 대화"})

                assert orchestrator.memory.turn_count == 2

    async def test_stream_can_skip_tts_for_text_only_channel(self):
        with (
            patch("core.orchestrator.LLMManager") as MockLLM,
            patch("core.orchestrator.TTSManager") as MockTTS,
        ):
            mock_llm = MockLLM.return_value

            async def stream(*_args, **_kwargs):
                yield "텍스트 응답."

            mock_llm.chat_stream = stream
            orchestrator = Orchestrator()
            orchestrator._llm = mock_llm

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "안녕"},
                    include_audio=False,
                )
            ]

            assert any(event_type == "text_stream" for event_type, _ in events)
            assert not any(event_type == "tts_chunk" for event_type, _ in events)
            MockTTS.assert_not_called()

    async def test_stream_exposes_valid_llm_route_before_answer(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            route = {
                "mode": "task",
                "provider": "gemini",
                "execution": "cloud",
                "fallback": False,
            }

            async def stream(*_args, **kwargs):
                kwargs["on_route_change"](route)
                yield "분석 결과입니다."

            mock_llm.chat_stream = stream
            orchestrator = Orchestrator()

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "이 구조를 분석해 주세요"},
                    include_audio=False,
                )
            ]

            route_index = next(i for i, event in enumerate(events) if event[0] == "llm_route")
            text_index = next(i for i, event in enumerate(events) if event[0] == "text_stream")
            assert route_index < text_index
            assert events[route_index][1]["provider"] == "gemini"

    async def test_stream_does_not_forward_vision_analysis_to_general_router(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            route = {
                "mode": "task",
                "provider": "gemini",
                "execution": "cloud",
                "fallback": False,
            }
            streamed_inputs = []

            async def stream(*_args, **kwargs):
                streamed_inputs.append(kwargs["user_input"])
                kwargs["on_route_change"](route)
                yield "일반 응답"

            mock_llm.chat_stream = stream
            orchestrator = Orchestrator()
            orchestrator._last_vision_analysis = "코드 분석 화면"

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "안녕"},
                    include_audio=False,
                )
            ]

            mock_llm.describe_conversation_route.assert_not_called()
            assert streamed_inputs == ["안녕"]
            assert "코드 분석 화면" not in streamed_inputs[0]
            emitted_route = next(
                payload for event, payload in events if event == "llm_route"
            )
            assert emitted_route["mode"] == "task"

    async def test_stream_returns_verified_local_vision_result(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.analyze_image = AsyncMock(
                return_value=VisionAnalysis.local_ollama("게임 화면", "llava:7b")
            )
            mock_llm.chat_stream = MagicMock()
            orchestrator = Orchestrator()
            orchestrator._llm = mock_llm

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"type": "vision", "image": "sensitive-base64"},
                    include_audio=False,
                )
            ]

        assert events == [(
            "vision_result",
            {
                "content": "게임 화면",
                "route": {
                    "provider": "ollama",
                    "execution": "local",
                    "fallback": False,
                    "model": "llava:7b",
                },
            },
        )]
        mock_llm.chat_stream.assert_not_called()

    async def test_stream_returns_safe_vision_error(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            mock_llm.analyze_image = AsyncMock(side_effect=VisionUnavailableError())
            orchestrator = Orchestrator()
            orchestrator._llm = mock_llm

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"type": "vision", "image": "sensitive-base64"},
                    include_audio=False,
                )
            ]

        assert events == [(
            "vision_error",
            {
                "code": "local_vision_unavailable",
                "message": "로컬 화면 분석을 사용할 수 없어 요청을 중단했습니다.",
            },
        )]
        assert "sensitive-base64" not in str(events)

    async def test_stream_forwards_runtime_fallback_route_before_fallback_text(self):
        with patch("core.orchestrator.LLMManager") as MockLLM:
            mock_llm = MockLLM.return_value
            initial_route = {
                "mode": "task",
                "provider": "gemini",
                "execution": "cloud",
                "fallback": False,
            }
            fallback_route = {
                "mode": "task",
                "provider": "ollama",
                "execution": "local",
                "fallback": True,
            }
            async def stream(*_args, **kwargs):
                kwargs["on_route_change"](initial_route)
                kwargs["on_route_change"](fallback_route)
                yield "로컬 폴백 응답."

            mock_llm.chat_stream = stream
            orchestrator = Orchestrator()

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "이 구조를 분석해 주세요"},
                    include_audio=False,
                )
            ]

            routes = [payload for event, payload in events if event == "llm_route"]
            assert routes == [initial_route, fallback_route]
            fallback_index = events.index(("llm_route", fallback_route))
            text_index = next(
                index for index, event in enumerate(events)
                if event[0] == "text_stream"
            )
            assert fallback_index < text_index

    async def test_stream_translates_completed_korean_sentence_for_tts(self):
        with (
            patch("core.orchestrator.LLMManager") as MockLLM,
            patch("core.orchestrator.TTSManager") as MockTTS,
        ):
            mock_llm = MockLLM.return_value
            async def stream(*_args, **_kwargs):
                yield "오늘도 "
                yield "수고했어."

            async def audio_stream(text, **_kwargs):
                assert text == "今日もお疲れさま。"
                yield b"wav"

            mock_llm.chat_stream = stream
            mock_llm.chat = AsyncMock(return_value="今日もお疲れさま。")
            MockTTS.return_value.generate_stream = audio_stream

            orchestrator = Orchestrator()
            orchestrator._settings.tts_target_language = "ja"
            orchestrator._tts_text_translator.target_language = "ja"

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "안녕"},
                    include_audio=True,
                )
            ]

        streamed_text = "".join(
            payload for event_type, payload in events if event_type == "text_stream"
        )
        assert streamed_text == "오늘도 수고했어."
        mock_llm.chat.assert_awaited_once()
        audio_events = [
            payload for event_type, payload in events
            if event_type == "tts_chunk" and payload[1]
        ]
        assert audio_events == [(0, b"wav", True)]

    async def test_stream_keeps_emoji_on_screen_but_removes_it_from_tts(self):
        synthesized = []
        with (
            patch("core.orchestrator.LLMManager") as MockLLM,
            patch("core.orchestrator.TTSManager") as MockTTS,
        ):
            mock_llm = MockLLM.return_value

            async def stream(*_args, **_kwargs):
                yield "정말 잘했어! 🎉"

            async def audio_stream(text, **kwargs):
                synthesized.append((text, kwargs["voice"]))
                yield b"wav"

            mock_llm.chat_stream = stream
            MockTTS.return_value.generate_stream = audio_stream
            orchestrator = Orchestrator()
            orchestrator._settings.tts_target_language = ""
            orchestrator._tts_text_translator.target_language = ""

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "완료했어"}, include_audio=True
                )
            ]

        streamed_text = "".join(
            payload for event_type, payload in events if event_type == "text_stream"
        )
        assert streamed_text == "정말 잘했어! 🎉"
        assert synthesized == [("정말 잘했어!", "cheer")]
        assert any(
            event_type == "tts_chunk" and payload[1] == b"wav"
            for event_type, payload in events
        )

    async def test_stream_announces_sentence_text_before_its_audio_chunks(self):
        """합성되는 문장의 원문을 tts_sentence로 먼저 알린다 — 자막 동기화용 (T-010)."""
        with (
            patch("core.orchestrator.LLMManager") as MockLLM,
            patch("core.orchestrator.TTSManager") as MockTTS,
        ):
            mock_llm = MockLLM.return_value

            async def stream(*_args, **_kwargs):
                yield "정말 잘했어! 🎉"

            async def audio_stream(_text, **_kwargs):
                yield b"wav"

            mock_llm.chat_stream = stream
            MockTTS.return_value.generate_stream = audio_stream
            orchestrator = Orchestrator()
            orchestrator._settings.tts_target_language = ""
            orchestrator._tts_text_translator.target_language = ""

            events = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "완료했어"}, include_audio=True
                )
            ]

        sentence_events = [
            payload for event_type, payload in events if event_type == "tts_sentence"
        ]
        # 화면 자막용이므로 TTS 입력과 달리 이모지를 유지한 원문이어야 한다.
        assert sentence_events == [{"chunk_index": 0, "text": "정말 잘했어! 🎉"}]

        first_sentence_at = next(i for i, (t, _p) in enumerate(events) if t == "tts_sentence")
        first_audio_at = next(
            i for i, (t, p) in enumerate(events) if t == "tts_chunk" and p[1]
        )
        assert first_sentence_at < first_audio_at

    async def test_stream_attaches_emoji_from_next_token_to_previous_sentence(self):
        synthesized = []
        with (
            patch("core.orchestrator.LLMManager") as MockLLM,
            patch("core.orchestrator.TTSManager") as MockTTS,
        ):
            mock_llm = MockLLM.return_value

            async def stream(*_args, **_kwargs):
                yield "정말 잘했어!"
                yield " 🎉"

            async def audio_stream(text, **kwargs):
                synthesized.append((text, kwargs["voice"]))
                yield b"wav"

            mock_llm.chat_stream = stream
            MockTTS.return_value.generate_stream = audio_stream
            orchestrator = Orchestrator()
            orchestrator._settings.tts_target_language = ""
            orchestrator._tts_text_translator.target_language = ""

            _ = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "완료했어"}, include_audio=True
                )
            ]

        assert synthesized == [("정말 잘했어!", "cheer")]

    async def test_stream_skips_emoji_only_tts_sentence(self):
        synthesized_texts = []
        with (
            patch("core.orchestrator.LLMManager") as MockLLM,
            patch("core.orchestrator.TTSManager") as MockTTS,
        ):
            mock_llm = MockLLM.return_value

            async def stream(*_args, **_kwargs):
                yield "좋아."
                yield " ✨💕"

            async def audio_stream(text, **_kwargs):
                synthesized_texts.append(text)
                yield b"wav"

            mock_llm.chat_stream = stream
            MockTTS.return_value.generate_stream = audio_stream
            orchestrator = Orchestrator()
            orchestrator._settings.tts_target_language = ""
            orchestrator._tts_text_translator.target_language = ""

            _ = [
                event
                async for event in orchestrator.handle_message_stream(
                    {"content": "진행해"}, include_audio=True
                )
            ]

        assert synthesized_texts == ["좋아."]
