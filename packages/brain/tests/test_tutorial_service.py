"""T-027 TutorialService 서버 권위 상태기계 테스트."""

from __future__ import annotations

import asyncio
import uuid

import pytest

from action.google_api import GoogleApiError, GoogleApiUncertainError
from tutorial import service as tutorial_service
from tutorial.ollama import StrictOllamaError, StrictOllamaResult
from tutorial.schemas import TutorialPhase
from tutorial.service import TutorialService
from tutorial.store import TutorialStore


SESSION_A = "webchat:550e8400-e29b-41d4-a716-446655440000"
SESSION_B = "webchat:123e4567-e89b-42d3-a456-426614174000"
SECRET = "tutorial-service-secret-that-is-at-least-32-bytes"


class Clock:
    def __init__(self, epoch: int = 1_788_321_600) -> None:
        self.epoch = epoch

    def __call__(self) -> int:
        return self.epoch

    def advance(self, seconds: int) -> None:
        self.epoch += seconds


class FakeGoogle:
    configured = True
    timeout_seconds = 10.0

    def __init__(self) -> None:
        self.created: list[tuple[str, dict]] = []
        self.deleted: list[tuple[str, str]] = []
        self.create_error: Exception | None = None
        self.delete_error: Exception | None = None

    def create(self, kind: str, fields: dict) -> str:
        self.created.append((kind, fields))
        if self.create_error is not None:
            raise self.create_error
        return f"{kind}-provider-1"

    def delete(self, kind: str, provider_id: str) -> bool:
        self.deleted.append((kind, provider_id))
        if self.delete_error is not None:
            raise self.delete_error
        return True


class FakeOllama:
    configured = True

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.error: Exception | None = None

    async def generate(self, prompt: str, system_prompt: str = ""):
        self.prompts.append(prompt)
        if self.error is not None:
            raise self.error
        return StrictOllamaResult("로컬 맞춤 답변", "qwen2.5:7b")


@pytest.fixture
def service_setup(tmp_path):
    clock = Clock()
    store = TutorialStore(
        tmp_path / "tutorial.sqlite", hmac_secret=SECRET, clock=clock
    )
    google = FakeGoogle()
    ollama = FakeOllama()
    service = TutorialService(
        store=store,
        ollama=ollama,
        google=google,
        clock=clock,
        cleanup_poll_seconds=0.01,
    )
    yield service, store, google, ollama, clock
    store.close()


def operation_id() -> str:
    return str(uuid.uuid4())


async def action(service, session, name, **payload):
    return await service.handle(
        session,
        name,
        {"operation_id": operation_id(), **payload},
    )


def payload_for(events, name):
    return next(payload for event, payload in events if event == name)


async def advance_to_calendar(service, session=SESSION_A):
    flow_id = payload_for(
        await action(service, session, "tutorial_start"), "tutorial_state"
    )["flowId"]
    approval = payload_for(
        await action(
            service,
            session,
            "tutorial_preferences_prepare",
            flow_id=flow_id,
            preferences={
                "interaction": "neutral",
                "information": "neutral",
                "decision": "neutral",
                "planning": "neutral",
            },
            preparation_minutes=5,
        ),
        "tutorial_approval_required",
    )
    await action(
        service,
        session,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=approval["requestId"],
        approval_token=approval["approvalToken"],
    )
    return flow_id


