"""T-015: 선제 제안 수락을 초안으로 잇는다.

선제 발화("3시에 회의 있어. 준비할 시간 잡아둘까?")에 사용자가 "그래"라고 답해도
`action/google_write_draft.py`의 `_WRITE_HINT`가 동사+명사를 요구하기 때문에
초안이 만들어지지 않았다. 수락 답변에는 일정 정보가 없기 때문이다.

해결은 **문맥을 채널이 기억하는 것**이다. 제안을 보낼 때 대상 일정을 함께 붙들어 두고,
바로 다음 사용자 메시지가 수락이면 **LLM을 거치지 않고** 초안을 조립한다.
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

# 제안이 유효한 시간. 이보다 오래되면 사용자가 다른 이야기를 하고 있다고 본다.
OFFER_TTL = timedelta(minutes=15)

# 준비 일정의 기본 길이.
PREPARATION_MINUTES = 30

# 수락으로 인정하는 표현. **완전일치**로만 판정한다.
# 부분일치를 허용하면 "그래서", "응답해줘" 같은 일반 대화가 초안을 만든다.
ACCEPT_WORDS = frozenset({
    "그래", "응", "어", "네", "예", "좋아", "좋아요", "부탁해", "부탁해요",
    "ㅇㅇ", "ㅇㅋ", "오케이", "해줘", "그래줘", "그렇게 해줘", "그래 부탁해",
    "응 좋아", "그래 좋아", "잡아줘", "만들어줘",
})

_TRIM = re.compile(r"[\s.!?~,]+")


def is_acceptance(text: str) -> bool:
    """제안을 받아들이는 답변인지 판정한다. 완전일치만 인정한다."""
    normalized = _TRIM.sub(" ", (text or "")).strip()
    return bool(normalized) and normalized in ACCEPT_WORDS


@dataclass(frozen=True)
class PendingOffer:
    """방금 보낸 선제 제안이 가리키는 일정."""

    event_id: str
    title: str
    starts_at: datetime
    created_at: datetime

    def is_alive(self, now: datetime) -> bool:
        return now - self.created_at <= OFFER_TTL


def build_preparation_draft(offer: PendingOffer, now: datetime) -> dict:
    """준비 일정 초안을 조립한다.

    클라이언트(`brain.ts`)는 `end > start`가 거짓이면 **오류 없이 조용히 버린다.**
    조용한 실패는 원인 규명이 불가능하므로 여기서 불변식을 보장한다.
    """
    end = offer.starts_at
    start = end - timedelta(minutes=PREPARATION_MINUTES)

    if start < now:
        # 일정이 코앞이면 시작이 과거로 잡히므로 지금부터로 민다.
        # `start == now`는 과거가 아니므로 그대로 둔다.
        start = now + timedelta(minutes=1)
        end = start + timedelta(minutes=PREPARATION_MINUTES)

    if end <= start:  # 방어 — 어떤 경로로도 불변식을 깨지 않는다.
        end = start + timedelta(minutes=PREPARATION_MINUTES)

    return {
        "kind": "calendar",
        "title": f"{offer.title} 준비",
        "startAt": _rfc3339(start),
        "endAt": _rfc3339(end),
    }


def _rfc3339(value: datetime) -> str:
    """오프셋을 포함한 문자열로 만든다. 없으면 클라이언트가 시간대를 잘못 읽는다."""
    aware = value if value.tzinfo else value.astimezone()
    return aware.isoformat()
