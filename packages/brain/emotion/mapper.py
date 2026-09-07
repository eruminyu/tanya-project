"""감정 → TTS 파라미터 / 애니메이션 매핑."""

from core.schemas import EmotionState, EmotionType


class EmotionMapper:
    """
    감정 상태를 TTS 음성 파라미터와 애니메이션 인텐트로 변환.

    TTS 파라미터:
    - rate: 말하기 속도 (0.5~2.0, 기본 1.0)
    - pitch: 음높이 (-20~+20, 기본 0)

    애니메이션 인텐트:
    - Unity 클라이언트가 해석하는 애니메이션/표정 힌트
    """

    # 감정별 기본 파라미터 (intensity=1.0 기준)
    EMOTION_TTS_MAP = {
        EmotionType.NEUTRAL: {"rate": 1.0, "pitch": 0},
        EmotionType.HAPPY: {"rate": 1.15, "pitch": 5},
        EmotionType.SAD: {"rate": 0.85, "pitch": -5},
        EmotionType.EXCITED: {"rate": 1.3, "pitch": 8},
        EmotionType.WORRIED: {"rate": 0.9, "pitch": -2},
        EmotionType.ANNOYED: {"rate": 1.1, "pitch": 3},
        EmotionType.AFFECTIONATE: {"rate": 0.95, "pitch": 3},
    }

    EMOTION_ANIMATION_MAP = {
        EmotionType.NEUTRAL: "idle",
        EmotionType.HAPPY: "smile",
        EmotionType.SAD: "sad",
        EmotionType.EXCITED: "excited",
        EmotionType.WORRIED: "worried",
        EmotionType.ANNOYED: "annoyed",
        EmotionType.AFFECTIONATE: "affectionate",
    }

    def map_to_tts_params(self, emotion: EmotionState) -> dict[str, float]:
        """
        감정 상태를 TTS 파라미터로 변환.

        Args:
            emotion: 감정 상태

        Returns:
            dict: {"rate": float, "pitch": float}
        """
        base_params = self.EMOTION_TTS_MAP.get(
            emotion.type, self.EMOTION_TTS_MAP[EmotionType.NEUTRAL]
        )

        # intensity를 적용해서 파라미터 스케일링
        # intensity 0.5는 기본값, 1.0은 최대
        scale = emotion.intensity

        # rate: intensity가 낮으면 기본값에 가깝게
        rate_offset = (base_params["rate"] - 1.0) * scale
        rate = 1.0 + rate_offset

        # pitch: intensity가 낮으면 기본값에 가깝게
        pitch = base_params["pitch"] * scale

        # 안전 범위 내로 제한
        rate = max(0.5, min(2.0, rate))
        pitch = max(-20, min(20, pitch))

        return {"rate": rate, "pitch": pitch}

    def map_to_animation(self, emotion: EmotionState) -> str:
        """
        감정 상태를 애니메이션 인텐트로 변환.

        Args:
            emotion: 감정 상태

        Returns:
            str: 애니메이션 인텐트 (Unity가 해석)
        """
        return self.EMOTION_ANIMATION_MAP.get(
            emotion.type, self.EMOTION_ANIMATION_MAP[EmotionType.NEUTRAL]
        )