@pytest.mark.asyncio
async def test_complete_flow_is_server_ordered_grounded_and_redacted_after_forget(
    service_setup,
):
    service, store, google, ollama, _ = service_setup

    started = await action(service, SESSION_A, "tutorial_start")
    state = payload_for(started, "tutorial_state")
    flow_id = state["flowId"]
    assert state["phase"] == "preferences_pending"

    prepared = await action(
        service,
        SESSION_A,
        "tutorial_preferences_prepare",
        flow_id=flow_id,
        preferences={
            "interaction": "complete",
            "information": "concrete",
            "decision": "evidence",
            "planning": "structured",
        },
        preparation_minutes=10,
    )
    approval = payload_for(prepared, "tutorial_approval_required")
    assert approval["preview"]["explanation"]["changeState"] == "not_executed"
    approved = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=approval["requestId"],
        approval_token=approval["approvalToken"],
    )
    assert payload_for(approved, "tutorial_state")["phase"] == "calendar_pending"

    calendar_preview = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )
    assert calendar_preview["preview"]["executor"] == "public_demo_brain/google"
    assert calendar_preview["preview"]["explanation"]["retention"][
        "googleCleanupDueAt"
    ] is None
    calendar_result = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_approve",
            flow_id=flow_id,
            request_id=calendar_preview["requestId"],
            approval_token=calendar_preview["approvalToken"],
        ),
        "tutorial_google_result",
    )
    assert calendar_result["status"] == "succeeded"
    assert calendar_result["cleanupStatus"] == "scheduled"

    task_result = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_skip",
            flow_id=flow_id,
            kind="task",
        ),
        "tutorial_google_result",
    )
    assert task_result["status"] == "skipped"

    answer = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_answer_generate",
            flow_id=flow_id,
            comparison="before",
            question_id="demo_preparation_summary_v1",
        ),
        "tutorial_answer_completed",
    )
    assert answer["route"] == {
        "provider": "ollama",
        "execution": "local",
        "fallback": False,
        "model": "qwen2.5:7b",
    }
    assert {source["type"] for source in answer["sources"]} == {
        "vm_memory",
        "google_calendar_receipt",
    }
    assert "calendar-provider-1" in ollama.prompts[0]

    receipt = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_receipt_get",
            flow_id=flow_id,
        ),
        "tutorial_receipt",
    )
    assert receipt["preferences"]["preparationMinutes"] == 10
    assert receipt["google"]["calendar"]["providerId"] == "calendar-provider-1"
    assert receipt["notSentToGoogle"] == ["preferences", "vm_memory"]

    forgotten = payload_for(
        await action(service, SESSION_A, "tutorial_forget", flow_id=flow_id),
        "tutorial_forgotten",
    )
    assert forgotten["memoryStatus"] == "forgotten"
    redacted = service.receipt(SESSION_A, flow_id, operation_id())
    assert redacted["preferences"] is None
    assert redacted["answerBefore"] is None
    assert redacted["google"]["calendar"]["sentFields"] is None
    assert redacted["google"]["calendar"]["providerId"] == "calendar-provider-1"
    assert redacted["explanation"]["changeState"] == "completed"
    assert redacted["explanation"]["exactChange"]["fields"]["google"] == {
        "calendar": "succeeded"
    }

    after = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_answer_generate",
            flow_id=flow_id,
            comparison="after",
            question_id="demo_preparation_summary_v1",
        ),
        "tutorial_answer_completed",
    )
    assert after["appliedPreferences"] == {}
    assert "calendar-provider-1" not in ollama.prompts[-1]
    assert store.get_snapshot(SESSION_A, flow_id).phase.value == "completed"
    assert len(google.created) == 1


@pytest.mark.asyncio
async def test_resume_reissues_pending_token_and_old_token_cannot_execute(service_setup):
    service, _, google, _, _ = service_setup
    flow_id = payload_for(
        await action(service, SESSION_A, "tutorial_start"), "tutorial_state"
    )["flowId"]
    prepared = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_preferences_prepare",
            flow_id=flow_id,
            preferences={
                "interaction": "neutral",
                "information": "neutral",
                "decision": "neutral",
                "planning": "neutral",
            },
            preparation_minutes=5,
        ),
        "tutorial_approval_required",
    )

    resumed = await action(
        service, SESSION_A, "tutorial_resume", flow_id=flow_id
    )
    renewed = payload_for(resumed, "tutorial_approval_required")
    assert renewed["approvalToken"] != prepared["approvalToken"]
    replay = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=prepared["requestId"],
        approval_token=prepared["approvalToken"],
    )
    assert payload_for(replay, "tutorial_error")["code"] == "invalid"
    assert google.created == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["calendar", "task"])
