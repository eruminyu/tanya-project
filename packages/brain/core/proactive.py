"""Phase 9-A: 자발적 말걸기 — TriggerRule ABC + ProactiveTriggerScheduler.

타냐가 사용자의 호출 없이 스스로 먼저 말을 거는 기능의 핵심 구조.
- TriggerContext: 규칙 평가에 필요한 상황 정보
- TriggerRule ABC: 개별 트리거 규칙 인터페이스
- ProactiveTriggerScheduler: 규칙 평가 + 발화 생성 + WebSocket 전송
"""

import asyncio
import logging
import sqlite3
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Callable, Awaitable

logger = logging.getLogger(__name__)


# ── TriggerContext ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScheduleEvent:
    """클라이언트가 밀어 넣은 오늘 일정 한 건 (T-013).

    Brain은 Google을 직접 호출하지 않는다. OAuth 토큰은 Windows 자격 증명
    저장소에 있고 그 경계를 넘지 않는다.
    """

    id: str
    title: str
    starts_at: datetime
    all_day: bool


@dataclass
class TriggerContext:
    """트리거 규칙 평가에 필요한 현재 상태 스냅샷."""

    now: datetime
    last_conversation_at: datetime | None
    session_start_at: datetime
    daily_fire_count: int
    hour_of_day: int
    total_conversations: int = 0
    # 기본값을 주므로 기존 규칙 8종과 그 테스트는 바뀌지 않는다.
    events: list["ScheduleEvent"] = field(default_factory=list)
    schedule_fetched_at: datetime | None = None


# ── TriggerRule ABC ────────────────────────────────────────────────────────────

class TriggerRule(ABC):
    """개별 트리거 규칙 추상 클래스.

    구상 클래스는 rule_name, cooldown_hours를 클래스 속성으로 정의하고
    should_fire / get_prompt를 구현해야 한다.
    """

    rule_name: str
    cooldown_hours: int

    @abstractmethod
    def should_fire(self, ctx: TriggerContext) -> bool:
        """현재 TriggerContext 기준으로 발동 여부를 반환한다."""
        ...

    @abstractmethod
    def get_prompt(self, ctx: TriggerContext) -> str:
        """LLM에 전달할 발화 생성 지시 프롬프트를 반환한다."""
        ...

    def offer_meta(self, ctx: TriggerContext) -> dict:
        """발화와 함께 채널에 넘길 문맥 (T-015).

        수락 답변("그래")에는 일정 정보가 없다. 무엇을 수락한 것인지
        채널이 기억할 수 있도록 대상을 함께 넘긴다. 기본은 문맥 없음이다.
        """
        return {}

    def fire_key(self, ctx: TriggerContext) -> str:
        """쿨다운을 기록·조회할 키. 기본은 규칙 단위다.

        같은 대상으로 두 번 말하면 안 되는 규칙은 대상별 키를 반환한다
        (예: `upcoming_event:{event_id}`). `proactive_cooldowns`의 PK가
        TEXT라 스키마 변경 없이 들어간다.
        """
        return self.rule_name


# ── ProactiveTriggerScheduler ──────────────────────────────────────────────────

SendFn = Callable[[str, dict], Awaitable[None]]

# 이보다 오래된 일정 스냅샷은 쓰지 않는다. 클라이언트 전송 주기(15분)의 두 배.
SCHEDULE_MAX_AGE = timedelta(minutes=30)
# 재연결은 잠시 보존하되 공개 웹의 UUID 세션이 프로세스 수명 동안 쌓이지 않게 한다.
SESSION_STATE_RETENTION = timedelta(minutes=30)
MAX_DISCONNECTED_SESSION_STATES = 256


