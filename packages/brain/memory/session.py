"""Phase 3.3: Session 관리 + Compaction.

SessionManager:
- 세션 키 기반 대화 컨텍스트 관리
- conversations 테이블에 턴 영속화 (MemoryStore)
- Compaction: soft_threshold 초과 시 오래된 턴을 LLM으로 요약
  → 요약을 장기 기억(category=episodic)에 저장
  → deque에서 요약된 턴 제거, system_context로 유지
"""
from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
from typing import Callable, Awaitable

from core.schemas import ConversationTurn, EmotionState
from memory.store import MemoryStore
from memory.long_term import LongTermMemory


class SessionContext:
    """단일 세션의 단기 메모리 + 컴팩션 컨텍스트."""

    def __init__(self, session_key: str, max_turns: int = 20) -> None:
        self.session_key = session_key
        self._turns: deque[ConversationTurn] = deque(maxlen=max_turns)
        self.system_context: str = ""  # Compaction 요약이 여기에 축적

    def append(self, turn: ConversationTurn) -> None:
        self._turns.append(turn)

    def get_history(self) -> list[dict]:
        history = []
        for t in self._turns:
            history.append({"role": "user", "content": t.user_message})
            history.append({"role": "assistant", "content": t.assistant_message})
        return history

    def pop_oldest(self, n: int) -> list[ConversationTurn]:
        """앞에서 n개 턴을 꺼내서 반환 (deque에서 제거)."""
        popped = []
        for _ in range(min(n, len(self._turns))):
            popped.append(self._turns.popleft())
        return popped

    @property
    def turn_count(self) -> int:
        return len(self._turns)


# ---------------------------------------------------------------------------
# 기본 요약 함수 (LLM 없을 때 placeholder)
# ---------------------------------------------------------------------------

async def _default_summarize(turns: list[ConversationTurn]) -> str:
    lines = []
    for t in turns:
        lines.append(f"User: {t.user_message}")
        lines.append(f"Tanya: {t.assistant_message}")
    return "이전 대화 요약:\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# SessionManager
# ---------------------------------------------------------------------------

class SessionManager:
    """세션 키 기반 대화 컨텍스트 관리자.

    Parameters
    ----------
    store:
        MemoryStore — conversations 테이블 영속화에 사용.
    long_term:
        LongTermMemory — Compaction 요약 저장에 사용.
    soft_threshold:
        이 값 이상이 되면 Compaction을 트리거 (기본 15).
    max_turns:
        세션 deque 최대 크기 (기본 20).
    summarize_fn:
        LLM 요약 함수. `async (turns) -> str` 시그니처.
        None이면 기본 placeholder 사용.
    """

    def __init__(
        self,
        store: MemoryStore,
        long_term: LongTermMemory,
        soft_threshold: int = 15,
        max_turns: int = 20,
        summarize_fn: Callable[[list[ConversationTurn]], Awaitable[str]] | None = None,
    ) -> None:
        self._store = store
        self._long_term = long_term
        self._soft_threshold = soft_threshold
        self._max_turns = max_turns
        # 외부에서 교체 가능하도록 인스턴스 속성으로
        self._summarize_fn: Callable[[list[ConversationTurn]], Awaitable[str]] = (
            summarize_fn or _default_summarize
        )
        self._sessions: dict[str, SessionContext] = {}

    # ------------------------------------------------------------------
    # 세션 조회 / 생성
    # ------------------------------------------------------------------

    def get_or_create(self, session_key: str) -> SessionContext:
        if session_key not in self._sessions:
            self._sessions[session_key] = SessionContext(
                session_key, max_turns=self._max_turns
            )
        return self._sessions[session_key]

    # ------------------------------------------------------------------
    # 턴 추가
    # ------------------------------------------------------------------

    async def add_turn(
        self,
        session_key: str,
        user_msg: str,
        assistant_msg: str,
        emotion: EmotionState | None = None,
        emotion_intensity: float | None = None,
        token_count: int | None = None,
    ) -> None:
        """턴을 세션 deque + conversations 테이블에 저장하고, 필요 시 compaction."""
        ctx = self.get_or_create(session_key)
        emo = emotion or EmotionState()

        turn = ConversationTurn(
            user_message=user_msg,
            assistant_message=assistant_msg,
            emotion=emo,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        ctx.append(turn)

        # DB 영속화
        self._store.save_conversation(
            session_key=session_key,
            user_msg=user_msg,
            assistant_msg=assistant_msg,
            emotion_type=emo.type.value,
            emotion_intensity=emotion_intensity,
            token_count=token_count,
        )

        # Compaction 체크
        if ctx.turn_count > self._soft_threshold:
            await self._compact(ctx)

    # ------------------------------------------------------------------
    # 히스토리 조회
    # ------------------------------------------------------------------

    def get_history(self, session_key: str) -> list[dict]:
        ctx = self.get_or_create(session_key)
        return ctx.get_history()

    # ------------------------------------------------------------------
    # Compaction
    # ------------------------------------------------------------------

    async def _compact(self, ctx: SessionContext) -> None:
        """오래된 턴 절반을 LLM으로 요약 → 장기 기억 저장 → deque 정리."""
        n_to_compact = ctx.turn_count // 2
        if n_to_compact == 0:
            return

        old_turns = ctx.pop_oldest(n_to_compact)
        summary = await self._summarize_fn(old_turns)

        # 장기 기억에 episodic으로 저장
        await self._long_term.save_memory(
            content=summary,
            category="episodic",
            importance=0.6,
        )

        # system_context 갱신 (누적)
        if ctx.system_context:
            ctx.system_context = ctx.system_context + "\n\n" + summary
        else:
            ctx.system_context = summary