@pytest.mark.parametrize("expire_via_approve", [False, True])
async def test_resume_reissues_expired_google_approval_without_provider_call(
    service_setup, kind, expire_via_approve
):
    service, store, google, _, clock = service_setup
    flow_id = await advance_to_calendar(service)
    if kind == "task":
        await action(
            service,
            SESSION_A,
            "tutorial_google_skip",
            flow_id=flow_id,
            kind="calendar",
        )
    first = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind=kind,
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )
    clock.advance(121)

    if expire_via_approve:
        expired = await action(
            service,
            SESSION_A,
            "tutorial_approve",
            flow_id=flow_id,
            request_id=first["requestId"],
            approval_token=first["approvalToken"],
        )
        assert payload_for(expired, "tutorial_error")["code"] == "expired"
        assert google.created == []

    resumed = await action(
        service, SESSION_A, "tutorial_resume", flow_id=flow_id
    )

    assert [event for event, _ in resumed] == [
        "tutorial_state",
        "tutorial_approval_required",
    ]
    renewed = payload_for(resumed, "tutorial_approval_required")
    assert renewed["requestId"] == first["requestId"]
    assert renewed["preview"] == first["preview"]
    assert renewed["approvalToken"] != first["approvalToken"]
    assert renewed["expiresAt"] != first["expiresAt"]
    assert google.created == []
    matching_actions = [
        item
        for item in store.get_google_actions(SESSION_A, flow_id)
        if item.kind.value == kind
    ]
    assert len(matching_actions) == 1
    assert matching_actions[0].request_id == first["requestId"]

    stale = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=first["requestId"],
        approval_token=first["approvalToken"],
    )
    assert payload_for(stale, "tutorial_error")["code"] == "invalid"
    assert google.created == []

    approved = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=renewed["requestId"],
        approval_token=renewed["approvalToken"],
    )
    assert payload_for(approved, "tutorial_google_result")["status"] == "succeeded"
    assert len(google.created) == 1
    replay = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=renewed["requestId"],
        approval_token=renewed["approvalToken"],
    )
    assert payload_for(replay, "tutorial_error")["code"] in {
        "invalid",
        "invalid_phase",
    }
    assert len(google.created) == 1


@pytest.mark.asyncio
async def test_repeated_google_prepare_conflict_then_resume_recovers_preview(
    service_setup,
):
    service, store, google, _, clock = service_setup
    flow_id = await advance_to_calendar(service)
    first = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )
    clock.advance(121)

    repeated = await action(
        service,
        SESSION_A,
        "tutorial_google_prepare",
        flow_id=flow_id,
        kind="calendar",
        scenario_id="hackathon_demo_v1",
        timezone="Asia/Seoul",
    )

    assert payload_for(repeated, "tutorial_error")["code"] == "conflict"
    assert google.created == []

    resumed = await action(
        service, SESSION_A, "tutorial_resume", flow_id=flow_id
    )
    renewed = payload_for(resumed, "tutorial_approval_required")
    assert renewed["requestId"] == first["requestId"]
    assert renewed["preview"] == first["preview"]
    assert renewed["approvalToken"] != first["approvalToken"]
    assert google.created == []
    calendar_actions = [
        item
        for item in store.get_google_actions(SESSION_A, flow_id)
        if item.kind.value == "calendar"
    ]
    assert len(calendar_actions) == 1
    assert calendar_actions[0].request_id == first["requestId"]


@pytest.mark.asyncio
async def test_resume_at_receipt_ready_returns_state_then_receipt(service_setup):
    service, _, _, _, _ = service_setup
    flow_id = await advance_to_calendar(service)
    await action(
        service, SESSION_A, "tutorial_google_skip", flow_id=flow_id, kind="calendar"
    )
    await action(
        service, SESSION_A, "tutorial_google_skip", flow_id=flow_id, kind="task"
    )
    await action(
        service,
        SESSION_A,
        "tutorial_answer_generate",
        flow_id=flow_id,
        comparison="before",
        question_id="demo_preparation_summary_v1",
    )

    resumed = await action(
        service, SESSION_A, "tutorial_resume", flow_id=flow_id
    )

    assert [event for event, _ in resumed] == [
        "tutorial_state",
        "tutorial_receipt",
    ]
    assert resumed[0][1]["phase"] == "receipt_ready"
    assert resumed[1][1]["flowId"] == flow_id


