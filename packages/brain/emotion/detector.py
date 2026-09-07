"""감정 감지기 - 키워드 기반 감정 분석."""

from core.schemas import EmotionState, EmotionType


class EmotionDetector:
    """사용자 메시지에서 감정을 감지하는 키워드 기반 감지기."""

    # 감정별 키워드 사전 (우선순위: affectionate > excited > happy > sad > worried > annoyed)
    EMOTION_KEYWORDS = {
        EmotionType.AFFECTIONATE: [
            "사랑", "❤️", "💕", "애정", "소중", "특별"
        ],
        EmotionType.EXCITED: [
            "와!", "우와", "신나", "설레", "기대", "!!!", "완전", "대박",
            "멋져", "쩔어", "굿"
        ],
        EmotionType.HAPPY: [
            "기뻐", "기쁘", "행복", "즐거", "재밌", "웃", "ㅎㅎ", "ㅋㅋ", "😊", "😄",
            "좋", "괜찮", "만족", "고마워", "감사", "완벽", "최고"
        ],
        EmotionType.SAD: [
            "슬퍼", "슬프", "우울", "힘들", "힘든", "외로", "쓸쓸", "😢", "😭", "아쉬",
            "후회", "그립"
        ],
        EmotionType.WORRIED: [
            "걱정", "불안", "두려", "무서", "조마조마", "긴장", "떨려",
            "염려", "근심"
        ],
        EmotionType.ANNOYED: [
            "짜증", "화나", "답답", "짜치", "열받", "빡쳐", "😡", "😠",
            "귀찮", "싫어"
        ],
    }

    def detect(self, user_message: str) -> EmotionState:
        """
        사용자 메시지에서 감정을 감지.

        Args:
            user_message: 사용자 입력 텍스트

        Returns:
            EmotionState: 감지된 감정 상태 (type + intensity)
        """
        if not user_message or not user_message.strip():
            return EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)

        # 각 감정별 점수 계산
        scores = {emotion_type: 0.0 for emotion_type in self.EMOTION_KEYWORDS}

        for emotion_type, keywords in self.EMOTION_KEYWORDS.items():
            for keyword in keywords:
                count = user_message.count(keyword)
                if count > 0:
                    scores[emotion_type] += count

        # 가장 높은 점수의 감정 선택
        max_emotion = max(scores, key=scores.get)
        max_score = scores[max_emotion]

        if max_score == 0:
            return EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)

        # 강도 계산 (키워드 개수에 비례, 최대 1.0)
        # 1개: 0.6, 2개: 0.7, 3개: 0.75, 4개: 0.8, 5개 이상: 0.85+
        intensity = min(0.5 + (max_score * 0.1), 1.0)

        return EmotionState(type=max_emotion, intensity=intensity)
