"""Phase 5-D: VAD (Voice Activity Detection) + 인터럽트 처리 테스트."""

import struct
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# VAD 기본 인터페이스
# ---------------------------------------------------------------------------

class TestVADInterface:
    """VAD 클래스 기본 인터페이스 검증."""

    def test_import(self):
        """VoiceActivityDetector를 import할 수 있어야 한다."""
        from core.vad import VoiceActivityDetector
        assert VoiceActivityDetector is not None

    def test_instantiate_with_sample_rate(self):
        """샘플 레이트와 함께 인스턴스화할 수 있어야 한다."""
        from core.vad import VoiceActivityDetector
        vad = VoiceActivityDetector(sample_rate=16000)
        assert vad.sample_rate == 16000

    def test_default_sample_rate(self):
        """기본 샘플 레이트는 16000이어야 한다."""
        from core.vad import VoiceActivityDetector
        vad = VoiceActivityDetector()
        assert vad.sample_rate == 16000

    def test_has_is_speech_method(self):
        """is_speech() 메서드가 있어야 한다."""
        from core.vad import VoiceActivityDetector
        assert hasattr(VoiceActivityDetector, "is_speech")


# ---------------------------------------------------------------------------
# VAD 동작 (webrtcvad mock)
# ---------------------------------------------------------------------------

def _make_pcm_frame(sample_rate: int = 16000, duration_ms: int = 30) -> bytes:
    """지정된 길이의 무음 PCM 프레임 생성 (16-bit mono)."""
    num_samples = int(sample_rate * duration_ms / 1000)
    return struct.pack(f"<{num_samples}h", *([0] * num_samples))


class TestVADDetection:
    """VAD 음성 감지 로직 검증."""

    def test_silence_returns_false(self):
        """무음 프레임은 False를 반환해야 한다."""
        from core.vad import VoiceActivityDetector

        mock_vad = MagicMock()
        mock_vad.is_speech.return_value = False

        with patch("core.vad._create_webrtcvad", return_value=mock_vad):
            detector = VoiceActivityDetector(sample_rate=16000)
            frame = _make_pcm_frame()
            result = detector.is_speech(frame)

        assert result is False

    def test_speech_returns_true(self):
        """유성 프레임은 True를 반환해야 한다."""
        from core.vad import VoiceActivityDetector

        mock_vad = MagicMock()
        mock_vad.is_speech.return_value = True

        with patch("core.vad._create_webrtcvad", return_value=mock_vad):
            detector = VoiceActivityDetector(sample_rate=16000)
            frame = _make_pcm_frame()
            result = detector.is_speech(frame)

        assert result is True

    def test_is_speech_fallback_when_unavailable(self):
        """webrtcvad 미설치 시 is_speech()는 항상 False를 반환해야 한다."""
        from core.vad import VoiceActivityDetector

        with patch("core.vad._create_webrtcvad", return_value=None):
            detector = VoiceActivityDetector(sample_rate=16000)
            frame = _make_pcm_frame()
            result = detector.is_speech(frame)

        assert result is False

    def test_is_available_true_when_webrtcvad_installed(self):
        """webrtcvad 설치 시 is_available()은 True를 반환해야 한다."""
        from core.vad import VoiceActivityDetector

        mock_vad = MagicMock()
        with patch("core.vad._create_webrtcvad", return_value=mock_vad):
            detector = VoiceActivityDetector()
            assert detector.is_available() is True

    def test_is_available_false_when_not_installed(self):
        """webrtcvad 미설치 시 is_available()은 False를 반환해야 한다."""
        from core.vad import VoiceActivityDetector

        with patch("core.vad._create_webrtcvad", return_value=None):
            detector = VoiceActivityDetector()
            assert detector.is_available() is False


# ---------------------------------------------------------------------------
# 인터럽트 처리 — InterruptController
# ---------------------------------------------------------------------------

class TestInterruptController:
    """TTS 재생 중 음성 감지 시 인터럽트 처리 로직 검증."""

    def test_import(self):
        """InterruptController를 import할 수 있어야 한다."""
        from core.vad import InterruptController
        assert InterruptController is not None

    def test_initial_state_not_interrupted(self):
        """초기 상태에서 인터럽트가 없어야 한다."""
        from core.vad import InterruptController
        ctrl = InterruptController()
        assert ctrl.is_interrupted is False

    def test_trigger_sets_interrupted(self):
        """trigger()를 호출하면 is_interrupted가 True가 되어야 한다."""
        from core.vad import InterruptController
        ctrl = InterruptController()
        ctrl.trigger()
        assert ctrl.is_interrupted is True

    def test_reset_clears_interrupted(self):
        """reset()을 호출하면 is_interrupted가 False가 되어야 한다."""
        from core.vad import InterruptController
        ctrl = InterruptController()
        ctrl.trigger()
        ctrl.reset()
        assert ctrl.is_interrupted is False

    def test_trigger_calls_callback(self):
        """trigger() 시 등록된 콜백이 호출되어야 한다."""
        from core.vad import InterruptController
        callback = MagicMock()
        ctrl = InterruptController(on_interrupt=callback)
        ctrl.trigger()
        callback.assert_called_once()


# ---------------------------------------------------------------------------
# Protocol: interrupt 이벤트
# ---------------------------------------------------------------------------

class TestInterruptProtocol:
    """interrupt EventEnvelope 생성 검증."""

    def test_make_interrupt_event(self):
        """ProtocolHandler로 interrupt 이벤트를 만들 수 있어야 한다."""
        from core.protocol import ProtocolHandler, EventEnvelope
        handler = ProtocolHandler()
        event = handler.make_event("interrupt", {"reason": "user_speech"})
        assert isinstance(event, EventEnvelope)
        assert event.event == "interrupt"
        assert event.payload["reason"] == "user_speech"
