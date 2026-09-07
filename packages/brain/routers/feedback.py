"""피드백 API — 사용자 명시적 평가(👍/👎) 처리."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()

_UP_DELTA = 0.2
_DOWN_DELTA = 0.3
_BASELINE_SCORE = 0.5


class FeedbackRequest(BaseModel):
    conv_id: int
    rating: Literal["up", "down"]


class FeedbackResponse(BaseModel):
    ok: bool
    conv_id: int
    new_score: float


@router.post("/feedback", response_model=FeedbackResponse)
async def post_feedback(req: Request, body: FeedbackRequest):
    """대화에 대한 명시적 평가를 기록한다.

    - up: quality_score + 0.2, is_finetune_candidate = 1
    - down: quality_score - 0.3, is_finetune_candidate = 0
    """
    store = getattr(req.app.state, "memory_store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="memory store not available")

    row = store._conn.execute(
        "SELECT id, quality_score FROM conversations WHERE id = ?",
        (body.conv_id,),
    ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="conversation not found")

    current = row["quality_score"] if row["quality_score"] is not None else _BASELINE_SCORE

    if body.rating == "up":
        new_score = min(current + _UP_DELTA, 1.0)
        candidate_value = 1
    else:
        new_score = max(current - _DOWN_DELTA, 0.0)
        candidate_value = 0

    store.update_quality_score(body.conv_id, new_score)
    store.update_finetune_candidate([body.conv_id], value=candidate_value)

    return FeedbackResponse(ok=True, conv_id=body.conv_id, new_score=new_score)
