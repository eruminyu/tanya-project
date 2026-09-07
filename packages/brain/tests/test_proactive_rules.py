"""Phase 9-A/B/C: ProactiveTriggerRule 단위 테스트."""

from datetime import datetime, timedelta

import pytest

from core.proactive import ScheduleEvent, TriggerContext
from core.proactive_rules import (
    AchievementRule,
    LongIdleRule,
    LongSessionRule,
    MorningGreetingRule,
    NightCheckRule,
    RandomThoughtRule,
    StreakBreakRule,
    UpcomingEventRule,
    WorkReminderRule,
)


_PRIVATE_RELATIONSHIP_TERMS = (
    "테스트사용자",
    "예시별명",
    "자기야",
    "여보야",
    "연인",
)


def _ctx(
    hour=10,
    last_offset_hours=None,
    session_offset_minutes=3,
    daily_fire_count=0,
    total_conversations=0,
):
    now = datetime(2026, 3, 17, hour, 0, 0)
    last = (now - timedelta(hours=last_offset_hours)) if last_offset_hours is not None else None
    return TriggerContext(
        now=now,
        last_conversation_at=last,
        session_start_at=now - timedelta(minutes=session_offset_minutes),
        daily_fire_count=daily_fire_count,
        hour_of_day=hour,
        total_conversations=total_conversations,
    )


# ── LongIdleRule ───────────────────────────────────────────────────────────────

class TestLongIdleRule:
    def test_fires_when_idle_exceeds_threshold(self):
        rule = LongIdleRule()
        ctx = _ctx(hour=14, last_offset_hours=5)
        assert rule.should_fire(ctx) is True

    def test_fires_exactly_at_threshold(self):
        rule = LongIdleRule()
        ctx = _ctx(hour=14, last_offset_hours=4)
        assert rule.should_fire(ctx) is True

    def test_does_not_fire_when_recent(self):
        rule = LongIdleRule()
        ctx = _ctx(hour=14, last_offset_hours=2)
        assert rule.should_fire(ctx) is False

    def test_fires_when_no_prior_conversation(self):
        """대화 기록 없을 때 발동 (첫 접속)."""
        rule = LongIdleRule()
        ctx = _ctx(hour=14, last_offset_hours=None)
        assert rule.should_fire(ctx) is True

    def test_prompt_contains_context(self):
        rule = LongIdleRule()
        ctx = _ctx(hour=14, last_offset_hours=5)
        prompt = rule.get_prompt(ctx)
        assert isinstance(prompt, str)
        assert len(prompt) > 20

    def test_first_contact_prompt_does_not_claim_prior_relationship(self):
        prompt = LongIdleRule().get_prompt(_ctx(last_offset_hours=None))

        assert "처음 접속" in prompt
        assert "오랫동안" not in prompt

    def test_rule_name(self):
        assert LongIdleRule.rule_name == "long_idle"

    def test_cooldown_hours(self):
        assert LongIdleRule.cooldown_hours == 4


# ── MorningGreetingRule ────────────────────────────────────────────────────────

class TestMorningGreetingRule:
    def test_fires_in_morning_window_fresh_session(self):
        rule = MorningGreetingRule()
        ctx = _ctx(hour=8, session_offset_minutes=3)
        assert rule.should_fire(ctx) is True

    def test_fires_at_window_start(self):
        rule = MorningGreetingRule()
        ctx = _ctx(hour=7, session_offset_minutes=2)
        assert rule.should_fire(ctx) is True

    def test_fires_at_window_end(self):
        rule = MorningGreetingRule()
        ctx = _ctx(hour=9, session_offset_minutes=4)
        assert rule.should_fire(ctx) is True

    def test_does_not_fire_outside_window(self):
        rule = MorningGreetingRule()
        ctx = _ctx(hour=11, session_offset_minutes=3)
        assert rule.should_fire(ctx) is False

    def test_does_not_fire_if_session_too_old(self):
        """세션 시작 후 10분 이상 경과 시 발동 금지."""
        rule = MorningGreetingRule()
        ctx = _ctx(hour=8, session_offset_minutes=15)
        assert rule.should_fire(ctx) is False

    def test_prompt_is_morning_related(self):
        rule = MorningGreetingRule()
        ctx = _ctx(hour=8, session_offset_minutes=3)
        prompt = rule.get_prompt(ctx)
        assert isinstance(prompt, str)
        assert len(prompt) > 20

    def test_rule_name(self):
        assert MorningGreetingRule.rule_name == "morning_greeting"

    def test_cooldown_hours(self):
        assert MorningGreetingRule.cooldown_hours == 16


