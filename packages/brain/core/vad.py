"""Phase 5-D: Voice Activity Detection + 인터럽트 처리.

webrtcvad 기반 로컬 VAD.
webrtcvad 미설치 시 is_speech()는 항상 False 반환 (graceful degradation).
"""

from typing import Callable, Any


def _create_webrtcvad(aggressiveness: int = 2) -> Any:
    """webrtcvad.Vad 인스턴스 생성. 미설치 시 None 반환."""
    try:
        import webrtcvad
        vad = webrtcvad.Vad(aggressiveness)
        return vad
    except (ImportError, Exception):
        return None


class VoiceActivityDetector:
    """webrtcvad 기반 Voice Activity Detector.

    사용법:
        detector = VoiceActivityDetector(sample_rate=16000)
        is_voice = detector.is_speech(pcm_frame_bytes)

    PCM 프레임 길이: 10ms / 20ms / 30ms (webrtcvad 요구사항)
    지원 샘플 레이트: 8000 / 16000 / 32000 / 48000
    """

    def __init__(self, sample_rate: int = 16000, aggressiveness: int = 2):
        self._sample_rate = sample_rate
        self._aggressiveness = aggressiveness
        self._vad = _create_webrtcvad(aggressiveness)

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    def is_available(self) -> bool:
        """webrtcvad가 설치되어 있는지 확인."""
        return self._vad is not None

    def is_speech(self, frame: bytes) -> bool:
        """PCM 프레임에서 음성 활동 감지.

        Args:
            frame: 16-bit mono PCM bytes (10/20/30ms 분량)

        Returns:
            음성이 감지되면 True, 무음이면 False
            webrtcvad 미설치 시 항상 False
        """
        if self._vad is None:
            return False
        try:
            return bool(self._vad.is_speech(frame, self._sample_rate))
        except Exception:
            return False


class InterruptController:
    """TTS 재생 중 음성 감지 시 인터럽트를 트리거하는 컨트롤러.

    사용법:
        ctrl = InterruptController(on_interrupt=lambda: print("interrupted!"))
        # VAD가 음성 감지 시:
        ctrl.trigger()
        # TTS 재생 중단 후:
        ctrl.reset()
    """

    def __init__(self, on_interrupt: Callable[[], None] | None = None):
        self._interrupted = False
        self._on_interrupt = on_interrupt

    @property
    def is_interrupted(self) -> bool:
        """현재 인터럽트 상태."""
        return self._interrupted

    def trigger(self) -> None:
        """인터럽트를 트리거한다. 등록된 콜백을 호출한다."""
        self._interrupted = True
        if self._on_interrupt is not None:
            self._on_interrupt()

    def reset(self) -> None:
        """인터럽트 상태를 초기화한다."""
        self._interrupted = False
