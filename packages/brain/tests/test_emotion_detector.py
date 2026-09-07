import pytest
from emotion.detector import EmotionDetector
from core.schemas import EmotionType


class TestEmotionDetector:
    """감정 감지기 테스트 - 키워드 기반."""

    def setup_method(self):
        self.detector = EmotionDetector()

    def test_detect_happy(self):
        """행복 감정 감지."""
        emotion = self.detector.detect("오늘 너무 기뻐! 좋은 일이 있었어!")
        assert emotion.type == EmotionType.HAPPY
        assert emotion.intensity > 0.5

    def test_detect_sad(self):
        """슬픔 감정 감지."""
        emotion = self.detector.detect("너무 슬퍼... 힘든 하루였어")
        assert emotion.type == EmotionType.SAD
        assert emotion.intensity > 0.5

    def test_detect_excited(self):
        """흥분/설렘 감정 감지."""
        emotion = self.detector.detect("와!!! 완전 신나!!")
        assert emotion.type == EmotionType.EXCITED
        assert emotion.intensity > 0.5

    def test_detect_worried(self):
        """걱정 감정 감지."""
        emotion = self.detector.detect("걱정돼... 불안해")
        assert emotion.type == EmotionType.WORRIED
        assert emotion.intensity > 0.5

    def test_detect_annoyed(self):
        """짜증 감정 감지."""
        emotion = self.detector.detect("짜증나! 화나!")
        assert emotion.type == EmotionType.ANNOYED
        assert emotion.intensity > 0.5

    def test_detect_affectionate(self):
        """애정 감정 감지."""
        emotion = self.detector.detect("사랑해 ❤️ 너무 좋아")
        assert emotion.type == EmotionType.AFFECTIONATE
        assert emotion.intensity > 0.5

    def test_public_politeness_is_happy_not_romantic_affection(self):
        """첫 방문자의 일반적인 감사·호평을 연인 감정으로 과해석하지 않는다."""
        emotion = self.detector.detect("고마워요, 정말 좋아요. 최고예요!")

        assert emotion.type == EmotionType.HAPPY

    def test_detect_neutral(self):
        """중립 감정 (감정 키워드 없음)."""
        emotion = self.detector.detect("오늘 날씨가 어때?")
        assert emotion.type == EmotionType.NEUTRAL
        assert emotion.intensity == 0.5

    def test_multiple_emotions_strongest_wins(self):
        """여러 감정이 혼재된 경우 가장 강한 것 우선."""
        # "좋아" (happy), "사랑" (affectionate) - affectionate 키워드가 더 강함
        emotion = self.detector.detect("좋아! 사랑해!")
        assert emotion.type == EmotionType.AFFECTIONATE

    def test_intensity_based_on_keyword_count(self):
        """키워드 반복 시 강도 증가."""
        emotion = self.detector.detect("너무너무너무 기뻐!!! 행복해!!")
        assert emotion.intensity >= 0.7

    def test_empty_message(self):
        """빈 메시지는 중립."""
        emotion = self.detector.detect("")
        assert emotion.type == EmotionType.NEUTRAL
