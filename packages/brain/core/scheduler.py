"""Phase 7-C: AutoFineTuneScheduler.

파인튜닝 데이터가 충분히 쌓이고 서버 유휴 시간(새벽)이 되면
자동으로 데이터를 추출 → 필터링 → JSONL 저장하는 백그라운드 스케줄러.

실제 QLoRA 학습은 별도 스크립트(finetune/llm/train.py)로 분리 — 현 단계에서는 데이터 저장까지만.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, datetime, timezone

logger = logging.getLogger(__name__)


class AutoFineTuneScheduler:
    """파인튜닝 파이프라인 자동 스케줄러.

    트리거 조건:
    - is_finetune_candidate=1 대화 수 >= trigger_count
    - 현재 시각이 schedule_hour ~ schedule_hour+3 (서버 유휴 새벽 시간)
    - 오늘 아직 실행 안 함
    """

    _CHECK_INTERVAL_SECONDS = 3600.0  # 1시간마다 체크

    def __init__(
        self,
        collector,
        filter_,
        formatter,
        trigger_count: int = 500,
        schedule_hour: int = 2,
        output_dir: str = "finetune_data",
        check_interval_seconds: float | None = None,
    ) -> None:
        self._collector = collector
        self._filter = filter_
        self._formatter = formatter
        self._trigger_count = trigger_count
        self._schedule_hour = schedule_hour
        self._output_dir = output_dir
        self._check_interval = (
            check_interval_seconds
            if check_interval_seconds is not None
            else self._CHECK_INTERVAL_SECONDS
        )
        self._task: asyncio.Task | None = None
        self._last_run_date: date | None = None

    # ------------------------------------------------------------------
    # 라이프사이클
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """백그라운드 스케줄러 태스크를 시작한다."""
        if self._task is not None and not self._task.done():
            return  # 이미 실행 중
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        """백그라운드 태스크를 취소하고 완료를 기다린다."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    # ------------------------------------------------------------------
    # 트리거 판단
    # ------------------------------------------------------------------

    def _should_trigger(self, candidate_count: int, current_hour: int) -> bool:
        """실행 조건을 충족하는지 확인한다."""
        if candidate_count < self._trigger_count:
            return False

        window_start = self._schedule_hour
        window_end = (self._schedule_hour + 4) % 24  # 4시간 window

        if window_end > window_start:
            in_window = window_start <= current_hour < window_end
        else:
            # 자정 넘어가는 케이스 (예: 22 ~ 2시)
            in_window = current_hour >= window_start or current_hour < window_end

        if not in_window:
            return False

        if self._last_run_date == date.today():
            return False

        return True

    # ------------------------------------------------------------------
    # 파이프라인 실행
    # ------------------------------------------------------------------

    async def _run_pipeline(self) -> None:
        """데이터 추출 → 필터링 → JSONL 저장 파이프라인을 실행한다."""
        conversations = self._collector.collect(min_quality=0.5)
        if not conversations:
            return

        filtered = self._filter.apply(conversations)
        if not filtered:
            return

        pairs = self._formatter.to_instruction_response(filtered)

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(self._output_dir, f"finetune_{timestamp}.jsonl")

        count = self._formatter.save_jsonl(pairs, output_path)
        self._last_run_date = date.today()
        logger.info("[AutoFineTuneScheduler] %d건 JSONL 저장 완료: %s", count, output_path)

    # ------------------------------------------------------------------
    # 내부 루프
    # ------------------------------------------------------------------

    async def _loop(self) -> None:
        """주기적으로 트리거 조건을 확인하고 파이프라인을 실행한다."""
        while True:
            try:
                stats = self._collector.stats()
                candidate_count = stats.get("candidate_count", 0)
                current_hour = datetime.now(timezone.utc).hour

                if self._should_trigger(candidate_count, current_hour):
                    await self._run_pipeline()

                await asyncio.sleep(self._check_interval)

            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error("[AutoFineTuneScheduler] 오류 발생, 다음 주기에 재시도: %s", e)
                await asyncio.sleep(self._check_interval)
