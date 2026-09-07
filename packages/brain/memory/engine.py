from collections import deque
from datetime import datetime, timezone

from config.settings import get_settings
from core.schemas import ConversationTurn, EmotionState


class MemoryEngine:
    """타냐의 기억 시스템.

    Phase 1: Short-term memory (in-memory deque)
    Phase 3: + Episodic (SQLite), User Profile (SQLite)
    """

    def __init__(self):
        settings = get_settings()
        max_turns = settings.memory_short_term_max_turns
        self._short_term: deque[ConversationTurn] = deque(maxlen=max_turns)

    def add_turn(
        self,
        user_message: str,
        assistant_message: str,
        emotion: EmotionState | None = None,
    ) -> None:
        """대화 한 턴을 단기 기억에 저장한다."""
        turn = ConversationTurn(
            user_message=user_message,
            assistant_message=assistant_message,
            emotion=emotion or EmotionState(),
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self._short_term.append(turn)

    def get_history(self) -> list[dict]:
        """LLM에 넘길 대화 히스토리를 반환한다.

        Returns:
            [{"role": "user"|"assistant", "content": "..."}] 형태의 리스트
        """
        history = []
        for turn in self._short_term:
            history.append({"role": "user", "content": turn.user_message})
            history.append({"role": "assistant", "content": turn.assistant_message})
        return history

    def get_recent_turns(self, n: int = 5) -> list[ConversationTurn]:
        """최근 N턴의 대화를 반환한다."""
        turns = list(self._short_term)
        return turns[-n:]

    def clear(self) -> None:
        """단기 기억을 초기화한다."""
        self._short_term.clear()

    @property
    def turn_count(self) -> int:
        return len(self._short_term)
