"""Mood State Machine - 감정 상태 관리 및 스무딩."""

from core.schemas import EmotionState, EmotionType


class MoodStateMachine:
    """
    타냐의 내부 감정 상태를 관리하는 상태 머신.

    감정 전환을 부드럽게 스무딩하여 급격한 변화를 방지하고,
    자연스러운 감정 흐름을 만든다.
    """

    # 스무딩 계수 (0~1, 높을수록 변화가 부드러움)
    SMOOTHING_FACTOR = 0.3

    def __init__(self):
        """초기 상태는 중립."""
        self._current_mood = EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)

    def update(self, detected_emotion: EmotionState) -> EmotionState:
        """
        감지된 감정을 기반으로 현재 mood 업데이트.

        Args:
            detected_emotion: 감지된 감정 상태

        Returns:
            EmotionState: 업데이트된 mood (스무딩 적용됨)
        """
        # 감정 타입 전환: 중립이 아닌 감정이 감지되면 바로 전환
        if detected_emotion.type != EmotionType.NEUTRAL:
            new_type = detected_emotion.type
        else:
            # 중립 입력 시, 현재 mood가 약하면 중립으로 전환
            if self._current_mood.intensity < 0.6:
                new_type = EmotionType.NEUTRAL
            else:
                # 강한 감정은 중립 입력에도 유지 (감정 지속성)
                new_type = self._current_mood.type

        # 강도 스무딩: 급격한 변화 방지
        target_intensity = detected_emotion.intensity
        current_intensity = self._current_mood.intensity

        # 같은 감정 타입이면 점진적으로 강도 증가
        if new_type == self._current_mood.type:
            new_intensity = (
                current_intensity * (1 - self.SMOOTHING_FACTOR)
                + target_intensity * self.SMOOTHING_FACTOR
            )
        else:
            # 다른 감정으로 전환 시에도 부드럽게
            new_intensity = (
                current_intensity * (1 - self.SMOOTHING_FACTOR * 1.5)
                + target_intensity * self.SMOOTHING_FACTOR * 1.5
            )

        # 강도는 0.0~1.0 범위 유지
        new_intensity = max(0.0, min(1.0, new_intensity))

        # 새 mood 저장
        self._current_mood = EmotionState(type=new_type, intensity=new_intensity)

        return self._current_mood

    def reset(self) -> None:
        """Mood를 초기 상태(중립)로 리셋."""
        self._current_mood = EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)

    @property
    def current_mood(self) -> EmotionState:
        """현재 mood 조회."""
        return self._current_mood
