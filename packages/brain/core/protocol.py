"""Phase 3.4: Wire Protocol V2.

메시지 타입:
- RequestEnvelope  (id, type="req", action, payload)
- ResponseEnvelope (id, type="res", success, payload, error)
- EventEnvelope    (type="event", event, payload)

ProtocolHandler:
- 레거시(id 필드 없음) / V2(id 필드 있음) 자동 판별
- parse_request(), make_response(), make_error(), make_event() 팩토리
"""
from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Envelope 모델
# ---------------------------------------------------------------------------

class RequestEnvelope(BaseModel):
    """클라이언트 → 서버 요청."""
    id: str
    type: str = Field(default="req")
    action: str
    payload: dict[str, Any] = Field(default_factory=dict)
    auth_token: str | None = Field(default=None)


class ResponseEnvelope(BaseModel):
    """서버 → 클라이언트 응답 (요청-응답 ID 매칭)."""
    id: str
    type: str = Field(default="res")
    success: bool
    payload: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class EventEnvelope(BaseModel):
    """서버 → 클라이언트 Push 이벤트 (emotion_update, tts_ready, status 등)."""
    type: str = Field(default="event")
    event: str
    payload: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# ProtocolHandler
# ---------------------------------------------------------------------------

class ProtocolHandler:
    """레거시 / V2 프로토콜 자동 판별 + 메시지 생성 헬퍼."""

    def is_legacy(self, data: dict) -> bool:
        """id 필드가 없으면 레거시 프로토콜로 판단."""
        return "id" not in data

    def parse_request(self, data: dict) -> RequestEnvelope:
        return RequestEnvelope(**data)

    def make_response(
        self,
        request_id: str,
        success: bool,
        payload: dict[str, Any] | None = None,
    ) -> ResponseEnvelope:
        return ResponseEnvelope(
            id=request_id,
            success=success,
            payload=payload or {},
        )

    def make_error(self, request_id: str, error: str) -> ResponseEnvelope:
        return ResponseEnvelope(id=request_id, success=False, error=error)

    def make_event(self, event: str, payload: dict[str, Any] | None = None) -> EventEnvelope:
        return EventEnvelope(event=event, payload=payload or {})

    def make_approval_event(
        self, skill: str, reason: str, approval_token: str
    ) -> EventEnvelope:
        """approval_required Push 이벤트 생성."""
        return EventEnvelope(
            event="approval_required",
            payload={
                "skill": skill,
                "reason": reason,
                "approval_token": approval_token,
            },
        )

    def make_tts_chunk_event(
        self,
        chunk_index: int,
        data: str,
        is_last: bool,
        word_boundary: dict[str, Any] | None = None,
    ) -> EventEnvelope:
        """tts_chunk Push 이벤트 생성.

        Args:
            chunk_index: 청크 순서 번호 (순서 보장용)
            data: Base64 인코딩된 오디오 bytes
            is_last: 마지막 청크 여부
            word_boundary: WordBoundary 메타데이터 (선택)
        """
        payload: dict[str, Any] = {
            "chunk_index": chunk_index,
            "data": data,
            "is_last": is_last,
        }
        if word_boundary is not None:
            payload["word_boundary"] = word_boundary
        return EventEnvelope(event="tts_chunk", payload=payload)
