import pytest
from emotion.state import MoodStateMachine
from core.schemas import EmotionState, EmotionType


class TestMoodStateMachine:
    """Mood state machine 테스트 - 감정 상태 스무딩."""

    def setup_method(self):
        self.machine = MoodStateMachine()

    def test_initial_state_is_neutral(self):
        """초기 상태는 중립."""
        assert self.machine.current_mood.type == EmotionType.NEUTRAL
        assert self.machine.current_mood.intensity == 0.5

    def test_update_mood_to_happy(self):
        """행복 감정으로 전환."""
        detected = EmotionState(type=EmotionType.HAPPY, intensity=0.8)
        new_mood = self.machine.update(detected)

        assert new_mood.type == EmotionType.HAPPY
        # 스무딩으로 인해 강도가 부드럽게 전환됨
        assert 0.5 < new_mood.intensity < 0.8

    def test_mood_smoothing(self):
        """감정 전환이 부드럽게 스무딩됨."""
        # 중립 → 행복
        detected1 = EmotionState(type=EmotionType.HAPPY, intensity=0.9)
        mood1 = self.machine.update(detected1)

        # 첫 전환에서 강도가 부드럽게 증가
        assert mood1.intensity < 0.9

        # 같은 감정 반복하면 점점 강도가 올라감
        mood2 = self.machine.update(detected1)
        assert mood2.intensity > mood1.intensity

    def test_mood_persistence(self):
        """중립 입력에도 기존 감정이 어느정도 유지됨."""
        # 행복 상태로 만들기
        happy = EmotionState(type=EmotionType.HAPPY, intensity=0.8)
        self.machine.update(happy)
        self.machine.update(happy)

        # 중립 입력
        neutral = EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)
        mood = self.machine.update(neutral)

        # 바로 중립으로 돌아가지 않고 천천히 감소
        # (감정이 지속되는 자연스러운 효과)
        assert mood.type == EmotionType.NEUTRAL or mood.type == EmotionType.HAPPY

    def test_emotion_decay(self):
        """같은 감정이 반복되지 않으면 강도가 감소."""
        happy = EmotionState(type=EmotionType.HAPPY, intensity=0.8)
        self.machine.update(happy)
        self.machine.update(happy)
        initial_intensity = self.machine.current_mood.intensity

        # 중립 반복
        neutral = EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)
        for _ in range(5):
            self.machine.update(neutral)

        # 강도가 감소했어야 함
        assert self.machine.current_mood.intensity < initial_intensity

    def test_mood_transition_between_different_emotions(self):
        """감정이 완전히 바뀔 때 스무딩."""
        # 행복 → 슬픔
        happy = EmotionState(type=EmotionType.HAPPY, intensity=0.9)
        self.machine.update(happy)
        self.machine.update(happy)

        sad = EmotionState(type=EmotionType.SAD, intensity=0.9)
        mood = self.machine.update(sad)

        # 타입은 바로 변경되지만 강도는 부드럽게
        assert mood.type == EmotionType.SAD
        assert mood.intensity < 0.9

    def test_reset_mood(self):
        """감정 상태 초기화."""
        happy = EmotionState(type=EmotionType.HAPPY, intensity=0.8)
        self.machine.update(happy)

        self.machine.reset()

        assert self.machine.current_mood.type == EmotionType.NEUTRAL
        assert self.machine.current_mood.intensity == 0.5

    def test_get_current_mood(self):
        """현재 mood 조회."""
        excited = EmotionState(type=EmotionType.EXCITED, intensity=0.7)
        self.machine.update(excited)

        current = self.machine.current_mood
        assert current.type == EmotionType.EXCITED
        assert current.intensity > 0.5
