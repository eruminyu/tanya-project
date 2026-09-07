"""피드백 API 테스트.

POST /feedback 엔드포인트와 MemoryStore.update_finetune_candidate() 검증.
"""
import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient


# ──────────────────────────────────────────────
# MemoryStore.update_finetune_candidate 단위 테스트
# ──────────────────────────────────────────────

class TestUpdateFinetuneCandidateMethod:
    def test_marks_single_candidate(self):
        """단일 conv_id를 파인튜닝 후보로 마킹한다."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        conv_id = store.save_conversation(
            session_key="test",
            user_msg="안녕하세요",
            assistant_msg="안녕하세요! 저는 타냐예요.",
        )

        updated = store.update_finetune_candidate([conv_id], value=1)

        assert updated == 1
        row = store._conn.execute(
            "SELECT is_finetune_candidate FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        assert row["is_finetune_candidate"] == 1

    def test_unmarks_candidate(self):
        """value=0으로 후보 해제한다."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        conv_id = store.save_conversation(
            session_key="test",
            user_msg="안녕하세요",
            assistant_msg="안녕하세요! 저는 타냐예요.",
        )
        store.update_finetune_candidate([conv_id], value=1)

        updated = store.update_finetune_candidate([conv_id], value=0)

        assert updated == 1
        row = store._conn.execute(
            "SELECT is_finetune_candidate FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        assert row["is_finetune_candidate"] == 0

    def test_marks_multiple_candidates(self):
        """여러 conv_id를 한 번에 마킹한다."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        ids = []
        for i in range(3):
            cid = store.save_conversation(
                session_key="test",
                user_msg=f"메시지 {i}",
                assistant_msg=f"응답 {i}",
            )
            ids.append(cid)

        updated = store.update_finetune_candidate(ids, value=1)

        assert updated == 3

    def test_empty_list_returns_zero(self):
        """빈 리스트 전달 시 0 반환."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        updated = store.update_finetune_candidate([], value=1)
        assert updated == 0

    def test_nonexistent_id_returns_zero(self):
        """존재하지 않는 id는 영향 없음."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        updated = store.update_finetune_candidate([9999], value=1)
        assert updated == 0


# ──────────────────────────────────────────────
# POST /feedback 엔드포인트 테스트
# ──────────────────────────────────────────────

def _make_test_client(store):
    """테스트용 FastAPI 앱 + store 주입."""
    from fastapi import FastAPI
    from routers.feedback import router as feedback_router

    app = FastAPI()
    app.include_router(feedback_router)
    app.state.memory_store = store

    return TestClient(app)


class TestFeedbackEndpoint:
    def _make_store_with_conversation(self, quality_score=0.5):
        """대화 1개가 저장된 MemoryStore 반환."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        conv_id = store.save_conversation(
            session_key="test",
            user_msg="오늘 날씨 어때?",
            assistant_msg="오늘은 맑고 따뜻한 날씨예요!",
        )
        if quality_score is not None:
            store.update_quality_score(conv_id, quality_score)
        return store, conv_id

    def test_thumbs_up_increases_score(self):
        """rating=up이면 quality_score가 상승하고 is_finetune_candidate=1."""
        store, conv_id = self._make_store_with_conversation(quality_score=0.5)
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": conv_id, "rating": "up"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["conv_id"] == conv_id
        assert body["new_score"] == pytest.approx(0.7, abs=1e-6)

        row = store._conn.execute(
            "SELECT quality_score, is_finetune_candidate FROM conversations WHERE id = ?",
            (conv_id,),
        ).fetchone()
        assert row["is_finetune_candidate"] == 1

    def test_thumbs_down_decreases_score(self):
        """rating=down이면 quality_score가 하락하고 is_finetune_candidate=0."""
        store, conv_id = self._make_store_with_conversation(quality_score=0.5)
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": conv_id, "rating": "down"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["new_score"] == pytest.approx(0.2, abs=1e-6)

        row = store._conn.execute(
            "SELECT is_finetune_candidate FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        assert row["is_finetune_candidate"] == 0

    def test_thumbs_up_clamped_at_one(self):
        """quality_score가 이미 높으면 1.0을 초과하지 않는다."""
        store, conv_id = self._make_store_with_conversation(quality_score=0.9)
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": conv_id, "rating": "up"})

        assert resp.status_code == 200
        assert resp.json()["new_score"] == pytest.approx(1.0, abs=1e-6)

    def test_thumbs_down_clamped_at_zero(self):
        """quality_score가 이미 낮으면 0.0 미만이 되지 않는다."""
        store, conv_id = self._make_store_with_conversation(quality_score=0.1)
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": conv_id, "rating": "down"})

        assert resp.status_code == 200
        assert resp.json()["new_score"] == pytest.approx(0.0, abs=1e-6)

    def test_null_score_uses_baseline(self):
        """quality_score가 NULL이면 baseline 0.5에서 조정 시작."""
        store, conv_id = self._make_store_with_conversation(quality_score=None)
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": conv_id, "rating": "up"})

        assert resp.status_code == 200
        assert resp.json()["new_score"] == pytest.approx(0.7, abs=1e-6)

    def test_not_found_returns_404(self):
        """존재하지 않는 conv_id이면 404 반환."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": 9999, "rating": "up"})

        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    def test_invalid_rating_returns_422(self):
        """잘못된 rating 값이면 422 반환."""
        from memory.store import MemoryStore

        store = MemoryStore(":memory:")
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": 1, "rating": "meh"})

        assert resp.status_code == 422

    def test_no_store_returns_503(self):
        """memory_store가 없으면 503 반환."""
        from fastapi import FastAPI
        from routers.feedback import router as feedback_router

        app = FastAPI()
        app.include_router(feedback_router)
        # memory_store 미주입

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post("/feedback", json={"conv_id": 1, "rating": "up"})

        assert resp.status_code == 503

    def test_response_schema(self):
        """응답이 ok, conv_id, new_score 필드를 포함한다."""
        store, conv_id = self._make_store_with_conversation(quality_score=0.5)
        client = _make_test_client(store)

        resp = client.post("/feedback", json={"conv_id": conv_id, "rating": "up"})

        body = resp.json()
        assert "ok" in body
        assert "conv_id" in body
        assert "new_score" in body
