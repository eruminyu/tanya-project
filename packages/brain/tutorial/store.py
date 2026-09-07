"""공개 해커톤 튜토리얼 전용 SQLite 저장소.

개인 기억 저장소와 의존성을 공유하지 않으며, 한 connection과 명시적
``BEGIN IMMEDIATE`` transaction을 재진입 lock으로 보호한다.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from tutorial.schemas import (
    AnswerComparison,
    ApprovalPurpose,
    CleanupEntry,
    GoogleAction,
    GoogleActionKind,
    GoogleActionStatus,
    PreparedApproval,
    SavedPreferences,
    TutorialAnswer,
    TutorialPhase,
    TutorialPreferences,
    TutorialSession,
)


_SCHEMA_VERSION = 1
_SESSION_TTL_SECONDS = 30 * 60
_APPROVAL_TTL_SECONDS = 2 * 60
_CLEANUP_DELAY_SECONDS = 30 * 60
_ALLOWED_PREPARATION_MINUTES = {5, 10, 20}
_FINAL_ACTION_STATUSES = {
    GoogleActionStatus.SUCCEEDED,
    GoogleActionStatus.FAILED,
    GoogleActionStatus.UNCERTAIN,
    GoogleActionStatus.REJECTED,
    GoogleActionStatus.SKIPPED,
}


class TutorialStoreError(RuntimeError):
    """호출자가 안전한 사용자 오류로 변환할 수 있는 저장소 오류."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class TutorialStore:
    """통합 튜토리얼의 서버 권위 상태를 보관한다."""

    def __init__(
        self,
        db_path: str | Path = "tutorial.sqlite",
        *,
        hmac_secret: str,
        clock: Callable[[], int | float] = time.time,
        busy_timeout_ms: int = 5_000,
    ) -> None:
        secret_bytes = (
            hmac_secret.encode("utf-8")
            if isinstance(hmac_secret, str)
            else b""
        )
        if len(secret_bytes) < 32:
            raise ValueError("tutorial HMAC secret must be at least 32 UTF-8 bytes")
        if busy_timeout_ms < 1_000:
            raise ValueError("busy_timeout_ms must be at least 1000")

        self._secret = secret_bytes
        self._clock = clock
        self._busy_timeout_ms = int(busy_timeout_ms)
        self._db_path = Path(db_path)
        if self._db_path.parent != Path(""):
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._closed = False
        self._conn = sqlite3.connect(
            str(self._db_path),
            check_same_thread=False,
            isolation_level=None,
            timeout=self._busy_timeout_ms / 1_000,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(f"PRAGMA busy_timeout={self._busy_timeout_ms}")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._migrate()
        self._recover_interrupted_actions()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._conn.close()
            self._closed = True

    def __enter__(self) -> "TutorialStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def schema_version(self) -> int:
        return int(self._pragma("user_version"))

    @property
    def foreign_keys_enabled(self) -> bool:
        return bool(self._pragma("foreign_keys"))

    @property
    def journal_mode(self) -> str:
        return str(self._pragma("journal_mode")).lower()

    @property
    def busy_timeout_ms(self) -> int:
        return int(self._pragma("busy_timeout"))

    def table_names(self) -> set[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        return {str(row["name"]) for row in rows}

    def hash_owner(self, session_key: str) -> str:
        identity = self._validated_identity(session_key)
        canonical_key = f"webchat:{identity}"
        return hmac.new(
            self._secret, canonical_key.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def start_session(self, session_key: str) -> TutorialSession:
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM tutorial_sessions WHERE owner_hash = ?",
                (owner_hash,),
            ).fetchone()
            if row is not None and int(row["expires_at"]) > now:
                return self._session_from_row(row)
            if row is not None:
                self._preserve_executing_as_unknown(
                    connection,
                    flow_id=str(row["flow_id"]),
                    now=now,
                )
                connection.execute(
                    "DELETE FROM tutorial_sessions WHERE flow_id = ?",
                    (row["flow_id"],),
                )

            flow_id = str(uuid.uuid4())
            expires_at = now + _SESSION_TTL_SECONDS
            connection.execute(
                """
                INSERT INTO tutorial_sessions
                    (flow_id, owner_hash, phase, created_at, expires_at, forgotten_at)
                VALUES (?, ?, ?, ?, ?, NULL)
                """,
                (
                    flow_id,
                    owner_hash,
                    TutorialPhase.PREFERENCES_PENDING.value,
                    now,
                    expires_at,
                ),
            )
            return TutorialSession(
                flow_id=flow_id,
                owner_hash=owner_hash,
                phase=TutorialPhase.PREFERENCES_PENDING,
                created_at=now,
                expires_at=expires_at,
                forgotten_at=None,
            )

    def get_snapshot(
        self, session_key: str, flow_id: str
    ) -> TutorialSession | None:
        owner_hash = self.hash_owner(session_key)
        with self._lock:
            row = self._owned_session_row(
                self._conn, owner_hash, flow_id, allow_expired=True
            )
        if row is None or int(row["expires_at"]) <= self._now():
            return None
        return self._session_from_row(row)

    def compare_and_set_phase(
        self,
        session_key: str,
        flow_id: str,
        expected: TutorialPhase,
        replacement: TutorialPhase,
    ) -> TutorialSession:
        owner_hash = self.hash_owner(session_key)
        expected = self._enum(TutorialPhase, expected)
        replacement = self._enum(TutorialPhase, replacement)
        with self._transaction() as connection:
            self._require_active_session(connection, owner_hash, flow_id)
            updated = connection.execute(
                "UPDATE tutorial_sessions SET phase = ? "
                "WHERE flow_id = ? AND phase = ?",
                (replacement.value, flow_id, expected.value),
            )
            if updated.rowcount != 1:
                raise TutorialStoreError("conflict", "튜토리얼 단계가 이미 변경되었습니다.")
            row = connection.execute(
                "SELECT * FROM tutorial_sessions WHERE flow_id = ?", (flow_id,)
            ).fetchone()
            return self._session_from_row(row)

    def save_preferences(
        self,
        session_key: str,
        flow_id: str,
        preferences: TutorialPreferences,
        preparation_minutes: int,
    ) -> SavedPreferences:
        if (
            type(preparation_minutes) is not int
            or preparation_minutes not in _ALLOWED_PREPARATION_MINUTES
        ):
            raise ValueError("preparation_minutes must be one of 5, 10, 20")
        try:
            normalized = TutorialPreferences.from_mapping(preferences.to_dict())
        except (AttributeError, ValueError) as exc:
            raise ValueError("preferences must be TutorialPreferences") from exc
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            session = self._require_active_session(connection, owner_hash, flow_id)
            self._reject_terminal_phase(session)
            connection.execute(
                """
                INSERT INTO tutorial_preferences
                    (flow_id, interaction, information, decision, planning,
                     preparation_minutes, saved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(flow_id) DO UPDATE SET
                    interaction=excluded.interaction,
                    information=excluded.information,
                    decision=excluded.decision,
                    planning=excluded.planning,
                    preparation_minutes=excluded.preparation_minutes,
                    saved_at=excluded.saved_at
                """,
                (
                    flow_id,
                    normalized.interaction.value,
                    normalized.information.value,
                    normalized.decision.value,
                    normalized.planning.value,
                    preparation_minutes,
                    now,
                ),
            )
            connection.execute(
                "UPDATE tutorial_sessions SET phase = ? WHERE flow_id = ?",
                (TutorialPhase.PREFERENCES_SAVED.value, flow_id),
            )
        return SavedPreferences(flow_id, normalized, preparation_minutes, now)

    def get_preferences(
        self, session_key: str, flow_id: str
    ) -> SavedPreferences | None:
        owner_hash = self.hash_owner(session_key)
        with self._lock:
            session = self._owned_session_row(
                self._conn, owner_hash, flow_id, allow_expired=True
            )
            if session is None or int(session["expires_at"]) <= self._now():
                return None
            row = self._conn.execute(
                "SELECT * FROM tutorial_preferences WHERE flow_id = ?", (flow_id,)
            ).fetchone()
        return self._preferences_from_row(row) if row is not None else None

    def create_approval(
        self,
        session_key: str,
        flow_id: str,
        purpose: ApprovalPurpose,
        request_id: str,
        payload: dict[str, Any],
    ) -> PreparedApproval:
        purpose = self._enum(ApprovalPurpose, purpose)
        request_id = self._canonical_uuid(request_id, "request_id")
        payload_json = self._json_object(payload, "approval payload")
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        expires_at = now + _APPROVAL_TTL_SECONDS
        token = secrets.token_urlsafe(32)
        token_hash = self._token_hash(token)
        with self._transaction() as connection:
            session = self._require_active_session(connection, owner_hash, flow_id)
            self._reject_terminal_phase(session)
            connection.execute(
                "UPDATE tutorial_approvals "
                "SET status='superseded', resolved_at=? "
                "WHERE flow_id=? AND purpose=? AND status='pending'",
                (now, flow_id, purpose.value),
            )
            connection.execute(
                """
                INSERT INTO tutorial_approvals
                    (flow_id, purpose, request_id, token_hash, payload_json,
                     status, created_at, expires_at, resolved_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
                """,
                (
                    flow_id,
                    purpose.value,
                    request_id,
                    token_hash,
                    payload_json,
                    now,
                    expires_at,
                ),
            )
        return PreparedApproval(token, request_id, purpose, json.loads(payload_json), expires_at)

    def reissue_pending_approval(
        self,
        session_key: str,
        flow_id: str,
        purpose: ApprovalPurpose,
        request_id: str,
    ) -> PreparedApproval | None:
        """Replace the latest recoverable token for one logical request."""
        purpose = self._enum(ApprovalPurpose, purpose)
        request_id = self._canonical_uuid(request_id, "request_id")
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            session = self._require_active_session(connection, owner_hash, flow_id)
            row = connection.execute(
                """
                SELECT * FROM tutorial_approvals
                WHERE flow_id=? AND purpose=?
                ORDER BY approval_id DESC LIMIT 1
                """,
                (flow_id, purpose.value),
            ).fetchone()
            if row is None or str(row["request_id"]) != request_id:
                return None
            return self._reissue_approval_row(
                connection,
                session=session,
                flow_id=flow_id,
                purpose=purpose,
                row=row,
                now=now,
            )

    def reissue_latest_recoverable_approval(
        self,
        session_key: str,
        flow_id: str,
        purpose: ApprovalPurpose,
    ) -> PreparedApproval | None:
        """재연결 시 현재 단계의 최신 복구 가능 token을 다시 발급한다."""
        purpose = self._enum(ApprovalPurpose, purpose)
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            session = self._require_active_session(connection, owner_hash, flow_id)
            row = connection.execute(
                "SELECT * FROM tutorial_approvals "
                "WHERE flow_id=? AND purpose=? "
                "ORDER BY approval_id DESC LIMIT 1",
                (flow_id, purpose.value),
            ).fetchone()
            return self._reissue_approval_row(
                connection,
                session=session,
                flow_id=flow_id,
                purpose=purpose,
                row=row,
                now=now,
            )

    def _reissue_approval_row(
        self,
        connection: sqlite3.Connection,
        *,
        session: sqlite3.Row,
        flow_id: str,
        purpose: ApprovalPurpose,
        row: sqlite3.Row | None,
        now: int,
    ) -> PreparedApproval | None:
        expected_phase = {
            ApprovalPurpose.PREFERENCES: TutorialPhase.PREFERENCES_PENDING,
            ApprovalPurpose.CALENDAR: TutorialPhase.CALENDAR_PENDING,
            ApprovalPurpose.TASK: TutorialPhase.TASK_PENDING,
        }[purpose]
        if row is None or TutorialPhase(str(session["phase"])) is not expected_phase:
            return None

        status = str(row["status"])
        if status not in {"pending", "expired"}:
            return None

        request_id = str(row["request_id"])
        if purpose in {ApprovalPurpose.CALENDAR, ApprovalPurpose.TASK}:
            action = connection.execute(
                "SELECT request_id, status FROM tutorial_google_actions "
                "WHERE flow_id=? AND kind=?",
                (flow_id, purpose.value),
            ).fetchone()
            if (
                action is None
                or str(action["request_id"]) != request_id
                or str(action["status"]) != GoogleActionStatus.PENDING.value
            ):
                return None

        if status == "pending":
            replacement = "expired" if int(row["expires_at"]) <= now else "superseded"
            connection.execute(
                "UPDATE tutorial_approvals SET status=?, resolved_at=? "
                "WHERE approval_id=? AND status='pending'",
                (replacement, now, row["approval_id"]),
            )

        token = secrets.token_urlsafe(32)
        expires_at = now + _APPROVAL_TTL_SECONDS
        connection.execute(
            """
            INSERT INTO tutorial_approvals
                (flow_id, purpose, request_id, token_hash, payload_json,
                 status, created_at, expires_at, resolved_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
            """,
            (
                flow_id,
                purpose.value,
                request_id,
                self._token_hash(token),
                row["payload_json"],
                now,
                expires_at,
            ),
        )
        payload = json.loads(str(row["payload_json"]))
        return PreparedApproval(token, request_id, purpose, payload, expires_at)

    def supersede_pending_approval(
        self,
        session_key: str,
        flow_id: str,
        purpose: ApprovalPurpose,
    ) -> None:
        """서버 권위 skip이 선택되면 노출된 raw token을 즉시 무효화한다."""
        purpose = self._enum(ApprovalPurpose, purpose)
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            self._require_active_session(connection, owner_hash, flow_id)
            connection.execute(
                "UPDATE tutorial_approvals SET status='superseded', resolved_at=? "
                "WHERE flow_id=? AND purpose=? AND status='pending'",
                (now, flow_id, purpose.value),
            )

    def consume_approval(
        self,
        session_key: str,
        flow_id: str,
        purpose: ApprovalPurpose,
        request_id: str,
        token: str,
        *,
        approved: bool = True,
    ) -> dict[str, Any]:
        purpose = self._enum(ApprovalPurpose, purpose)
        request_id = self._canonical_uuid(request_id, "request_id")
        if not isinstance(token, str) or not token:
            raise TutorialStoreError("invalid", "승인 token이 올바르지 않습니다.")
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        expired = False
        payload: dict[str, Any] | None = None
        with self._transaction() as connection:
            self._require_active_session(connection, owner_hash, flow_id)
            row = connection.execute(
                """
                SELECT * FROM tutorial_approvals
                WHERE flow_id=? AND purpose=? AND request_id=? AND status='pending'
                """,
                (flow_id, purpose.value, request_id),
            ).fetchone()
            if row is None or not hmac.compare_digest(
                str(row["token_hash"]), self._token_hash(token)
            ):
                raise TutorialStoreError("invalid", "승인 요청이 유효하지 않습니다.")
            if int(row["expires_at"]) <= now:
                connection.execute(
                    "UPDATE tutorial_approvals SET status='expired', resolved_at=? "
                    "WHERE approval_id=?",
                    (now, row["approval_id"]),
                )
                expired = True
            else:
                status = "consumed" if approved else "rejected"
                connection.execute(
                    "UPDATE tutorial_approvals SET status=?, resolved_at=? "
                    "WHERE approval_id=? AND status='pending'",
                    (status, now, row["approval_id"]),
                )
                payload = (
                    json.loads(str(row["payload_json"])) if approved else {}
                )
        if expired:
            raise TutorialStoreError("expired", "승인 요청이 만료되었습니다.")
        return payload or {}

    def reserve_google_action(
        self,
        session_key: str,
        flow_id: str,
        kind: GoogleActionKind,
        request_id: str,
    ) -> GoogleAction:
        kind = self._enum(GoogleActionKind, kind)
        request_id = self._canonical_uuid(request_id, "request_id")
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            session = self._require_active_session(connection, owner_hash, flow_id)
            self._reject_terminal_phase(session)
            existing = connection.execute(
                "SELECT * FROM tutorial_google_actions WHERE flow_id=? AND kind=?",
                (flow_id, kind.value),
            ).fetchone()
            if existing is not None:
                if existing["request_id"] == request_id:
                    return self._google_action_from_row(existing)
                raise TutorialStoreError(
                    "conflict", "이 단계의 Google action이 이미 존재합니다."
                )
            connection.execute(
                """
                INSERT INTO tutorial_google_actions
                    (flow_id, kind, request_id, status, provider_id,
                     sent_fields_json, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)
                """,
                (flow_id, kind.value, request_id, now, now),
            )
            row = connection.execute(
                "SELECT * FROM tutorial_google_actions WHERE flow_id=? AND kind=?",
                (flow_id, kind.value),
            ).fetchone()
            return self._google_action_from_row(row)

    def mark_google_action_executing(
        self,
        session_key: str,
        flow_id: str,
        kind: GoogleActionKind,
        request_id: str,
    ) -> GoogleAction:
        kind = self._enum(GoogleActionKind, kind)
        request_id = self._canonical_uuid(request_id, "request_id")
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            self._require_active_session(connection, owner_hash, flow_id)
            row = self._matching_action(connection, flow_id, kind, request_id)
            status = GoogleActionStatus(str(row["status"]))
            if status is GoogleActionStatus.EXECUTING:
                return self._google_action_from_row(row)
            if status is not GoogleActionStatus.PENDING:
                raise TutorialStoreError("conflict", "Google action을 실행할 수 없습니다.")
            connection.execute(
                "UPDATE tutorial_google_actions SET status='executing', updated_at=? "
                "WHERE flow_id=? AND kind=?",
                (now, flow_id, kind.value),
            )
            row = connection.execute(
                "SELECT * FROM tutorial_google_actions WHERE flow_id=? AND kind=?",
                (flow_id, kind.value),
            ).fetchone()
            return self._google_action_from_row(row)

    def finish_google_action(
        self,
        session_key: str,
        flow_id: str,
        kind: GoogleActionKind,
        request_id: str,
        status: GoogleActionStatus,
        *,
        provider_id: str | None = None,
        sent_fields: dict[str, Any] | None = None,
    ) -> GoogleAction:
        kind = self._enum(GoogleActionKind, kind)
        status = self._enum(GoogleActionStatus, status)
        request_id = self._canonical_uuid(request_id, "request_id")
        if status not in _FINAL_ACTION_STATUSES:
            raise ValueError("status must be a final Google action status")
        if status is GoogleActionStatus.SUCCEEDED:
            if not isinstance(provider_id, str) or not provider_id.strip():
                raise ValueError("succeeded action requires provider_id")
            sent_json = self._json_object(sent_fields, "sent_fields")
            normalized_provider_id = provider_id.strip()
        else:
            if provider_id is not None or sent_fields is not None:
                raise ValueError("non-succeeded action cannot contain provider details")
            sent_json = None
            normalized_provider_id = None

        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            # 외부 호출이 세션 만료 직후 끝나도 provider ID와 cleanup 근거를
            # 잃지 않도록 결과 확정만 예외적으로 만료 세션에 허용한다.
            self._owned_session_row(
                connection, owner_hash, flow_id, allow_expired=True
            )
            row = self._matching_action(connection, flow_id, kind, request_id)
            current = GoogleActionStatus(str(row["status"]))
            if current in _FINAL_ACTION_STATUSES:
                if current is status:
                    return self._google_action_from_row(row)
                raise TutorialStoreError("conflict", "Google action 결과가 이미 확정되었습니다.")
            if status in {
                GoogleActionStatus.SUCCEEDED,
                GoogleActionStatus.FAILED,
                GoogleActionStatus.UNCERTAIN,
            } and current is not GoogleActionStatus.EXECUTING:
                raise TutorialStoreError(
                    "conflict", "실행 전 action은 실행 결과로 확정할 수 없습니다."
                )
            if status in {
                GoogleActionStatus.REJECTED,
                GoogleActionStatus.SKIPPED,
            } and current is not GoogleActionStatus.PENDING:
                raise TutorialStoreError(
                    "conflict", "실행을 시작한 action은 거절하거나 건너뛸 수 없습니다."
                )
            connection.execute(
                """
                UPDATE tutorial_google_actions
                SET status=?, provider_id=?, sent_fields_json=?, updated_at=?
                WHERE flow_id=? AND kind=?
                """,
                (
                    status.value,
                    normalized_provider_id,
                    sent_json,
                    now,
                    flow_id,
                    kind.value,
                ),
            )
            if status in {
                GoogleActionStatus.SUCCEEDED,
                GoogleActionStatus.UNCERTAIN,
            }:
                connection.execute(
                    """
                    INSERT INTO tutorial_cleanup_queue
                        (cleanup_id, flow_id, kind, request_id, provider_id,
                         due_at, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(flow_id, kind) DO NOTHING
                    """,
                    (
                        str(uuid.uuid4()),
                        flow_id,
                        kind.value,
                        request_id,
                        normalized_provider_id,
                        (
                            now + _CLEANUP_DELAY_SECONDS
                            if status is GoogleActionStatus.SUCCEEDED
                            else now
                        ),
                        (
                            "scheduled"
                            if status is GoogleActionStatus.SUCCEEDED
                            else "unknown"
                        ),
                    ),
                )
            row = connection.execute(
                "SELECT * FROM tutorial_google_actions WHERE flow_id=? AND kind=?",
                (flow_id, kind.value),
            ).fetchone()
            return self._google_action_from_row(row)

    def get_google_actions(
        self, session_key: str, flow_id: str
    ) -> list[GoogleAction]:
        owner_hash = self.hash_owner(session_key)
        with self._lock:
            session = self._owned_session_row(
                self._conn, owner_hash, flow_id, allow_expired=True
            )
            if session is None or int(session["expires_at"]) <= self._now():
                return []
            rows = self._conn.execute(
                "SELECT * FROM tutorial_google_actions WHERE flow_id=? ORDER BY kind",
                (flow_id,),
            ).fetchall()
        return [self._google_action_from_row(row) for row in rows]

    def list_executable_google_actions(self) -> list[GoogleAction]:
        now = self._now()
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT action.* FROM tutorial_google_actions AS action
                JOIN tutorial_sessions AS session ON session.flow_id=action.flow_id
                WHERE action.status='pending' AND session.expires_at>?
                ORDER BY action.created_at
                """,
                (now,),
            ).fetchall()
        return [self._google_action_from_row(row) for row in rows]

    def cleanup_status(self, flow_id: str, kind: GoogleActionKind) -> str:
        kind = self._enum(GoogleActionKind, kind)
        with self._lock:
            row = self._conn.execute(
                "SELECT status FROM tutorial_cleanup_queue WHERE flow_id=? AND kind=?",
                (flow_id, kind.value),
            ).fetchone()
        return str(row["status"]) if row is not None else "not_required"

    def save_answer(
        self,
        session_key: str,
        flow_id: str,
        comparison: AnswerComparison,
        *,
        content: str,
        model: str,
        sources: list[dict[str, Any]],
    ) -> TutorialAnswer:
        comparison = self._enum(AnswerComparison, comparison)
        if not isinstance(content, str) or not content.strip():
            raise ValueError("answer content is required")
        if not isinstance(model, str) or not model.strip():
            raise ValueError("actual model name is required")
        sources_json = self._json_array(sources, "sources")
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            session = self._require_active_session(connection, owner_hash, flow_id)
            if (
                TutorialPhase(str(session["phase"])) is TutorialPhase.FORGOTTEN
                and comparison is not AnswerComparison.AFTER
            ):
                raise TutorialStoreError("conflict", "삭제 뒤에는 기본 답변만 저장할 수 있습니다.")
            try:
                connection.execute(
                    """
                    INSERT INTO tutorial_answers
                        (flow_id, comparison, content, provider, execution,
                         fallback, model, sources_json, created_at)
                    VALUES (?, ?, ?, 'ollama', 'local', 0, ?, ?, ?)
                    """,
                    (
                        flow_id,
                        comparison.value,
                        content.strip(),
                        model.strip(),
                        sources_json,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise TutorialStoreError("conflict", "해당 비교 답변이 이미 존재합니다.") from exc
        return TutorialAnswer(
            flow_id,
            comparison,
            content.strip(),
            model.strip(),
            json.loads(sources_json),
            now,
        )

    def get_answer(
        self,
        session_key: str,
        flow_id: str,
        comparison: AnswerComparison,
    ) -> TutorialAnswer | None:
        comparison = self._enum(AnswerComparison, comparison)
        owner_hash = self.hash_owner(session_key)
        with self._lock:
            session = self._owned_session_row(
                self._conn, owner_hash, flow_id, allow_expired=True
            )
            if session is None or int(session["expires_at"]) <= self._now():
                return None
            row = self._conn.execute(
                "SELECT * FROM tutorial_answers WHERE flow_id=? AND comparison=?",
                (flow_id, comparison.value),
            ).fetchone()
        return self._answer_from_row(row) if row is not None else None

    def forget(self, session_key: str, flow_id: str) -> TutorialSession:
        owner_hash = self.hash_owner(session_key)
        now = self._now()
        with self._transaction() as connection:
            self._require_active_session(connection, owner_hash, flow_id)
            executing = connection.execute(
                "SELECT 1 FROM tutorial_google_actions "
                "WHERE flow_id=? AND status='executing' LIMIT 1",
                (flow_id,),
            ).fetchone()
            if executing is not None:
                raise TutorialStoreError(
                    "conflict",
                    "외부 작업 결과를 확인한 뒤 삭제할 수 있습니다.",
                )
            connection.execute(
                "DELETE FROM tutorial_preferences WHERE flow_id=?", (flow_id,)
            )
            connection.execute(
                "DELETE FROM tutorial_approvals WHERE flow_id=?", (flow_id,)
            )
            connection.execute(
                "DELETE FROM tutorial_answers WHERE flow_id=?", (flow_id,)
            )
            connection.execute(
                "DELETE FROM tutorial_google_actions WHERE flow_id=?", (flow_id,)
            )
            connection.execute(
                "UPDATE tutorial_sessions SET phase=?, forgotten_at=? WHERE flow_id=?",
                (TutorialPhase.FORGOTTEN.value, now, flow_id),
            )
            row = connection.execute(
                "SELECT * FROM tutorial_sessions WHERE flow_id=?", (flow_id,)
            ).fetchone()
            return self._session_from_row(row)

    def get_cleanup_entries(self) -> list[CleanupEntry]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM tutorial_cleanup_queue ORDER BY due_at, cleanup_id"
            ).fetchall()
        return [self._cleanup_from_row(row) for row in rows]

    def list_due_cleanup(self, *, limit: int = 100) -> list[CleanupEntry]:
        if limit < 1 or limit > 1_000:
            raise ValueError("cleanup limit must be between 1 and 1000")
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM tutorial_cleanup_queue
                WHERE due_at<=? AND provider_id IS NOT NULL
                  AND status IN ('scheduled', 'failed')
                ORDER BY due_at, cleanup_id LIMIT ?
                """,
                (self._now(), limit),
            ).fetchall()
        return [self._cleanup_from_row(row) for row in rows]

    def mark_cleanup_running(self, cleanup_id: str) -> CleanupEntry:
        with self._transaction() as connection:
            updated = connection.execute(
                "UPDATE tutorial_cleanup_queue SET status='running' "
                "WHERE cleanup_id=? AND provider_id IS NOT NULL "
                "AND status IN ('scheduled', 'failed')",
                (cleanup_id,),
            )
            if updated.rowcount != 1:
                raise TutorialStoreError("conflict", "cleanup 항목을 실행할 수 없습니다.")
            row = connection.execute(
                "SELECT * FROM tutorial_cleanup_queue WHERE cleanup_id=?",
                (cleanup_id,),
            ).fetchone()
            return self._cleanup_from_row(row)

    def finish_cleanup(self, cleanup_id: str, *, succeeded: bool) -> CleanupEntry:
        with self._transaction() as connection:
            updated = connection.execute(
                """
                UPDATE tutorial_cleanup_queue
                SET status=?, provider_id=CASE WHEN ? THEN NULL ELSE provider_id END
                WHERE cleanup_id=? AND status='running'
                """,
                ("succeeded" if succeeded else "failed", int(succeeded), cleanup_id),
            )
            if updated.rowcount != 1:
                raise TutorialStoreError("conflict", "cleanup 결과를 확정할 수 없습니다.")
            row = connection.execute(
                "SELECT * FROM tutorial_cleanup_queue WHERE cleanup_id=?",
                (cleanup_id,),
            ).fetchone()
            return self._cleanup_from_row(row)

    def _migrate(self) -> None:
        with self._lock:
            version = int(self._pragma("user_version"))
            if version == _SCHEMA_VERSION:
                return
            if version != 0:
                raise RuntimeError(f"unsupported tutorial schema version: {version}")
            self._conn.executescript(
                """
                BEGIN IMMEDIATE;
                CREATE TABLE tutorial_sessions (
                    flow_id TEXT PRIMARY KEY,
                    owner_hash TEXT NOT NULL UNIQUE,
                    phase TEXT NOT NULL CHECK (phase IN (
                        'preferences_pending','preferences_saved',
                        'calendar_pending','calendar_executing','calendar_finished',
                        'task_pending','task_executing','task_finished',
                        'answer_before','receipt_ready','forgetting','forgotten',
                        'answer_after','completed'
                    )),
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    forgotten_at INTEGER,
                    CHECK (length(owner_hash)=64),
                    CHECK (created_at < expires_at)
                );
                CREATE INDEX idx_tutorial_sessions_expiry
                    ON tutorial_sessions(expires_at);

                CREATE TABLE tutorial_preferences (
                    flow_id TEXT PRIMARY KEY
                        REFERENCES tutorial_sessions(flow_id) ON DELETE CASCADE,
                    interaction TEXT NOT NULL
                        CHECK (interaction IN ('complete','interactive','neutral')),
                    information TEXT NOT NULL
                        CHECK (information IN ('concrete','big_picture','neutral')),
                    decision TEXT NOT NULL CHECK (decision IN ('evidence','context','neutral')),
                    planning TEXT NOT NULL CHECK (planning IN ('structured','flexible','neutral')),
                    preparation_minutes INTEGER NOT NULL CHECK (preparation_minutes IN (5,10,20)),
                    saved_at INTEGER NOT NULL
                );

                CREATE TABLE tutorial_approvals (
                    approval_id INTEGER PRIMARY KEY,
                    flow_id TEXT NOT NULL REFERENCES tutorial_sessions(flow_id) ON DELETE CASCADE,
                    purpose TEXT NOT NULL CHECK (purpose IN ('preferences','calendar','task')),
                    request_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL CHECK (length(token_hash)=64),
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL
                        CHECK (status IN (
                            'pending','consumed','rejected','expired','superseded'
                        )),
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    resolved_at INTEGER,
                    CHECK (created_at < expires_at)
                );
                CREATE UNIQUE INDEX uq_tutorial_pending_approval
                    ON tutorial_approvals(flow_id, purpose) WHERE status='pending';
                CREATE INDEX idx_tutorial_approval_request
                    ON tutorial_approvals(flow_id, purpose, request_id);

                CREATE TABLE tutorial_google_actions (
                    flow_id TEXT NOT NULL REFERENCES tutorial_sessions(flow_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL CHECK (kind IN ('calendar','task')),
                    request_id TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL
                        CHECK (status IN (
                            'pending','executing','succeeded','failed',
                            'uncertain','rejected','skipped'
                        )),
                    provider_id TEXT,
                    sent_fields_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (flow_id, kind)
                );

                CREATE TABLE tutorial_answers (
                    flow_id TEXT NOT NULL REFERENCES tutorial_sessions(flow_id) ON DELETE CASCADE,
                    comparison TEXT NOT NULL CHECK (comparison IN ('before','after')),
                    content TEXT NOT NULL,
                    provider TEXT NOT NULL CHECK (provider='ollama'),
                    execution TEXT NOT NULL CHECK (execution='local'),
                    fallback INTEGER NOT NULL CHECK (fallback=0),
                    model TEXT NOT NULL,
                    sources_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (flow_id, comparison)
                );

                CREATE TABLE tutorial_cleanup_queue (
                    cleanup_id TEXT PRIMARY KEY,
                    flow_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('calendar','task')),
                    request_id TEXT NOT NULL,
                    provider_id TEXT,
                    due_at INTEGER NOT NULL,
                    status TEXT NOT NULL
                        CHECK (status IN (
                            'scheduled','running','succeeded','failed','unknown'
                        )),
                    UNIQUE (flow_id, kind)
                );
                CREATE INDEX idx_tutorial_cleanup_due
                    ON tutorial_cleanup_queue(status, due_at);
                PRAGMA user_version=1;
                COMMIT;
                """
            )

    def _recover_interrupted_actions(self) -> None:
        now = self._now()
        with self._transaction() as connection:
            self._preserve_executing_as_unknown(connection, now=now)
            connection.execute(
                """
                UPDATE tutorial_sessions
                SET phase='task_pending'
                WHERE phase='calendar_executing'
                  AND EXISTS (
                    SELECT 1 FROM tutorial_google_actions AS action
                    WHERE action.flow_id=tutorial_sessions.flow_id
                      AND action.kind='calendar'
                      AND action.status='uncertain'
                  )
                """
            )
            connection.execute(
                """
                UPDATE tutorial_sessions
                SET phase='answer_before'
                WHERE phase='task_executing'
                  AND EXISTS (
                    SELECT 1 FROM tutorial_google_actions AS action
                    WHERE action.flow_id=tutorial_sessions.flow_id
                      AND action.kind='task'
                      AND action.status='uncertain'
                  )
                """
            )
            connection.execute(
                "UPDATE tutorial_cleanup_queue SET status='failed' "
                "WHERE status='running'"
            )

    def _preserve_executing_as_unknown(
        self,
        connection: sqlite3.Connection,
        *,
        now: int,
        flow_id: str | None = None,
    ) -> None:
        where = "WHERE status='executing'"
        parameters: tuple[object, ...] = ()
        if flow_id is not None:
            where += " AND flow_id=?"
            parameters = (flow_id,)
        interrupted = connection.execute(
            "SELECT flow_id, kind, request_id FROM tutorial_google_actions " + where,
            parameters,
        ).fetchall()
        for row in interrupted:
            connection.execute(
                """
                INSERT INTO tutorial_cleanup_queue
                    (cleanup_id, flow_id, kind, request_id, provider_id,
                     due_at, status)
                VALUES (?, ?, ?, ?, NULL, ?, 'unknown')
                ON CONFLICT(flow_id, kind) DO NOTHING
                """,
                (
                    str(uuid.uuid4()),
                    row["flow_id"],
                    row["kind"],
                    row["request_id"],
                    now,
                ),
            )
        connection.execute(
            "UPDATE tutorial_google_actions SET status='uncertain', updated_at=? "
            + where,
            (now, *parameters),
        )

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    def _pragma(self, name: str) -> Any:
        if name not in {"user_version", "foreign_keys", "journal_mode", "busy_timeout"}:
            raise ValueError("unsupported pragma")
        with self._lock:
            row = self._conn.execute(f"PRAGMA {name}").fetchone()
        return row[0]

    def _now(self) -> int:
        return int(self._clock())

    @staticmethod
    def _validated_identity(session_key: str) -> str:
        if not isinstance(session_key, str) or not session_key.startswith("webchat:"):
            raise TutorialStoreError("invalid", "안전한 웹 세션을 확인할 수 없습니다.")
        identity = session_key.removeprefix("webchat:")
        try:
            parsed = uuid.UUID(identity)
        except (ValueError, AttributeError) as exc:
            raise TutorialStoreError("invalid", "안전한 웹 세션을 확인할 수 없습니다.") from exc
        if parsed.version != 4 or str(parsed) != identity:
            raise TutorialStoreError("invalid", "안전한 웹 세션을 확인할 수 없습니다.")
        return identity

    @staticmethod
    def _canonical_uuid(value: str, field: str) -> str:
        try:
            parsed = uuid.UUID(value)
        except (ValueError, AttributeError, TypeError) as exc:
            raise TutorialStoreError("invalid", f"{field}가 올바르지 않습니다.") from exc
        if parsed.version != 4 or str(parsed) != value:
            raise TutorialStoreError("invalid", f"{field}가 올바르지 않습니다.")
        return str(parsed)

    @staticmethod
    def _enum(enum_type, value):
        try:
            return value if isinstance(value, enum_type) else enum_type(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"unsupported {enum_type.__name__}") from exc

    @staticmethod
    def _json_object(value: Any, name: str) -> str:
        if not isinstance(value, dict):
            raise ValueError(f"{name} must be an object")
        try:
            return json.dumps(
                value,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must contain JSON values") from exc

    @staticmethod
    def _json_array(value: Any, name: str) -> str:
        if not isinstance(value, list) or not all(
            isinstance(item, dict) for item in value
        ):
            raise ValueError(f"{name} must be a list of objects")
        try:
            return json.dumps(
                value,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must contain JSON values") from exc

    def _token_hash(self, token: str) -> str:
        return hmac.new(
            self._secret, token.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _owned_session_row(
        self,
        connection: sqlite3.Connection,
        owner_hash: str,
        flow_id: str,
        *,
        allow_expired: bool,
    ) -> sqlite3.Row | None:
        row = connection.execute(
            "SELECT * FROM tutorial_sessions WHERE flow_id=?", (flow_id,)
        ).fetchone()
        if row is None or not hmac.compare_digest(str(row["owner_hash"]), owner_hash):
            raise TutorialStoreError("not_found", "튜토리얼 세션을 찾을 수 없습니다.")
        if not allow_expired and int(row["expires_at"]) <= self._now():
            raise TutorialStoreError("expired", "튜토리얼 세션이 만료되었습니다.")
        return row

    def _require_active_session(
        self, connection: sqlite3.Connection, owner_hash: str, flow_id: str
    ) -> sqlite3.Row:
        row = self._owned_session_row(
            connection, owner_hash, flow_id, allow_expired=False
        )
        assert row is not None
        return row

    @staticmethod
    def _reject_terminal_phase(session: sqlite3.Row) -> None:
        if TutorialPhase(str(session["phase"])) in {
            TutorialPhase.FORGOTTEN,
            TutorialPhase.COMPLETED,
        }:
            raise TutorialStoreError("conflict", "종료된 튜토리얼은 변경할 수 없습니다.")

    @staticmethod
    def _session_from_row(row: sqlite3.Row) -> TutorialSession:
        return TutorialSession(
            flow_id=str(row["flow_id"]),
            owner_hash=str(row["owner_hash"]),
            phase=TutorialPhase(str(row["phase"])),
            created_at=int(row["created_at"]),
            expires_at=int(row["expires_at"]),
            forgotten_at=(
                int(row["forgotten_at"]) if row["forgotten_at"] is not None else None
            ),
        )

    @staticmethod
    def _preferences_from_row(row: sqlite3.Row) -> SavedPreferences:
        return SavedPreferences(
            flow_id=str(row["flow_id"]),
            preferences=TutorialPreferences.from_mapping(
                {
                    "interaction": row["interaction"],
                    "information": row["information"],
                    "decision": row["decision"],
                    "planning": row["planning"],
                }
            ),
            preparation_minutes=int(row["preparation_minutes"]),
            saved_at=int(row["saved_at"]),
        )

    @staticmethod
    def _google_action_from_row(row: sqlite3.Row) -> GoogleAction:
        sent_fields = (
            json.loads(str(row["sent_fields_json"]))
            if row["sent_fields_json"] is not None
            else None
        )
        return GoogleAction(
            flow_id=str(row["flow_id"]),
            kind=GoogleActionKind(str(row["kind"])),
            request_id=str(row["request_id"]),
            status=GoogleActionStatus(str(row["status"])),
            provider_id=(
                str(row["provider_id"])
                if row["provider_id"] is not None
                else None
            ),
            sent_fields=sent_fields,
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
        )

    @staticmethod
    def _matching_action(
        connection: sqlite3.Connection,
        flow_id: str,
        kind: GoogleActionKind,
        request_id: str,
    ) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM tutorial_google_actions "
            "WHERE flow_id=? AND kind=? AND request_id=?",
            (flow_id, kind.value, request_id),
        ).fetchone()
        if row is None:
            raise TutorialStoreError("not_found", "Google action을 찾을 수 없습니다.")
        return row

    @staticmethod
    def _answer_from_row(row: sqlite3.Row) -> TutorialAnswer:
        return TutorialAnswer(
            flow_id=str(row["flow_id"]),
            comparison=AnswerComparison(str(row["comparison"])),
            content=str(row["content"]),
            model=str(row["model"]),
            sources=json.loads(str(row["sources_json"])),
            created_at=int(row["created_at"]),
        )

    @staticmethod
    def _cleanup_from_row(row: sqlite3.Row) -> CleanupEntry:
        return CleanupEntry(
            cleanup_id=str(row["cleanup_id"]),
            flow_id=str(row["flow_id"]),
            kind=GoogleActionKind(str(row["kind"])),
            request_id=str(row["request_id"]),
            provider_id=(
                str(row["provider_id"])
                if row["provider_id"] is not None
                else None
            ),
            due_at=int(row["due_at"]),
            status=str(row["status"]),
        )
