"""Phase 4-B: ApprovalStore — 위험 스킬 승인 토큰 관리.

- approval_token: UUID v4 기반 단기 토큰
- TTL: 기본 30초 (만료 후 consume 불가)
- 1회 사용 후 즉시 삭제 (replay attack 방지)
"""
from __future__ import annotations

import time
import uuid
from typing import Any


class ApprovalStore:
    """임시 승인 토큰 저장소.

    Parameters
    ----------
    ttl_seconds:
        토큰 유효 시간 (초). 기본 30초.
    """

    def __init__(self, ttl_seconds: int = 30) -> None:
        self._ttl = ttl_seconds
        self._tokens: dict[str, dict[str, Any]] = {}

    def create(self, skill: str, payload: dict[str, Any]) -> str:
        """승인 토큰을 생성한다."""
        token = str(uuid.uuid4())
        self._tokens[token] = {
            "skill": skill,
            "payload": payload,
            "expires_at": time.time() + self._ttl,
        }
        return token

    def consume(self, token: str) -> dict[str, Any] | None:
        """토큰을 소비하고 엔트리를 반환한다.

        만료됐거나 없으면 None.
        성공 시 저장소에서 즉시 삭제(1회 사용).
        """
        entry = self._tokens.get(token)
        if entry is None:
            return None
        if time.time() > entry["expires_at"]:
            del self._tokens[token]
            return None
        del self._tokens[token]
        return {"skill": entry["skill"], "payload": entry["payload"]}

    def cleanup(self) -> None:
        """만료된 토큰을 일괄 삭제한다."""
        now = time.time()
        expired = [t for t, e in self._tokens.items() if now > e["expires_at"]]
        for t in expired:
            del self._tokens[t]
