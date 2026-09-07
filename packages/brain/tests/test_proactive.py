"""Phase 9-A: ProactiveTriggerScheduler 단위 테스트."""

import asyncio
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from core.proactive import (
    MAX_DISCONNECTED_SESSION_STATES,
    ProactiveTriggerScheduler,
    ScheduleEvent,
    TriggerContext,
    TriggerRule,
)
from core.proactive_rules import AchievementRule, UpcomingEventRule


# ── 테스트용 구상 규칙 ─────────────────────────────────────────────────────────

class AlwaysFireRule(TriggerRule):
    rule_name = "always_fire"
    cooldown_hours = 1

    def should_fire(self, ctx: TriggerContext) -> bool:
        return True

    def get_prompt(self, ctx: TriggerContext) -> str:
        return "테스트용 프롬프트"


class NeverFireRule(TriggerRule):
    rule_name = "never_fire"
    cooldown_hours = 1

    def should_fire(self, ctx: TriggerContext) -> bool:
        return False

    def get_prompt(self, ctx: TriggerContext) -> str:
        return "절대 안 씀"


class UpcomingTestRule(AlwaysFireRule):
    rule_name = "upcoming_event"


# ── TriggerContext ─────────────────────────────────────────────────────────────

class TestTriggerContext:
    def test_build_with_all_fields(self):
        now = datetime(2026, 3, 17, 10, 0, 0)
        last = datetime(2026, 3, 17, 6, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=last,
            session_start_at=now - timedelta(minutes=3),
            daily_fire_count=1,
            hour_of_day=10,
        )
        assert ctx.now == now
        assert ctx.last_conversation_at == last
        assert ctx.daily_fire_count == 1
        assert ctx.hour_of_day == 10

    def test_last_conversation_can_be_none(self):
        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        assert ctx.last_conversation_at is None


# ── TriggerRule ABC ────────────────────────────────────────────────────────────

class TestTriggerRuleABC:
    def test_cannot_instantiate_abstract(self):
        with pytest.raises(TypeError):
            TriggerRule()  # type: ignore

    def test_concrete_rule_has_required_attributes(self):
        rule = AlwaysFireRule()
        assert rule.rule_name == "always_fire"
        assert rule.cooldown_hours == 1

    def test_should_fire_returns_bool(self):
        rule = AlwaysFireRule()
        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        assert rule.should_fire(ctx) is True

    def test_get_prompt_returns_str(self):
        rule = AlwaysFireRule()
        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        prompt = rule.get_prompt(ctx)
        assert isinstance(prompt, str)
        assert len(prompt) > 0


# ── ProactiveTriggerScheduler ──────────────────────────────────────────────────

def _make_scheduler(rules=None, max_daily=5, quiet_start=2, quiet_end=7):
    mock_llm = AsyncMock()
    # ADR-0007: 선제 발화는 일상 모드 고정 경로로 나간다.
    mock_llm.chat_casual = AsyncMock(return_value="안녕 사용자!")
    return ProactiveTriggerScheduler(
        rules=rules or [AlwaysFireRule()],
        llm=mock_llm,
        persona_prompt="타냐 페르소나",
        max_daily_fires=max_daily,
        quiet_start_hour=quiet_start,
        quiet_end_hour=quiet_end,
        check_interval_seconds=0.05,  # 테스트용 빠른 루프
    )