@pytest.mark.asyncio
async def test_resume_after_interrupted_calendar_advances_without_provider_retry(
    tmp_path,
):
    db_path = tmp_path / "tutorial.sqlite"
    clock = Clock()
    store = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    session = store.start_session(SESSION_A)
    for expected, replacement in (
        (TutorialPhase.PREFERENCES_PENDING, TutorialPhase.PREFERENCES_SAVED),
        (TutorialPhase.PREFERENCES_SAVED, TutorialPhase.CALENDAR_PENDING),
        (TutorialPhase.CALENDAR_PENDING, TutorialPhase.CALENDAR_EXECUTING),
    ):
        store.compare_and_set_phase(
            SESSION_A, session.flow_id, expected, replacement
        )
    request_id = operation_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, "calendar", request_id
    )
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, "calendar", request_id
    )
    store.close()

    reopened = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    google = FakeGoogle()
    service = TutorialService(
        store=reopened,
        ollama=FakeOllama(),
        google=google,
        clock=clock,
    )
    try:
        resumed = await action(
            service,
            SESSION_A,
            "tutorial_resume",
            flow_id=session.flow_id,
        )
        state = payload_for(resumed, "tutorial_state")
        assert state["phase"] == "task_pending"
        assert state["calendarStatus"] == "uncertain"
        assert google.created == []
    finally:
        reopened.close()


@pytest.mark.asyncio
async def test_wrong_phase_cross_session_and_invalid_operation_fail_closed(service_setup):
    service, _, google, ollama, _ = service_setup
    flow_id = payload_for(
        await action(service, SESSION_A, "tutorial_start"), "tutorial_state"
    )["flowId"]

    wrong_phase = await action(
        service,
        SESSION_A,
        "tutorial_answer_generate",
        flow_id=flow_id,
        comparison="before",
        question_id="demo_preparation_summary_v1",
    )
    assert payload_for(wrong_phase, "tutorial_error")["code"] == "invalid_phase"
    cross = await action(
        service, SESSION_B, "tutorial_resume", flow_id=flow_id
    )
    assert payload_for(cross, "tutorial_error")["code"] == "invalid"
    invalid = await service.handle(
        SESSION_A,
        "tutorial_start",
        {"operation_id": "not-a-uuid"},
    )
    assert payload_for(invalid, "tutorial_error")["operationId"] == ""
    assert google.created == []
    assert ollama.prompts == []


@pytest.mark.asyncio
async def test_receipt_is_unavailable_before_answer_completes(service_setup):
    service, _, _, _, _ = service_setup
    flow_id = payload_for(
        await action(service, SESSION_A, "tutorial_start"), "tutorial_state"
    )["flowId"]

    result = await action(
        service, SESSION_A, "tutorial_receipt_get", flow_id=flow_id
    )

    assert payload_for(result, "tutorial_error")["code"] == "invalid_phase"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (GoogleApiError("safe"), "failed"),
        (GoogleApiUncertainError("safe"), "uncertain"),
    ],
)
async def test_google_errors_are_recorded_without_automatic_retry(
    service_setup, error, expected
):
    service, _, google, _, _ = service_setup
    flow_id = payload_for(
        await action(service, SESSION_A, "tutorial_start"), "tutorial_state"
    )["flowId"]
    pref = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_preferences_prepare",
            flow_id=flow_id,
            preferences={
                "interaction": "neutral",
                "information": "neutral",
                "decision": "neutral",
                "planning": "neutral",
            },
            preparation_minutes=5,
        ),
        "tutorial_approval_required",
    )
    await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=pref["requestId"],
        approval_token=pref["approvalToken"],
    )
    preview = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )
    google.create_error = error

    result = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_approve",
            flow_id=flow_id,
            request_id=preview["requestId"],
            approval_token=preview["approvalToken"],
        ),
        "tutorial_google_result",
    )

    assert result["status"] == expected
    assert result["cleanupDueAt"] is None
    assert result["cleanupStatus"] == (
        "unknown" if expected == "uncertain" else "not_required"
    )
    assert len(google.created) == 1
    replay = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=preview["requestId"],
        approval_token=preview["approvalToken"],
    )
    assert payload_for(replay, "tutorial_error")["code"] == "invalid"
    assert len(google.created) == 1


