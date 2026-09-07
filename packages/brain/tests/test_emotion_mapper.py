import pytest
from emotion.mapper import EmotionMapper
from core.schemas import EmotionState, EmotionType


class TestEmotionMapper:
    """감정 → TTS/애니메이션 매핑 테스트."""

    def setup_method(self):
        self.mapper = EmotionMapper()

    def test_neutral_emotion_mapping(self):
        """중립 감정 매핑."""
        emotion = EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 기본 파라미터
        assert params["rate"] == 1.0
        assert params["pitch"] == 0
        assert animation == "idle"

    def test_happy_emotion_mapping(self):
        """행복 감정 매핑."""
        emotion = EmotionState(type=EmotionType.HAPPY, intensity=0.8)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 밝은 톤
        assert params["rate"] > 1.0
        assert params["pitch"] > 0
        assert animation == "smile"

    def test_sad_emotion_mapping(self):
        """슬픔 감정 매핑."""
        emotion = EmotionState(type=EmotionType.SAD, intensity=0.7)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 느리고 낮은 톤
        assert params["rate"] < 1.0
        assert params["pitch"] < 0
        assert animation == "sad"

    def test_excited_emotion_mapping(self):
        """흥분/설렘 감정 매핑."""
        emotion = EmotionState(type=EmotionType.EXCITED, intensity=0.9)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 빠르고 높은 톤
        assert params["rate"] > 1.0
        assert params["pitch"] > 0
        assert animation == "excited"

    def test_worried_emotion_mapping(self):
        """걱정 감정 매핑."""
        emotion = EmotionState(type=EmotionType.WORRIED, intensity=0.6)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 약간 느린 속도
        assert params["rate"] < 1.0
        assert animation == "worried"

    def test_annoyed_emotion_mapping(self):
        """짜증 감정 매핑."""
        emotion = EmotionState(type=EmotionType.ANNOYED, intensity=0.7)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 강한 톤
        assert params["pitch"] > 0
        assert animation == "annoyed"

    def test_affectionate_emotion_mapping(self):
        """애정 감정 매핑."""
        emotion = EmotionState(type=EmotionType.AFFECTIONATE, intensity=0.8)
        params = self.mapper.map_to_tts_params(emotion)
        animation = self.mapper.map_to_animation(emotion)

        # 부드럽고 다정한 톤
        assert params["rate"] < 1.0
        assert params["pitch"] > 0
        assert animation == "affectionate"

    def test_intensity_affects_parameters(self):
        """강도가 파라미터에 영향."""
        weak = EmotionState(type=EmotionType.HAPPY, intensity=0.5)
        strong = EmotionState(type=EmotionType.HAPPY, intensity=0.9)

        weak_params = self.mapper.map_to_tts_params(weak)
        strong_params = self.mapper.map_to_tts_params(strong)

        # 강도가 높을수록 변화 폭이 커야 함
        assert abs(strong_params["rate"] - 1.0) > abs(weak_params["rate"] - 1.0)

    def test_tts_params_within_bounds(self):
        """TTS 파라미터가 안전한 범위 내에 있는지 확인."""
        for emotion_type in EmotionType:
            emotion = EmotionState(type=emotion_type, intensity=1.0)
            params = self.mapper.map_to_tts_params(emotion)

            # edge-tts 권장 범위: rate 0.5~2.0, pitch -20~+20
            assert 0.5 <= params["rate"] <= 2.0
            assert -20 <= params["pitch"] <= 20
