"""Phase 3.2: LongTermMemory 테스트"""
import math
import time
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from memory.store import MemoryStore
from memory.long_term import LongTermMemory
from core.schemas import MemoryRecord


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
    """384차원 고정 벡터를 반환하는 임베딩 프로바이더 mock."""
    provider = MagicMock()
    provider.dimension = 384

    async def _embed(text: str) -> list[float]:
        # 텍스트별로 약간 다른 벡터 생성 (결정론적)
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


# ---------------------------------------------------------------------------
# MemoryRecord 스키마
# ---------------------------------------------------------------------------

class TestMemoryRecordSchema:
    def test_fields_present(self):
        rec = MemoryRecord(
            id=1,
            content="테스트 기억",
            category="episodic",
            importance=0.7,
            created_at="2026-01-01T00:00:00+00:00",
            relevance_score=0.85,
        )
        assert rec.id == 1
        assert rec.content == "테스트 기억"
        assert rec.relevance_score == pytest.approx(0.85)

    def test_defaults(self):
        rec = MemoryRecord(
            id=2,
            content="기본값 테스트",
            created_at="2026-01-01T00:00:00+00:00",
        )
        assert rec.category == "episodic"
        assert rec.importance == pytest.approx(0.5)
        assert rec.relevance_score == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# 기억 저장 (save_memory)
# ---------------------------------------------------------------------------

class TestSaveMemory:
    @pytest.mark.asyncio
    async def test_save_returns_id(self, ltm):
        mem_id = await ltm.save_memory("사용자는 게임을 좋아한다")
        assert isinstance(mem_id, int)
        assert mem_id > 0

    @pytest.mark.asyncio
    async def test_save_stores_content(self, ltm, store):
        mem_id = await ltm.save_memory("파이썬 좋아함", category="preference")
        mem = store.get_memory(mem_id)
        assert mem is not None
        assert mem["content"] == "파이썬 좋아함"
        assert mem["category"] == "preference"

    @pytest.mark.asyncio
    async def test_save_stores_embedding_in_vec_table(self, ltm, store):
        mem_id = await ltm.save_memory("벡터 저장 테스트")
        # memories_vec에 해당 rowid로 행이 존재해야 함
        count = store.execute_scalar(
            "SELECT count(*) FROM memories_vec WHERE rowid = ?", (mem_id,)
        )
        assert count == 1

    @pytest.mark.asyncio
    async def test_save_all_categories(self, ltm):
        categories = ["episodic", "preference", "fact", "emotional"]
        for cat in categories:
            mem_id = await ltm.save_memory(f"{cat} 기억", category=cat)
            assert mem_id > 0


# ---------------------------------------------------------------------------
# 검색 (search)
# ---------------------------------------------------------------------------

class TestSearch:
    @pytest.mark.asyncio
    async def test_search_returns_memory_records(self, ltm):
        await ltm.save_memory("사용자는 RPG 게임을 좋아한다", category="preference")
        results = await ltm.search("게임", top_k=5)
        assert isinstance(results, list)
        assert all(isinstance(r, MemoryRecord) for r in results)

    @pytest.mark.asyncio
    async def test_search_empty_store_returns_empty(self, ltm):
        results = await ltm.search("아무것도 없음", top_k=5)
        assert results == []

    @pytest.mark.asyncio
    async def test_search_respects_top_k(self, ltm):
        for i in range(10):
            await ltm.save_memory(f"기억 {i}번")
        results = await ltm.search("기억", top_k=3)
        assert len(results) <= 3

    @pytest.mark.asyncio
    async def test_search_category_filter(self, ltm):
        await ltm.save_memory("게임 좋아함", category="preference")
        await ltm.save_memory("오늘 비가 왔다", category="episodic")
        results = await ltm.search("좋아", top_k=5, category="preference")
        assert all(r.category == "preference" for r in results)

    @pytest.mark.asyncio
    async def test_relevance_score_between_0_and_1(self, ltm):
        await ltm.save_memory("테스트 기억")
        results = await ltm.search("테스트", top_k=5)
        if results:
            for r in results:
                assert 0.0 <= r.relevance_score <= 1.0


# ---------------------------------------------------------------------------
# Temporal Decay
# ---------------------------------------------------------------------------

class TestTemporalDecay:
    def test_decay_factor_30_days(self, ltm):
        """반감기 30일 — 30일 경과 시 점수 ≈ 0.5."""
        factor = ltm._decay_factor(30)
        assert 0.45 < factor < 0.55

    def test_decay_factor_0_days(self, ltm):
        """0일 경과 시 점수 = 1.0."""
        factor = ltm._decay_factor(0)
        assert factor == pytest.approx(1.0)

    def test_decay_factor_90_days(self, ltm):
        """90일 경과 시 점수 ≈ 0.125 (세 번 반감)."""
        factor = ltm._decay_factor(90)
        assert 0.10 < factor < 0.15


# ---------------------------------------------------------------------------
# 사용자 프로필
# ---------------------------------------------------------------------------

class TestUserProfile:
    def test_set_and_get(self, ltm):
        ltm.set_profile("name", "사용자")
        assert ltm.get_profile("name") == "사용자"

    def test_update_existing(self, ltm):
        ltm.set_profile("hobby", "게임")
        ltm.set_profile("hobby", "독서")
        assert ltm.get_profile("hobby") == "독서"

    def test_get_missing_returns_none(self, ltm):
        assert ltm.get_profile("nonexistent") is None

    def test_get_all_profile(self, ltm):
        ltm.set_profile("a", "1")
        ltm.set_profile("b", "2")
        result = ltm.get_all_profile()
        assert result["a"] == "1"
        assert result["b"] == "2"