@pytest.mark.asyncio
async def test_google_rejection_does_not_call_provider_and_advances(service_setup):
    service, _, google, _, _ = service_setup
    flow_id = await advance_to_calendar(service)
    preview = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )

    rejected = await action(
        service,
        SESSION_A,
        "tutorial_reject",
        flow_id=flow_id,
        request_id=preview["requestId"],
        approval_token=preview["approvalToken"],
    )

    assert payload_for(rejected, "tutorial_google_result")["status"] == "rejected"
    assert payload_for(rejected, "tutorial_state")["phase"] == "task_pending"
    assert google.created == []


@pytest.mark.asyncio
async def test_concurrent_approval_calls_google_at_most_once(service_setup):
    service, _, google, _, _ = service_setup
    flow_id = payload_for(
        await action(service, SESSION_A, "tutorial_start"), "tutorial_state"
    )["flowId"]
    pref = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_preferences_prepare",
            flow_id=flow_id,
            preferences={
                "interaction": "neutral",
                "information": "neutral",
                "decision": "neutral",
                "planning": "neutral",
            },
            preparation_minutes=5,
        ),
        "tutorial_approval_required",
    )
    await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=pref["requestId"],
        approval_token=pref["approvalToken"],
    )
    preview = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )
    same_payload = {
        "operation_id": operation_id(),
        "flow_id": flow_id,
        "request_id": preview["requestId"],
        "approval_token": preview["approvalToken"],
    }

    first, second = await asyncio.gather(
        service.handle(SESSION_A, "tutorial_approve", dict(same_payload)),
        service.handle(SESSION_A, "tutorial_approve", dict(same_payload)),
    )

    all_events = first + second
    assert len(google.created) == 1
    assert sum(event == "tutorial_google_result" for event, _ in all_events) == 1
    assert sum(event == "tutorial_error" for event, _ in all_events) == 1


@pytest.mark.asyncio
async def test_local_model_failure_never_creates_answer(service_setup):
    service, store, _, ollama, _ = service_setup
    flow_id = payload_for(
        await action(service, SESSION_A, "tutorial_start"), "tutorial_state"
    )["flowId"]
    pref = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_preferences_prepare",
            flow_id=flow_id,
            preferences={
                "interaction": "neutral",
                "information": "neutral",
                "decision": "neutral",
                "planning": "neutral",
            },
            preparation_minutes=5,
        ),
        "tutorial_approval_required",
    )
    await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=pref["requestId"],
        approval_token=pref["approvalToken"],
    )
    await action(
        service, SESSION_A, "tutorial_google_skip", flow_id=flow_id, kind="calendar"
    )
    await action(
        service, SESSION_A, "tutorial_google_skip", flow_id=flow_id, kind="task"
    )
    ollama.error = StrictOllamaError("raw sensitive provider response")

    failed = await action(
        service,
        SESSION_A,
        "tutorial_answer_generate",
        flow_id=flow_id,
        comparison="before",
        question_id="demo_preparation_summary_v1",
    )

    error = payload_for(failed, "tutorial_error")
    assert error["code"] == "local_model_unavailable"
    assert "sensitive" not in error["message"]
    assert store.get_answer(SESSION_A, flow_id, "before") is None


@pytest.mark.asyncio
async def test_cleanup_worker_deletes_due_resource_by_kind(service_setup):
    service, store, google, _, clock = service_setup
    # Store 계약을 직접 사용해 due cleanup을 만든다.
    session = store.start_session(SESSION_A)
    request_id = operation_id()
    store.reserve_google_action(SESSION_A, session.flow_id, "calendar", request_id)
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, "calendar", request_id
    )
    store.finish_google_action(
        SESSION_A,
        session.flow_id,
        "calendar",
        request_id,
        "succeeded",
        provider_id="calendar-cleanup-1",
        sent_fields={"title": "정리 대상"},
    )
    clock.advance(1_800)

    assert await service.run_cleanup_once() == 1
    assert google.deleted == [("calendar", "calendar-cleanup-1")]
    cleaned = store.get_cleanup_entries()[0]
    assert cleaned.status == "succeeded"
    assert cleaned.provider_id is None