# ── RandomThoughtRule ──────────────────────────────────────────────────────────

class TestRandomThoughtRule:
    def test_prompt_is_string(self):
        rule = RandomThoughtRule()
        ctx = _ctx(hour=15)
        prompt = rule.get_prompt(ctx)
        assert isinstance(prompt, str)
        assert len(prompt) > 10

    def test_should_fire_returns_bool(self):
        rule = RandomThoughtRule()
        ctx = _ctx(hour=15)
        result = rule.should_fire(ctx)
        assert isinstance(result, bool)

    def test_does_not_fire_at_daily_limit(self):
        """하루 랜덤 잡담 최대 3회."""
        rule = RandomThoughtRule(max_daily=3)
        ctx = _ctx(hour=15, daily_fire_count=3)
        assert rule.should_fire(ctx) is False

    def test_rule_name(self):
        assert RandomThoughtRule.rule_name == "random_thought"

    def test_cooldown_hours(self):
        assert RandomThoughtRule.cooldown_hours == 6


# ── StreakBreakRule ─────────────────────────────────────────────────────────────

class TestStreakBreakRule:
    def test_fires_when_absent_over_24h(self):
        """24시간 이상 부재 시 발동한다."""
        rule = StreakBreakRule()
        ctx = _ctx(hour=14, last_offset_hours=25)
        assert rule.should_fire(ctx) is True

    def test_fires_exactly_at_24h(self):
        """정확히 24시간 경과 시 발동한다."""
        rule = StreakBreakRule()
        ctx = _ctx(hour=14, last_offset_hours=24)
        assert rule.should_fire(ctx) is True

    def test_does_not_fire_when_recent(self):
        """24시간 미만이면 발동하지 않는다."""
        rule = StreakBreakRule()
        ctx = _ctx(hour=14, last_offset_hours=10)
        assert rule.should_fire(ctx) is False

    def test_does_not_fire_when_no_history(self):
        """대화 기록이 없으면(첫 접속) StreakBreak는 발동하지 않는다."""
        rule = StreakBreakRule()
        ctx = _ctx(hour=14, last_offset_hours=None)
        assert rule.should_fire(ctx) is False

    def test_prompt_mentions_absence(self):
        """프롬프트에 부재 관련 내용이 포함된다."""
        rule = StreakBreakRule()
        ctx = _ctx(hour=14, last_offset_hours=30)
        prompt = rule.get_prompt(ctx)
        assert isinstance(prompt, str)
        assert len(prompt) > 20

    def test_rule_name(self):
        assert StreakBreakRule.rule_name == "streak_break"

    def test_cooldown_hours(self):
        assert StreakBreakRule.cooldown_hours == 24


# ── AchievementRule ────────────────────────────────────────────────────────────

