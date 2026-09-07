"""감정 엔진 - Detector, State, Mapper 통합."""

from emotion.detector import EmotionDetector
from emotion.state import MoodStateMachine
from emotion.mapper import EmotionMapper
from core.schemas import EmotionState


class EmotionEngine:
    """
    감정 엔진 통합 인터페이스.

    사용자 메시지 → 감정 감지 → mood 업데이트 → TTS/애니메이션 매핑
    """

    def __init__(self):
        """각 컴포넌트 초기화."""
        self._detector = EmotionDetector()
        self._mood_machine = MoodStateMachine()
        self._mapper = EmotionMapper()

    def process_user_message(self, user_message: str) -> dict:
        """
        사용자 메시지를 처리하여 감정 관련 정보 생성.

        Args:
            user_message: 사용자 입력 텍스트

        Returns:
            dict: {
                "detected_emotion": EmotionState,  # 감지된 감정
                "current_mood": EmotionState,      # 업데이트된 mood
                "tts_params": dict,                # TTS 파라미터
                "animation_intent": str            # 애니메이션 인텐트
            }
        """
        # 1. 사용자 메시지에서 감정 감지
        detected_emotion = self._detector.detect(user_message)

        # 2. Mood state machine 업데이트
        current_mood = self._mood_machine.update(detected_emotion)

        # 3. 현재 mood를 TTS 파라미터와 애니메이션으로 매핑
        tts_params = self._mapper.map_to_tts_params(current_mood)
        animation_intent = self._mapper.map_to_animation(current_mood)

        return {
            "detected_emotion": detected_emotion,
            "current_mood": current_mood,
            "tts_params": tts_params,
            "animation_intent": animation_intent,
        }

    def get_current_mood(self) -> EmotionState:
        """현재 mood 조회."""
        return self._mood_machine.current_mood

    def reset_mood(self) -> None:
        """Mood를 중립 상태로 리셋."""
        self._mood_machine.reset()
