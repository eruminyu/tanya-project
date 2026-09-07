"""Phase 5-A: TTS 청크 스트리밍 테스트."""

import base64
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.providers.tts_base import TTSProvider
from core.providers.edge_tts_provider import EdgeTTSProvider
from core.audio import TTSManager
from core.protocol import ProtocolHandler, EventEnvelope


# ---------------------------------------------------------------------------
# TTSProvider 스트리밍 인터페이스
# ---------------------------------------------------------------------------

class TestTTSProviderStreamingInterface:
    """TTSProvider ABC에 generate_stream 추상 메서드가 있어야 한다."""

    def test_tts_base_has_generate_stream(self):
        """generate_stream 메서드가 TTSProvider에 정의되어 있어야 한다."""
        assert hasattr(TTSProvider, "generate_stream")

    def test_generate_stream_is_abstract(self):
        """generate_stream은 추상 메서드여야 한다."""
        import inspect
        # abstractmethods 집합에 포함되어야 함
        assert "generate_stream" in TTSProvider.__abstractmethods__

    def test_concrete_provider_must_implement_stream(self):
        """generate_stream 미구현 시 인스턴스화 불가."""
        class PartialProvider(TTSProvider):
            @property
            def provider_name(self) -> str:
                return "partial"
            def is_available(self) -> bool:
                return True
            async def generate(self, text, rate=1.0, pitch=0.0, voice="") -> str:
                return ""
            # generate_stream 미구현

        with pytest.raises(TypeError):
            PartialProvider()


# ---------------------------------------------------------------------------
# EdgeTTSProvider 스트리밍
# ---------------------------------------------------------------------------

class TestEdgeTTSStreaming:
    """EdgeTTSProvider.generate_stream() 동작 검증."""

    @pytest.mark.asyncio
    async def test_generate_stream_yields_bytes(self):
        """generate_stream은 bytes 청크를 yield해야 한다."""
        fake_chunks = [
            {"type": "audio", "data": b"chunk1"},
            {"type": "WordBoundary", "data": {}},  # 무시해야 함
            {"type": "audio", "data": b"chunk2"},
        ]

        async def fake_stream():
            for c in fake_chunks:
                yield c

        with patch("edge_tts.Communicate") as mock_comm_cls:
            mock_comm = MagicMock()
            mock_comm.stream = fake_stream
            mock_comm_cls.return_value = mock_comm

            provider = EdgeTTSProvider()
            chunks = []
            async for chunk in provider.generate_stream("안녕"):
                chunks.append(chunk)

        assert chunks == [b"chunk1", b"chunk2"]

    @pytest.mark.asyncio
    async def test_generate_stream_skips_non_audio(self):
        """audio 타입 외 이벤트는 yield하지 않아야 한다."""
        fake_chunks = [
            {"type": "SessionEnd", "data": b""},
            {"type": "WordBoundary", "data": {}},
        ]

        async def fake_stream():
            for c in fake_chunks:
                yield c

        with patch("edge_tts.Communicate") as mock_comm_cls:
            mock_comm = MagicMock()
            mock_comm.stream = fake_stream
            mock_comm_cls.return_value = mock_comm

            provider = EdgeTTSProvider()
            chunks = [c async for c in provider.generate_stream("test")]

        assert chunks == []

    @pytest.mark.asyncio
    async def test_generate_still_works_after_stream_added(self):
        """기존 generate() 메서드가 여전히 동작해야 한다."""
        fake_audio = b"full_audio"

        async def fake_stream():
            yield {"type": "audio", "data": fake_audio}

        with patch("edge_tts.Communicate") as mock_comm_cls:
            mock_comm = MagicMock()
            mock_comm.stream = fake_stream
            mock_comm_cls.return_value = mock_comm

            provider = EdgeTTSProvider()
            result = await provider.generate("안녕")

        assert result == base64.b64encode(fake_audio).decode("utf-8")


# ---------------------------------------------------------------------------
# TTSManager 스트리밍 인터페이스
# ---------------------------------------------------------------------------

class TestTTSManagerStreaming:
    """TTSManager.generate_stream() 메서드 동작 검증."""

    def test_tts_manager_has_generate_stream(self):
        """TTSManager에 generate_stream 메서드가 있어야 한다."""
        assert hasattr(TTSManager, "generate_stream")

    @pytest.mark.asyncio
    async def test_manager_generate_stream_delegates_to_provider(self):
        """TTSManager.generate_stream은 provider.generate_stream에 위임해야 한다."""
        async def fake_stream(*args, **kwargs) -> AsyncIterator[bytes]:
            yield b"data1"
            yield b"data2"

        with patch("core.audio.get_settings") as mock_settings:
            settings = MagicMock()
            settings.tts_provider = "edge-tts"
            settings.tts_voice = "ko-KR-SunHiNeural"
            mock_settings.return_value = settings

            with patch("core.audio.EdgeTTSProvider") as mock_cls:
                mock_provider = MagicMock()
                mock_provider.is_available.return_value = True
                mock_provider.provider_name = "edge-tts"
                mock_provider.generate_stream = fake_stream
                mock_cls.return_value = mock_provider

                manager = TTSManager()
                chunks = [c async for c in manager.generate_stream("테스트")]

        assert chunks == [b"data1", b"data2"]


# ---------------------------------------------------------------------------
# Wire Protocol: tts_chunk 이벤트
# ---------------------------------------------------------------------------

class TestTTSChunkProtocol:
    """tts_chunk EventEnvelope 생성 검증."""

    def test_make_tts_chunk_event(self):
        """ProtocolHandler로 tts_chunk 이벤트를 만들 수 있어야 한다."""
        handler = ProtocolHandler()
        chunk_data = base64.b64encode(b"audio_bytes").decode("utf-8")

        event = handler.make_tts_chunk_event(
            chunk_index=0,
            data=chunk_data,
            is_last=False,
        )

        assert isinstance(event, EventEnvelope)
        assert event.event == "tts_chunk"
        assert event.payload["chunk_index"] == 0
        assert event.payload["data"] == chunk_data
        assert event.payload["is_last"] is False

    def test_make_tts_chunk_event_last(self):
        """마지막 청크 is_last=True로 표시."""
        handler = ProtocolHandler()
        event = handler.make_tts_chunk_event(
            chunk_index=5,
            data="",
            is_last=True,
        )
        assert event.payload["is_last"] is True
        assert event.payload["chunk_index"] == 5

    def test_tts_chunk_event_serializable(self):
        """tts_chunk 이벤트는 JSON 직렬화 가능해야 한다."""
        import json
        handler = ProtocolHandler()
        event = handler.make_tts_chunk_event(0, "abc", False)
        data = json.loads(event.model_dump_json())
        assert data["type"] == "event"
        assert data["event"] == "tts_chunk"