class TestAchievementRule:
    def test_fires_at_100_milestone(self):
        """100번째 대화에서 발동한다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=100)
        assert rule.should_fire(ctx) is True

    def test_fires_at_300_milestone(self):
        """300번째 대화에서 발동한다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=300)
        assert rule.should_fire(ctx) is True

    def test_fires_at_500_milestone(self):
        """500번째 대화에서 발동한다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=500)
        assert rule.should_fire(ctx) is True

    def test_fires_at_1000_milestone(self):
        """1000번째 대화에서 발동한다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=1000)
        assert rule.should_fire(ctx) is True

    def test_fires_near_milestone(self):
        """마일스톤 ±5 이내에서도 발동한다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=103)
        assert rule.should_fire(ctx) is True

    def test_does_not_fire_far_from_milestone(self):
        """마일스톤에서 멀면 발동하지 않는다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=150)
        assert rule.should_fire(ctx) is False

    def test_does_not_fire_at_zero(self):
        """대화가 없으면 발동하지 않는다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=0)
        assert rule.should_fire(ctx) is False

    def test_prompt_mentions_count(self):
        """프롬프트에 대화 수가 포함된다."""
        rule = AchievementRule()
        ctx = _ctx(total_conversations=100)
        prompt = rule.get_prompt(ctx)
        assert isinstance(prompt, str)
        assert "100" in prompt

    def test_rule_name(self):
        assert AchievementRule.rule_name == "achievement"

    def test_cooldown_hours(self):
        assert AchievementRule.cooldown_hours == 168


# ── UpcomingEventRule (T-013) ──────────────────────────────────────────────────

def _schedule_ctx(minutes_until=30, all_day=False, events=None, fetched=True):
    """일정 하나가 minutes_until 뒤에 시작하는 컨텍스트."""
    now = datetime(2026, 9, 15, 14, 20, 0)
    if events is None:
        events = [
            ScheduleEvent(
                id="evt-1",
                title="프로젝트 회의",
                starts_at=now + timedelta(minutes=minutes_until),
                all_day=all_day,
            )
        ]
    return TriggerContext(
        now=now,
        last_conversation_at=None,
        session_start_at=now - timedelta(minutes=10),
        daily_fire_count=0,
        hour_of_day=14,
        events=events,
        schedule_fetched_at=now if fetched else None,
    )


class TestUpcomingEventRule:
    def test_fires_inside_the_window(self):
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(minutes_until=30)) is True

    def test_fires_at_both_edges(self):
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(minutes_until=20)) is True
        assert rule.should_fire(_schedule_ctx(minutes_until=40)) is True

    def test_does_not_fire_outside_the_window(self):
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(minutes_until=19)) is False
        assert rule.should_fire(_schedule_ctx(minutes_until=41)) is False

    def test_does_not_fire_for_events_already_started(self):
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(minutes_until=-5)) is False

    def test_ignores_all_day_events(self):
        """종일 일정은 시작 시각이 의미 없다."""
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(minutes_until=30, all_day=True)) is False

    def test_does_not_fire_without_schedule(self):
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(events=[])) is False

    def test_does_not_fire_when_snapshot_is_missing(self):
        """스케줄러가 신선도로 걸러낸 경우 fetched_at이 None이다."""
        rule = UpcomingEventRule()
        assert rule.should_fire(_schedule_ctx(minutes_until=30, fetched=False)) is False

    def test_picks_the_soonest_event_in_the_window(self):
        now = datetime(2026, 9, 15, 14, 20, 0)
        rule = UpcomingEventRule()
        ctx = _schedule_ctx(events=[
            ScheduleEvent("late", "나중 회의", now + timedelta(minutes=38), False),
            ScheduleEvent("soon", "곧 회의", now + timedelta(minutes=22), False),
        ])

        assert rule.should_fire(ctx) is True
        assert rule.target_event(ctx).id == "soon"

    def test_prompt_carries_title_and_remaining_minutes(self):
        rule = UpcomingEventRule()
        prompt = rule.get_prompt(_schedule_ctx(minutes_until=25))

        assert "프로젝트 회의" in prompt
        assert "25" in prompt

    def test_fire_key_is_per_event(self):
        """같은 일정으로 두 번 말하지 않는다. 다른 일정은 따로 센다."""
        rule = UpcomingEventRule()
        ctx = _schedule_ctx(minutes_until=30)

        assert rule.fire_key(ctx) == "upcoming_event:evt-1"

    def test_fire_key_is_rule_name_without_target(self):
        rule = UpcomingEventRule()
        assert rule.fire_key(_schedule_ctx(events=[])) == rule.rule_name


@pytest.mark.parametrize(
    ("rule", "ctx"),
    [
        (LongIdleRule(), _ctx(hour=14, last_offset_hours=5)),
        (MorningGreetingRule(), _ctx(hour=8, session_offset_minutes=3)),
        (RandomThoughtRule(), _ctx(hour=15)),
        (NightCheckRule(), _ctx(hour=23)),
        (LongSessionRule(), _ctx(hour=14, session_offset_minutes=180)),
        (WorkReminderRule(), _ctx(hour=10)),
        (StreakBreakRule(), _ctx(hour=14, last_offset_hours=30)),
        (AchievementRule(), _ctx(total_conversations=100)),
        (UpcomingEventRule(), _schedule_ctx(minutes_until=25)),
    ],
)
def test_proactive_prompts_are_safe_for_public_visitors(rule, ctx):
    prompt = rule.get_prompt(ctx)

    assert "사용자" in prompt
    for term in _PRIVATE_RELATIONSHIP_TERMS:
        assert term not in prompt
