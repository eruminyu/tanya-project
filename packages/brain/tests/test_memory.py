import pytest
from memory.engine import MemoryEngine
from core.schemas import EmotionState, EmotionType


class TestMemoryEngine:
    def setup_method(self):
        self.engine = MemoryEngine()

    def test_add_turn_and_count(self):
        self.engine.add_turn("안녕!", "안녕 사용자~ ❤️")
        assert self.engine.turn_count == 1

    def test_get_history_format(self):
        self.engine.add_turn("오늘 뭐 해?", "코딩하고 있지!")
        history = self.engine.get_history()

        assert len(history) == 2
        assert history[0] == {"role": "user", "content": "오늘 뭐 해?"}
        assert history[1] == {"role": "assistant", "content": "코딩하고 있지!"}

    def test_multiple_turns(self):
        self.engine.add_turn("첫번째", "응답1")
        self.engine.add_turn("두번째", "응답2")
        self.engine.add_turn("세번째", "응답3")

        history = self.engine.get_history()
        assert len(history) == 6  # 3턴 x 2 (user + assistant)
        assert history[0]["content"] == "첫번째"
        assert history[-1]["content"] == "응답3"

    def test_get_recent_turns(self):
        for i in range(10):
            self.engine.add_turn(f"msg{i}", f"reply{i}")

        recent = self.engine.get_recent_turns(3)
        assert len(recent) == 3
        assert recent[0].user_message == "msg7"
        assert recent[-1].user_message == "msg9"

    def test_max_turns_limit(self):
        """deque maxlen을 초과하면 오래된 기억이 사라진다."""
        # settings의 기본값은 20
        for i in range(25):
            self.engine.add_turn(f"msg{i}", f"reply{i}")

        assert self.engine.turn_count == 20
        history = self.engine.get_history()
        # 가장 오래된 것은 msg5 (0~4는 밀려남)
        assert history[0]["content"] == "msg5"

    def test_clear(self):
        self.engine.add_turn("hello", "hi")
        self.engine.clear()
        assert self.engine.turn_count == 0
        assert self.engine.get_history() == []

    def test_add_turn_with_emotion(self):
        emotion = EmotionState(type=EmotionType.HAPPY, intensity=0.8)
        self.engine.add_turn("좋은 소식!", "정말? 나도 기뻐!", emotion)

        turns = self.engine.get_recent_turns(1)
        assert turns[0].emotion.type == EmotionType.HAPPY
        assert turns[0].emotion.intensity == 0.8

    def test_turn_has_timestamp(self):
        self.engine.add_turn("시간 테스트", "응답")
        turns = self.engine.get_recent_turns(1)
        assert turns[0].timestamp is not None
