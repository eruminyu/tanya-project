"""T-026 공개 해커톤 튜토리얼 SQLite 저장소 계약 테스트."""

from __future__ import annotations

import hashlib
import hmac
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from config.settings import Settings
from tutorial.schemas import (
    AnswerComparison,
    ApprovalPurpose,
    GoogleActionKind,
    GoogleActionStatus,
    TutorialPhase,
    TutorialPreferences,
)
from tutorial.store import TutorialStore, TutorialStoreError


SESSION_A = "webchat:550e8400-e29b-41d4-a716-446655440000"
SESSION_B = "webchat:123e4567-e89b-42d3-a456-426614174000"
SECRET = "tutorial-test-secret-that-is-at-least-32-bytes"


class Clock:
    def __init__(self, epoch: int = 1_788_321_600) -> None:
        self.epoch = epoch

    def __call__(self) -> int:
        return self.epoch

    def advance(self, seconds: int) -> None:
        self.epoch += seconds


@pytest.fixture
def tutorial_store(tmp_path):
    clock = Clock()
    db_path = tmp_path / "tutorial.sqlite"
    store = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    yield store, clock, db_path
    store.close()


def request_id() -> str:
    return str(uuid.uuid4())


def preferences(**overrides: str) -> TutorialPreferences:
    values = {
        "interaction": "neutral",
        "information": "concrete",
        "decision": "evidence",
        "planning": "structured",
    }
    values.update(overrides)
    return TutorialPreferences.from_mapping(values)


def test_schema_is_tutorial_only_and_enables_required_pragmas(tutorial_store):
    store, _, _ = tutorial_store

    assert store.schema_version == 1
    assert store.foreign_keys_enabled is True
    assert store.journal_mode == "wal"
    assert store.busy_timeout_ms >= 5_000
    assert store.table_names() == {
        "tutorial_sessions",
        "tutorial_preferences",
        "tutorial_approvals",
        "tutorial_google_actions",
        "tutorial_answers",
        "tutorial_cleanup_queue",
    }
    assert not any(
        forbidden in table
        for table in store.table_names()
        for forbidden in ("capsule", "memory", "fts", "vec")
    )


def test_preferences_are_strict_and_actions_do_not_extend_session_ttl(tutorial_store):
    store, clock, _ = tutorial_store
    session = store.start_session(SESSION_A)
    original_expiry = session.expires_at
    neutral = preferences(
        information="neutral", decision="neutral", planning="neutral"
    )

    store.save_preferences(SESSION_A, session.flow_id, neutral, 10)
    clock.advance(600)

    saved = store.get_preferences(SESSION_A, session.flow_id)
    assert saved is not None
    assert saved.preferences == neutral
    assert saved.preparation_minutes == 10
    assert store.get_snapshot(SESSION_A, session.flow_id).expires_at == original_expiry

    with pytest.raises(ValueError):
        TutorialPreferences.from_mapping({
            "interaction": "complete",
            "information": "concrete",
            "decision": "evidence",
            "planning": "structured",
            "mbti": "INTJ",
        })
    with pytest.raises(ValueError):
        preferences(interaction="INTJ")
    with pytest.raises(ValueError):
        store.save_preferences(SESSION_A, session.flow_id, preferences(), 30)
    with pytest.raises(ValueError):
        store.create_approval(
            SESSION_A,
            session.flow_id,
            ApprovalPurpose.PREFERENCES,
            request_id(),
            {"invalid_number": float("nan")},
        )


