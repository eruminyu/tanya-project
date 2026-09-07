"""Phase 9-A/B/C: 트리거 규칙 8종.

Phase 9-A:
- LongIdleRule: 마지막 대화로부터 N시간 이상 경과
- MorningGreetingRule: 오전 7~10시 첫 접속 (세션 시작 후 10분 이내)
- RandomThoughtRule: 확률 기반 랜덤 잡담

Phase 9-B:
- NightCheckRule: 오후 23시~새벽 1시 사용 중 감지
- LongSessionRule: 연속 세션 2시간 이상 감지
- WorkReminderRule: 평일 설정 시간 리마인더

Phase 9-C:
- StreakBreakRule: 24시간 이상 장기 부재 감지
- AchievementRule: 누적 대화 마일스톤 축하 (100/300/500/1000건)
"""

import random
from datetime import timedelta

from core.proactive import ScheduleEvent, TriggerContext, TriggerRule


class LongIdleRule(TriggerRule):
    """마지막 대화로부터 N시간 이상 경과 시 말을 건다."""

    rule_name = "long_idle"
    cooldown_hours = 4
    idle_threshold_hours: int = 4

    def should_fire(self, ctx: TriggerContext) -> bool:
        if ctx.last_conversation_at is None:
            return True  # 대화 기록 없음 = 오랫동안 대화 없음으로 간주
        elapsed = ctx.now - ctx.last_conversation_at
        return elapsed >= timedelta(hours=self.idle_threshold_hours)

    def get_prompt(self, ctx: TriggerContext) -> str:
        if ctx.last_conversation_at is None:
            return (
                f"지금 시각은 {ctx.now.strftime('%H시 %M분')}이야. "
                "사용자가 처음 접속했어. 타냐로서 부담스럽지 않게 먼저 인사하고, "
                "지금 필요한 도움이 있는지 한 번만 물어봐. 부드러운 존댓말로 2문장 이내로 말해."
            )
        elapsed_h = int((ctx.now - ctx.last_conversation_at).total_seconds() // 3600)
        idle_desc = f"약 {elapsed_h}시간 동안"
        return (
            f"지금 시각은 {ctx.now.strftime('%H시 %M분')}이야. "
            f"사용자가 {idle_desc} 대화하지 않았어. "
            "타냐로서 자연스럽게 먼저 말을 걸어봐. "
            "재촉하지 말고 부드러운 존댓말로 3문장 이내로 말해."
        )


class MorningGreetingRule(TriggerRule):
    """오전 7~10시, 세션 시작 후 10분 이내에 아침 인사를 건다."""

    rule_name = "morning_greeting"
    cooldown_hours = 16
    morning_start: int = 7
    morning_end: int = 10       # 10시 미만 (10시는 포함 안 함)
    session_window_minutes: int = 10

    def should_fire(self, ctx: TriggerContext) -> bool:
        if not (self.morning_start <= ctx.hour_of_day < self.morning_end):
            return False
        session_age = ctx.now - ctx.session_start_at
        return session_age <= timedelta(minutes=self.session_window_minutes)

    def get_prompt(self, ctx: TriggerContext) -> str:
        return (
            f"지금 오전 {ctx.hour_of_day}시야. 사용자가 방금 접속했어. "
            "타냐로서 밝고 다정하게 아침 인사를 건네봐. "
            "밥 먹었는지, 잘 잤는지 같은 자연스러운 안부도 포함해서. "
            "부드러운 존댓말로 3문장 이내로 말해."
        )


class RandomThoughtRule(TriggerRule):
    """확률 기반으로 불규칙하게 잡담을 시작한다.

    하루 max_daily 회 초과 시 발동 안 함.
    """

    rule_name = "random_thought"
    cooldown_hours = 6

    def __init__(self, fire_probability: float = 0.3, max_daily: int = 3) -> None:
        self._prob = fire_probability
        self._max_daily = max_daily

    def should_fire(self, ctx: TriggerContext) -> bool:
        if ctx.daily_fire_count >= self._max_daily:
            return False
        return random.random() < self._prob

    def get_prompt(self, ctx: TriggerContext) -> str:
        return (
            "타냐로서 사용자에게 가벼운 대화를 먼저 건네고 싶어졌어. "
            "현재 맥락 없이 아는 척하거나 기존 관계를 가정하지 말고, "
            "부담 없이 답할 수 있는 짧은 안부나 질문을 부드러운 존댓말로 2문장 이내로 말해."
        )


# ── Phase 9-B 추가 규칙 ────────────────────────────────────────────────────────

class NightCheckRule(TriggerRule):
    """오후 23시~새벽 1시(0시) 사용 중일 때 슬슬 자라고 챙겨준다."""

    rule_name = "night_check"
    cooldown_hours = 8
    night_hours: tuple[int, ...] = (23, 0)

    def should_fire(self, ctx: TriggerContext) -> bool:
        return ctx.hour_of_day in self.night_hours

    def get_prompt(self, ctx: TriggerContext) -> str:
        return (
            f"지금 {ctx.now.strftime('%H시 %M분')}이야. 사용자가 아직 활동 중이야. "
            "타냐로서 휴식을 제안하되 생활 패턴을 단정하거나 잔소리하지 마. "
            "부드러운 존댓말로 2문장 이내로 말해."
        )


class LongSessionRule(TriggerRule):
    """연속으로 2시간 이상 세션을 유지 중일 때 잠깐 쉬라고 말을 건다."""

    rule_name = "long_session"
    cooldown_hours = 2
    session_threshold_hours: int = 2

    def should_fire(self, ctx: TriggerContext) -> bool:
        elapsed = ctx.now - ctx.session_start_at
        return elapsed >= timedelta(hours=self.session_threshold_hours)

    def get_prompt(self, ctx: TriggerContext) -> str:
        elapsed_h = int((ctx.now - ctx.session_start_at).total_seconds() // 3600)
        return (
            f"사용자가 {elapsed_h}시간째 세션을 이어가고 있어. "
            "타냐로서 잠깐 눈을 쉬고 물을 마시는 짧은 휴식을 제안해. "
            "재촉하지 말고 부드러운 존댓말로 2문장 이내로 말해."
        )


class WorkReminderRule(TriggerRule):
    """평일 특정 시간에 오늘 할 일을 리마인드해준다."""

    rule_name = "work_reminder"
    cooldown_hours = 12

    def __init__(self, target_hour: int = 10) -> None:
        self._target_hour = target_hour

    def should_fire(self, ctx: TriggerContext) -> bool:
        if ctx.now.weekday() >= 5:  # 토(5), 일(6) 제외
            return False
        return ctx.hour_of_day == self._target_hour

    def get_prompt(self, ctx: TriggerContext) -> str:
        return (
            f"지금 오전 {self._target_hour}시이고 평일이야. 사용자가 오늘 할 일을 "
            "확인하면 좋을 시간이야. 타냐로서 할 일 확인을 가볍게 제안해. "
            "부드러운 존댓말로 2문장 이내로 말해."
        )


# ── Phase 9-C 추가 규칙 ────────────────────────────────────────────────────────

class StreakBreakRule(TriggerRule):
    """24시간 이상 장기 부재 후 재접속 시 반갑게 맞이한다.

    LongIdleRule(4시간)과 달리 훨씬 긴 부재를 감지하며,
    '오래 못 봤다'는 뉘앙스로 말을 건다.
    대화 기록이 없는 첫 접속에는 발동하지 않는다.
    """

    rule_name = "streak_break"
    cooldown_hours = 24
    absence_threshold_hours: int = 24

    def should_fire(self, ctx: TriggerContext) -> bool:
        if ctx.last_conversation_at is None:
            return False  # 첫 접속은 LongIdleRule이 담당
        elapsed = ctx.now - ctx.last_conversation_at
        return elapsed >= timedelta(hours=self.absence_threshold_hours)

    def get_prompt(self, ctx: TriggerContext) -> str:
        elapsed_h = int((ctx.now - ctx.last_conversation_at).total_seconds() // 3600)
        elapsed_desc = f"약 {elapsed_h}시간" if elapsed_h < 48 else f"약 {elapsed_h // 24}일"
        return (
            f"사용자가 {elapsed_desc} 만에 다시 접속했어. "
            "타냐로서 반갑게 맞이하되 부재 이유나 관계를 추측하지 마. "
            "가볍게 안부를 묻고 필요한 도움이 있는지 부드러운 존댓말로 3문장 이내로 말해."
        )


class AchievementRule(TriggerRule):
    """누적 대화 마일스톤(100/300/500/1000건) 도달 시 축하 발화를 한다.

    마일스톤 ±5 이내일 때 발동 (정확한 시점에 접속하지 않을 수 있으므로).
    쿨다운 168시간(7일)으로 같은 마일스톤 중복 축하 방지.
    total_conversations = 0이면 (store 미연결) 발동 안 함.
    """

    rule_name = "achievement"
    cooldown_hours = 168
    milestones: tuple[int, ...] = (100, 300, 500, 1000)
    tolerance: int = 5

    def _nearest_milestone(self, total: int) -> int | None:
        """total이 마일스톤 ±tolerance 이내이면 해당 마일스톤 반환, 아니면 None."""
        for m in self.milestones:
            if abs(total - m) <= self.tolerance:
                return m
        return None

    def should_fire(self, ctx: TriggerContext) -> bool:
        if ctx.total_conversations == 0:
            return False
        return self._nearest_milestone(ctx.total_conversations) is not None

    def get_prompt(self, ctx: TriggerContext) -> str:
        milestone = self._nearest_milestone(ctx.total_conversations) or ctx.total_conversations
        return (
            f"사용자와 타냐가 나눈 대화가 {milestone}번을 넘었어. "
            "과도한 친밀감이나 관계를 가정하지 말고, 꾸준히 사용해 준 것에 감사하며 "
            "이 기록을 밝고 간결하게 축하해. 부드러운 존댓말로 2문장 이내로 말해."
        )


# ── T-013: 일정 인지 규칙 ──────────────────────────────────────────────────────

class UpcomingEventRule(TriggerRule):
    """곧 시작하는 일정을 근거로 먼저 말을 건다.

    기존 8종과 달리 발화의 근거가 시계가 아니라 **사용자의 실제 상황**이다.
    일정 스냅샷은 클라이언트가 밀어 넣으며, 스케줄러가 신선도를 이미 걸러
    오래된 스냅샷은 `ctx.events`가 비어서 들어온다.
    """

    rule_name = "upcoming_event"
    cooldown_hours = 1

    def __init__(self, lead_min_minutes: int = 20, lead_max_minutes: int = 40) -> None:
        self._lead_min = lead_min_minutes
        self._lead_max = lead_max_minutes

    def target_event(self, ctx: TriggerContext) -> ScheduleEvent | None:
        """발화 대상 일정. 창 안에 여러 건이면 가장 임박한 것."""
        if ctx.schedule_fetched_at is None:
            return None
        candidates = [
            event
            for event in ctx.events
            if not event.all_day
            and self._lead_min <= self._minutes_until(ctx, event) <= self._lead_max
        ]
        return min(candidates, key=lambda e: e.starts_at, default=None)

    def should_fire(self, ctx: TriggerContext) -> bool:
        return self.target_event(ctx) is not None

    def offer_meta(self, ctx: TriggerContext) -> dict:
        """수락 답변을 초안으로 잇기 위해 대상 일정을 넘긴다 (T-015)."""
        event = self.target_event(ctx)
        if event is None:
            return {}
        return {
            "rule": self.rule_name,
            "event": {"id": event.id, "title": event.title, "starts_at": event.starts_at},
        }

    def fire_key(self, ctx: TriggerContext) -> str:
        """같은 일정으로 두 번 말하지 않는다."""
        event = self.target_event(ctx)
        return f"{self.rule_name}:{event.id}" if event else self.rule_name

    def get_prompt(self, ctx: TriggerContext) -> str:
        event = self.target_event(ctx)
        if event is None:
            return ""
        minutes = self._minutes_until(ctx, event)
        return (
            f"사용자의 일정에 '{event.title}'이(가) {minutes}분 뒤에 시작해. "
            "타냐로서 그 일정을 언급하며 먼저 말을 걸어봐. "
            "한 문장으로 짧게 알려주고, 지금 하면 도움이 될 구체적인 행동을 하나만 제안해. "
            "부드러운 존댓말로 말하고 2문장을 넘기지 마."
        )

    @staticmethod
    def _minutes_until(ctx: TriggerContext, event: ScheduleEvent) -> float:
        return (event.starts_at - ctx.now).total_seconds() / 60