@dataclass
class _SessionState:
    """A proactive scheduler snapshot owned by exactly one channel session."""

    last_conversation_at: datetime | None = None
    session_start_at: datetime = field(default_factory=datetime.now)
    daily_count: int = 0
    daily_count_date: datetime | None = None
    schedule_events: list[ScheduleEvent] = field(default_factory=list)
    schedule_fetched_at: datetime | None = None
    disconnected_at: datetime | None = None
    evaluation_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class ProactiveTriggerScheduler:
    """등록된 TriggerRule들을 주기적으로 평가해 타냐의 자발적 발화를 생성한다.

    발동 정책:
    - WebSocket send_fn이 등록된(연결된) 상태에서만 발동
    - 야간 quiet_hours(기본 새벽 2~7시) 발동 금지
    - 하루 최대 발화 횟수(max_daily_fires) 초과 금지
    - 규칙별 cooldown_hours 이내 재발동 금지
    - 한 루프에서 최대 1개 규칙만 발동
    """

    def __init__(
        self,
        rules: list[TriggerRule],
        llm,
        persona_prompt: str,
        max_daily_fires: int = 5,
        quiet_start_hour: int = 2,
        quiet_end_hour: int = 7,
        check_interval_seconds: float = 60.0,
        db_path: str = ":memory:",
    ) -> None:
        self._rules = rules
        self._llm = llm
        self._persona_prompt = persona_prompt
        self._max_daily_fires = max_daily_fires
        self._quiet_start = quiet_start_hour
        self._quiet_end = quiet_end_hour
        self._interval = check_interval_seconds
        self._db_path = db_path

        # 연결 상태: session_key → send_fn
        self._connections: dict[str, SendFn] = {}

        # 쿨다운 기록: rule_name → last_fired_at (in-memory cache + DB 영속화)
        self._last_fired: dict[str, datetime] = {}

        # 대화/일정/일일 한도는 연결별로 분리한다. 빈 키는 기존 직접 호출과
        # 단위 테스트가 사용하던 기본 세션을 보존하기 위한 호환 경로다.
        self._session_states: dict[str, _SessionState] = {"": _SessionState()}

        self._task: asyncio.Task | None = None

        # DB 연결 유지 (특히 :memory: 공유를 위해 인스턴스 연결 보관)
        self._db_conn: sqlite3.Connection = sqlite3.connect(self._db_path)
        # DB 초기화 + 기존 쿨다운 로드
        self._init_db()
        self._load_cooldowns_from_db()

        # 총 대화 수 조회용 MemoryStore (옵셔널)
        self._store = None

    # ── 연결 관리 ─────────────────────────────────────────────────────────────

    def set_connection(self, send_fn: SendFn, session_key: str) -> None:
        """WebSocket 연결 등록. 이 이후부터 발동 가능."""
        self._prune_session_states()
        self._connections[session_key] = send_fn
        state = self._session_state(session_key)
        state.session_start_at = datetime.now()
        state.disconnected_at = None

    def clear_connection(
        self, session_key: str, send_fn: SendFn | None = None
    ) -> None:
        """WebSocket 해제. 짧은 재연결 상태만 제한적으로 보존한다."""
        current = self._connections.get(session_key)
        # 같은 stable session id로 새 소켓이 먼저 등록된 경우, 늦게 끝난 이전
        # 소켓의 finally가 새 연결을 지우면 안 된다.
        if send_fn is not None and current is not send_fn:
            return
        self._connections.pop(session_key, None)
        state = self._session_states.get(session_key)
        if state is not None:
            state.disconnected_at = datetime.now()
        self._prune_session_states()

    @property
    def is_connected(self) -> bool:
        return bool(self._connections)

    def update_schedule(
        self,
        events: list[ScheduleEvent],
        fetched_at: datetime,
        session_key: str | None = None,
    ) -> None:
        """클라이언트가 보낸 일정 스냅샷으로 교체한다. 누적하지 않는다 (T-013).

        누적하면 취소된 일정이 남아 없는 약속으로 말을 걸게 된다.
        """
        state = self._session_state(self._resolve_session_key(session_key))
        state.schedule_events = list(events)
        state.schedule_fetched_at = fetched_at

    def upsert_schedule_event(
        self,
        event: ScheduleEvent,
        fetched_at: datetime,
        session_key: str | None = None,
    ) -> None:
        """실제 생성이 확인된 일정 한 건을 현재 스냅샷에 추가하거나 교체한다.

        전체 스냅샷 교체와 달리 공개 웹의 생성 직후 경로에는 방금 만든 한 건만
        있으므로, 다른 일정은 보존하고 동일한 provider id만 교체한다.
        """
        state = self._session_state(self._resolve_session_key(session_key))
        current_events = (
            state.schedule_events if self._schedule_is_fresh(fetched_at, state) else []
        )
        state.schedule_events = [
            existing for existing in current_events if existing.id != event.id
        ]
        state.schedule_events.append(event)
        state.schedule_fetched_at = fetched_at

    def update_last_conversation(self, session_key: str | None = None) -> None:
        """대화가 발생할 때마다 채널에서 호출해 마지막 대화 시각을 갱신."""
        state = self._session_state(self._resolve_session_key(session_key))
        state.last_conversation_at = datetime.now()

    def set_memory_store(self, store) -> None:
        """총 대화 수 조회를 위한 MemoryStore를 주입한다."""
        self._store = store

    # ── 스케줄러 생명주기 ──────────────────────────────────────────────────────

    async def start(self) -> None:
        """백그라운드 평가 루프를 시작한다."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        """백그라운드 루프를 정리한다."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _run_loop(self) -> None:
        """연결된 각 세션의 문맥만 사용해 주기적으로 규칙을 평가한다."""
        while True:
            try:
                for session_key in list(self._connections):
                    ctx = self._build_context(session_key)
                    await self._evaluate(ctx, session_key=session_key)
            except Exception as e:
                logger.error(f"ProactiveTriggerScheduler 루프 오류: {e}")
            await asyncio.sleep(self._interval)

    # ── 평가 로직 ──────────────────────────────────────────────────────────────

    async def _evaluate(
        self, ctx: TriggerContext, session_key: str | None = None
    ) -> bool:
        """규칙들을 평가하고 조건 충족 시 발화를 생성·전송한다.

        Returns:
            True if a trigger fired, False otherwise.
        """
        return await self._evaluate_rules(ctx, self._rules, session_key=session_key)

    async def evaluate_rule_now(
        self,
        rule_name: str,
        session_key: str | None = None,
        event_id: str | None = None,
    ) -> bool:
        """현재 문맥에서 이름이 일치하는 규칙만 즉시 평가한다.

        연결, quiet hours, 일일 한도, 쿨다운은 주기 평가와 똑같이 적용한다.
        event_id가 있으면 방금 생성된 그 일정만 규칙 문맥에 남긴다.
        """
        rules = [rule for rule in self._rules if rule.rule_name == rule_name]
        if not rules:
            return False
        resolved_key = self._resolve_session_key(session_key)
        ctx = self._build_context(resolved_key)
        if event_id is not None:
            target = next((event for event in ctx.events if event.id == event_id), None)
            if target is None:
                return False
            ctx = replace(ctx, events=[target])
        return await self._evaluate_rules(ctx, rules, session_key=resolved_key)

    async def _evaluate_rules(
        self,
        ctx: TriggerContext,
        rules: list[TriggerRule],
        session_key: str | None = None,
    ) -> bool:
        """주기 평가와 즉시 평가가 공유하는 정책 및 발화 실행 경로."""
        resolved_key = self._resolve_session_key(session_key)
        state = self._session_state(resolved_key)

        # 쿨다운 확인부터 기록까지 한 세션의 임계 구역으로 묶는다. LLM 호출이
        # await를 포함해도 같은 세션의 동시 평가가 중복 발화를 통과할 수 없다.
        async with state.evaluation_lock:
            if self._connections.get(resolved_key) is None:
                return False

            if self._is_quiet_hour(ctx.hour_of_day):
                return False

            self._reset_daily_count_if_new_day(ctx.now, state)
            if max(ctx.daily_fire_count, state.daily_count) >= self._max_daily_fires:
                return False

            for rule in rules:
                # should_fire를 먼저 본다. fire_key가 대상에 따라 달라지는 규칙이 있다.
                if not rule.should_fire(ctx):
                    continue
                fire_key = rule.fire_key(ctx)
                if not self._is_cooled_down(
                    fire_key, rule, session_key=resolved_key
                ):
                    continue

                prompt = rule.get_prompt(ctx)
                try:
                    # ADR-0007: 분류를 거치지 않고 일상 모드(로컬)로 고정한다.
                    text = await self._llm.chat_casual(
                        user_input=prompt,
                        system_prompt=self._persona_prompt,
                        history=[],
                    )
                except Exception as e:
                    logger.error(f"Proactive LLM 호출 실패 ({rule.rule_name}): {e}")
                    continue

                # LLM await 중 같은 stable session id가 재연결될 수 있다. 최초에
                # 잡아 둔 닫힌 소켓이 아니라 현재 등록된 최신 연결로 보낸다.
                current_send_fn = self._connections.get(resolved_key)
                if current_send_fn is None:
                    return False
                try:
                    await current_send_fn(text, rule.offer_meta(ctx))
                except Exception as e:
                    logger.error(f"Proactive 전송 실패: {e}")

                # 전송 오류도 시도한 발화로 센다. 그렇지 않으면 닫힌 연결 하나가
                # 매 평가마다 LLM 호출과 전송을 반복하는 재시도 폭주를 만든다.
                self._record_fire(fire_key, session_key=resolved_key)
                state.daily_count += 1
                return True

        return False

    def _build_context(self, session_key: str | None = None) -> TriggerContext:
        """현재 상태로 TriggerContext를 빌드한다."""
        resolved_key = self._resolve_session_key(session_key)
        state = self._session_state(resolved_key)
        now = datetime.now()
        self._reset_daily_count_if_new_day(now, state)
        return TriggerContext(
            now=now,
            last_conversation_at=state.last_conversation_at,
            session_start_at=state.session_start_at,
            daily_fire_count=state.daily_count,
            hour_of_day=now.hour,
            total_conversations=self._get_total_conversations(resolved_key),
            events=self._fresh_schedule_events(now, state),
            schedule_fetched_at=self._fresh_schedule_fetched_at(now, state),
        )

    def _schedule_is_fresh(self, now: datetime, state: _SessionState) -> bool:
        """스냅샷이 오래되면 버린다. 클라이언트가 죽은 뒤 옛 일정으로 말을 걸지 않도록."""
        if state.schedule_fetched_at is None:
            return False
        return now - state.schedule_fetched_at < SCHEDULE_MAX_AGE

    def _fresh_schedule_events(
        self, now: datetime, state: _SessionState
    ) -> list[ScheduleEvent]:
        return list(state.schedule_events) if self._schedule_is_fresh(now, state) else []

    def _fresh_schedule_fetched_at(
        self, now: datetime, state: _SessionState
    ) -> datetime | None:
        return state.schedule_fetched_at if self._schedule_is_fresh(now, state) else None

    def _get_total_conversations(self, session_key: str = "") -> int:
        """MemoryStore에서 제품 전체 누적 대화 수를 조회한다.

        AchievementRule은 원래 타냐와 나눈 전체 누적 마일스톤을 축하한다.
        현재 Orchestrator 저장 계약도 모든 채널을 ``session_key='default'``로
        기록하므로 proactive transport session으로 필터링하면 항상 0이 된다.
        ``session_key``는 다른 proactive 상태 격리에만 쓰고 이 집계는 전역이다.
        """
        if self._store is None:
            return 0
        try:
            row = self._store._conn.execute(
                "SELECT COUNT(*) FROM conversations"
            ).fetchone()
            return row[0] if row else 0
        except Exception:
            return 0

    def _reset_daily_count_if_new_day(
        self, now: datetime, state: _SessionState
    ) -> None:
        today = now.date()
        if state.daily_count_date is None or state.daily_count_date.date() != today:
            state.daily_count = 0
            state.daily_count_date = now

    def _resolve_session_key(self, session_key: str | None) -> str:
        """기존 무인자 호출은 연결이 하나일 때 그 세션으로 해석한다."""
        if session_key is not None:
            return session_key
        if len(self._connections) == 1:
            return next(iter(self._connections))
        return ""

    def _session_state(self, session_key: str) -> _SessionState:
        return self._session_states.setdefault(session_key, _SessionState())

    def _prune_session_states(self, now: datetime | None = None) -> None:
        """끊긴 세션을 TTL/LRU로 정리하되 활성 평가와 짧은 재연결은 보존한다."""
        now = now or datetime.now()
        disconnected: list[tuple[str, _SessionState]] = []
        for session_key, state in list(self._session_states.items()):
            if (
                not session_key
                or session_key in self._connections
                or state.disconnected_at is None
                or state.evaluation_lock.locked()
            ):
                continue
            if now - state.disconnected_at >= SESSION_STATE_RETENTION:
                self._session_states.pop(session_key, None)
                continue
            disconnected.append((session_key, state))

        excess = len(disconnected) - MAX_DISCONNECTED_SESSION_STATES
        if excess <= 0:
            return
        disconnected.sort(key=lambda item: item[1].disconnected_at or now)
        for session_key, _state in disconnected[:excess]:
            self._session_states.pop(session_key, None)

    @staticmethod
    def _cooldown_storage_key(session_key: str, fire_key: str) -> str:
        # 빈 세션의 기존 DB 키는 그대로 읽을 수 있게 유지한다.
        return fire_key if not session_key else f"{session_key}::{fire_key}"

    # ── 정책 헬퍼 ─────────────────────────────────────────────────────────────

    def _is_quiet_hour(self, hour: int) -> bool:
        """야간 조용 모드(quiet_start ~ quiet_end-1시) 여부."""
        return self._quiet_start <= hour < self._quiet_end

    def _is_cooled_down(
        self,
        fire_key: str,
        rule: "TriggerRule | None" = None,
        session_key: str | None = None,
    ) -> bool:
        """쿨다운이 끝났으면 True (발동 가능), 아직 쿨다운 중이면 False."""
        resolved_key = self._resolve_session_key(session_key)
        storage_key = self._cooldown_storage_key(resolved_key, fire_key)
        last = self._last_fired.get(storage_key)
        if last is None:
            return True
        if rule is None:
            rule = next((r for r in self._rules if r.rule_name == fire_key), None)
        if rule is None:
            return True
        return datetime.now() - last >= timedelta(hours=rule.cooldown_hours)

    def _record_fire(
        self, rule_name: str, session_key: str | None = None
    ) -> None:
        """발동 시각을 in-memory와 DB에 기록한다."""
        resolved_key = self._resolve_session_key(session_key)
        storage_key = self._cooldown_storage_key(resolved_key, rule_name)
        now = datetime.now()
        self._last_fired[storage_key] = now
        self._save_cooldown_to_db(storage_key, now)

    # ── DB 영속화 ──────────────────────────────────────────────────────────────

    def _init_db(self) -> None:
        self._db_conn.execute(
            """
            CREATE TABLE IF NOT EXISTS proactive_cooldowns (
                rule_name TEXT PRIMARY KEY,
                last_fired_at TEXT NOT NULL
            )
            """
        )
        self._db_conn.commit()

    def _load_cooldowns_from_db(self) -> None:
        try:
            rows = self._db_conn.execute(
                "SELECT rule_name, last_fired_at FROM proactive_cooldowns"
            ).fetchall()
            for rule_name, fired_at_str in rows:
                self._last_fired[rule_name] = datetime.fromisoformat(fired_at_str)
        except Exception as e:
            logger.warning(f"쿨다운 DB 로드 실패 (무시하고 진행): {e}")

    def _save_cooldown_to_db(self, rule_name: str, fired_at: datetime) -> None:
        try:
            self._db_conn.execute(
                """
                INSERT OR REPLACE INTO proactive_cooldowns (rule_name, last_fired_at)
                VALUES (?, ?)
                """,
                (rule_name, fired_at.isoformat()),
            )
            self._db_conn.commit()
        except Exception as e:
            logger.warning(f"쿨다운 DB 저장 실패: {e}")