def test_owner_hash_is_hmac_and_two_sessions_are_isolated(tutorial_store):
    store, _, db_path = tutorial_store
    session_a = store.start_session(SESSION_A)
    session_b = store.start_session(SESSION_B)
    store.save_preferences(SESSION_A, session_a.flow_id, preferences(), 5)
    store.save_preferences(
        SESSION_B,
        session_b.flow_id,
        preferences(interaction="interactive"),
        20,
    )

    assert session_a.owner_hash != session_b.owner_hash
    assert len(session_a.owner_hash) == 64
    assert session_a.owner_hash == hmac.new(
        SECRET.encode("utf-8"),
        SESSION_A.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    with pytest.raises(TutorialStoreError) as cross_session:
        store.get_preferences(SESSION_B, session_a.flow_id)
    assert cross_session.value.code == "not_found"

    with sqlite3.connect(db_path) as connection:
        serialized = "\n".join(
            str(value)
            for row in connection.execute("SELECT * FROM tutorial_sessions")
            for value in row
        )
    assert SESSION_A not in serialized
    assert SESSION_B not in serialized

    with pytest.raises(TutorialStoreError) as insecure:
        store.start_session("webchat:not-a-canonical-uuid")
    assert insecure.value.code == "invalid"
    with pytest.raises(TutorialStoreError):
        store.start_session(f"webchat:{SESSION_A.removeprefix('webchat:').upper()}")


def test_active_flow_is_reused_and_expired_flow_does_not_block_new_start(
    tutorial_store,
):
    store, clock, _ = tutorial_store
    first = store.start_session(SESSION_A)
    assert store.start_session(SESSION_A).flow_id == first.flow_id
    store.save_preferences(SESSION_A, first.flow_id, preferences(), 10)

    action_request = request_id()
    store.reserve_google_action(
        SESSION_A, first.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    store.mark_google_action_executing(
        SESSION_A, first.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    store.finish_google_action(
        SESSION_A,
        first.flow_id,
        GoogleActionKind.CALENDAR,
        action_request,
        GoogleActionStatus.SUCCEEDED,
        provider_id="calendar-resource-1",
        sent_fields={"title": "해커톤 준비"},
    )
    store.save_answer(
        SESSION_A,
        first.flow_id,
        AnswerComparison.BEFORE,
        content="만료 전에 만든 답변",
        model="qwen2.5:7b",
        sources=[{"type": "vm_memory"}],
    )

    clock.advance(1_800)
    assert store.get_preferences(SESSION_A, first.flow_id) is None
    assert store.get_google_actions(SESSION_A, first.flow_id) == []
    assert store.get_answer(
        SESSION_A, first.flow_id, AnswerComparison.BEFORE
    ) is None
    assert store.get_snapshot(SESSION_A, first.flow_id) is None

    second = store.start_session(SESSION_A)
    assert second.flow_id != first.flow_id
    assert store.get_cleanup_entries()[0].provider_id == "calendar-resource-1"


def test_executing_action_cannot_be_forgotten_and_expiry_preserves_unknown_cleanup(
    tutorial_store,
):
    store, clock, _ = tutorial_store
    session = store.start_session(SESSION_A)
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, action_request
    )

    with pytest.raises(TutorialStoreError) as in_progress:
        store.forget(SESSION_A, session.flow_id)
    assert in_progress.value.code == "conflict"
    assert store.get_google_actions(SESSION_A, session.flow_id)[0].status is (
        GoogleActionStatus.EXECUTING
    )

    clock.advance(1_800)
    replacement = store.start_session(SESSION_A)

    assert replacement.flow_id != session.flow_id
    cleanup = store.get_cleanup_entries()[0]
    assert cleanup.flow_id == session.flow_id
    assert cleanup.request_id == action_request
    assert cleanup.provider_id is None
    assert cleanup.status == "unknown"

    finishing = store.start_session(SESSION_B)
    finishing_request = request_id()
    store.reserve_google_action(
        SESSION_B,
        finishing.flow_id,
        GoogleActionKind.TASK,
        finishing_request,
    )
    store.mark_google_action_executing(
        SESSION_B,
        finishing.flow_id,
        GoogleActionKind.TASK,
        finishing_request,
    )
    clock.advance(1_800)
    result = store.finish_google_action(
        SESSION_B,
        finishing.flow_id,
        GoogleActionKind.TASK,
        finishing_request,
        GoogleActionStatus.SUCCEEDED,
        provider_id="task-resource-after-expiry",
        sent_fields={"title": "마감 확인"},
    )
    assert result.status is GoogleActionStatus.SUCCEEDED
    task_cleanup = {
        entry.kind: entry for entry in store.get_cleanup_entries()
    }[GoogleActionKind.TASK]
    assert task_cleanup.provider_id == "task-resource-after-expiry"
    assert task_cleanup.status == "scheduled"


def test_approval_is_bound_one_time_and_reissued_on_resume(tutorial_store):
    store, clock, db_path = tutorial_store
    session_a = store.start_session(SESSION_A)
    session_b = store.start_session(SESSION_B)
    approval_request = request_id()
    first = store.create_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.PREFERENCES,
        approval_request,
        {"preferences": preferences().to_dict(), "preparation_minutes": 10},
    )
    renewed = store.reissue_pending_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.PREFERENCES,
        approval_request,
    )
    assert renewed.token != first.token
    assert renewed.request_id == first.request_id
    assert renewed.payload == first.payload
    with sqlite3.connect(db_path) as connection:
        serialized = "\n".join(
            str(value)
            for row in connection.execute("SELECT * FROM tutorial_approvals")
            for value in row
        )
    assert first.token not in serialized
    assert renewed.token not in serialized

    with pytest.raises(TutorialStoreError):
        store.consume_approval(
            SESSION_A,
            session_a.flow_id,
            ApprovalPurpose.PREFERENCES,
            approval_request,
            first.token,
        )
    with pytest.raises(TutorialStoreError) as cross_session:
        store.consume_approval(
            SESSION_B,
            session_b.flow_id,
            ApprovalPurpose.PREFERENCES,
            approval_request,
            renewed.token,
        )
    assert cross_session.value.code == "invalid"

    assert store.consume_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.PREFERENCES,
        approval_request,
        renewed.token,
    ) == renewed.payload
    with pytest.raises(TutorialStoreError) as replay:
        store.consume_approval(
            SESSION_A,
            session_a.flow_id,
            ApprovalPurpose.PREFERENCES,
            approval_request,
            renewed.token,
        )
    assert replay.value.code == "invalid"

    rejected = store.create_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.TASK,
        request_id(),
        {"kind": "task"},
    )
    assert store.consume_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.TASK,
        rejected.request_id,
        rejected.token,
        approved=False,
    ) == {}
    with pytest.raises(TutorialStoreError):
        store.consume_approval(
            SESSION_A,
            session_a.flow_id,
            ApprovalPurpose.TASK,
            rejected.request_id,
            rejected.token,
        )

    expiring = store.create_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.CALENDAR,
        request_id(),
        {"kind": "calendar"},
    )
    clock.advance(121)
    with pytest.raises(TutorialStoreError) as expired:
        store.consume_approval(
            SESSION_A,
            session_a.flow_id,
            ApprovalPurpose.CALENDAR,
            expiring.request_id,
            expiring.token,
        )
    assert expired.value.code == "expired"

    concurrent = store.create_approval(
        SESSION_A,
        session_a.flow_id,
        ApprovalPurpose.CALENDAR,
        request_id(),
        {"kind": "calendar"},
    )

    def consume_once(_: int) -> str:
        try:
            store.consume_approval(
                SESSION_A,
                session_a.flow_id,
                ApprovalPurpose.CALENDAR,
                concurrent.request_id,
                concurrent.token,
            )
            return "consumed"
        except TutorialStoreError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(consume_once, range(2))) == [
            "consumed",
            "invalid",
        ]


