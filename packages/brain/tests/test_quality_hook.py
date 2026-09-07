"""Phase 7-B: Orchestrator quality_score 훅 TDD 테스트.

_estimate_quality() 메서드와 MemoryStore 연동 테스트.
"""
import pytest

from core.orchestrator import Orchestrator


# ──────────────────────────────────────────────
# TestEstimateQuality
# ──────────────────────────────────────────────

class TestEstimateQuality:
    """_estimate_quality() 단위 테스트."""

    def setup_method(self):
        self.orc = Orchestrator.__new__(Orchestrator)  # __init__ 우회

    def test_baseline_score(self):
        """기본 점수는 0.5."""
        # 길이가 범위 밖이고 fallback 아닌 경우 → baseline
        score = self.orc._estimate_quality("x" * 200, "y" * 600)
        assert score == pytest.approx(0.5, abs=0.01)

    def test_good_user_msg_length_adds_score(self):
        """5~100자 user_msg → +0.1."""
        user = "안녕 데모 사용자, 오늘 날씨 어때요?"    # ~17자
        assistant = "y" * 600                       # 범위 밖
        score = self.orc._estimate_quality(user, assistant)
        assert score == pytest.approx(0.6, abs=0.01)

    def test_good_assistant_msg_length_adds_score(self):
        """20~500자 assistant_msg → +0.2."""
        user = "x" * 200                            # 범위 밖
        assistant = "타냐의 응답입니다. " * 5        # 적당한 길이
        score = self.orc._estimate_quality(user, assistant)
        assert score == pytest.approx(0.7, abs=0.01)

    def test_both_good_lengths(self):
        """둘 다 좋은 길이 → 0.5 + 0.1 + 0.2 = 0.8."""
        user = "안녕 데모 사용자, 오늘 날씨 어때요?"
        assistant = "오늘 날씨는 맑고 화창해! 기분 좋은 날이야. 데모 사용자도 기분 좋지?"
        score = self.orc._estimate_quality(user, assistant)
        assert score == pytest.approx(0.8, abs=0.01)

    def test_fallback_message_reduces_score(self):
        """fallback 메시지 → -0.5."""
        user = "안녕하세요 타냐야"
        assistant = "잠깐, 생각을 정리 중이야... 조금만 기다려줘. ❤️"
        score = self.orc._estimate_quality(user, assistant)
        # user 길이 9자(5~100 통과 +0.1), asst 길이 30자(20~500 통과 +0.2), fallback(-0.5)
        # → 0.5 + 0.1 + 0.2 - 0.5 = 0.3
        assert score == pytest.approx(0.3, abs=0.02)

    def test_score_clamp_minimum(self):
        """점수 최소값은 0.0."""
        # fallback + 짧은 길이 → 0.5 - 0.5 = 0.0
        user = "x" * 200
        assistant = "잠깐, 생각을 정리 중이야 일단"
        score = self.orc._estimate_quality(user, assistant)
        assert score >= 0.0

    def test_score_clamp_maximum(self):
        """점수 최대값은 1.0."""
        user = "안녕 데모 사용자, 좋은 아침이야!"
        assistant = "좋은 아침이야 데모 사용자! 오늘도 화이팅! " * 5
        score = self.orc._estimate_quality(user, assistant)
        assert score <= 1.0

    def test_emotion_intensity_adds_score(self):
        """emotion_intensity >= 0.6 → +0.1."""
        user = "x" * 200
        assistant = "y" * 600
        score_no_emotion = self.orc._estimate_quality(user, assistant)
        score_with_emotion = self.orc._estimate_quality(user, assistant, emotion_intensity=0.8)
        assert score_with_emotion == pytest.approx(score_no_emotion + 0.1, abs=0.01)

    def test_low_emotion_intensity_no_bonus(self):
        """emotion_intensity < 0.6 → 보너스 없음."""
        user = "x" * 200
        assistant = "y" * 600
        score_no_emotion = self.orc._estimate_quality(user, assistant)
        score_low_emotion = self.orc._estimate_quality(user, assistant, emotion_intensity=0.3)
        assert score_low_emotion == pytest.approx(score_no_emotion, abs=0.01)

    def test_none_emotion_intensity(self):
        """emotion_intensity=None → 보너스 없음."""
        user = "x" * 200
        assistant = "y" * 600
        score = self.orc._estimate_quality(user, assistant, emotion_intensity=None)
        assert score == pytest.approx(0.5, abs=0.01)


# ──────────────────────────────────────────────
# TestQualityHookIntegration
# ──────────────────────────────────────────────

