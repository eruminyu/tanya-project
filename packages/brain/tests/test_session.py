"""Phase 3.3: SessionManager + Compaction 테스트"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from memory.store import MemoryStore
from memory.long_term import LongTermMemory
from memory.session import SessionManager
from core.schemas import ConversationTurn, EmotionState


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def store():
    s = MemoryStore(":memory:")
    yield s
    s.close()


@pytest.fixture
def mock_provider():
    provider = MagicMock()
    provider.dimension = 384

    async def _embed(text: str) -> list[float]:
        seed = sum(ord(c) for c in text) % 100
        base = [0.0] * 384
        base[seed] = 1.0
        return base

    async def _embed_batch(texts):
        return [await _embed(t) for t in texts]

    provider.embed = AsyncMock(side_effect=_embed)
    provider.embed_batch = AsyncMock(side_effect=_embed_batch)
    return provider


@pytest.fixture
def ltm(store, mock_provider):
    return LongTermMemory(store=store, embedding_provider=mock_provider)


@pytest.fixture
def session_mgr(store, ltm):
    return SessionManager(store=store, long_term=ltm, soft_threshold=5)


# ---------------------------------------------------------------------------
# 세션 생성 + 격리
# ---------------------------------------------------------------------------

class TestSessionCreation:
    def test_get_or_create_returns_context(self, session_mgr):
        ctx = session_mgr.get_or_create("tauri:main")
        assert ctx is not None

    def test_same_key_returns_same_context(self, session_mgr):
        ctx1 = session_mgr.get_or_create("tauri:main")
        ctx2 = session_mgr.get_or_create("tauri:main")
        assert ctx1 is ctx2

    def test_different_keys_isolated(self, session_mgr):
        ctx_a = session_mgr.get_or_create("tauri:main")
        ctx_b = session_mgr.get_or_create("discord:dm:123")
        assert ctx_a is not ctx_b

    def test_session_key_formats(self, session_mgr):
        """세션 키 규칙: live2d:<id>, webchat:<id>, discord:dm:<id>."""
        for key in ["live2d:main", "webchat:browser-1", "discord:dm:42"]:
            ctx = session_mgr.get_or_create(key)
            assert ctx is not None


# ---------------------------------------------------------------------------
# 턴 추가 + 히스토리
# ---------------------------------------------------------------------------

class TestTurnManagement:
    @pytest.mark.asyncio
    async def test_add_turn_increases_count(self, session_mgr):
        await session_mgr.add_turn("tauri:main", "안녕", "안녕하세요!")
        ctx = session_mgr.get_or_create("tauri:main")
        assert ctx.turn_count == 1

    @pytest.mark.asyncio
    async def test_add_multiple_turns(self, session_mgr):
        for i in range(3):
            await session_mgr.add_turn("tauri:main", f"user {i}", f"reply {i}")
        ctx = session_mgr.get_or_create("tauri:main")
        assert ctx.turn_count == 3

    @pytest.mark.asyncio
    async def test_get_history_format(self, session_mgr):
        await session_mgr.add_turn("tauri:main", "hello", "hi")
        history = session_mgr.get_history("tauri:main")
        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[0]["content"] == "hello"
        assert history[1]["role"] == "assistant"
        assert history[1]["content"] == "hi"

    @pytest.mark.asyncio
    async def test_turns_isolated_across_sessions(self, session_mgr):
        await session_mgr.add_turn("tauri:main", "A", "a")
        await session_mgr.add_turn("discord:dm:1", "B", "b")
        assert session_mgr.get_or_create("tauri:main").turn_count == 1
        assert session_mgr.get_or_create("discord:dm:1").turn_count == 1

    @pytest.mark.asyncio
    async def test_add_turn_persists_to_store(self, session_mgr, store):
        await session_mgr.add_turn("tauri:main", "저장 테스트", "저장됨")
        count = store.count_conversations("tauri:main")
        assert count == 1


# ---------------------------------------------------------------------------
# Compaction (LLM 의존 — mock 사용)
# ---------------------------------------------------------------------------

class TestCompaction:
    @pytest.mark.asyncio
    async def test_compaction_not_triggered_below_threshold(self, session_mgr):
        """soft_threshold=5 미만 — compaction 안 일어남."""
        for i in range(4):
            await session_mgr.add_turn("tauri:main", f"msg {i}", f"rep {i}")
        ctx = session_mgr.get_or_create("tauri:main")
        assert ctx.turn_count == 4

    @pytest.mark.asyncio
    async def test_compaction_triggered_at_threshold(self, session_mgr, ltm):
        """soft_threshold 초과 시 compaction 실행."""
        mock_llm = AsyncMock(return_value="요약된 대화 내용입니다.")
        session_mgr._summarize_fn = mock_llm

        for i in range(6):  # threshold=5 초과
            await session_mgr.add_turn("tauri:main", f"msg {i}", f"rep {i}")

        mock_llm.assert_called()

    @pytest.mark.asyncio
    async def test_compaction_reduces_turn_count(self, session_mgr):
        """Compaction 후 deque 길이가 줄어든다."""
        mock_llm = AsyncMock(return_value="요약된 대화.")
        session_mgr._summarize_fn = mock_llm

        for i in range(6):
            await session_mgr.add_turn("tauri:main", f"msg {i}", f"rep {i}")

        ctx = session_mgr.get_or_create("tauri:main")
        assert ctx.turn_count < 6

    @pytest.mark.asyncio
    async def test_compaction_saves_summary_to_long_term(self, session_mgr, store):
        """Compaction 요약이 장기 기억(episodic)으로 저장된다."""
        mock_llm = AsyncMock(return_value="요약된 내용.")
        session_mgr._summarize_fn = mock_llm

        for i in range(6):
            await session_mgr.add_turn("tauri:main", f"msg {i}", f"rep {i}")

        # memories 테이블에 category=episodic 행이 생겼어야 함
        count = store.execute_scalar(
            "SELECT count(*) FROM memories WHERE category = 'episodic'"
        )
        assert count >= 1

    @pytest.mark.asyncio
    async def test_compaction_summary_in_system_context(self, session_mgr):
        """Compaction 후 요약이 system_context에 남는다."""
        mock_llm = AsyncMock(return_value="요약된 내용입니다.")
        session_mgr._summarize_fn = mock_llm

        for i in range(6):
            await session_mgr.add_turn("tauri:main", f"msg {i}", f"rep {i}")

        ctx = session_mgr.get_or_create("tauri:main")
        assert ctx.system_context is not None
        assert len(ctx.system_context) > 0


# ---------------------------------------------------------------------------
# engine.py 하위 호환
# ---------------------------------------------------------------------------

class TestEngineCompat:
    def test_engine_still_works_without_store(self):
        """기존 MemoryEngine(store 없음)은 그대로 동작해야 한다."""
        from memory.engine import MemoryEngine
        engine = MemoryEngine()
        engine.add_turn("hello", "hi")
        assert engine.turn_count == 1
        history = engine.get_history()
        assert len(history) == 2