@pytest.mark.parametrize("expire_via_consume", [False, True])
def test_expired_google_approval_is_reissued_for_same_pending_action(
    tutorial_store, expire_via_consume
):
    store, clock, db_path = tutorial_store
    session = store.start_session(SESSION_A)
    store.compare_and_set_phase(
        SESSION_A,
        session.flow_id,
        TutorialPhase.PREFERENCES_PENDING,
        TutorialPhase.CALENDAR_PENDING,
    )
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.CALENDAR,
        action_request,
    )
    first = store.create_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.CALENDAR,
        action_request,
        {
            "kind": "calendar",
            "draft": {"title": "Tanya 해커톤 준비 점검"},
            "preview": {"kind": "calendar"},
        },
    )
    clock.advance(121)

    if expire_via_consume:
        with pytest.raises(TutorialStoreError) as expired:
            store.consume_approval(
                SESSION_A,
                session.flow_id,
                ApprovalPurpose.CALENDAR,
                action_request,
                first.token,
            )
        assert expired.value.code == "expired"

    renewed = store.reissue_pending_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.CALENDAR,
        action_request,
    )

    assert renewed is not None
    assert renewed.token != first.token
    assert renewed.request_id == first.request_id
    assert renewed.payload == first.payload
    actions = store.get_google_actions(SESSION_A, session.flow_id)
    assert len(actions) == 1
    assert actions[0].request_id == action_request
    assert actions[0].status is GoogleActionStatus.PENDING
    with sqlite3.connect(db_path) as connection:
        serialized = "\n".join(
            str(value)
            for row in connection.execute("SELECT * FROM tutorial_approvals")
            for value in row
        )
    assert first.token not in serialized
    assert renewed.token not in serialized

    with pytest.raises(TutorialStoreError) as old_token:
        store.consume_approval(
            SESSION_A,
            session.flow_id,
            ApprovalPurpose.CALENDAR,
            action_request,
            first.token,
        )
    assert old_token.value.code == "invalid"
    assert store.consume_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.CALENDAR,
        action_request,
        renewed.token,
    ) == renewed.payload
    assert store.reissue_pending_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.CALENDAR,
        action_request,
    ) is None


