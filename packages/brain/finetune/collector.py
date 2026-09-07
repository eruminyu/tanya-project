"""Phase 7-A: 파인튜닝 데이터 수집기.

MemoryStore에서 quality_score와 is_finetune_candidate 기준으로
학습 대상 대화를 추출한다.
"""
from __future__ import annotations


class FineTuneCollector:
    """SQLite conversations 테이블에서 파인튜닝 후보 대화를 수집한다."""

    def __init__(self, store) -> None:
        """
        Args:
            store: MemoryStore 인스턴스 (또는 동일 인터페이스를 제공하는 스텁).
                   내부 `_conn` sqlite3.Connection을 직접 사용한다.
        """
        self._store = store

    # ------------------------------------------------------------------
    # 수집
    # ------------------------------------------------------------------

    def collect(
        self,
        min_quality: float = 0.5,
        limit: int = 1000,
    ) -> list[dict]:
        """quality_score >= min_quality AND is_finetune_candidate = 1 인 대화 반환.

        Args:
            min_quality: 최소 품질 점수 (기본 0.5)
            limit: 최대 반환 건수 (기본 1000)

        Returns:
            대화 dict 리스트 (각 행은 conversations 테이블 컬럼 포함)
        """
        rows = self._store._conn.execute(
            """
            SELECT * FROM conversations
            WHERE is_finetune_candidate = 1
              AND quality_score IS NOT NULL
              AND quality_score >= ?
            ORDER BY quality_score DESC
            LIMIT ?
            """,
            (min_quality, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------
    # 후보 마킹
    # ------------------------------------------------------------------

    def mark_candidates(self, conv_ids: list[int]) -> int:
        """주어진 ID 목록의 is_finetune_candidate를 1로 설정한다.

        Args:
            conv_ids: 마킹할 conversations.id 목록

        Returns:
            실제 업데이트된 행 수
        """
        if not conv_ids:
            return 0
        placeholders = ",".join("?" * len(conv_ids))
        cur = self._store._conn.execute(
            f"UPDATE conversations SET is_finetune_candidate = 1 WHERE id IN ({placeholders})",
            conv_ids,
        )
        self._store._conn.commit()
        return cur.rowcount

    # ------------------------------------------------------------------
    # 통계
    # ------------------------------------------------------------------

    def stats(self) -> dict:
        """수집 현황 통계를 반환한다.

        Returns:
            {
                "total_conversations": int,
                "candidate_count": int,
                "avg_quality_score": float | None,
            }
        """
        conn = self._store._conn

        total = conn.execute(
            "SELECT COUNT(*) FROM conversations"
        ).fetchone()[0]

        candidate_count = conn.execute(
            "SELECT COUNT(*) FROM conversations WHERE is_finetune_candidate = 1"
        ).fetchone()[0]

        avg_row = conn.execute(
            "SELECT AVG(quality_score) FROM conversations WHERE quality_score IS NOT NULL"
        ).fetchone()[0]

        return {
            "total_conversations": total,
            "candidate_count": candidate_count,
            "avg_quality_score": avg_row,
        }