@pytest.mark.asyncio
async def test_cleanup_failure_remains_retryable(service_setup):
    service, store, google, _, clock = service_setup
    session = store.start_session(SESSION_A)
    request_id = operation_id()
    store.reserve_google_action(SESSION_A, session.flow_id, "task", request_id)
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, "task", request_id
    )
    store.finish_google_action(
        SESSION_A,
        session.flow_id,
        "task",
        request_id,
        "succeeded",
        provider_id="task-cleanup-1",
        sent_fields={"title": "정리 대상", "due": "2026-09-04"},
    )
    clock.advance(1_800)
    google.delete_error = GoogleApiError("safe")

    assert await service.run_cleanup_once() == 1
    failed = store.get_cleanup_entries()[0]
    assert failed.status == "failed"
    assert failed.provider_id == "task-cleanup-1"

    google.delete_error = None
    assert await service.run_cleanup_once() == 1
    retried = store.get_cleanup_entries()[0]
    assert retried.status == "succeeded"
    assert retried.provider_id is None


@pytest.mark.asyncio
async def test_skip_after_preview_invalidates_exposed_approval_token(service_setup):
    service, _, google, _, _ = service_setup
    flow_id = await advance_to_calendar(service)
    preview = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )

    skipped = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_skip",
            flow_id=flow_id,
            kind="calendar",
        ),
        "tutorial_google_result",
    )
    assert skipped["status"] == "skipped"
    replay = await action(
        service,
        SESSION_A,
        "tutorial_approve",
        flow_id=flow_id,
        request_id=preview["requestId"],
        approval_token=preview["approvalToken"],
    )
    assert payload_for(replay, "tutorial_error")["code"] == "invalid"
    assert google.created == []


@pytest.mark.asyncio
async def test_session_remaining_time_gate_blocks_late_google_create(service_setup):
    service, _, google, _, clock = service_setup
    flow_id = await advance_to_calendar(service)
    clock.advance(1_788)
    preview = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_google_prepare",
            flow_id=flow_id,
            kind="calendar",
            scenario_id="hackathon_demo_v1",
            timezone="Asia/Seoul",
        ),
        "tutorial_approval_required",
    )

    result = payload_for(
        await action(
            service,
            SESSION_A,
            "tutorial_approve",
            flow_id=flow_id,
            request_id=preview["requestId"],
            approval_token=preview["approvalToken"],
        ),
        "tutorial_google_result",
    )

    assert result["status"] == "failed"
    assert google.created == []


@pytest.mark.asyncio
async def test_google_prepare_rejects_non_iana_timezone_before_reservation(service_setup):
    service, store, google, _, _ = service_setup
    flow_id = await advance_to_calendar(service)

    result = await action(
        service,
        SESSION_A,
        "tutorial_google_prepare",
        flow_id=flow_id,
        kind="calendar",
        scenario_id="hackathon_demo_v1",
        timezone="localtime",
    )

    assert payload_for(result, "tutorial_error")["code"] == "invalid"
    assert store.get_google_actions(SESSION_A, flow_id) == []
    assert google.created == []


def test_iana_timezone_allowlist_uses_packaged_dataset_and_fails_closed(
    monkeypatch,
    tmp_path,
):
    assert "Asia/Seoul" in tutorial_service._IANA_TIMEZONES
    assert "UTC" in tutorial_service._IANA_TIMEZONES
    assert "localtime" not in tutorial_service._IANA_TIMEZONES

    package_root = tmp_path / "tzdata"
    package_root.mkdir()
    zones_path = package_root / "zones"
    monkeypatch.setattr(tutorial_service.resources, "files", lambda _package: package_root)

    zones_path.write_text("", encoding="utf-8")
    assert tutorial_service._load_iana_timezones() == frozenset()

    zones_path.write_bytes(b"\xff")
    assert tutorial_service._load_iana_timezones() == frozenset()

    def unavailable_package(_package):
        raise OSError("tzdata resource unavailable")

    monkeypatch.setattr(tutorial_service.resources, "files", unavailable_package)
    assert tutorial_service._load_iana_timezones() == frozenset()