class TestSchedulerConnection:
    def test_not_connected_initially(self):
        scheduler = _make_scheduler()
        assert not scheduler.is_connected

    def test_set_connection(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")
        assert scheduler.is_connected

    def test_clear_connection(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")
        scheduler.clear_connection("tauri:test")
        assert not scheduler.is_connected

    def test_clear_wrong_key_no_effect(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")
        scheduler.clear_connection("tauri:other")  # 다른 키
        assert scheduler.is_connected  # 여전히 연결 중

    def test_disconnect_cache_is_bounded_and_preserves_short_reconnect(self):
        scheduler = _make_scheduler()
        session_key = "webchat:reconnect"
        fetched = datetime.now()
        event = ScheduleEvent(
            "event", "재연결 일정", fetched + timedelta(minutes=30), False
        )
        scheduler.set_connection(AsyncMock(), session_key)
        scheduler.update_schedule([event], fetched, session_key=session_key)
        scheduler.update_last_conversation(session_key=session_key)
        scheduler.clear_connection(session_key)
        scheduler.set_connection(AsyncMock(), session_key)

        reconnected = scheduler._build_context(session_key)
        assert reconnected.events == [event]
        assert reconnected.last_conversation_at is not None

        scheduler.clear_connection(session_key)
        for index in range(MAX_DISCONNECTED_SESSION_STATES + 10):
            key = f"webchat:transient-{index}"
            scheduler.set_connection(AsyncMock(), key)
            scheduler.clear_connection(key)

        disconnected = [
            key
            for key, state in scheduler._session_states.items()
            if key and state.disconnected_at is not None
        ]
        assert len(disconnected) <= MAX_DISCONNECTED_SESSION_STATES


class TestSchedulerPolicies:
    @pytest.mark.asyncio
    async def test_no_fire_when_not_connected(self):
        scheduler = _make_scheduler()
        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        fired = await scheduler._evaluate(ctx)
        assert not fired

    @pytest.mark.asyncio
    async def test_no_fire_during_quiet_hours(self):
        scheduler = _make_scheduler(quiet_start=2, quiet_end=7)
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")

        now = datetime(2026, 3, 17, 3, 0, 0)  # 새벽 3시
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=3,
        )
        fired = await scheduler._evaluate(ctx)
        assert not fired
        send_fn.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_fire_when_daily_limit_reached(self):
        scheduler = _make_scheduler(max_daily=3)
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")

        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=3,  # 한도 도달
            hour_of_day=10,
        )
        fired = await scheduler._evaluate(ctx)
        assert not fired

    @pytest.mark.asyncio
    async def test_no_fire_when_cooldown_active(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")

        # 방금 발동했다고 기록
        scheduler._record_fire("always_fire")

        now = datetime.now()
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        fired = await scheduler._evaluate(ctx)
        assert not fired

    @pytest.mark.asyncio
    async def test_fires_once_per_evaluate(self):
        """한 _evaluate 호출에서 최대 1개만 발동."""
        rules = [AlwaysFireRule(), AlwaysFireRule()]
        # 두 번째 규칙도 always fire지만 첫 번째가 먼저 발동하면 중단
        rules[1].rule_name = "always_fire_2"
        scheduler = _make_scheduler(rules=rules)
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")

        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        await scheduler._evaluate(ctx)
        # send_fn은 정확히 1번만 호출
        assert send_fn.call_count == 1

    @pytest.mark.asyncio
    async def test_fire_calls_send_fn(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")

        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        fired = await scheduler._evaluate(ctx)
        assert fired
        # T-015: 발화와 함께 규칙의 문맥(offer_meta)이 넘어간다. 기본 규칙은 빈 dict.
        send_fn.assert_called_once_with("안녕 사용자!", {})

    @pytest.mark.asyncio
    async def test_cooldown_recorded_after_fire(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "tauri:test")

        now = datetime(2026, 3, 17, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        await scheduler._evaluate(ctx)
        assert not scheduler._is_cooled_down("always_fire")  # 쿨다운 중

    @pytest.mark.asyncio
    async def test_send_failure_is_recorded_to_prevent_retry_storm(self):
        scheduler = _make_scheduler()
        send_fn = AsyncMock(side_effect=RuntimeError("closed socket"))
        scheduler.set_connection(send_fn, "tauri:test")
        now = datetime(2026, 9, 2, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )

        first = await scheduler._evaluate(ctx)
        second = await scheduler._evaluate(ctx)

        assert first is True
        assert second is False
        assert scheduler._llm.chat_casual.await_count == 1
        send_fn.assert_awaited_once()


class TestSchedulerIsQuietHour:
    def test_quiet_hour_inside_range(self):
        scheduler = _make_scheduler(quiet_start=2, quiet_end=7)
        assert scheduler._is_quiet_hour(2) is True
        assert scheduler._is_quiet_hour(5) is True
        assert scheduler._is_quiet_hour(6) is True

    def test_quiet_hour_outside_range(self):
        scheduler = _make_scheduler(quiet_start=2, quiet_end=7)
        assert scheduler._is_quiet_hour(7) is False
        assert scheduler._is_quiet_hour(10) is False
        assert scheduler._is_quiet_hour(1) is False


class TestSchedulerStartStop:
    @pytest.mark.asyncio
    async def test_start_and_stop(self):
        scheduler = _make_scheduler()
        await scheduler.start()
        assert scheduler._task is not None
        await scheduler.stop()
        assert scheduler._task is None or scheduler._task.done()


# ── T-013: 일정 스냅샷 ─────────────────────────────────────────────────────────

def _scheduler(**kwargs):
    """일정 테스트용 스케줄러. LLM은 호출되지 않는 경로만 본다."""
    return ProactiveTriggerScheduler(
        rules=[],
        llm=MagicMock(),
        persona_prompt="",
        **kwargs,
    )


class TestScheduleSnapshot:
    def test_context_has_no_schedule_by_default(self):
        """기존 규칙 8종이 영향받지 않도록 기본값을 가진다."""
        ctx = TriggerContext(
            now=datetime(2026, 9, 15, 14, 20),
            last_conversation_at=None,
            session_start_at=datetime(2026, 9, 15, 9, 0),
            daily_fire_count=0,
            hour_of_day=14,
        )

        assert ctx.events == []
        assert ctx.schedule_fetched_at is None

    def test_update_schedule_is_carried_into_context(self):
        scheduler = _scheduler()
        fetched = datetime(2026, 9, 15, 14, 20)
        events = [
            ScheduleEvent(
                id="abc123",
                title="프로젝트 회의",
                starts_at=datetime(2026, 9, 15, 15, 0),
                all_day=False,
            )
        ]

        scheduler.update_schedule(events, fetched)
        ctx = scheduler._build_context()

        assert ctx.events == events
        assert ctx.schedule_fetched_at == fetched

    def test_latest_snapshot_replaces_the_previous_one(self):
        """일정은 누적하지 않는다. 취소된 일정이 남으면 안 된다."""
        scheduler = _scheduler()
        old = ScheduleEvent("old", "취소된 회의", datetime(2026, 9, 15, 15, 0), False)
        new = ScheduleEvent("new", "새 회의", datetime(2026, 9, 15, 16, 0), False)

        scheduler.update_schedule([old], datetime(2026, 9, 15, 14, 0))
        scheduler.update_schedule([new], datetime(2026, 9, 15, 14, 15))

        assert scheduler._build_context().events == [new]

    def test_upsert_schedule_event_preserves_others_and_replaces_same_id(self):
        scheduler = _scheduler()
        fetched = datetime.now()
        other = ScheduleEvent("other", "다른 일정", fetched + timedelta(hours=2), False)
        old = ScheduleEvent("same", "이전 제목", fetched + timedelta(minutes=30), False)
        replacement = ScheduleEvent("same", "새 제목", fetched + timedelta(minutes=35), False)
        scheduler.update_schedule([other, old], fetched - timedelta(minutes=5))

        scheduler.upsert_schedule_event(replacement, fetched)

        ctx = scheduler._build_context()
        assert ctx.events == [other, replacement]
        assert ctx.schedule_fetched_at == fetched

    def test_upsert_schedule_event_does_not_revive_stale_snapshot(self):
        scheduler = _scheduler()
        now = datetime.now()
        stale = ScheduleEvent("stale", "지난 스냅샷", now + timedelta(hours=1), False)
        created = ScheduleEvent("created", "방금 만든 일정", now + timedelta(minutes=30), False)
        scheduler.update_schedule([stale], now - timedelta(minutes=31))

        scheduler.upsert_schedule_event(created, now)

        assert scheduler._build_context().events == [created]

    def test_stale_snapshot_is_dropped(self):
        """클라이언트가 죽었거나 Google이 끊긴 뒤 옛 일정으로 말을 걸지 않는다."""
        scheduler = _scheduler()
        events = [ScheduleEvent("abc", "회의", datetime(2026, 9, 15, 15, 0), False)]

        scheduler.update_schedule(events, datetime.now() - timedelta(minutes=31))
        ctx = scheduler._build_context()

        assert ctx.events == []
        assert ctx.schedule_fetched_at is None

    def test_fresh_snapshot_survives(self):
        scheduler = _scheduler()
        events = [ScheduleEvent("abc", "회의", datetime(2026, 9, 15, 15, 0), False)]

        scheduler.update_schedule(events, datetime.now() - timedelta(minutes=29))

        assert scheduler._build_context().events == events

    def test_schedule_and_conversation_state_are_isolated_by_session(self):
        scheduler = _scheduler()
        fetched = datetime.now()
        event_a = ScheduleEvent(
            "private-a", "A의 비공개 일정", fetched + timedelta(minutes=25), False
        )
        event_b = ScheduleEvent(
            "private-b", "B의 비공개 일정", fetched + timedelta(minutes=30), False
        )

        scheduler.update_schedule([event_a], fetched, session_key="webchat:a")
        scheduler.update_schedule([event_b], fetched, session_key="webchat:b")
        scheduler.update_last_conversation(session_key="webchat:a")

        context_a = scheduler._build_context("webchat:a")
        context_b = scheduler._build_context("webchat:b")
        assert context_a.events == [event_a]
        assert context_b.events == [event_b]
        assert context_a.last_conversation_at is not None
        assert context_b.last_conversation_at is None


class TestAchievementConversationCount:
    def test_transport_session_does_not_filter_legacy_global_history(self):
        """Orchestrator가 `default`로 저장한 기존 대화도 마일스톤에 포함한다."""
        scheduler = _scheduler()
        store = MagicMock()
        store._conn.execute.return_value.fetchone.return_value = (100,)
        store.count_conversations.return_value = 0
        scheduler.set_memory_store(store)

        context = scheduler._build_context("webchat:stable-browser-id")

        assert context.total_conversations == 100
        assert AchievementRule().should_fire(context) is True
        store.count_conversations.assert_not_called()


class TestImmediateRuleEvaluation:
    @pytest.mark.asyncio
    async def test_evaluate_rule_now_targets_named_rule_only(self):
        scheduler = _make_scheduler(
            rules=[AlwaysFireRule(), UpcomingTestRule()],
            quiet_start=2,
            quiet_end=2,
        )
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "webchat:test")

        fired = await scheduler.evaluate_rule_now("upcoming_event")

        assert fired is True
        assert scheduler._llm.chat_casual.await_args.kwargs["user_input"] == "테스트용 프롬프트"
        send_fn.assert_awaited_once()
        assert "always_fire" not in scheduler._last_fired
        assert not scheduler._is_cooled_down(
            "upcoming_event",
            UpcomingTestRule(),
            session_key="webchat:test",
        )

    @pytest.mark.asyncio
    async def test_evaluate_rule_now_keeps_normal_connection_policy(self):
        scheduler = _make_scheduler(rules=[UpcomingTestRule()])

        fired = await scheduler.evaluate_rule_now("upcoming_event")

        assert fired is False
        scheduler._llm.chat_casual.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_proactive_send_and_limits_are_isolated_by_session(self):
        scheduler = _make_scheduler(
            rules=[UpcomingEventRule()],
            max_daily=1,
            quiet_start=2,
            quiet_end=2,
        )
        send_a = AsyncMock()
        send_b = AsyncMock()
        scheduler.set_connection(send_a, "webchat:a")
        scheduler.set_connection(send_b, "webchat:b")
        fetched = datetime.now()
        event_a = ScheduleEvent(
            "event-a", "A만 아는 일정", fetched + timedelta(minutes=25), False
        )
        event_b = ScheduleEvent(
            "event-b", "B만 아는 일정", fetched + timedelta(minutes=30), False
        )
        scheduler.update_schedule([event_a], fetched, session_key="webchat:a")
        scheduler.update_schedule([event_b], fetched, session_key="webchat:b")

        fired_a = await scheduler.evaluate_rule_now(
            "upcoming_event", session_key="webchat:a", event_id="event-a"
        )
        fired_b = await scheduler.evaluate_rule_now(
            "upcoming_event", session_key="webchat:b", event_id="event-b"
        )

        assert fired_a is True
        assert fired_b is True
        send_a.assert_awaited_once()
        send_b.assert_awaited_once()
        assert send_a.await_args.args[1]["event"]["id"] == "event-a"
        assert send_b.await_args.args[1]["event"]["id"] == "event-b"

    @pytest.mark.asyncio
    async def test_created_event_evaluation_is_pinned_when_an_earlier_event_exists(self):
        scheduler = _make_scheduler(
            rules=[UpcomingEventRule()], quiet_start=2, quiet_end=2
        )
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "webchat:test")
        fetched = datetime.now()
        earlier = ScheduleEvent(
            "existing", "기존 일정", fetched + timedelta(minutes=25), False
        )
        created = ScheduleEvent(
            "created", "방금 만든 일정", fetched + timedelta(minutes=30), False
        )
        scheduler.update_schedule(
            [earlier], fetched, session_key="webchat:test"
        )
        scheduler.upsert_schedule_event(
            created, fetched, session_key="webchat:test"
        )

        fired = await scheduler.evaluate_rule_now(
            "upcoming_event", session_key="webchat:test", event_id="created"
        )

        assert fired is True
        assert "방금 만든 일정" in scheduler._llm.chat_casual.await_args.kwargs["user_input"]
        assert send_fn.await_args.args[1]["event"]["id"] == "created"

    @pytest.mark.asyncio
    async def test_concurrent_evaluations_cannot_bypass_cooldown(self):
        scheduler = _make_scheduler(
            rules=[UpcomingEventRule()], quiet_start=2, quiet_end=2
        )
        send_fn = AsyncMock()
        scheduler.set_connection(send_fn, "webchat:test")
        fetched = datetime.now()
        event = ScheduleEvent(
            "created", "동시 평가 일정", fetched + timedelta(minutes=30), False
        )
        scheduler.update_schedule([event], fetched, session_key="webchat:test")

        async def slow_response(**_kwargs):
            await asyncio.sleep(0.01)
            return "한 번만 보내는 제안"

        scheduler._llm.chat_casual.side_effect = slow_response
        results = await asyncio.gather(
            scheduler.evaluate_rule_now(
                "upcoming_event", session_key="webchat:test", event_id="created"
            ),
            scheduler.evaluate_rule_now(
                "upcoming_event", session_key="webchat:test", event_id="created"
            ),
        )

        assert sorted(results) == [False, True]
        assert scheduler._llm.chat_casual.await_count == 1
        send_fn.assert_awaited_once()
        assert scheduler._build_context("webchat:test").daily_fire_count == 1

    @pytest.mark.asyncio
    async def test_reconnect_during_llm_uses_latest_socket_and_keeps_cooldown(self):
        scheduler = _make_scheduler(quiet_start=2, quiet_end=2)
        session_key = "webchat:stable-browser-id"
        old_send = AsyncMock()
        new_send = AsyncMock()
        scheduler.set_connection(old_send, session_key)
        llm_started = asyncio.Event()
        release_llm = asyncio.Event()

        async def delayed_response(**_kwargs):
            llm_started.set()
            await release_llm.wait()
            return "재연결 뒤 한 번만 보내는 제안"

        scheduler._llm.chat_casual.side_effect = delayed_response
        context = scheduler._build_context(session_key)
        evaluation = asyncio.create_task(
            scheduler._evaluate(context, session_key=session_key)
        )
        await llm_started.wait()

        scheduler.set_connection(new_send, session_key)
        scheduler.clear_connection(session_key, old_send)
        assert scheduler._connections[session_key] is new_send
        release_llm.set()

        assert await evaluation is True
        old_send.assert_not_awaited()
        new_send.assert_awaited_once()

        scheduler.clear_connection(session_key, new_send)
        reconnect_send = AsyncMock()
        scheduler.set_connection(reconnect_send, session_key)
        assert await scheduler._evaluate(
            scheduler._build_context(session_key), session_key=session_key
        ) is False
        reconnect_send.assert_not_awaited()


class TestProactiveUsesLocalLLM:
    """ADR-0007 — 선제 발화는 분류를 거치지 않고 일상 모드로 고정한다."""

    def test_scheduler_calls_the_casual_pinned_path(self):
        llm = MagicMock()
        llm.chat_casual = AsyncMock(return_value="안녕!")
        llm.chat = AsyncMock(return_value="이 경로로 가면 안 된다")
        scheduler = ProactiveTriggerScheduler(
            rules=[AlwaysFireRule()],
            llm=llm,
            persona_prompt="페르소나",
        )
        scheduler.set_connection(AsyncMock(), "c1")
        now = datetime(2026, 9, 15, 14, 20)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=14,
        )

        fired = asyncio.run(scheduler._evaluate(ctx))

        assert fired is True
        llm.chat_casual.assert_awaited_once()
        llm.chat.assert_not_awaited()