def test_reissue_does_not_revive_an_older_request_after_latest_is_consumed(
    tutorial_store,
):
    store, clock, _ = tutorial_store
    session = store.start_session(SESSION_A)
    old_request = request_id()
    old = store.create_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
        old_request,
        {"version": "old"},
    )
    clock.advance(121)
    with pytest.raises(TutorialStoreError):
        store.consume_approval(
            SESSION_A,
            session.flow_id,
            ApprovalPurpose.PREFERENCES,
            old_request,
            old.token,
        )

    latest = store.create_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
        request_id(),
        {"version": "latest"},
    )
    assert store.consume_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
        latest.request_id,
        latest.token,
    ) == latest.payload

    assert store.reissue_pending_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
        old_request,
    ) is None
    assert store.reissue_latest_recoverable_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
    ) is None


@pytest.mark.parametrize(
    "action_status",
    [
        GoogleActionStatus.EXECUTING,
        GoogleActionStatus.SUCCEEDED,
        GoogleActionStatus.FAILED,
        GoogleActionStatus.UNCERTAIN,
        GoogleActionStatus.REJECTED,
        GoogleActionStatus.SKIPPED,
    ],
)
def test_google_approval_reissue_requires_action_to_still_be_pending(
    tutorial_store, action_status
):
    store, clock, db_path = tutorial_store
    session = store.start_session(SESSION_A)
    store.compare_and_set_phase(
        SESSION_A,
        session.flow_id,
        TutorialPhase.PREFERENCES_PENDING,
        TutorialPhase.CALENDAR_PENDING,
    )
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.CALENDAR,
        action_request,
    )
    approval = store.create_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.CALENDAR,
        action_request,
        {"kind": "calendar"},
    )
    if action_status in {
        GoogleActionStatus.EXECUTING,
        GoogleActionStatus.SUCCEEDED,
        GoogleActionStatus.FAILED,
        GoogleActionStatus.UNCERTAIN,
    }:
        store.mark_google_action_executing(
            SESSION_A,
            session.flow_id,
            GoogleActionKind.CALENDAR,
            action_request,
        )
    if action_status is not GoogleActionStatus.EXECUTING:
        store.finish_google_action(
            SESSION_A,
            session.flow_id,
            GoogleActionKind.CALENDAR,
            action_request,
            action_status,
            **(
                {
                    "provider_id": "calendar-provider-1",
                    "sent_fields": {"title": "Tanya 해커톤 준비 점검"},
                }
                if action_status is GoogleActionStatus.SUCCEEDED
                else {}
            ),
        )
    clock.advance(121)

    assert store.reissue_pending_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.CALENDAR,
        action_request,
    ) is None
    with sqlite3.connect(db_path) as connection:
        approvals = connection.execute(
            "SELECT request_id, status FROM tutorial_approvals"
        ).fetchall()
    assert approvals == [(approval.request_id, "pending")]


def test_google_kind_is_unique_under_concurrency_and_skip_needs_no_cleanup(
    tutorial_store,
):
    store, _, _ = tutorial_store
    session = store.start_session(SESSION_A)
    first_request = request_id()
    second_request = request_id()

    def reserve(candidate: str) -> str:
        try:
            return store.reserve_google_action(
                SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, candidate
            ).request_id
        except TutorialStoreError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(reserve, [first_request, second_request]))

    assert "conflict" in results
    assert len(store.get_google_actions(SESSION_A, session.flow_id)) == 1

    task_request = request_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, GoogleActionKind.TASK, task_request
    )
    skipped = store.finish_google_action(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.TASK,
        task_request,
        GoogleActionStatus.SKIPPED,
    )
    assert skipped.status is GoogleActionStatus.SKIPPED
    assert store.cleanup_status(session.flow_id, GoogleActionKind.TASK) == "not_required"


