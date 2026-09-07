"""Phase 3.0: MemoryStore 테스트"""
import pytest
import sqlite3
from memory.store import MemoryStore


@pytest.fixture
def store():
    """인메모리 DB를 사용하는 MemoryStore."""
    s = MemoryStore(":memory:")
    yield s
    s.close()


class TestMemoryStoreInit:
    def test_tables_created(self, store):
        tables = store.get_table_names()
        assert "conversations" in tables
        assert "memories" in tables
        assert "user_profile" in tables

    def test_fts_table_created(self, store):
        tables = store.get_table_names()
        assert "memories_fts" in tables

    def test_wal_mode_enabled(self, tmp_path):
        # :memory: DB는 WAL 미지원 — 실제 파일 DB로 검증
        db_path = str(tmp_path / "test.db")
        with MemoryStore(db_path) as s:
            result = s.execute_scalar("PRAGMA journal_mode")
        assert result == "wal"


class TestConversations:
    def test_save_and_count(self, store):
        store.save_conversation(
            session_key="test:main",
            user_msg="안녕",
            assistant_msg="안녕하세요!",
            emotion_type="happy",
            emotion_intensity=0.8,
            token_count=10,
        )
        assert store.count_conversations("test:main") == 1

    def test_multiple_sessions_isolated(self, store):
        store.save_conversation("session_a", "msg1", "reply1")
        store.save_conversation("session_b", "msg2", "reply2")
        assert store.count_conversations("session_a") == 1
        assert store.count_conversations("session_b") == 1

    def test_finetune_candidate_default_zero(self, store):
        store.save_conversation("test:main", "hello", "hi")
        rows = store.get_conversations("test:main", limit=1)
        assert rows[0]["is_finetune_candidate"] == 0

    def test_quality_score_default_none(self, store):
        store.save_conversation("test:main", "hello", "hi")
        rows = store.get_conversations("test:main", limit=1)
        assert rows[0]["quality_score"] is None

    def test_update_quality_score(self, store):
        conv_id = store.save_conversation("test:main", "hello", "hi")
        store.update_quality_score(conv_id, 0.9)
        rows = store.get_conversations("test:main", limit=1)
        assert rows[0]["quality_score"] == pytest.approx(0.9)


class TestMemories:
    def test_save_and_get_memory(self, store):
        mem_id = store.save_memory(
            content="사용자는 게임을 좋아한다",
            category="preference",
            importance=0.7,
        )
        mem = store.get_memory(mem_id)
        assert mem is not None
        assert mem["content"] == "사용자는 게임을 좋아한다"
        assert mem["category"] == "preference"

    def test_fts_row_created(self, store):
        store.save_memory(content="파이썬 개발자", category="fact")
        count = store.execute_scalar(
            "SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'python OR 파이썬'"
        )
        assert count >= 1


class TestUserProfile:
    def test_set_and_get(self, store):
        store.set_profile("name", "사용자")
        assert store.get_profile("name") == "사용자"

    def test_update_existing(self, store):
        store.set_profile("name", "사용자")
        store.set_profile("name", "데모 사용자")
        assert store.get_profile("name") == "데모 사용자"

    def test_get_missing_returns_none(self, store):
        assert store.get_profile("nonexistent") is None

    def test_get_all_profile(self, store):
        store.set_profile("a", "1")
        store.set_profile("b", "2")
        result = store.get_all_profile()
        assert result["a"] == "1"
        assert result["b"] == "2"


class TestContextManager:
    def test_context_manager(self):
        with MemoryStore(":memory:") as s:
            s.save_conversation("test", "hi", "hello")
            assert s.count_conversations("test") == 1
