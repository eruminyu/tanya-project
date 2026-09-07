"""통합 튜토리얼 SQLite 경계에서 사용하는 값 객체."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping


class TutorialPhase(str, Enum):
    PREFERENCES_PENDING = "preferences_pending"
    PREFERENCES_SAVED = "preferences_saved"
    CALENDAR_PENDING = "calendar_pending"
    CALENDAR_EXECUTING = "calendar_executing"
    CALENDAR_FINISHED = "calendar_finished"
    TASK_PENDING = "task_pending"
    TASK_EXECUTING = "task_executing"
    TASK_FINISHED = "task_finished"
    ANSWER_BEFORE = "answer_before"
    RECEIPT_READY = "receipt_ready"
    FORGETTING = "forgetting"
    FORGOTTEN = "forgotten"
    ANSWER_AFTER = "answer_after"
    COMPLETED = "completed"


class InteractionStyle(str, Enum):
    COMPLETE = "complete"
    INTERACTIVE = "interactive"
    NEUTRAL = "neutral"


class InformationStyle(str, Enum):
    CONCRETE = "concrete"
    BIG_PICTURE = "big_picture"
    NEUTRAL = "neutral"


class DecisionStyle(str, Enum):
    EVIDENCE = "evidence"
    CONTEXT = "context"
    NEUTRAL = "neutral"


class PlanningStyle(str, Enum):
    STRUCTURED = "structured"
    FLEXIBLE = "flexible"
    NEUTRAL = "neutral"


class ApprovalPurpose(str, Enum):
    PREFERENCES = "preferences"
    CALENDAR = "calendar"
    TASK = "task"


class GoogleActionKind(str, Enum):
    CALENDAR = "calendar"
    TASK = "task"


class GoogleActionStatus(str, Enum):
    PENDING = "pending"
    EXECUTING = "executing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNCERTAIN = "uncertain"
    REJECTED = "rejected"
    SKIPPED = "skipped"


class AnswerComparison(str, Enum):
    BEFORE = "before"
    AFTER = "after"


@dataclass(frozen=True)
class TutorialPreferences:
    interaction: InteractionStyle
    information: InformationStyle
    decision: DecisionStyle
    planning: PlanningStyle

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any]) -> "TutorialPreferences":
        if not isinstance(values, Mapping):
            raise ValueError("preferences must be an object")
        expected = {"interaction", "information", "decision", "planning"}
        if set(values) != expected:
            raise ValueError("preferences must contain exactly four supported keys")
        try:
            return cls(
                interaction=InteractionStyle(values["interaction"]),
                information=InformationStyle(values["information"]),
                decision=DecisionStyle(values["decision"]),
                planning=PlanningStyle(values["planning"]),
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("preferences contain an unsupported value") from exc

    def to_dict(self) -> dict[str, str]:
        return {
            "interaction": self.interaction.value,
            "information": self.information.value,
            "decision": self.decision.value,
            "planning": self.planning.value,
        }


@dataclass(frozen=True)
class TutorialSession:
    flow_id: str
    owner_hash: str
    phase: TutorialPhase
    created_at: int
    expires_at: int
    forgotten_at: int | None


@dataclass(frozen=True)
class SavedPreferences:
    flow_id: str
    preferences: TutorialPreferences
    preparation_minutes: int
    saved_at: int


@dataclass(frozen=True)
class PreparedApproval:
    token: str
    request_id: str
    purpose: ApprovalPurpose
    payload: dict[str, Any]
    expires_at: int


@dataclass(frozen=True)
class GoogleAction:
    flow_id: str
    kind: GoogleActionKind
    request_id: str
    status: GoogleActionStatus
    provider_id: str | None
    sent_fields: dict[str, Any] | None
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class TutorialAnswer:
    flow_id: str
    comparison: AnswerComparison
    content: str
    model: str
    sources: list[dict[str, Any]]
    created_at: int


@dataclass(frozen=True)
class CleanupEntry:
    cleanup_id: str
    flow_id: str
    kind: GoogleActionKind
    request_id: str
    provider_id: str | None
    due_at: int
    status: str
