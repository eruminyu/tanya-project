"""Phase 7-A: 파인튜닝 데이터 품질 필터.

짧은 대화, fallback 응답, 낮은 품질 점수를 가진 행을 제거한다.
"""
from __future__ import annotations

_FALLBACK_MARKER = "잠깐, 생각을 정리 중이야"
_MIN_MSG_LEN = 10
_MIN_QUALITY = 0.3


class FineTuneFilter:
    """파인튜닝 후보 대화에서 저품질 행을 걸러낸다."""

    def apply(self, conversations: list[dict]) -> list[dict]:
        """제외 조건에 해당하지 않는 대화만 반환.

        제외 조건:
        - user_msg 또는 assistant_msg 길이 < 10자
        - assistant_msg에 fallback 마커 포함
        - quality_score가 None 또는 0.3 미만
        """
        result = []
        for conv in conversations:
            if len(conv.get("user_msg", "")) < _MIN_MSG_LEN:
                continue
            if len(conv.get("assistant_msg", "")) < _MIN_MSG_LEN:
                continue
            if _FALLBACK_MARKER in conv.get("assistant_msg", ""):
                continue
            score = conv.get("quality_score")
            if score is None or score < _MIN_QUALITY:
                continue
            result.append(conv)
        return result

    def filter_stats(self, before: int, after: int) -> dict:
        """필터링 전후 통계를 반환한다."""
        removed = before - after
        removal_rate = (removed / before) if before > 0 else 0.0
        return {
            "before": before,
            "after": after,
            "removed": removed,
            "removal_rate": removal_rate,
        }