class TestQualityHookIntegration:
    """_handle_text() 안에서 quality_score가 저장되는지 통합 확인."""

    @pytest.mark.asyncio
    async def test_quality_score_saved_to_store(self, monkeypatch):
        """_handle_text() 호출 시 quality_score가 store에 저장된다."""
        import sqlite3
        from unittest.mock import AsyncMock, MagicMock

        orc = Orchestrator.__new__(Orchestrator)
        orc._settings = MagicMock()
        orc._settings.enable_emotion = False
        orc._settings.enable_memory = False
        orc._settings.enable_long_term_memory = False
        orc._settings.enable_finetune_scoring = True
        orc._settings.finetune_candidate_threshold = 0.6
        orc._last_vision_analysis = ""
        orc._persona_prompt = ""
        orc._long_term = None

        # LLM mock
        orc._llm = MagicMock()
        orc._llm.chat = AsyncMock(return_value="안녕 데모 사용자, 잘 지냈어? 오늘도 화이팅!")

        # TTS mock
        monkeypatch.setattr(
            "core.orchestrator.generate_tts_base64",
            AsyncMock(return_value="FAKEAUDIO"),
        )

        # Store mock — quality_score 저장 추적
        saved_scores = {}
        marked_ids = []

        class FakeStore:
            def save_conversation(self, session_key, user_msg, assistant_msg,
                                  emotion_type=None, emotion_intensity=None, token_count=None):
                return 42  # 가짜 conv_id

            def update_quality_score(self, conv_id, score):
                saved_scores[conv_id] = score

            def update_finetune_candidate(self, conv_ids):
                marked_ids.extend(conv_ids)
                return len(conv_ids)

        orc._store = FakeStore()

        response = await orc._handle_text("안녕하세요 타냐야, 잘 지내고 있어?")

        assert response is not None
        assert 42 in saved_scores
        assert 0.0 <= saved_scores[42] <= 1.0

    @pytest.mark.asyncio
    async def test_high_quality_marks_candidate(self, monkeypatch):
        """quality_score >= threshold 이면 is_finetune_candidate = 1로 마킹된다."""
        from unittest.mock import AsyncMock, MagicMock

        orc = Orchestrator.__new__(Orchestrator)
        orc._settings = MagicMock()
        orc._settings.enable_emotion = False
        orc._settings.enable_memory = False
        orc._settings.enable_long_term_memory = False
        orc._settings.enable_finetune_scoring = True
        orc._settings.finetune_candidate_threshold = 0.3  # 낮춰서 확실히 통과
        orc._last_vision_analysis = ""
        orc._persona_prompt = ""
        orc._long_term = None

        orc._llm = MagicMock()
        orc._llm.chat = AsyncMock(
            return_value="안녕 데모 사용자! 오늘도 잘 부탁해. 무슨 일 있어?"
        )

        monkeypatch.setattr(
            "core.orchestrator.generate_tts_base64",
            AsyncMock(return_value="AUDIO"),
        )

        marked_ids = []

        class FakeStore:
            def save_conversation(self, *a, **kw):
                return 99

            def update_quality_score(self, conv_id, score):
                pass

            def update_finetune_candidate(self, conv_ids):
                marked_ids.extend(conv_ids)
                return len(conv_ids)

        orc._store = FakeStore()

        await orc._handle_text("안녕 타냐, 오늘 날씨 어때?")

        assert 99 in marked_ids

    @pytest.mark.asyncio
    async def test_scoring_disabled_skips_store(self, monkeypatch):
        """enable_finetune_scoring=False 이면 store 저장 호출 안 함."""
        from unittest.mock import AsyncMock, MagicMock

        orc = Orchestrator.__new__(Orchestrator)
        orc._settings = MagicMock()
        orc._settings.enable_emotion = False
        orc._settings.enable_memory = False
        orc._settings.enable_long_term_memory = False
        orc._settings.enable_finetune_scoring = False
        orc._last_vision_analysis = ""
        orc._persona_prompt = ""
        orc._long_term = None

        orc._llm = MagicMock()
        orc._llm.chat = AsyncMock(return_value="응답이에요 데모 사용자!")

        monkeypatch.setattr(
            "core.orchestrator.generate_tts_base64",
            AsyncMock(return_value="AUDIO"),
        )

        store_called = []

        class FakeStore:
            def save_conversation(self, *a, **kw):
                store_called.append("save")
                return 1

            def update_quality_score(self, conv_id, score):
                store_called.append("quality")

            def update_finetune_candidate(self, conv_ids):
                store_called.append("candidate")
                return 0

        orc._store = FakeStore()

        await orc._handle_text("안녕 타냐야!")

        assert "quality" not in store_called
        assert "candidate" not in store_called
