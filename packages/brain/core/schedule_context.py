"""클라이언트 일정 스냅샷과 공개 웹 생성 일정 파싱 (T-013, T-024).

데스크톱은 Google을 직접 읽지 않고 Windows 자격 증명 저장소의 OAuth 경계를
유지한 채 클라이언트가 읽은 일정만 Brain에 보낸다. 공개 웹 데모에서는 Brain이
서버 데모 계정으로 실제 생성에 성공한 Calendar 항목만 같은 형식으로 반영한다.
"""

import logging
from datetime import datetime
from typing import Any

from core.proactive import ScheduleEvent

logger = logging.getLogger(__name__)


def _parse_datetime(value: Any) -> datetime | None:
    """ISO 8601 문자열을 naive local datetime으로 바꾼다.

    TriggerContext의 `now`가 `datetime.now()`(naive)라 비교하려면 맞춰야 한다.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.astimezone().replace(tzinfo=None) if parsed.tzinfo else parsed


def parse_schedule_events(raw: Any) -> list[ScheduleEvent]:
    """일정 배열을 ScheduleEvent 목록으로 바꾼다.

    깨진 항목은 건너뛰고 나머지를 살린다. 스냅샷 하나가 어긋났다고
    WebSocket 연결을 끊으면 대화까지 죽는다.
    """
    if not isinstance(raw, list):
        return []

    events: list[ScheduleEvent] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        event_id = item.get("id")
        title = item.get("title")
        starts_at = _parse_datetime(item.get("startsAt"))
        if not isinstance(event_id, str) or not event_id:
            continue
        if not isinstance(title, str) or not title.strip():
            continue
        if starts_at is None:
            continue
        events.append(
            ScheduleEvent(
                id=event_id,
                title=title.strip(),
                starts_at=starts_at,
                all_day=bool(item.get("allDay", False)),
            )
        )
    return events
