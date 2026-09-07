"""Phase 3.2: 장기 기억 통합 모듈.

LongTermMemory:
- 기억 저장: 임베딩 생성 + memories / memories_vec / memories_fts 동시 INSERT
- Hybrid Search: 벡터 유사도 70% + BM25 FTS5 30% 가중 합산
- Temporal Decay: score × e^(-λ × age_days), λ = ln(2)/30 (반감기 30일)
- Importance 가중치: score × (0.5 + importance × 0.5)
- 사용자 프로필 KV 스토어 (MemoryStore 위임)
"""
from __future__ import annotations

import math
import struct
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from core.schemas import MemoryRecord
from memory.store import MemoryStore

if TYPE_CHECKING:
    from memory.embeddings import EmbeddingProvider

# λ = ln(2) / 30  →  반감기 30일
_DECAY_LAMBDA = math.log(2) / 30


class LongTermMemory:
    """장기 기억 통합 클래스.

    Parameters
    ----------
    store:
        MemoryStore 인스턴스 (SQLite + sqlite-vec + FTS5).
    embedding_provider:
        EmbeddingProvider 인스턴스 (384차원 권장).
    vector_weight:
        Hybrid Search에서 벡터 점수 비중 (기본 0.7).
    fts_weight:
        Hybrid Search에서 FTS5 점수 비중 (기본 0.3).
    """

    def __init__(
        self,
        store: MemoryStore,
        embedding_provider: EmbeddingProvider,
        vector_weight: float = 0.7,
        fts_weight: float = 0.3,
    ) -> None:
        self._store = store
        self._emb = embedding_provider
        self._vw = vector_weight
        self._fw = fts_weight

    # ------------------------------------------------------------------
    # 기억 저장
    # ------------------------------------------------------------------

    async def save_memory(
        self,
        content: str,
        category: str = "episodic",
        importance: float = 0.5,
        source_turn_ids: str | None = None,
    ) -> int:
        """기억을 저장하고 임베딩 벡터를 vec 테이블에 동기화한다."""
        # 1) memories + FTS5 INSERT (MemoryStore 처리)
        mem_id = self._store.save_memory(
            content=content,
            category=category,
            importance=importance,
            source_turn_ids=source_turn_ids,
        )

        # 2) 임베딩 생성
        vec = await self._emb.embed(content)

        # 3) memories_vec INSERT
        self._store._conn.execute(
            "INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)",
            (mem_id, _serialize_f32(vec)),
        )
        self._store._conn.commit()

        return mem_id

    # ------------------------------------------------------------------
    # Hybrid Search
    # ------------------------------------------------------------------

    async def search(
        self,
        query: str,
        top_k: int = 5,
        category: str | None = None,
    ) -> list[MemoryRecord]:
        """Hybrid Search: 벡터 유사도 × 0.7 + BM25 FTS5 × 0.3 + Temporal Decay + Importance."""
        query_vec = await self._emb.embed(query)

        # --- 벡터 유사도 검색 ---
        vec_scores: dict[int, float] = {}
        try:
            rows = self._store._conn.execute(
                """
                SELECT rowid, distance
                FROM memories_vec
                WHERE embedding MATCH ?
                ORDER BY distance
                LIMIT ?
                """,
                (_serialize_f32(query_vec), top_k * 3),
            ).fetchall()

            if rows:
                # distance → 유사도 (L2 거리를 0~1 점수로 변환)
                max_dist = max(r[1] for r in rows) or 1.0
                for r in rows:
                    vec_scores[r[0]] = 1.0 - (r[1] / max_dist)
        except Exception:
            pass  # vec 테이블 없거나 빈 경우 패스

        # --- FTS5 BM25 검색 ---
        fts_scores: dict[int, float] = {}
        try:
            # FTS5 bm25()는 음수 — 절댓값이 클수록 관련도 높음
            fts_rows = self._store._conn.execute(
                """
                SELECT rowid, bm25(memories_fts) AS score
                FROM memories_fts
                WHERE memories_fts MATCH ?
                ORDER BY score
                LIMIT ?
                """,
                (query, top_k * 3),
            ).fetchall()

            if fts_rows:
                max_abs = max(abs(r[1]) for r in fts_rows) or 1.0
                for r in fts_rows:
                    fts_scores[r[0]] = abs(r[1]) / max_abs
        except Exception:
            pass

        # --- 후보 통합 ---
        candidates = set(vec_scores.keys()) | set(fts_scores.keys())
        if not candidates:
            return []

        # memories 전체 조회 (후보 id 목록으로 필터)
        placeholders = ",".join("?" * len(candidates))
        mem_rows = self._store._conn.execute(
            f"SELECT * FROM memories WHERE id IN ({placeholders})",
            tuple(candidates),
        ).fetchall()

        now = datetime.now(timezone.utc)
        scored: list[tuple[float, dict]] = []

        for row in mem_rows:
            mem = dict(row)

            # 카테고리 필터
            if category is not None and mem["category"] != category:
                continue

            mid = mem["id"]
            v_score = vec_scores.get(mid, 0.0)
            f_score = fts_scores.get(mid, 0.0)
            hybrid = self._vw * v_score + self._fw * f_score

            # Temporal Decay
            try:
                created = datetime.fromisoformat(mem["created_at"])
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                age_days = (now - created).total_seconds() / 86400
            except Exception:
                age_days = 0.0

            decay = self._decay_factor(age_days)

            # Importance 가중치
            importance = mem.get("importance", 0.5)
            importance_weight = 0.5 + importance * 0.5

            final = hybrid * decay * importance_weight
            scored.append((final, mem))

        # 정렬 후 top_k
        scored.sort(key=lambda x: x[0], reverse=True)
        top = scored[:top_k]

        # 점수 정규화 (0~1)
        max_score = top[0][0] if top else 1.0
        if max_score == 0.0:
            max_score = 1.0

        return [
            MemoryRecord(
                id=mem["id"],
                content=mem["content"],
                category=mem["category"],
                importance=mem.get("importance", 0.5),
                created_at=mem["created_at"],
                relevance_score=min(score / max_score, 1.0),
            )
            for score, mem in top
        ]

    # ------------------------------------------------------------------
    # Temporal Decay 헬퍼
    # ------------------------------------------------------------------

    def _decay_factor(self, age_days: float) -> float:
        """score × e^(-λ × age_days), λ = ln(2)/30."""
        return math.exp(-_DECAY_LAMBDA * age_days)

    # ------------------------------------------------------------------
    # 사용자 프로필 (MemoryStore 위임)
    # ------------------------------------------------------------------

    def set_profile(self, key: str, value: str) -> None:
        self._store.set_profile(key, value)

    def get_profile(self, key: str) -> str | None:
        return self._store.get_profile(key)

    def get_all_profile(self) -> dict[str, str]:
        return self._store.get_all_profile()


# ---------------------------------------------------------------------------
# 내부 유틸리티
# ---------------------------------------------------------------------------

def _serialize_f32(vector: list[float]) -> bytes:
    """float32 리스트를 little-endian bytes로 직렬화 (sqlite-vec 호환)."""
    return struct.pack(f"{len(vector)}f", *vector)
