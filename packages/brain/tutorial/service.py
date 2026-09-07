"""공개 해커톤 통합 튜토리얼의 서버 권위 상태기계."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
import weakref
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from importlib import resources
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from action.google_api import (
    GoogleApiClient,
    GoogleApiError,
    GoogleApiUncertainError,
)
from tutorial.ollama import StrictOllamaClient, StrictOllamaError
from tutorial.schemas import (
    AnswerComparison,
    ApprovalPurpose,
    GoogleAction,
    GoogleActionKind,
    GoogleActionStatus,
    PreparedApproval,
    TutorialPhase,
    TutorialPreferences,
    TutorialSession,
)
from tutorial.store import TutorialStore, TutorialStoreError


logger = logging.getLogger(__name__)


def _load_iana_timezones() -> frozenset[str]:
    """Load a host-independent IANA allowlist from the pinned tzdata package."""
    try:
        raw_zones = (
            resources.files("tzdata")
            .joinpath("zones")
            .read_text(encoding="utf-8")
        )
    except (AttributeError, ModuleNotFoundError, OSError, TypeError, UnicodeError):
        logger.exception("pinned tzdata timezone 목록을 불러오지 못했습니다.")
        return frozenset()

    zones = frozenset(zone.strip() for zone in raw_zones.splitlines() if zone.strip())
    if not zones:
        logger.error("pinned tzdata timezone 목록이 비어 있습니다.")
    return zones


_SCENARIO_ID = "hackathon_demo_v1"
_QUESTION_ID = "demo_preparation_summary_v1"
_IANA_TIMEZONES = _load_iana_timezones()
_PUBLIC_ERROR_MESSAGES = {
    "invalid": "요청 형식을 확인해 주세요.",
    "invalid_phase": "현재 단계에서는 이 요청을 실행할 수 없습니다.",
    "expired": "튜토리얼 세션이 만료되었습니다.",
    "conflict": "이미 처리되었거나 다른 요청이 진행 중입니다.",
    "unavailable": "통합 튜토리얼을 사용할 수 없습니다.",
    "local_model_unavailable": "로컬 답변 모델을 사용할 수 없습니다.",
    "external_failed": "Google 데모 작업을 완료하지 못했습니다.",
    "external_uncertain": "Google 생성 결과를 확인할 수 없어 자동 재시도하지 않습니다.",
}


class TutorialServiceError(RuntimeError):
    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        self.message = message or _PUBLIC_ERROR_MESSAGES.get(
            code, _PUBLIC_ERROR_MESSAGES["invalid"]
        )
        super().__init__(self.message)


class TutorialService:
    """SQLite를 source of truth로 삼는 단일 튜토리얼 service."""

    def __init__(
        self,
        *,
        store: TutorialStore,
        ollama: StrictOllamaClient,
        google: GoogleApiClient,
        clock: Callable[[], float] = time.time,
        cleanup_poll_seconds: float = 30.0,
    ) -> None:
        self._store = store
        self._ollama = ollama
        self._google = google
        self._clock = clock
        self._cleanup_poll_seconds = max(0.01, float(cleanup_poll_seconds))
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._cleanup_task: asyncio.Task | None = None

    @classmethod
    def from_settings(
        cls, settings: Any, *, store: TutorialStore
    ) -> "TutorialService":
        return cls(
            store=store,
            ollama=StrictOllamaClient(
                base_url=settings.tutorial_ollama_base_url,
                model=settings.tutorial_ollama_model,
                timeout_seconds=settings.tutorial_ollama_timeout_seconds,
                think=getattr(settings, "ollama_think", False),
                num_ctx=getattr(settings, "ollama_num_ctx", 0),
            ),
            google=GoogleApiClient(
                client_id=settings.google_demo_client_id,
                client_secret=settings.google_demo_client_secret,
                refresh_token=settings.google_demo_refresh_token,
                calendar_id=settings.google_demo_calendar_id,
                task_list_id=settings.google_demo_task_list_id,
                timeout_seconds=settings.google_demo_timeout_seconds,
            ),
            cleanup_poll_seconds=settings.tutorial_cleanup_poll_seconds,
        )

    @property
    def configured(self) -> bool:
        return bool(self._ollama.configured and self._google.configured)

    async def start(self) -> None:
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        task = self._cleanup_task
        self._cleanup_task = None
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def handle(
        self, session_key: str, action: str, payload: dict[str, Any]
    ) -> list[tuple[str, dict[str, Any]]]:
        raw_payload = payload if isinstance(payload, dict) else {}
        operation_id = self._canonical_operation(raw_payload.get("operation_id"))
        flow_hint = raw_payload.get("flow_id")
        flow_id = self._canonical_uuid(flow_hint) or ""
        if operation_id is None:
            return [self._error_event("", flow_id, "invalid")]
        if action != "tutorial_start" and not flow_id:
            return [self._error_event(operation_id, "", "invalid")]
        if not self.configured:
            return [self._error_event(operation_id, flow_id, "unavailable")]

        lock_key = f"{session_key}:{flow_id or 'start'}"
        lock = self._locks.setdefault(lock_key, asyncio.Lock())
        try:
            async with lock:
                return await self._dispatch(
                    session_key, action, raw_payload, operation_id
                )
        except TutorialServiceError as error:
            return [
                self._error_event(
                    operation_id, flow_id, error.code, error.message
                )
            ]
        except TutorialStoreError as error:
            code = error.code if error.code in {
                "invalid", "expired", "conflict"
            } else "invalid"
            return [self._error_event(operation_id, flow_id, code)]
        except (TypeError, ValueError, ZoneInfoNotFoundError):
            return [self._error_event(operation_id, flow_id, "invalid")]
        except Exception:
            logger.warning("통합 튜토리얼 요청을 안전하게 종료했습니다 action=%s", action)
            return [self._error_event(operation_id, flow_id, "unavailable")]

    def receipt(
        self, session_key: str, flow_id: str, operation_id: str
    ) -> dict[str, Any]:
        session = self._active_session(session_key, flow_id)
        preferences = self._store.get_preferences(session_key, flow_id)
        actions = {
            action.kind: action
            for action in self._store.get_google_actions(session_key, flow_id)
        }
        before = self._store.get_answer(
            session_key, flow_id, AnswerComparison.BEFORE
        )
        after = self._store.get_answer(
            session_key, flow_id, AnswerComparison.AFTER
        )
        cleanup = {
            entry.kind: entry
            for entry in self._store.get_cleanup_entries()
            if entry.flow_id == flow_id
        }
        forgotten = session.forgotten_at is not None

        def answer_payload(answer):
            if answer is None:
                return None
            return {
                "route": self._route(answer.model),
                "sources": answer.sources,
            }

        google_payload: dict[str, Any] = {}
        for kind in GoogleActionKind:
            action = actions.get(kind)
            entry = cleanup.get(kind)
            if action is None and entry is None:
                google_payload[kind.value] = None
                continue
            inferred_status = (
                action.status.value
                if action is not None
                else "uncertain" if entry and entry.status == "unknown" else "succeeded"
            )
            google_payload[kind.value] = {
                "requestId": action.request_id if action else entry.request_id,
                "providerId": action.provider_id if action else entry.provider_id,
                "status": inferred_status,
                "sentFields": None if forgotten or action is None else action.sent_fields,
                "createdAt": (
                    self._iso(action.updated_at)
                    if action and action.status is GoogleActionStatus.SUCCEEDED
                    else None
                ),
                "cleanupDueAt": (
                    self._iso(entry.due_at)
                    if entry is not None and inferred_status == "succeeded"
                    else None
                ),
                "cleanupStatus": entry.status if entry else "not_required",
            }

        preference_payload = None
        if preferences is not None and not forgotten:
            preference_payload = {
                **preferences.preferences.to_dict(),
                "preparationMinutes": preferences.preparation_minutes,
            }
        memory_status = (
            "forgotten" if forgotten else "saved" if preferences else "empty"
        )
        return {
            "flowId": flow_id,
            "operationId": operation_id,
            "expiresAt": self._iso(session.expires_at),
            "explanation": self._receipt_explanation(
                session, preferences, actions, cleanup
            ),
            "preferences": preference_payload,
            "storage": {
                "type": "sqlite",
                "execution": "self_hosted_brain_vm",
                "scope": "session",
                "memoryStatus": memory_status,
                "forgottenAt": (
                    self._iso(session.forgotten_at)
                    if session.forgotten_at is not None
                    else None
                ),
            },
            "answerBefore": None if forgotten else answer_payload(before),
            "answerAfter": answer_payload(after),
            "google": google_payload,
            "notSentToGoogle": ["preferences", "vm_memory"],
        }

    async def run_cleanup_once(self) -> int:
        processed = 0
        for entry in self._store.list_due_cleanup():
            try:
                running = self._store.mark_cleanup_running(entry.cleanup_id)
                assert running.provider_id is not None
                succeeded = await asyncio.to_thread(
                    self._google.delete,
                    running.kind.value,
                    running.provider_id,
                )
            except (GoogleApiError, TutorialStoreError):
                try:
                    self._store.finish_cleanup(entry.cleanup_id, succeeded=False)
                except TutorialStoreError:
                    pass
            except Exception:
                try:
                    self._store.finish_cleanup(entry.cleanup_id, succeeded=False)
                except TutorialStoreError:
                    pass
            else:
                self._store.finish_cleanup(
                    entry.cleanup_id, succeeded=bool(succeeded)
                )
            processed += 1
        return processed

    async def _cleanup_loop(self) -> None:
        while True:
            await self.run_cleanup_once()
            await asyncio.sleep(self._cleanup_poll_seconds)

    async def _dispatch(
        self,
        session_key: str,
        action: str,
        payload: dict[str, Any],
        operation_id: str,
    ) -> list[tuple[str, dict[str, Any]]]:
        if action == "tutorial_start":
            session = self._store.start_session(session_key)
            return [("tutorial_state", self._state(session_key, session, operation_id))]
        if action == "tutorial_resume":
            return self._resume(session_key, payload, operation_id)
        if action == "tutorial_preferences_prepare":
            return self._prepare_preferences(session_key, payload, operation_id)
        if action in {"tutorial_approve", "tutorial_reject"}:
            return await self._resolve_approval(
                session_key,
                payload,
                operation_id,
                approved=action == "tutorial_approve",
            )
        if action == "tutorial_google_prepare":
            return self._prepare_google(session_key, payload, operation_id)
        if action == "tutorial_google_skip":
            return self._skip_google(session_key, payload, operation_id)
        if action == "tutorial_answer_generate":
            return await self._generate_answer(
                session_key, payload, operation_id
            )
        if action == "tutorial_receipt_get":
            flow_id = self._flow_id(payload)
            session = self._active_session(session_key, flow_id)
            if session.phase not in {
                TutorialPhase.RECEIPT_READY,
                TutorialPhase.FORGOTTEN,
                TutorialPhase.ANSWER_AFTER,
                TutorialPhase.COMPLETED,
            }:
                raise TutorialServiceError("invalid_phase")
            return [("tutorial_receipt", self.receipt(session_key, flow_id, operation_id))]
        if action == "tutorial_forget":
            return self._forget(session_key, payload, operation_id)
        raise TutorialServiceError("invalid")

    def _resume(
        self, session_key: str, payload: dict[str, Any], operation_id: str
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        events: list[tuple[str, dict[str, Any]]] = [
            ("tutorial_state", self._state(session_key, session, operation_id))
        ]
        purpose = {
            TutorialPhase.PREFERENCES_PENDING: ApprovalPurpose.PREFERENCES,
            TutorialPhase.CALENDAR_PENDING: ApprovalPurpose.CALENDAR,
            TutorialPhase.TASK_PENDING: ApprovalPurpose.TASK,
        }.get(session.phase)
        if purpose is not None:
            renewed = self._store.reissue_latest_recoverable_approval(
                session_key, flow_id, purpose
            )
            if renewed is not None:
                events.append(
                    ("tutorial_approval_required", self._approval_event(
                        flow_id, operation_id, renewed
                    ))
                )
        if session.phase is TutorialPhase.RECEIPT_READY:
            events.append(
                ("tutorial_receipt", self.receipt(session_key, flow_id, operation_id))
            )
        return events

    def _prepare_preferences(
        self, session_key: str, payload: dict[str, Any], operation_id: str
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        self._require_phase(session, TutorialPhase.PREFERENCES_PENDING)
        preferences = TutorialPreferences.from_mapping(payload.get("preferences"))
        preparation_minutes = payload.get("preparation_minutes")
        if type(preparation_minutes) is not int or preparation_minutes not in {5, 10, 20}:
            raise TutorialServiceError("invalid")
        request_id = str(uuid.uuid4())
        fields = {
            **preferences.to_dict(),
            "preparationMinutes": preparation_minutes,
        }
        preview = {
            "kind": "tutorial_preferences_store",
            "fields": fields,
            "executor": "tutorial_service/sqlite",
            "message": "승인 전에는 응답 설정을 저장하지 않습니다.",
            "explanation": self._explanation(
                session=session,
                data_type="proposed_tutorial_preferences",
                exact_kind="tutorial_preferences_store",
                fields=fields,
                executor_type="tutorial_service",
                executor_target="sqlite",
            ),
        }
        approval = self._store.create_approval(
            session_key,
            flow_id,
            ApprovalPurpose.PREFERENCES,
            request_id,
            {
                "preferences": preferences.to_dict(),
                "preparation_minutes": preparation_minutes,
                "preview": preview,
            },
        )
        return [("tutorial_approval_required", self._approval_event(
            flow_id, operation_id, approval
        ))]

    def _prepare_google(
        self, session_key: str, payload: dict[str, Any], operation_id: str
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        kind = self._google_kind(payload.get("kind"))
        self._require_google_pending_phase(session, kind)
        if payload.get("scenario_id") != _SCENARIO_ID:
            raise TutorialServiceError("invalid")
        timezone_name = payload.get("timezone")
        if (
            not isinstance(timezone_name, str)
            or len(timezone_name) > 64
            or timezone_name not in _IANA_TIMEZONES
        ):
            raise TutorialServiceError("invalid")
        timezone_value = ZoneInfo(timezone_name)
        draft = self._google_draft(
            session_key, flow_id, kind, timezone_name, timezone_value
        )
        saved_preferences = self._store.get_preferences(session_key, flow_id)
        if saved_preferences is None:
            raise TutorialServiceError("invalid_phase")
        request_id = str(uuid.uuid4())
        self._store.reserve_google_action(
            session_key, flow_id, kind, request_id
        )
        exact_kind = (
            "google_calendar_create"
            if kind is GoogleActionKind.CALENDAR
            else "google_task_create"
        )
        preview = {
            "kind": kind.value,
            "fields": draft,
            "executor": "public_demo_brain/google",
            "accountScope": "shared_demo_account",
            "message": (
                "아직 Google에는 변경이 없습니다. 승인하면 공용 데모 Brain이 "
                "표시된 필드만 전송하고 성공 30분 뒤 자동 삭제합니다."
            ),
            "explanation": self._explanation(
                session=session,
                data_type="approved_tutorial_preferences",
                exact_kind=exact_kind,
                fields=draft,
                executor_type="public_demo_brain",
                executor_target="google",
                data_updated_at=saved_preferences.saved_at,
            ),
        }
        approval = self._store.create_approval(
            session_key,
            flow_id,
            ApprovalPurpose(kind.value),
            request_id,
            {"kind": kind.value, "draft": draft, "preview": preview},
        )
        return [("tutorial_approval_required", self._approval_event(
            flow_id, operation_id, approval
        ))]

    async def _resolve_approval(
        self,
        session_key: str,
        payload: dict[str, Any],
        operation_id: str,
        *,
        approved: bool,
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        purpose = self._purpose_for_phase(session.phase)
        request_id = payload.get("request_id")
        token = payload.get("approval_token")
        if not isinstance(request_id, str) or not isinstance(token, str):
            raise TutorialServiceError("invalid")
        stored = self._store.consume_approval(
            session_key,
            flow_id,
            purpose,
            request_id,
            token,
            approved=approved,
        )
        if purpose is ApprovalPurpose.PREFERENCES:
            if not approved:
                return [("tutorial_state", self._state(
                    session_key, session, operation_id
                ))]
            preferences = TutorialPreferences.from_mapping(stored["preferences"])
            saved = self._store.save_preferences(
                session_key,
                flow_id,
                preferences,
                stored["preparation_minutes"],
            )
            del saved
            session = self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.PREFERENCES_SAVED,
                TutorialPhase.CALENDAR_PENDING,
            )
            return [("tutorial_state", self._state(
                session_key, session, operation_id
            ))]

        kind = GoogleActionKind(purpose.value)
        if not approved:
            action = self._store.finish_google_action(
                session_key,
                flow_id,
                kind,
                request_id,
                GoogleActionStatus.REJECTED,
            )
            session = self._advance_google_phase(session_key, flow_id, kind)
            return [
                ("tutorial_google_result", self._google_result(
                    flow_id, operation_id, action
                )),
                ("tutorial_state", self._state(session_key, session, operation_id)),
            ]

        expected = (
            TutorialPhase.CALENDAR_PENDING
            if kind is GoogleActionKind.CALENDAR
            else TutorialPhase.TASK_PENDING
        )
        executing = (
            TutorialPhase.CALENDAR_EXECUTING
            if kind is GoogleActionKind.CALENDAR
            else TutorialPhase.TASK_EXECUTING
        )
        self._store.compare_and_set_phase(
            session_key, flow_id, expected, executing
        )
        self._store.mark_google_action_executing(
            session_key, flow_id, kind, request_id
        )
        current = self._active_session(session_key, flow_id)
        remaining = current.expires_at - self._now()
        provider_id: str | None = None
        if remaining < int(self._google.timeout_seconds) + 5:
            status = GoogleActionStatus.FAILED
        else:
            try:
                provider_id = await asyncio.to_thread(
                    self._google.create, kind.value, stored["draft"]
                )
            except GoogleApiUncertainError:
                status = GoogleActionStatus.UNCERTAIN
            except GoogleApiError:
                status = GoogleActionStatus.FAILED
            else:
                status = GoogleActionStatus.SUCCEEDED

        action = self._store.finish_google_action(
            session_key,
            flow_id,
            kind,
            request_id,
            status,
            provider_id=provider_id if status is GoogleActionStatus.SUCCEEDED else None,
            sent_fields=stored["draft"] if status is GoogleActionStatus.SUCCEEDED else None,
        )
        session = self._advance_google_phase(session_key, flow_id, kind)
        return [
            ("tutorial_google_result", self._google_result(
                flow_id, operation_id, action
            )),
            ("tutorial_state", self._state(session_key, session, operation_id)),
        ]

    def _skip_google(
        self, session_key: str, payload: dict[str, Any], operation_id: str
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        kind = self._google_kind(payload.get("kind"))
        self._require_google_pending_phase(session, kind)
        existing = next(
            (
                action
                for action in self._store.get_google_actions(session_key, flow_id)
                if action.kind is kind
            ),
            None,
        )
        if existing is None:
            request_id = str(uuid.uuid4())
            self._store.reserve_google_action(
                session_key, flow_id, kind, request_id
            )
        elif existing.status is GoogleActionStatus.PENDING:
            request_id = existing.request_id
            self._store.supersede_pending_approval(
                session_key, flow_id, ApprovalPurpose(kind.value)
            )
        else:
            raise TutorialServiceError("conflict")
        action = self._store.finish_google_action(
            session_key,
            flow_id,
            kind,
            request_id,
            GoogleActionStatus.SKIPPED,
        )
        session = self._advance_google_phase(session_key, flow_id, kind)
        return [
            ("tutorial_google_result", self._google_result(
                flow_id, operation_id, action
            )),
            ("tutorial_state", self._state(session_key, session, operation_id)),
        ]

    async def _generate_answer(
        self, session_key: str, payload: dict[str, Any], operation_id: str
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        try:
            comparison = AnswerComparison(payload.get("comparison"))
        except (TypeError, ValueError):
            raise TutorialServiceError("invalid") from None
        if payload.get("question_id") != _QUESTION_ID:
            raise TutorialServiceError("invalid")
        expected = (
            TutorialPhase.ANSWER_BEFORE
            if comparison is AnswerComparison.BEFORE
            else TutorialPhase.FORGOTTEN
        )
        self._require_phase(session, expected)
        prompt, applied, sources = self._answer_prompt(
            session_key, flow_id, comparison
        )
        try:
            result = await self._ollama.generate(
                prompt,
                "서버가 제공한 근거만 사용하고 한국어로 간결하게 답하세요.",
            )
        except StrictOllamaError:
            raise TutorialServiceError("local_model_unavailable") from None
        answer = self._store.save_answer(
            session_key,
            flow_id,
            comparison,
            content=result.content,
            model=result.model,
            sources=sources,
        )
        if comparison is AnswerComparison.BEFORE:
            session = self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.ANSWER_BEFORE,
                TutorialPhase.RECEIPT_READY,
            )
        else:
            self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.FORGOTTEN,
                TutorialPhase.ANSWER_AFTER,
            )
            session = self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.ANSWER_AFTER,
                TutorialPhase.COMPLETED,
            )
        completed = {
            "flowId": flow_id,
            "operationId": operation_id,
            "comparison": comparison.value,
            "content": answer.content,
            "route": self._route(answer.model),
            "appliedPreferences": applied,
            "sources": answer.sources,
        }
        return [
            ("tutorial_answer_started", {
                "flowId": flow_id,
                "operationId": operation_id,
                "comparison": comparison.value,
            }),
            ("tutorial_answer_completed", completed),
            ("tutorial_state", self._state(session_key, session, operation_id)),
        ]

    def _forget(
        self, session_key: str, payload: dict[str, Any], operation_id: str
    ) -> list[tuple[str, dict[str, Any]]]:
        flow_id = self._flow_id(payload)
        session = self._active_session(session_key, flow_id)
        self._require_phase(session, TutorialPhase.RECEIPT_READY)
        self._store.compare_and_set_phase(
            session_key,
            flow_id,
            TutorialPhase.RECEIPT_READY,
            TutorialPhase.FORGETTING,
        )
        session = self._store.forget(session_key, flow_id)
        cleanup = {
            entry.kind.value: entry.status
            for entry in self._store.get_cleanup_entries()
            if entry.flow_id == flow_id
        }
        event = {
            "flowId": flow_id,
            "operationId": operation_id,
            "memoryStatus": "forgotten",
            "forgottenAt": self._iso(session.forgotten_at),
            "googleCleanup": {
                "calendar": cleanup.get("calendar", "not_required"),
                "task": cleanup.get("task", "not_required"),
            },
        }
        return [
            ("tutorial_forgotten", event),
            ("tutorial_state", self._state(session_key, session, operation_id)),
        ]

    def _answer_prompt(
        self,
        session_key: str,
        flow_id: str,
        comparison: AnswerComparison,
    ) -> tuple[str, dict[str, str], list[dict[str, Any]]]:
        if comparison is AnswerComparison.AFTER:
            return (
                "개인화 기억을 삭제한 상태입니다. 해커톤 준비를 위한 일반적인 "
                "짧은 체크리스트를 작성하세요.",
                {},
                [],
            )
        saved = self._store.get_preferences(session_key, flow_id)
        if saved is None:
            raise TutorialServiceError("invalid_phase")
        actions = [
            action
            for action in self._store.get_google_actions(session_key, flow_id)
            if action.status is GoogleActionStatus.SUCCEEDED
        ]
        sources: list[dict[str, Any]] = [
            {"type": "vm_memory", "recordVersion": 1}
        ]
        grounded: list[dict[str, Any]] = []
        for action in actions:
            source_type = f"google_{action.kind.value}_receipt"
            sources.append({
                "type": source_type,
                "requestId": action.request_id,
                "providerId": action.provider_id,
            })
            grounded.append({
                "kind": action.kind.value,
                "requestId": action.request_id,
                "providerId": action.provider_id,
                "sentFields": action.sent_fields,
            })
        applied = saved.preferences.to_dict()
        prompt = (
            "다음 승인된 공개 튜토리얼 정보만 근거로 해커톤 준비 요약을 작성하세요.\n"
            + json.dumps(
                {
                    "preferences": applied,
                    "preparationMinutes": saved.preparation_minutes,
                    "googleReceipts": grounded,
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return prompt, applied, sources

    def _advance_google_phase(
        self, session_key: str, flow_id: str, kind: GoogleActionKind
    ) -> TutorialSession:
        if kind is GoogleActionKind.CALENDAR:
            current = self._active_session(session_key, flow_id)
            if current.phase is TutorialPhase.CALENDAR_PENDING:
                self._store.compare_and_set_phase(
                    session_key,
                    flow_id,
                    TutorialPhase.CALENDAR_PENDING,
                    TutorialPhase.CALENDAR_FINISHED,
                )
            else:
                self._store.compare_and_set_phase(
                    session_key,
                    flow_id,
                    TutorialPhase.CALENDAR_EXECUTING,
                    TutorialPhase.CALENDAR_FINISHED,
                )
            return self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.CALENDAR_FINISHED,
                TutorialPhase.TASK_PENDING,
            )
        current = self._active_session(session_key, flow_id)
        if current.phase is TutorialPhase.TASK_PENDING:
            self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.TASK_PENDING,
                TutorialPhase.TASK_FINISHED,
            )
        else:
            self._store.compare_and_set_phase(
                session_key,
                flow_id,
                TutorialPhase.TASK_EXECUTING,
                TutorialPhase.TASK_FINISHED,
            )
        return self._store.compare_and_set_phase(
            session_key,
            flow_id,
            TutorialPhase.TASK_FINISHED,
            TutorialPhase.ANSWER_BEFORE,
        )

    def _google_draft(
        self,
        session_key: str,
        flow_id: str,
        kind: GoogleActionKind,
        timezone_name: str,
        timezone_value: ZoneInfo,
    ) -> dict[str, Any]:
        saved = self._store.get_preferences(session_key, flow_id)
        if saved is None:
            raise TutorialServiceError("invalid_phase")
        local_now = datetime.fromtimestamp(self._now(), tz=timezone_value)
        if kind is GoogleActionKind.CALENDAR:
            start = local_now + timedelta(minutes=saved.preparation_minutes)
            end = start + timedelta(minutes=30)
            return {
                "title": "Tanya 해커톤 준비 점검",
                "startAt": start.isoformat(timespec="seconds"),
                "endAt": end.isoformat(timespec="seconds"),
                "timeZone": timezone_name,
            }
        return {
            "title": "Tanya 해커톤 발표 준비",
            "due": (local_now.date() + timedelta(days=1)).isoformat(),
        }

    def _state(
        self,
        session_key: str,
        session: TutorialSession,
        operation_id: str,
    ) -> dict[str, Any]:
        actions = {
            action.kind: action.status.value
            for action in self._store.get_google_actions(
                session_key, session.flow_id
            )
        }
        preferences = self._store.get_preferences(session_key, session.flow_id)
        return {
            "flowId": session.flow_id,
            "operationId": operation_id,
            "phase": session.phase.value,
            "expiresAt": self._iso(session.expires_at),
            "calendarStatus": actions.get(GoogleActionKind.CALENDAR),
            "taskStatus": actions.get(GoogleActionKind.TASK),
            "memoryStatus": (
                "forgotten"
                if session.forgotten_at is not None
                else "saved" if preferences is not None else "empty"
            ),
        }

    def _google_result(
        self,
        flow_id: str,
        operation_id: str,
        action: GoogleAction,
    ) -> dict[str, Any]:
        cleanup = next(
            (
                entry
                for entry in self._store.get_cleanup_entries()
                if entry.flow_id == flow_id and entry.kind is action.kind
            ),
            None,
        )
        succeeded = action.status is GoogleActionStatus.SUCCEEDED
        return {
            "flowId": flow_id,
            "operationId": operation_id,
            "requestId": action.request_id,
            "kind": action.kind.value,
            "status": action.status.value,
            "providerId": action.provider_id if succeeded else None,
            "sentFields": action.sent_fields if succeeded else None,
            "createdAt": self._iso(action.updated_at) if succeeded else None,
            "resolvedAt": self._iso(action.updated_at),
            "cleanupDueAt": (
                self._iso(cleanup.due_at)
                if cleanup is not None and succeeded
                else None
            ),
            "cleanupStatus": cleanup.status if cleanup else "not_required",
        }

    def _approval_event(
        self,
        flow_id: str,
        operation_id: str,
        approval: PreparedApproval,
    ) -> dict[str, Any]:
        return {
            "flowId": flow_id,
            "operationId": operation_id,
            "requestId": approval.request_id,
            "purpose": approval.purpose.value,
            "approvalToken": approval.token,
            "expiresAt": self._iso(approval.expires_at),
            "preview": approval.payload["preview"],
        }

    def _explanation(
        self,
        *,
        session: TutorialSession,
        data_type: str,
        exact_kind: str,
        fields: dict[str, Any],
        executor_type: str,
        executor_target: str,
        data_updated_at: int | None = None,
    ) -> dict[str, Any]:
        return {
            "whyNow": {
                "code": "user_requested_tutorial_step",
                "summary": "사용자가 현재 튜토리얼 단계를 요청했어요.",
            },
            "dataUsed": [{
                "type": data_type,
                "updatedAt": self._iso(
                    self._now() if data_updated_at is None else data_updated_at
                ),
            }],
            "processing": {
                "location": "self_hosted_brain_vm",
                "route": "tutorial_service",
            },
            "exactChange": {"kind": exact_kind, "fields": fields},
            "executor": {"type": executor_type, "target": executor_target},
            "approval": {"status": "required", "executesOnApproval": True},
            "changeState": "not_executed",
            "retention": {
                "memoryExpiresAt": self._iso(session.expires_at),
                "googleCleanupAfterMinutes": 30,
                "googleCleanupDueAt": None,
            },
        }

    def _receipt_explanation(
        self, session, preferences, actions, cleanup
    ) -> dict[str, Any]:
        statuses = {
            kind: action.status for kind, action in actions.items()
        }
        for kind, entry in cleanup.items():
            statuses.setdefault(
                kind,
                (
                    GoogleActionStatus.UNCERTAIN
                    if entry.status == "unknown"
                    else GoogleActionStatus.SUCCEEDED
                ),
            )
        successful_kinds = {
            kind
            for kind, status in statuses.items()
            if status is GoogleActionStatus.SUCCEEDED
        }
        successful_actions = [
            action
            for action in actions.values()
            if action.status is GoogleActionStatus.SUCCEEDED
        ]
        action_statuses = list(statuses.values())
        uncertain = (
            GoogleActionStatus.UNCERTAIN in action_statuses
            or any(entry.status == "unknown" for entry in cleanup.values())
        )
        attempted = any(
            status in {
                GoogleActionStatus.SUCCEEDED,
                GoogleActionStatus.FAILED,
                GoogleActionStatus.UNCERTAIN,
            }
            for status in action_statuses
        ) or bool(cleanup)
        if attempted:
            approval_status = "approved"
        elif GoogleActionStatus.REJECTED in action_statuses:
            approval_status = "rejected"
        elif GoogleActionStatus.SKIPPED in action_statuses:
            approval_status = "skipped"
        else:
            approval_status = "not_required"
        data_used = ([{
            "type": "approved_tutorial_preferences",
            "updatedAt": self._iso(preferences.saved_at),
        }] if preferences else [])
        data_used.extend({
            "type": f"approved_{action.kind.value}_receipt",
            "updatedAt": self._iso(action.updated_at),
        } for action in successful_actions)
        actual_due_values = [
            entry.due_at
            for kind, entry in cleanup.items()
            if kind in successful_kinds
        ]
        return {
            "whyNow": {
                "code": "user_started_public_tutorial",
                "summary": "사용자가 공개 체험을 시작했어요.",
            },
            "dataUsed": data_used,
            "processing": {
                "location": "self_hosted_brain_vm",
                "route": "strict_ollama",
            },
            "exactChange": {
                "kind": "tutorial_receipt",
                "fields": {
                    "google": {
                        kind.value: status.value
                        for kind, status in statuses.items()
                    }
                },
            },
            "executor": {
                "type": "public_demo_brain",
                "target": "google" if attempted else "sqlite",
            },
            "approval": {"status": approval_status},
            "changeState": (
                "uncertain" if uncertain
                else "completed" if successful_kinds else "not_run"
            ),
            "retention": {
                "memoryExpiresAt": self._iso(session.expires_at),
                "googleCleanupAfterMinutes": 30,
                "googleCleanupDueAt": (
                    self._iso(max(actual_due_values))
                    if actual_due_values else None
                ),
            },
        }

    def _active_session(self, session_key: str, flow_id: str) -> TutorialSession:
        session = self._store.get_snapshot(session_key, flow_id)
        if session is None:
            raise TutorialServiceError("expired")
        return session

    @staticmethod
    def _require_phase(session: TutorialSession, expected: TutorialPhase) -> None:
        if session.phase is not expected:
            raise TutorialServiceError("invalid_phase")

    def _require_google_pending_phase(
        self, session: TutorialSession, kind: GoogleActionKind
    ) -> None:
        expected = (
            TutorialPhase.CALENDAR_PENDING
            if kind is GoogleActionKind.CALENDAR
            else TutorialPhase.TASK_PENDING
        )
        self._require_phase(session, expected)

    @staticmethod
    def _purpose_for_phase(phase: TutorialPhase) -> ApprovalPurpose:
        try:
            return {
                TutorialPhase.PREFERENCES_PENDING: ApprovalPurpose.PREFERENCES,
                TutorialPhase.CALENDAR_PENDING: ApprovalPurpose.CALENDAR,
                TutorialPhase.TASK_PENDING: ApprovalPurpose.TASK,
            }[phase]
        except KeyError:
            raise TutorialServiceError("invalid_phase") from None

    @staticmethod
    def _google_kind(value: Any) -> GoogleActionKind:
        try:
            return GoogleActionKind(value)
        except (TypeError, ValueError):
            raise TutorialServiceError("invalid") from None

    @staticmethod
    def _flow_id(payload: dict[str, Any]) -> str:
        flow_id = payload.get("flow_id")
        if not isinstance(flow_id, str) or not flow_id:
            raise TutorialServiceError("invalid")
        return flow_id

    @staticmethod
    def _canonical_operation(value: Any) -> str | None:
        return TutorialService._canonical_uuid(value)

    @staticmethod
    def _canonical_uuid(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        try:
            parsed = uuid.UUID(value)
        except (ValueError, AttributeError):
            return None
        return str(parsed) if parsed.version == 4 and str(parsed) == value else None

    @staticmethod
    def _route(model: str) -> dict[str, Any]:
        return {
            "provider": "ollama",
            "execution": "local",
            "fallback": False,
            "model": model,
        }

    @staticmethod
    def _iso(value: int | None) -> str | None:
        if value is None:
            return None
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )

    def _now(self) -> int:
        return int(self._clock())

    @staticmethod
    def _error_event(
        operation_id: str,
        flow_id: str,
        code: str,
        message: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        return (
            "tutorial_error",
            {
                "flowId": flow_id,
                "operationId": operation_id,
                "code": code,
                "message": message or _PUBLIC_ERROR_MESSAGES.get(
                    code, _PUBLIC_ERROR_MESSAGES["invalid"]
                ),
            },
        )
