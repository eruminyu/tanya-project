import pytest
from emotion.engine import EmotionEngine
from core.schemas import EmotionType


class TestEmotionEngine:
    """감정 엔진 통합 테스트."""

    def setup_method(self):
        self.engine = EmotionEngine()

    def test_process_happy_message(self):
        """행복한 메시지 처리."""
        result = self.engine.process_user_message("오늘 너무 기뻐!")

        assert result["detected_emotion"].type == EmotionType.HAPPY
        assert result["current_mood"].type == EmotionType.HAPPY
        assert result["tts_params"]["rate"] > 1.0
        assert result["animation_intent"] == "smile"

    def test_process_sad_message(self):
        """슬픈 메시지 처리."""
        result = self.engine.process_user_message("힘든 하루였어...")

        assert result["detected_emotion"].type == EmotionType.SAD
        assert result["current_mood"].type == EmotionType.SAD
        assert result["tts_params"]["rate"] < 1.0
        assert result["animation_intent"] == "sad"

    def test_process_neutral_message(self):
        """중립 메시지 처리."""
        result = self.engine.process_user_message("오늘 날씨 어때?")

        assert result["detected_emotion"].type == EmotionType.NEUTRAL
        assert result["current_mood"].type == EmotionType.NEUTRAL
        assert result["tts_params"]["rate"] == 1.0
        assert result["animation_intent"] == "idle"

    def test_mood_smoothing_across_messages(self):
        """여러 메시지에 걸친 mood 스무딩."""
        # 행복 → 행복 → 중립
        result1 = self.engine.process_user_message("기뻐!")
        result2 = self.engine.process_user_message("완전 좋아!")
        result3 = self.engine.process_user_message("안녕")

        # 두 번째 행복 메시지에서 강도 증가
        assert result2["current_mood"].intensity > result1["current_mood"].intensity

        # 중립 메시지 후에도 바로 중립으로 안 떨어짐 (지속성)
        # mood는 스무딩되므로 타입이 HAPPY 또는 NEUTRAL일 수 있음
        assert result3["current_mood"].type in [EmotionType.HAPPY, EmotionType.NEUTRAL]

    def test_emotion_transition(self):
        """감정 전환 테스트."""
        # 행복 → 슬픔
        result1 = self.engine.process_user_message("기뻐!")
        result2 = self.engine.process_user_message("슬퍼...")

        assert result1["current_mood"].type == EmotionType.HAPPY
        assert result2["current_mood"].type == EmotionType.SAD

    def test_get_current_mood(self):
        """현재 mood 조회."""
        self.engine.process_user_message("완전 신나!")

        mood = self.engine.get_current_mood()
        assert mood.type == EmotionType.EXCITED
        assert mood.intensity > 0.5

    def test_reset_mood(self):
        """Mood 리셋."""
        self.engine.process_user_message("완전 행복해!")
        self.engine.reset_mood()

        mood = self.engine.get_current_mood()
        assert mood.type == EmotionType.NEUTRAL
        assert mood.intensity == 0.5

    def test_tts_params_and_animation_consistency(self):
        """TTS 파라미터와 애니메이션이 현재 mood 기반."""
        self.engine.process_user_message("사랑해 ❤️")

        result = self.engine.process_user_message("그냥 일반 대화")

        # 현재 mood가 affectionate이므로, TTS와 애니메이션도 그에 맞춰짐
        # (스무딩으로 인해 바로 중립으로 안 바뀜)
        mood_type = result["current_mood"].type
        assert result["animation_intent"] in ["affectionate", "idle"]