def test_google_action_final_status_matches_execution_boundary(tutorial_store):
    store, _, _ = tutorial_store
    session = store.start_session(SESSION_A)
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.CALENDAR,
        action_request,
    )

    with pytest.raises(TutorialStoreError) as not_started:
        store.finish_google_action(
            SESSION_A,
            session.flow_id,
            GoogleActionKind.CALENDAR,
            action_request,
            GoogleActionStatus.UNCERTAIN,
        )
    assert not_started.value.code == "conflict"

    store.mark_google_action_executing(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.CALENDAR,
        action_request,
    )
    with pytest.raises(TutorialStoreError) as already_started:
        store.finish_google_action(
            SESSION_A,
            session.flow_id,
            GoogleActionKind.CALENDAR,
            action_request,
            GoogleActionStatus.SKIPPED,
        )
    assert already_started.value.code == "conflict"


def test_answer_comparison_is_unique_and_forget_removes_personalization_only(
    tutorial_store,
):
    store, _, _ = tutorial_store
    session = store.start_session(SESSION_A)
    store.save_preferences(SESSION_A, session.flow_id, preferences(), 10)
    approval = store.create_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
        request_id(),
        {"preferences": preferences().to_dict()},
    )
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    store.finish_google_action(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.CALENDAR,
        action_request,
        GoogleActionStatus.SUCCEEDED,
        provider_id="calendar-resource-2",
        sent_fields={"title": "해커톤 준비", "startAt": "2026-09-02T12:00:00Z"},
    )
    store.save_answer(
        SESSION_A,
        session.flow_id,
        AnswerComparison.BEFORE,
        content="개인화 답변",
        model="qwen2.5:7b",
        sources=[{"type": "vm_memory", "recordVersion": 1}],
    )
    with pytest.raises(TutorialStoreError) as duplicate_answer:
        store.save_answer(
            SESSION_A,
            session.flow_id,
            AnswerComparison.BEFORE,
            content="중복 답변",
            model="qwen2.5:7b",
            sources=[],
        )
    assert duplicate_answer.value.code == "conflict"

    store.forget(SESSION_A, session.flow_id)
    snapshot = store.get_snapshot(SESSION_A, session.flow_id)
    assert snapshot is not None
    assert snapshot.phase is TutorialPhase.FORGOTTEN
    assert store.get_preferences(SESSION_A, session.flow_id) is None
    assert store.get_google_actions(SESSION_A, session.flow_id) == []
    assert store.get_answer(
        SESSION_A, session.flow_id, AnswerComparison.BEFORE
    ) is None
    assert store.reissue_pending_approval(
        SESSION_A,
        session.flow_id,
        ApprovalPurpose.PREFERENCES,
        approval.request_id,
    ) is None

    cleanup = store.get_cleanup_entries()[0]
    assert cleanup.provider_id == "calendar-resource-2"
    assert cleanup.status == "scheduled"
    store.mark_cleanup_running(cleanup.cleanup_id)
    store.finish_cleanup(cleanup.cleanup_id, succeeded=True)
    completed = store.get_cleanup_entries()[0]
    assert completed.status == "succeeded"
    assert completed.provider_id is None


def test_restart_recovers_interrupted_external_states_without_retry_signal(tmp_path):
    db_path = tmp_path / "tutorial.sqlite"
    clock = Clock()
    store = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    session = store.start_session(SESSION_A)
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, GoogleActionKind.CALENDAR, action_request
    )
    task_request = request_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, GoogleActionKind.TASK, task_request
    )
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, GoogleActionKind.TASK, task_request
    )
    store.finish_google_action(
        SESSION_A,
        session.flow_id,
        GoogleActionKind.TASK,
        task_request,
        GoogleActionStatus.SUCCEEDED,
        provider_id="task-resource-restart",
        sent_fields={"title": "제출 확인"},
    )
    cleanup = store.get_cleanup_entries()[0]
    store.mark_cleanup_running(cleanup.cleanup_id)
    store.close()

    reopened = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    try:
        actions = reopened.get_google_actions(SESSION_A, session.flow_id)
        by_kind = {action.kind: action for action in actions}
        assert by_kind[GoogleActionKind.CALENDAR].status is GoogleActionStatus.UNCERTAIN
        assert by_kind[GoogleActionKind.TASK].status is GoogleActionStatus.SUCCEEDED
        assert reopened.list_executable_google_actions() == []
        cleanup_by_kind = {
            entry.kind: entry for entry in reopened.get_cleanup_entries()
        }
        assert cleanup_by_kind[GoogleActionKind.CALENDAR].status == "unknown"
        assert cleanup_by_kind[GoogleActionKind.CALENDAR].provider_id is None
        assert cleanup_by_kind[GoogleActionKind.CALENDAR].request_id == action_request
        assert cleanup_by_kind[GoogleActionKind.TASK].status == "failed"
        assert cleanup_by_kind[GoogleActionKind.TASK].provider_id == "task-resource-restart"
    finally:
        reopened.close()


