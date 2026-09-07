from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.approval import ApprovalStore
from core.orchestrator import Orchestrator


def make_orchestrator(*, configured: bool = True):
    orchestrator = object.__new__(Orchestrator)
    orchestrator._google_demo_approvals = ApprovalStore(ttl_seconds=300)
    orchestrator._google_demo = MagicMock()
    orchestrator._google_demo.configured = configured
    return orchestrator


def test_configured_web_demo_decorates_draft_with_one_time_approval_contract():
    orchestrator = make_orchestrator()

    prepared = orchestrator.prepare_google_draft({
        "kind": "task",
        "title": "발표 자료 정리",
        "due": "2026-09-01",
    })

    assert prepared["executor"] == "brain"
    assert prepared["requestId"]
    assert prepared["approvalToken"]

    stored = orchestrator._google_demo_approvals.consume(prepared["approvalToken"])
    assert stored == {
        "skill": "google_demo_write",
        "payload": {
            "request_id": prepared["requestId"],
            "draft": {
                "kind": "task",
                "title": "발표 자료 정리",
                "due": "2026-09-01",
            },
        },
    }


def test_unconfigured_demo_keeps_desktop_draft_contract_unchanged():
    orchestrator = make_orchestrator(configured=False)
    original = {"kind": "task", "title": "자료 정리", "due": None}

    assert orchestrator.prepare_google_draft(original) == original


def test_unified_tutorial_does_not_issue_legacy_brain_approval_token():
    orchestrator = make_orchestrator(configured=True)
    orchestrator._settings = SimpleNamespace(
        hackathon_tutorial_configured=True
    )
    original = {"kind": "task", "title": "자료 정리", "due": None}

    assert orchestrator.prepare_google_draft(original) == original
    assert len(orchestrator._google_demo_approvals._tokens) == 0


@pytest.mark.asyncio
async def test_web_approval_consumes_token_and_executes_server_provider_once():
    orchestrator = make_orchestrator()
    prepared = orchestrator.prepare_google_draft({
        "kind": "task",
        "title": "발표 자료 정리",
        "due": None,
    })
    orchestrator._google_demo.create.return_value = {
        "requestId": prepared["requestId"],
        "providerId": "task-1",
        "title": "발표 자료 정리",
        "duplicate": False,
    }

    events = []
    async for event in orchestrator.handle_message_stream({
        "action": "google_write_approve",
        "payload": {"approval_token": prepared["approvalToken"]},
    }):
        events.append(event)

    assert events == [("google_write_result", {
        "requestId": prepared["requestId"],
        "providerId": "task-1",
        "title": "발표 자료 정리",
        "duplicate": False,
    })]
    orchestrator._google_demo.create.assert_called_once_with(
        prepared["requestId"],
        {"kind": "task", "title": "발표 자료 정리", "due": None},
    )

    replay = []
    async for event in orchestrator.handle_message_stream({
        "action": "google_write_approve",
        "payload": {"approval_token": prepared["approvalToken"]},
    }):
        replay.append(event)
    assert replay == [("google_write_error", {
        "message": "Google 쓰기 승인 토큰이 유효하지 않거나 만료되었습니다.",
    })]
    orchestrator._google_demo.create.assert_called_once()


@pytest.mark.asyncio
async def test_calendar_approval_emits_created_schedule_after_provider_receipt():
    orchestrator = make_orchestrator()
    draft = {
        "kind": "calendar",
        "title": "해커톤 데모",
        "startAt": "2026-08-31T15:00:00+09:00",
        "endAt": "2026-08-31T16:00:00+09:00",
    }
    prepared = orchestrator.prepare_google_draft(draft)
    receipt = {
        "requestId": prepared["requestId"],
        "providerId": "calendar-1",
        "title": "해커톤 데모",
        "duplicate": False,
    }
    orchestrator._google_demo.create.return_value = receipt

    events = []
    async for event in orchestrator.handle_message_stream({
        "action": "google_write_approve",
        "payload": {"approval_token": prepared["approvalToken"]},
    }):
        events.append(event)

    assert events == [
        ("google_write_result", receipt),
        ("schedule_created", {
            "id": "calendar-1",
            "title": "해커톤 데모",
            "startsAt": "2026-08-31T15:00:00+09:00",
            "allDay": False,
        }),
    ]


@pytest.mark.asyncio
async def test_web_rejection_invalidates_token_without_google_call():
    orchestrator = make_orchestrator()
    prepared = orchestrator.prepare_google_draft({
        "kind": "calendar",
        "title": "데모 일정",
        "startAt": "2026-08-31T15:00:00+09:00",
        "endAt": "2026-08-31T16:00:00+09:00",
    })

    events = []
    async for event in orchestrator.handle_message_stream({
        "action": "google_write_reject",
        "payload": {"approval_token": prepared["approvalToken"]},
    }):
        events.append(event)

    assert events == [("google_write_cancelled", {
        "requestId": prepared["requestId"],
    })]
    orchestrator._google_demo.create.assert_not_called()

    replay = []
    async for event in orchestrator.handle_message_stream({
        "action": "google_write_approve",
        "payload": {"approval_token": prepared["approvalToken"]},
    }):
        replay.append(event)
    assert replay[0][0] == "google_write_error"
    orchestrator._google_demo.create.assert_not_called()
