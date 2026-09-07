"""Phase 7-C: AutoFineTuneScheduler TDD 테스트."""
import asyncio
import pytest

from core.scheduler import AutoFineTuneScheduler


# ──────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────

class FakeCollector:
    def __init__(self, candidate_count=0):
        self._count = candidate_count
        self.collect_called = False

    def stats(self):
        return {"candidate_count": self._count}

    def collect(self, min_quality=0.5, limit=1000):
        self.collect_called = True
        return [{"user_msg": f"msg{i}", "assistant_msg": f"resp{i}", "quality_score": 0.8}
                for i in range(self._count)]


class FakeFilter:
    def apply(self, conversations):
        return conversations

    def filter_stats(self, before, after):
        return {"before": before, "after": after, "removed": before - after, "removal_rate": 0.0}


class FakeFormatter:
    def __init__(self):
        self.saved_paths = []
        self.saved_data = []

    def to_instruction_response(self, conversations):
        return [{"instruction": c["user_msg"], "response": c["assistant_msg"]} for c in conversations]

    def save_jsonl(self, data, output_path):
        self.saved_paths.append(output_path)
        self.saved_data.append(data)
        return len(data)


def make_scheduler(candidate_count=600, trigger_count=500, schedule_hour=2,
                   current_hour=2, output_dir="finetune_data"):
    collector = FakeCollector(candidate_count)
    filter_ = FakeFilter()
    formatter = FakeFormatter()
    scheduler = AutoFineTuneScheduler(
        collector=collector,
        filter_=filter_,
        formatter=formatter,
        trigger_count=trigger_count,
        schedule_hour=schedule_hour,
        output_dir=output_dir,
    )
    scheduler._formatter = formatter  # 외부에서 검사 가능하도록
    return scheduler, collector, formatter


# ──────────────────────────────────────────────
# TestShouldTrigger
# ──────────────────────────────────────────────

class TestShouldTrigger:
    def test_triggers_when_count_and_hour_match(self):
        scheduler, _, _ = make_scheduler(candidate_count=600, trigger_count=500, schedule_hour=2)
        assert scheduler._should_trigger(candidate_count=600, current_hour=2)

    def test_no_trigger_insufficient_count(self):
        scheduler, _, _ = make_scheduler(candidate_count=300, trigger_count=500)
        assert not scheduler._should_trigger(candidate_count=300, current_hour=2)

    def test_no_trigger_wrong_hour(self):
        scheduler, _, _ = make_scheduler(schedule_hour=2)
        assert not scheduler._should_trigger(candidate_count=600, current_hour=14)

    def test_triggers_at_exact_count(self):
        scheduler, _, _ = make_scheduler(trigger_count=500)
        assert scheduler._should_trigger(candidate_count=500, current_hour=2)

    def test_triggers_in_window(self):
        """schedule_hour ~ schedule_hour+3 사이 시간도 트리거."""
        scheduler, _, _ = make_scheduler(schedule_hour=2, trigger_count=100)
        assert scheduler._should_trigger(candidate_count=100, current_hour=3)
        assert scheduler._should_trigger(candidate_count=100, current_hour=4)
        assert scheduler._should_trigger(candidate_count=100, current_hour=5)
        assert not scheduler._should_trigger(candidate_count=100, current_hour=6)

    def test_no_trigger_when_already_ran_today(self):
        """오늘 이미 실행했으면 다시 트리거 안 함."""
        from datetime import date
        scheduler, _, _ = make_scheduler(trigger_count=100)
        scheduler._last_run_date = date.today()
        assert not scheduler._should_trigger(candidate_count=600, current_hour=2)


# ──────────────────────────────────────────────
# TestRunPipeline
# ──────────────────────────────────────────────

class TestRunPipeline:
    @pytest.mark.asyncio
    async def test_run_pipeline_saves_jsonl(self):
        scheduler, collector, formatter = make_scheduler(candidate_count=10)
        await scheduler._run_pipeline()
        assert len(formatter.saved_paths) == 1
        assert formatter.saved_paths[0].endswith(".jsonl")

    @pytest.mark.asyncio
    async def test_run_pipeline_uses_collector(self):
        scheduler, collector, formatter = make_scheduler(candidate_count=5)
        await scheduler._run_pipeline()
        assert collector.collect_called

    @pytest.mark.asyncio
    async def test_run_pipeline_updates_last_run_date(self):
        from datetime import date
        scheduler, _, _ = make_scheduler(candidate_count=5)
        assert scheduler._last_run_date is None
        await scheduler._run_pipeline()
        assert scheduler._last_run_date == date.today()

    @pytest.mark.asyncio
    async def test_run_pipeline_empty_data_skips_save(self):
        """데이터가 없으면 JSONL 저장 안 함."""
        scheduler, collector, formatter = make_scheduler(candidate_count=0)
        await scheduler._run_pipeline()
        assert len(formatter.saved_paths) == 0


# ──────────────────────────────────────────────
# TestSchedulerLifecycle
# ──────────────────────────────────────────────

class TestSchedulerLifecycle:
    @pytest.mark.asyncio
    async def test_start_creates_task(self):
        scheduler, _, _ = make_scheduler()
        await scheduler.start()
        assert scheduler._task is not None
        await scheduler.stop()

    @pytest.mark.asyncio
    async def test_stop_cancels_task(self):
        scheduler, _, _ = make_scheduler()
        await scheduler.start()
        await scheduler.stop()
        assert scheduler._task.done()

    @pytest.mark.asyncio
    async def test_double_start_is_safe(self):
        """start를 두 번 호출해도 안전."""
        scheduler, _, _ = make_scheduler()
        await scheduler.start()
        task1 = scheduler._task
        await scheduler.start()  # 두 번째 호출 — 기존 태스크 재사용
        assert scheduler._task is task1
        await scheduler.stop()