@pytest.mark.parametrize(
    ("kind", "phase_steps", "expected_phase"),
    [
        (
            GoogleActionKind.CALENDAR,
            [
                (TutorialPhase.PREFERENCES_PENDING, TutorialPhase.PREFERENCES_SAVED),
                (TutorialPhase.PREFERENCES_SAVED, TutorialPhase.CALENDAR_PENDING),
                (TutorialPhase.CALENDAR_PENDING, TutorialPhase.CALENDAR_EXECUTING),
            ],
            TutorialPhase.TASK_PENDING,
        ),
        (
            GoogleActionKind.TASK,
            [
                (TutorialPhase.PREFERENCES_PENDING, TutorialPhase.PREFERENCES_SAVED),
                (TutorialPhase.PREFERENCES_SAVED, TutorialPhase.CALENDAR_PENDING),
                (TutorialPhase.CALENDAR_PENDING, TutorialPhase.CALENDAR_FINISHED),
                (TutorialPhase.CALENDAR_FINISHED, TutorialPhase.TASK_PENDING),
                (TutorialPhase.TASK_PENDING, TutorialPhase.TASK_EXECUTING),
            ],
            TutorialPhase.ANSWER_BEFORE,
        ),
    ],
)
def test_restart_moves_interrupted_phase_to_next_stable_step(
    tmp_path, kind, phase_steps, expected_phase
):
    db_path = tmp_path / f"{kind.value}.sqlite"
    clock = Clock()
    store = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    session = store.start_session(SESSION_A)
    for expected, replacement in phase_steps:
        store.compare_and_set_phase(
            SESSION_A, session.flow_id, expected, replacement
        )
    action_request = request_id()
    store.reserve_google_action(
        SESSION_A, session.flow_id, kind, action_request
    )
    store.mark_google_action_executing(
        SESSION_A, session.flow_id, kind, action_request
    )
    store.close()

    reopened = TutorialStore(db_path, hmac_secret=SECRET, clock=clock)
    try:
        snapshot = reopened.get_snapshot(SESSION_A, session.flow_id)
        assert snapshot is not None
        assert snapshot.phase is expected_phase
        actions = reopened.get_google_actions(SESSION_A, session.flow_id)
        interrupted = next(action for action in actions if action.kind is kind)
        assert interrupted.status is GoogleActionStatus.UNCERTAIN
        assert reopened.cleanup_status(session.flow_id, kind) == "unknown"
    finally:
        reopened.close()


def test_tutorial_settings_fail_closed_and_require_separate_database(tmp_path):
    db_path = tmp_path / "tutorial.sqlite"
    common = {
        "_env_file": None,
        "enable_hackathon_tutorial": True,
        "tutorial_db_path": str(db_path),
        "tutorial_hmac_secret": SECRET,
        "tutorial_ollama_base_url": "http://127.0.0.1:11434",
        "tutorial_ollama_model": "qwen2.5:7b",
        "enable_google_demo": True,
        "google_demo_client_id": "client-id",
        "google_demo_client_secret": "client-secret",
        "google_demo_refresh_token": "refresh-token",
        "memory_db_path": str(tmp_path / "personal.sqlite"),
        "memory_capsule_index_db_path": str(tmp_path / "capsule.sqlite"),
    }

    assert Settings(**common).hackathon_tutorial_configured is True
    assert (
        Settings(
            **{**common, "enable_hackathon_tutorial": False}
        ).hackathon_tutorial_configured
        is False
    )
    assert (
        Settings(
            **{**common, "tutorial_ollama_base_url": "https://ollama.example.com"}
        ).hackathon_tutorial_configured
        is False
    )
    assert (
        Settings(
            **{**common, "google_demo_refresh_token": ""}
        ).hackathon_tutorial_configured
        is False
    )
    assert (
        Settings(
            **{**common, "tutorial_hmac_secret": "short"}
        ).hackathon_tutorial_configured
        is False
    )
    assert (
        Settings(
            **{**common, "tutorial_db_path": common["memory_db_path"]}
        ).hackathon_tutorial_configured
        is False
    )
    assert (
        Settings(
            **{
                **common,
                "tutorial_db_path": common["memory_capsule_index_db_path"],
            }
        ).hackathon_tutorial_configured
        is False
    )
