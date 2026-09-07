"""Phase 7-A: FineTuneCollector TDD 테스트."""
import sqlite3
import pytest

from finetune.collector import FineTuneCollector


# ──────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────

class FakeStore:
    """MemoryStore의 최소 인터페이스 스텁."""

    def __init__(self):
        self._conn = sqlite3.connect(":memory:")
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript("""
            CREATE TABLE conversations (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key           TEXT    NOT NULL,
                user_msg              TEXT    NOT NULL,
                assistant_msg         TEXT    NOT NULL,
                emotion_type          TEXT,
                emotion_intensity     REAL,
                token_count           INTEGER,
                quality_score         REAL,
                is_finetune_candidate INTEGER NOT NULL DEFAULT 0,
                created_at            TEXT    NOT NULL
            );
        """)

    def _now(self):
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()

    def insert(self, session_key, user_msg, assistant_msg,
               quality_score=None, is_candidate=0):
        self._conn.execute(
            """INSERT INTO conversations
               (session_key, user_msg, assistant_msg, quality_score,
                is_finetune_candidate, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session_key, user_msg, assistant_msg,
             quality_score, is_candidate, self._now()),
        )
        self._conn.commit()
        return self._conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    def update_quality_score(self, conv_id: int, score: float) -> None:
        self._conn.execute(
            "UPDATE conversations SET quality_score = ? WHERE id = ?",
            (score, conv_id),
        )
        self._conn.commit()

    def update_finetune_candidate(self, conv_ids: list[int]) -> int:
        if not conv_ids:
            return 0
        placeholders = ",".join("?" * len(conv_ids))
        cur = self._conn.execute(
            f"UPDATE conversations SET is_finetune_candidate = 1 WHERE id IN ({placeholders})",
            conv_ids,
        )
        self._conn.commit()
        return cur.rowcount


# ──────────────────────────────────────────────
# TestFineTuneCollectorCollect
# ──────────────────────────────────────────────

class TestFineTuneCollectorCollect:
    def test_collect_returns_candidate_rows(self):
        store = FakeStore()
        store.insert("test:main", "안녕", "안녕 데모 사용자!", quality_score=0.7, is_candidate=1)
        store.insert("test:main", "hello", "hi!", quality_score=0.3, is_candidate=1)

        collector = FineTuneCollector(store)
        result = collector.collect(min_quality=0.5)

        assert len(result) == 1
        assert result[0]["user_msg"] == "안녕"

    def test_collect_excludes_non_candidates(self):
        store = FakeStore()
        store.insert("test:main", "안녕", "안녕!", quality_score=0.8, is_candidate=0)

        collector = FineTuneCollector(store)
        result = collector.collect(min_quality=0.5)

        assert len(result) == 0

    def test_collect_excludes_null_quality(self):
        store = FakeStore()
        store.insert("test:main", "test", "response", quality_score=None, is_candidate=1)

        collector = FineTuneCollector(store)
        result = collector.collect(min_quality=0.0)

        assert len(result) == 0

    def test_collect_respects_limit(self):
        store = FakeStore()
        for i in range(10):
            store.insert("test:main", f"msg{i}", f"resp{i}", quality_score=0.8, is_candidate=1)

        collector = FineTuneCollector(store)
        result = collector.collect(min_quality=0.5, limit=3)

        assert len(result) == 3

    def test_collect_default_min_quality(self):
        """기본 min_quality=0.5로 0.4는 제외."""
        store = FakeStore()
        store.insert("test:main", "good", "great!", quality_score=0.8, is_candidate=1)
        store.insert("test:main", "bad", "meh", quality_score=0.4, is_candidate=1)

        collector = FineTuneCollector(store)
        result = collector.collect()

        assert len(result) == 1

    def test_collect_multiple_sessions(self):
        store = FakeStore()
        store.insert("test:main", "msg1", "resp1", quality_score=0.7, is_candidate=1)
        store.insert("webchat:abc", "msg2", "resp2", quality_score=0.7, is_candidate=1)

        collector = FineTuneCollector(store)
        result = collector.collect()

        assert len(result) == 2


# ──────────────────────────────────────────────
# TestFineTuneCollectorMarkCandidates
# ──────────────────────────────────────────────

class TestFineTuneCollectorMarkCandidates:
    def test_mark_candidates_updates_flag(self):
        store = FakeStore()
        id1 = store.insert("test:main", "msg1", "resp1", quality_score=0.7, is_candidate=0)
        id2 = store.insert("test:main", "msg2", "resp2", quality_score=0.7, is_candidate=0)

        collector = FineTuneCollector(store)
        count = collector.mark_candidates([id1, id2])

        assert count == 2
        result = collector.collect(min_quality=0.5)
        assert len(result) == 2

    def test_mark_candidates_empty_list(self):
        store = FakeStore()
        collector = FineTuneCollector(store)
        count = collector.mark_candidates([])
        assert count == 0

    def test_mark_candidates_returns_updated_count(self):
        store = FakeStore()
        id1 = store.insert("test:main", "msg1", "resp1", quality_score=0.8, is_candidate=0)

        collector = FineTuneCollector(store)
        count = collector.mark_candidates([id1, 9999])  # 9999는 없는 ID

        assert count == 1  # 실제 업데이트된 건수만


# ──────────────────────────────────────────────
# TestFineTuneCollectorStats
# ──────────────────────────────────────────────

class TestFineTuneCollectorStats:
    def test_stats_empty_db(self):
        store = FakeStore()
        collector = FineTuneCollector(store)
        stats = collector.stats()

        assert stats["total_conversations"] == 0
        assert stats["candidate_count"] == 0
        assert stats["avg_quality_score"] is None

    def test_stats_with_data(self):
        store = FakeStore()
        store.insert("test:main", "msg1", "resp1", quality_score=0.8, is_candidate=1)
        store.insert("test:main", "msg2", "resp2", quality_score=0.6, is_candidate=0)
        store.insert("test:main", "msg3", "resp3", quality_score=None, is_candidate=0)

        collector = FineTuneCollector(store)
        stats = collector.stats()

        assert stats["total_conversations"] == 3
        assert stats["candidate_count"] == 1
        assert abs(stats["avg_quality_score"] - 0.7) < 0.01  # (0.8+0.6)/2, None 제외

    def test_stats_keys(self):
        store = FakeStore()
        collector = FineTuneCollector(store)
        stats = collector.stats()

        assert "total_conversations" in stats
        assert "candidate_count" in stats
        assert "avg_quality_score" in stats
