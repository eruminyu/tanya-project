"""T-017: 공개 배포용 요청 제한.

해커톤 심사를 위해 웹 체험판을 인터넷에 노출하면 다음 엔드포인트가 무인증으로 열린다.

    /ws/webchat          누구나 LLM 무제한 사용
    /stt/transcriptions  누구나 STT 사용 (10MB 업로드)
    /live2d_compat, /feedback

심사 기간에는 링크가 공개적으로 배포되므로 한도가 없으면 비용과 자원이 무한히 샌다.
인증을 걸 수는 없다 — 심사위원이 로그인할 수 없기 때문이다. 따라서 **인증 없이 총량을 제한**한다.

기본값은 꺼짐이다. 내부망·데스크톱 사용에는 필요 없고, 켜는 순간 정상 사용을 막을 위험이 있다.
"""

import time
from collections import deque
from dataclasses import dataclass, field

# 방문자 실제 IP를 담는 헤더. 프록시 뒤에서는 소켓 주소가 전부 프록시 IP다.
_IP_HEADERS = ("cf-connecting-ip", "x-real-ip", "x-forwarded-for")

_DAY_SECONDS = 86400.0
_MINUTE = 60.0
# 이 시간 이상 조용한 클라이언트는 잊는다. 공개 서비스는 IP가 무한히 들어온다.
_FORGET_AFTER = 600.0


def client_key(headers, socket_host: str | None) -> str:
    """요청의 실제 출발지를 식별한다.

    헤더 이름은 대소문자를 가리지 않는다. `X-Forwarded-For`는 쉼표로 이어지므로
    가장 앞(원 클라이언트)을 쓴다. 아무것도 없으면 소켓 주소, 그것도 없으면
    `unknown`으로 묶는다 — 키가 없다고 무제한이 되면 안 된다.
    """
    lowered = {str(k).lower(): v for k, v in dict(headers or {}).items()}
    for name in _IP_HEADERS:
        value = lowered.get(name)
        if value:
            first = str(value).split(",")[0].strip()
            if first:
                return first
    return (socket_host or "").strip() or "unknown"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    message: str = ""
    retry_after: int = 0


@dataclass
class _Client:
    hits: deque = field(default_factory=deque)
    connections: int = 0
    last_seen: float = 0.0


class RateLimiter:
    """슬라이딩 윈도우 요청 제한 + 일일 총량 + 동시 연결 수 제한.

    프로세스 안 메모리만 쓴다. Brain은 단일 인스턴스로 운영되므로 충분하고,
    외부 저장소 의존을 늘리지 않는다.
    """

    def __init__(
        self,
        per_minute: int = 30,
        daily_total: int = 2000,
        max_connections_per_client: int = 3,
        enabled: bool = True,
    ) -> None:
        self._per_minute = per_minute
        self._daily_total = daily_total
        self._max_connections = max_connections_per_client
        self._enabled = enabled
        self._clients: dict[str, _Client] = {}
        self._day_start: float | None = None
        self._day_count = 0

    # ── 요청 ──────────────────────────────────────────────────────────────────

    def check(self, key: str, now: float | None = None) -> Decision:
        if not self._enabled:
            return Decision(True)
        moment = time.monotonic() if now is None else now

        self._roll_day(moment)
        if self._day_count >= self._daily_total:
            return Decision(
                False,
                "오늘 체험판 한도를 모두 사용했어. 내일 다시 만나줘.",
                retry_after=int(self._day_start + _DAY_SECONDS - moment) if self._day_start else 3600,
            )

        client = self._clients.setdefault(key, _Client())
        client.last_seen = moment
        cutoff = moment - _MINUTE
        while client.hits and client.hits[0] <= cutoff:
            client.hits.popleft()

        if len(client.hits) >= self._per_minute:
            retry = int(client.hits[0] + _MINUTE - moment) + 1
            return Decision(False, "요청이 너무 빨라. 잠시 뒤에 다시 시도해줘.", retry_after=max(retry, 1))

        client.hits.append(moment)
        self._day_count += 1
        self._forget_idle(moment)
        return Decision(True)

    # ── 동시 연결 ─────────────────────────────────────────────────────────────

    def acquire_connection(self, key: str) -> bool:
        if not self._enabled:
            return True
        client = self._clients.setdefault(key, _Client())
        if client.connections >= self._max_connections:
            return False
        client.connections += 1
        client.last_seen = time.monotonic()
        return True

    def release_connection(self, key: str) -> None:
        client = self._clients.get(key)
        if client is None:
            return
        client.connections = max(0, client.connections - 1)

    # ── 내부 ──────────────────────────────────────────────────────────────────

    def tracked_clients(self) -> int:
        return len(self._clients)

    def _roll_day(self, now: float) -> None:
        if self._day_start is None or now - self._day_start >= _DAY_SECONDS:
            self._day_start = now
            self._day_count = 0

    def _forget_idle(self, now: float) -> None:
        """오래 조용한 클라이언트를 버린다. 연결이 남아 있으면 남긴다."""
        stale = [
            key for key, c in self._clients.items()
            if c.connections == 0 and now - c.last_seen > _FORGET_AFTER
        ]
        for key in stale:
            del self._clients[key]
