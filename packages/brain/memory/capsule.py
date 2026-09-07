"""공개 웹 체험용, 세션 격리 기억 캡슐.

CouchDB를 원본으로 두고 전용 SQLite/FTS5/sqlite-vec 인덱스를 changes
checkpoint로 동기화한다. 개인 장기 기억 테이블과는 어떤 행도 공유하지 않는다.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import secrets
import struct
import threading
import time
import uuid
import weakref
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import quote

import requests

from memory.store import MemoryCapsuleIndexStore

logger = logging.getLogger(__name__)

_ALLOWED_MINUTES = frozenset({10, 20, 30})
_DOC_TYPE = "tanya_public_memory_capsule_v1"
_SOURCE_TYPE = "explicit_choice"
_SOURCE_LABEL = "준비 시간 선택"
_RECALL_QUERY = "일정 전에 준비하는 데 어느 정도 시간을 선호하나요"
_FTS_QUERY = '"준비" OR "시간" OR "선호"'


class MemoryCapsuleError(Exception):
    """클라이언트에 안전하게 노출할 수 있는 기억 캡슐 오류."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class CouchDBRepositoryError(RuntimeError):
    """URL·인증정보·응답 본문을 외부로 전달하지 않는 저장소 내부 오류."""


class CouchDBMemoryCapsuleRepository:
    """전용 CouchDB 데이터베이스의 최소 transport."""

    def __init__(
        self,
        *,
        base_url: str,
        database: str,
        username: str,
        password: str,
        timeout_seconds: float = 5.0,
        transport: Any = requests,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._database = database
        self._auth = (username, password)
        self._timeout = timeout_seconds
        self._transport = transport
        self._ready = False
        self._ready_lock = threading.Lock()

    @property
    def database(self) -> str:
        return self._database

    @property
    def _database_url(self) -> str:
        return f"{self._base_url}/{quote(self._database, safe='')}"

    def _request(self, method: str, url: str, **kwargs: Any):
        try:
            return self._transport.request(
                method,
                url,
                auth=self._auth,
                timeout=self._timeout,
                **kwargs,
            )
        except Exception as exc:
            raise CouchDBRepositoryError("CouchDB request failed") from exc

    @staticmethod
    def _json(response: Any) -> dict[str, Any]:
        try:
            data = response.json()
        except Exception as exc:
            raise CouchDBRepositoryError("CouchDB returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise CouchDBRepositoryError("CouchDB returned an invalid payload")
        return data

    def ensure_database(self) -> None:
        if self._ready:
            return
        with self._ready_lock:
            if self._ready:
                return
            response = self._request("GET", self._database_url)
            if response.status_code == 404:
                created = self._request("PUT", self._database_url)
                if created.status_code not in {201, 202, 412}:
                    raise CouchDBRepositoryError("CouchDB database creation failed")
            elif response.status_code != 200:
                raise CouchDBRepositoryError("CouchDB database check failed")
            index = self._request(
                "POST",
                f"{self._database_url}/_index",
                json={
                    "index": {
                        "fields": ["type", "owner_hash", "expires_at_epoch"]
                    },
                    "name": "memory-capsule-owner-expiry",
                    "type": "json",
                },
            )
            if index.status_code not in {200, 201}:
                raise CouchDBRepositoryError("CouchDB index creation failed")
            self._ready = True

    def get(self, doc_id: str) -> dict[str, Any] | None:
        response = self._request(
            "GET", f"{self._database_url}/{quote(doc_id, safe='')}"
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise CouchDBRepositoryError("CouchDB document read failed")
        return self._json(response)

    def put(self, document: dict[str, Any]) -> dict[str, Any]:
        doc_id = str(document.get("_id") or "")
        if not doc_id:
            raise ValueError("CouchDB document requires _id")
        target = f"{self._database_url}/{quote(doc_id, safe='')}"

        for attempt in range(2):
            current = self.get(doc_id)
            outgoing = dict(document)
            if current and current.get("_rev"):
                outgoing["_rev"] = current["_rev"]
            response = self._request("PUT", target, json=outgoing)
            if response.status_code in {201, 202}:
                result = self._json(response)
                outgoing["_rev"] = result.get("rev")
                return outgoing
            if response.status_code != 409 or attempt == 1:
                raise CouchDBRepositoryError("CouchDB document write failed")
        raise CouchDBRepositoryError("CouchDB document write conflicted")

    def delete(self, doc_id: str, *, expected_revision: str | None = None) -> bool:
        revision = expected_revision
        if revision is None:
            current = self.get(doc_id)
            if current is None:
                return False
            revision = current.get("_rev")
        if not revision:
            raise CouchDBRepositoryError("CouchDB document revision is missing")
        response = self._request(
            "DELETE",
            f"{self._database_url}/{quote(doc_id, safe='')}",
            params={"rev": revision},
        )
        if response.status_code not in {200, 202}:
            raise CouchDBRepositoryError("CouchDB document deletion failed")
        return True

    def find_by_owner(self, owner_hash: str) -> list[dict[str, Any]]:
        return self._find(
            {"type": _DOC_TYPE, "owner_hash": owner_hash}, limit=100
        )

    def find_expired(
        self, now_epoch: float, *, limit: int = 100
    ) -> list[dict[str, Any]]:
        return self._find(
            {
                "type": _DOC_TYPE,
                "expires_at_epoch": {"$lte": now_epoch},
            },
            limit=limit,
        )

    def _find(
        self, selector: dict[str, Any], *, limit: int
    ) -> list[dict[str, Any]]:
        response = self._request(
            "POST",
            f"{self._database_url}/_find",
            json={"selector": selector, "limit": limit},
        )
        if response.status_code != 200:
            raise CouchDBRepositoryError("CouchDB query failed")
        data = self._json(response)
        docs = data.get("docs")
        if not isinstance(docs, list) or not all(isinstance(doc, dict) for doc in docs):
            raise CouchDBRepositoryError("CouchDB query payload is invalid")
        return docs

    def changes(
        self, since: Any, *, limit: int = 100
    ) -> tuple[list[dict[str, Any]], Any, int]:
        response = self._request(
            "GET",
            f"{self._database_url}/_changes",
            params={
                "since": since,
                "include_docs": "true",
                "limit": limit,
            },
        )
        if response.status_code != 200:
            raise CouchDBRepositoryError("CouchDB changes read failed")
        data = self._json(response)
        results = data.get("results")
        if not isinstance(results, list) or "last_seq" not in data:
            raise CouchDBRepositoryError("CouchDB changes payload is invalid")
        pending = data.get("pending", 0)
        return results, data["last_seq"], int(pending or 0)


@dataclass(frozen=True)
class _PendingApproval:
    session_hash: str
    preparation_minutes: int
    created_at: datetime
    expires_at: datetime
    approval_expires_at: datetime
    generation: str
    document_id: str


class MemoryCapsuleApprovalStore:
    """세션 결합·1회용·단기 만료 승인 토큰."""

    def __init__(
        self,
        ttl_seconds: int = 120,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._ttl = ttl_seconds
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._tokens: dict[str, _PendingApproval] = {}
        self._session_tokens: OrderedDict[str, str] = OrderedDict()
        self._max_sessions = 2048

    def create(
        self,
        *,
        session_hash: str,
        preparation_minutes: int,
        created_at: datetime,
        expires_at: datetime,
    ) -> str:
        self._cleanup()
        previous = self._session_tokens.get(session_hash)
        if previous is not None:
            self._tokens.pop(previous, None)
        token = secrets.token_urlsafe(32)
        self._tokens[token] = _PendingApproval(
            session_hash=session_hash,
            preparation_minutes=preparation_minutes,
            created_at=created_at,
            expires_at=expires_at,
            approval_expires_at=self._clock() + timedelta(seconds=self._ttl),
            generation=secrets.token_hex(16),
            document_id=f"memory-capsule-{secrets.token_urlsafe(24)}",
        )
        self._session_tokens[session_hash] = token
        self._session_tokens.move_to_end(session_hash)
        while len(self._session_tokens) > self._max_sessions:
            _, oldest_token = self._session_tokens.popitem(last=False)
            self._tokens.pop(oldest_token, None)
        return token

    def consume(self, token: str, *, session_hash: str) -> _PendingApproval:
        pending = self._tokens.get(token)
        if pending is None:
            self._cleanup()
            raise MemoryCapsuleError("invalid", "승인 요청을 확인할 수 없습니다.")
        if self._clock() >= pending.approval_expires_at:
            del self._tokens[token]
            self._session_tokens.pop(pending.session_hash, None)
            raise MemoryCapsuleError("expired", "승인 요청이 만료되었습니다.")
        if not hmac.compare_digest(pending.session_hash, session_hash):
            raise MemoryCapsuleError("invalid", "이 세션의 승인 요청이 아닙니다.")
        del self._tokens[token]
        self._session_tokens.pop(pending.session_hash, None)
        self._cleanup()
        return pending

    def discard_session(self, session_hash: str) -> None:
        token = self._session_tokens.pop(session_hash, None)
        if token is not None:
            self._tokens.pop(token, None)

    def _cleanup(self) -> None:
        now = self._clock()
        expired = [
            token
            for token, pending in self._tokens.items()
            if now >= pending.approval_expires_at
        ]
        for token in expired:
            pending = self._tokens.pop(token)
            if self._session_tokens.get(pending.session_hash) == token:
                self._session_tokens.pop(pending.session_hash, None)


class MemoryCapsuleRateLimiter:
    """세션과 IP 각각에 action별 슬라이딩 윈도우 제한을 건다."""

    def __init__(
        self, per_action_per_minute: int = 10, *, max_keys: int = 4096
    ) -> None:
        self._limit = max(1, per_action_per_minute)
        self._hits: dict[tuple[str, str, str], deque[float]] = defaultdict(deque)
        self._last_seen: OrderedDict[tuple[str, str, str], float] = OrderedDict()
        self._max_keys = max(32, max_keys)

    def check(self, *, session_hash: str, client_identity: str, action: str) -> None:
        now = time.monotonic()
        for scope, identity in (
            ("session", session_hash),
            ("client", client_identity or "unknown"),
        ):
            key = (scope, identity, action)
            hits = self._hits[key]
            while hits and hits[0] <= now - 60.0:
                hits.popleft()
            if len(hits) >= self._limit:
                raise MemoryCapsuleError(
                    "unavailable", "요청이 너무 빠릅니다. 잠시 뒤에 다시 시도해 주세요."
                )
            hits.append(now)
            self._last_seen[key] = now
            self._last_seen.move_to_end(key)
        self._cleanup(now)

    def _cleanup(self, now: float) -> None:
        stale = [key for key, seen in self._last_seen.items() if seen <= now - 600.0]
        for key in stale:
            self._last_seen.pop(key, None)
            self._hits.pop(key, None)
        while len(self._last_seen) > self._max_keys:
            key, _ = self._last_seen.popitem(last=False)
            self._hits.pop(key, None)


class MemoryCapsuleService:
    """승인, CouchDB changes 동기화, 의미 검색, 삭제를 한 경계로 묶는다."""

    def __init__(
        self,
        *,
        store: MemoryCapsuleIndexStore,
        embedding_provider: Any,
        repository: CouchDBMemoryCapsuleRepository | None,
        ttl_seconds: int = 1800,
        approval_ttl_seconds: int = 120,
        sync_interval_seconds: float = 5.0,
        rate_limit_per_action_per_minute: int = 10,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._embedding = embedding_provider
        self._repository = repository
        self._ttl = ttl_seconds
        self._sync_interval = sync_interval_seconds
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._approvals = MemoryCapsuleApprovalStore(
            approval_ttl_seconds, clock=self._clock
        )
        self._sync_lock = asyncio.Lock()
        self._sync_task: asyncio.Task | None = None
        self._session_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._rate_limiter = MemoryCapsuleRateLimiter(
            rate_limit_per_action_per_minute
        )

    @property
    def configured(self) -> bool:
        return self._repository is not None

    async def start(self) -> None:
        if self._repository is None or self._sync_task is not None:
            return
        self._sync_task = asyncio.create_task(
            self._sync_loop(), name="memory-capsule-couchdb-sync"
        )

    async def stop(self) -> None:
        task = self._sync_task
        self._sync_task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _sync_loop(self) -> None:
        while True:
            try:
                await self.sync_once()
                await self.cleanup_expired()
            except Exception:
                logger.warning("기억 캡슐 CouchDB 동기화 실패", exc_info=True)
            await asyncio.sleep(self._sync_interval)

    def _require_repository(self) -> CouchDBMemoryCapsuleRepository:
        if self._repository is None:
            raise MemoryCapsuleError(
                "unavailable", "기억 저장소가 아직 연결되지 않았습니다."
            )
        return self._repository

    async def _ensure_ready(self) -> CouchDBMemoryCapsuleRepository:
        repository = self._require_repository()
        try:
            await asyncio.to_thread(repository.ensure_database)
        except CouchDBRepositoryError as exc:
            raise MemoryCapsuleError(
                "unavailable", "기억 저장소에 연결할 수 없습니다."
            ) from exc
        return repository

    def _session_hash(
        self, session_key: str, *, client_identity: str, action: str
    ) -> str:
        session_hash = _owner_hash(session_key)
        self._rate_limiter.check(
            session_hash=session_hash,
            client_identity=client_identity,
            action=action,
        )
        return session_hash

    def _session_lock(self, session_hash: str) -> asyncio.Lock:
        lock = self._session_locks.get(session_hash)
        if lock is None:
            lock = asyncio.Lock()
            self._session_locks[session_hash] = lock
        return lock

    async def prepare(
        self,
        session_key: str,
        preparation_minutes: Any,
        *,
        client_identity: str = "unknown",
    ) -> dict[str, Any]:
        if type(preparation_minutes) is not int or preparation_minutes not in _ALLOWED_MINUTES:
            raise MemoryCapsuleError(
                "invalid", "준비 시간은 10분, 20분, 30분 중에서 선택해 주세요."
            )
        session_hash = self._session_hash(
            session_key, client_identity=client_identity, action="prepare"
        )
        async with self._session_lock(session_hash):
            await self._ensure_ready()
            await self.sync_once()

            created_at = _as_utc(self._clock())
            expires_at = created_at + timedelta(seconds=self._ttl)
            token = self._approvals.create(
                session_hash=session_hash,
                preparation_minutes=preparation_minutes,
                created_at=created_at,
                expires_at=expires_at,
            )
            return {
                "approvalToken": token,
                "preparationMinutes": preparation_minutes,
                "content": _content_for(preparation_minutes),
                "sessionScoped": True,
                "source": {
                    "type": _SOURCE_TYPE,
                    "label": _SOURCE_LABEL,
                    "sessionScoped": True,
                    "createdAt": _format_datetime(created_at),
                },
                "expiresAt": _format_datetime(expires_at),
            }

    async def approve(
        self,
        session_key: str,
        approval_token: Any,
        *,
        client_identity: str = "unknown",
    ) -> dict[str, Any]:
        if not isinstance(approval_token, str) or not approval_token:
            raise MemoryCapsuleError("invalid", "승인 요청을 확인할 수 없습니다.")
        session_hash = self._session_hash(
            session_key, client_identity=client_identity, action="approve"
        )
        async with self._session_lock(session_hash):
            pending = self._approvals.consume(
                approval_token, session_hash=session_hash
            )
            repository = await self._ensure_ready()

            document = _make_document(session_hash=session_hash, pending=pending)
            try:
                saved_document = await asyncio.to_thread(repository.put, document)
                await self.sync_once()
                owner_documents = await asyncio.to_thread(
                    repository.find_by_owner, session_hash
                )
                for old_document in owner_documents:
                    if old_document.get("_id") == document["_id"]:
                        continue
                    try:
                        old = _validate_document(
                            old_document,
                            expected_doc_id=str(old_document.get("_id") or ""),
                            now=_as_utc(self._clock()),
                            max_ttl_seconds=self._ttl,
                        )
                    except ValueError:
                        logger.warning(
                            "계약 외 CouchDB 문서는 삭제하지 않고 인덱스에서 제외: %s",
                            old_document.get("_id"),
                        )
                        continue
                    await asyncio.to_thread(
                        repository.delete,
                        str(old_document["_id"]),
                        expected_revision=old["couchdb_rev"],
                    )
                if len(owner_documents) > 1:
                    await self.sync_once()
            except MemoryCapsuleError:
                raise
            except Exception as exc:
                raise MemoryCapsuleError(
                    "storage_error", "기억을 저장하고 동기화하지 못했습니다."
                ) from exc

            indexed = self._store.get_memory_capsule(session_hash)
            expected_revision = saved_document.get("_rev")
            if (
                indexed is None
                or indexed["couchdb_doc_id"] != document["_id"]
                or indexed["generation"] != pending.generation
                or indexed["couchdb_rev"] != expected_revision
                or float(indexed["expires_at_epoch"]) <= self._clock().timestamp()
            ):
                raise MemoryCapsuleError(
                    "storage_error", "기억을 검색 인덱스에 반영하지 못했습니다."
                )
            return _response_from_row(indexed, include_relevance=False)

    async def reject(
        self,
        session_key: str,
        approval_token: Any,
        *,
        client_identity: str = "unknown",
    ) -> dict[str, Any]:
        if not isinstance(approval_token, str) or not approval_token:
            raise MemoryCapsuleError("invalid", "승인 요청을 확인할 수 없습니다.")
        session_hash = self._session_hash(
            session_key, client_identity=client_identity, action="reject"
        )
        async with self._session_lock(session_hash):
            self._approvals.consume(
                approval_token, session_hash=session_hash
            )
            return {}

    async def recall(
        self, session_key: str, *, client_identity: str = "unknown"
    ) -> dict[str, Any]:
        session_hash = self._session_hash(
            session_key, client_identity=client_identity, action="recall"
        )
        repository = await self._ensure_ready()
        async with self._session_lock(session_hash):
            await self.sync_once()
            now = _as_utc(self._clock())
            try:
                owner_documents = await asyncio.to_thread(
                    repository.find_by_owner, session_hash
                )
                expired_documents: list[dict[str, Any]] = []
                has_active = False
                for document in owner_documents:
                    try:
                        validated = _validate_document(
                            document,
                            expected_doc_id=str(document.get("_id") or ""),
                            now=now,
                            max_ttl_seconds=self._ttl,
                            allow_expired=True,
                        )
                    except ValueError:
                        continue
                    if validated["expires_at"] <= now:
                        expired_documents.append(validated | {"_id": document["_id"]})
                    else:
                        has_active = True
                for expired in expired_documents:
                    await asyncio.to_thread(
                        repository.delete,
                        expired["_id"],
                        expected_revision=expired["couchdb_rev"],
                    )
                if expired_documents:
                    await self.sync_once()
            except MemoryCapsuleError:
                raise
            except Exception as exc:
                raise MemoryCapsuleError(
                    "storage_error", "만료된 기억을 안전하게 정리하지 못했습니다."
                ) from exc
            if expired_documents and not has_active:
                raise MemoryCapsuleError("expired", "기억 캡슐이 자동 만료되었습니다.")

            query_vector = await self._embedding.embed(_RECALL_QUERY)
            result = self._store.search_memory_capsule(
                session_key_hash=session_hash,
                now_epoch=now.timestamp(),
                query_embedding=_serialize_f32(query_vector),
                fts_query=_FTS_QUERY,
            )
            if result is None:
                return {
                    "capsule": None,
                    "source": None,
                    "relevance": None,
                    "syncedAt": None,
                    "expiresAt": None,
                }
            distance = max(0.0, min(2.0, float(result["vector_distance"])))
            vector_score = max(0.0, min(1.0, 1.0 - distance))
            fts_bonus = 0.2 if result.get("fts_score") is not None else 0.0
            relevance = min(1.0, vector_score * 0.8 + fts_bonus)
            return _response_from_row(
                result, include_relevance=True, relevance=round(relevance, 4)
            )

    async def forget(
        self, session_key: str, *, client_identity: str = "unknown"
    ) -> dict[str, Any]:
        session_hash = self._session_hash(
            session_key, client_identity=client_identity, action="forget"
        )
        async with self._session_lock(session_hash):
            repository = await self._ensure_ready()
            self._approvals.discard_session(session_hash)
            try:
                owner_documents = await asyncio.to_thread(
                    repository.find_by_owner, session_hash
                )
                for document in owner_documents:
                    doc_id = str(document.get("_id") or "")
                    try:
                        validated = _validate_document(
                            document,
                            expected_doc_id=doc_id,
                            now=_as_utc(self._clock()),
                            max_ttl_seconds=self._ttl,
                            allow_expired=True,
                        )
                    except ValueError:
                        logger.warning(
                            "계약 외 CouchDB 문서는 삭제하지 않음: %s", doc_id
                        )
                        continue
                    await asyncio.to_thread(
                        repository.delete,
                        doc_id,
                        expected_revision=validated["couchdb_rev"],
                    )
                await self.sync_once()
                remaining = await asyncio.to_thread(
                    repository.find_by_owner, session_hash
                )
            except Exception as exc:
                raise MemoryCapsuleError(
                    "storage_error", "기억을 완전히 삭제하지 못했습니다."
                ) from exc
            valid_remaining = []
            for document in remaining:
                try:
                    _validate_document(
                        document,
                        expected_doc_id=str(document.get("_id") or ""),
                        now=_as_utc(self._clock()),
                        max_ttl_seconds=self._ttl,
                        allow_expired=True,
                    )
                    valid_remaining.append(document)
                except ValueError:
                    continue
            if valid_remaining:
                raise MemoryCapsuleError(
                    "storage_error", "기억 원본 삭제를 확인하지 못했습니다."
                )

            # 이미 CouchDB에 없었다면 changes가 오지 않는다. 원본 부재를 확인했으므로
            # 남은 로컬 인덱스를 지우는 것이 정합한 복구 동작이다.
            self._store.delete_memory_capsule(session_hash)
            if self._store.get_memory_capsule(session_hash) is not None:
                raise MemoryCapsuleError(
                    "storage_error", "기억 검색 인덱스를 삭제하지 못했습니다."
                )
            return {}

    async def cleanup_expired(self) -> None:
        repository = self._repository
        if repository is None:
            return
        now = _as_utc(self._clock())
        expired = await asyncio.to_thread(repository.find_expired, now.timestamp())
        deleted_ids: list[tuple[str, str]] = []
        for document in expired:
            doc_id = str(document.get("_id") or "")
            try:
                validated = _validate_document(
                    document,
                    expected_doc_id=doc_id,
                    now=now,
                    max_ttl_seconds=self._ttl,
                    allow_expired=True,
                )
            except ValueError:
                logger.warning(
                    "계약 외 만료 CouchDB 문서는 삭제하지 않음: %s", doc_id
                )
                continue
            async with self._session_lock(validated["owner_hash"]):
                await asyncio.to_thread(
                    repository.delete,
                    doc_id,
                    expected_revision=validated["couchdb_rev"],
                )
                deleted_ids.append((doc_id, validated["generation"]))
        if deleted_ids:
            await self.sync_once()
            for doc_id, generation in deleted_ids:
                # Canonical 문서가 이미 없던 경우 changes 삭제 이벤트가 없다.
                self._store.delete_memory_capsule_by_doc_id(
                    doc_id, generation=generation
                )

    async def sync_once(self) -> None:
        repository = await self._ensure_ready()
        async with self._sync_lock:
            since = self._store.get_memory_capsule_checkpoint()
            for _ in range(100):
                try:
                    changes, last_sequence, pending = await asyncio.to_thread(
                        repository.changes, since
                    )
                    for change in changes:
                        await self._apply_change(change, repository)
                except MemoryCapsuleError:
                    raise
                except Exception as exc:
                    raise MemoryCapsuleError(
                        "storage_error", "기억 검색 인덱스를 동기화하지 못했습니다."
                    ) from exc

                try:
                    # 각 change의 로컬 트랜잭션(특히 delete)이 commit된 뒤에만
                    # checkpoint를 전진한다. 실패하면 같은 change를 재생한다.
                    self._store.set_memory_capsule_checkpoint(last_sequence)
                except Exception as exc:
                    raise MemoryCapsuleError(
                        "storage_error", "기억 동기화 위치를 저장하지 못했습니다."
                    ) from exc
                since = last_sequence
                if pending <= 0:
                    return
            raise MemoryCapsuleError(
                "storage_error", "기억 변경 내역이 너무 많아 동기화를 완료하지 못했습니다."
            )

    async def _apply_change(
        self,
        change: dict[str, Any],
        repository: CouchDBMemoryCapsuleRepository,
    ) -> None:
        doc_id = str(change.get("id") or "")
        if not doc_id:
            raise ValueError("CouchDB change is missing id")
        if change.get("deleted") is True:
            self._store.delete_memory_capsule_by_doc_id(doc_id)
            return

        document = change.get("doc")
        try:
            validated = _validate_document(
                document,
                expected_doc_id=doc_id,
                now=_as_utc(self._clock()),
                max_ttl_seconds=self._ttl,
                allow_expired=True,
            )
        except ValueError:
            # 계약 외 원본은 이 기능이 소유한다고 가정하지 않는다. 로컬 후보에서만
            # 제외하고 CouchDB 원본은 절대로 변경하지 않는다.
            self._store.delete_memory_capsule_by_doc_id(doc_id)
            logger.warning(
                "계약 외 CouchDB 문서를 인덱싱하지 않음: %s", doc_id
            )
            return

        if validated["expires_at"] <= _as_utc(self._clock()):
            self._store.delete_memory_capsule_by_doc_id(doc_id)
            return

        embedding = await self._embedding.embed(validated["content"])
        synced_at = max(_as_utc(self._clock()), validated["created_at"])
        if synced_at > validated["expires_at"]:
            self._store.delete_memory_capsule_by_doc_id(doc_id)
            return
        self._store.replace_memory_capsule(
            couchdb_doc_id=doc_id,
            session_key_hash=validated["owner_hash"],
            preparation_minutes=validated["preparation_minutes"],
            content=validated["content"],
            source_metadata=json.dumps(
                validated["source"], ensure_ascii=False, separators=(",", ":")
            ),
            generation=validated["generation"],
            couchdb_rev=validated["couchdb_rev"],
            created_at_epoch=validated["created_at"].timestamp(),
            synced_at_epoch=synced_at.timestamp(),
            expires_at_epoch=validated["expires_at"].timestamp(),
            embedding=_serialize_f32(embedding),
        )


def _owner_hash(session_key: str) -> str:
    if not session_key.startswith("webchat:"):
        raise MemoryCapsuleError("invalid", "안전한 웹 세션을 확인할 수 없습니다.")
    identity = session_key.removeprefix("webchat:")
    try:
        parsed = uuid.UUID(identity)
    except (ValueError, AttributeError) as exc:
        raise MemoryCapsuleError(
            "invalid", "이 환경에서는 기억 캡슐을 사용할 수 없습니다."
        ) from exc
    if parsed.version != 4 or str(parsed) != identity.lower():
        raise MemoryCapsuleError(
            "invalid", "이 환경에서는 기억 캡슐을 사용할 수 없습니다."
        )
    return hashlib.sha256(session_key.encode("utf-8")).hexdigest()


def _content_for(minutes: int) -> str:
    return f"사용자는 일정 전에 {minutes}분의 준비 시간을 선호합니다."


def _make_document(
    *, session_hash: str, pending: _PendingApproval
) -> dict[str, Any]:
    created_at_epoch = pending.created_at.timestamp()
    return {
        "_id": pending.document_id,
        "type": _DOC_TYPE,
        "owner_hash": session_hash,
        "generation": pending.generation,
        "preparation_minutes": pending.preparation_minutes,
        "content": _content_for(pending.preparation_minutes),
        "source": {
            "type": _SOURCE_TYPE,
            "label": _SOURCE_LABEL,
            "session_scoped": True,
            "created_at_epoch": created_at_epoch,
        },
        "created_at_epoch": created_at_epoch,
        "expires_at_epoch": pending.expires_at.timestamp(),
    }


def _validate_document(
    document: Any,
    *,
    expected_doc_id: str,
    now: datetime,
    max_ttl_seconds: int,
    allow_expired: bool = False,
) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("document must be an object")
    if (
        document.get("_id") != expected_doc_id
        or document.get("type") != _DOC_TYPE
        or not expected_doc_id.startswith("memory-capsule-")
        or not (40 <= len(expected_doc_id) <= 80)
    ):
        raise ValueError("unexpected document identity")
    owner_hash = document.get("owner_hash")
    if (
        not isinstance(owner_hash, str)
        or len(owner_hash) != 64
        or any(c not in "0123456789abcdef" for c in owner_hash)
    ):
        raise ValueError("invalid owner hash")
    generation = document.get("generation")
    if (
        not isinstance(generation, str)
        or len(generation) != 32
        or any(c not in "0123456789abcdef" for c in generation)
    ):
        raise ValueError("invalid generation")
    couchdb_rev = document.get("_rev")
    if not isinstance(couchdb_rev, str) or not couchdb_rev:
        raise ValueError("missing CouchDB revision")
    minutes = document.get("preparation_minutes")
    if type(minutes) is not int or minutes not in _ALLOWED_MINUTES:
        raise ValueError("invalid preparation minutes")
    if document.get("content") != _content_for(minutes):
        raise ValueError("content was not server generated")
    source = document.get("source")
    if not isinstance(source, dict) or source != {
        "type": _SOURCE_TYPE,
        "label": _SOURCE_LABEL,
        "session_scoped": True,
        "created_at_epoch": document.get("created_at_epoch"),
    }:
        raise ValueError("invalid source metadata")
    created_epoch = document.get("created_at_epoch")
    expires_epoch = document.get("expires_at_epoch")
    if (
        isinstance(created_epoch, bool)
        or not isinstance(created_epoch, (int, float))
        or isinstance(expires_epoch, bool)
        or not isinstance(expires_epoch, (int, float))
        or not math.isfinite(float(created_epoch))
        or not math.isfinite(float(expires_epoch))
        or float(created_epoch) < 0
        or float(expires_epoch) < 0
    ):
        raise ValueError("timestamps must be numeric epochs")
    try:
        created_at = datetime.fromtimestamp(float(created_epoch), tz=timezone.utc)
        expires_at = datetime.fromtimestamp(float(expires_epoch), tz=timezone.utc)
    except (OverflowError, OSError, ValueError) as exc:
        raise ValueError("timestamps are outside the supported range") from exc
    if expires_at <= created_at:
        raise ValueError("invalid expiry")
    now = _as_utc(now)
    if created_at > now + timedelta(seconds=60):
        raise ValueError("creation timestamp is in the future")
    if expires_at > created_at + timedelta(seconds=max_ttl_seconds + 5):
        raise ValueError("expiry exceeds configured TTL")
    if not allow_expired and expires_at <= now:
        raise ValueError("document is expired")
    return {
        "owner_hash": owner_hash,
        "generation": generation,
        "couchdb_rev": couchdb_rev,
        "preparation_minutes": minutes,
        "content": document["content"],
        "source": source,
        "created_at": created_at,
        "expires_at": expires_at,
    }


def _response_from_row(
    row: dict[str, Any],
    *,
    include_relevance: bool,
    relevance: float | None = None,
) -> dict[str, Any]:
    stored_source = json.loads(row["source_metadata"])
    source = {
        "type": stored_source["type"],
        "label": stored_source["label"],
        "sessionScoped": bool(stored_source["session_scoped"]),
        "createdAt": _format_epoch(float(stored_source["created_at_epoch"])),
    }
    result: dict[str, Any] = {
        "capsule": {
            "preparationMinutes": int(row["preparation_minutes"]),
            "content": row["content"],
        },
        "source": source,
        "syncedAt": _format_epoch(float(row["synced_at_epoch"])),
        "expiresAt": _format_epoch(float(row["expires_at_epoch"])),
    }
    if include_relevance:
        result["relevance"] = relevance
    return result


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_datetime(value: datetime) -> str:
    return _as_utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def _format_epoch(value: float) -> str:
    return _format_datetime(datetime.fromtimestamp(value, tz=timezone.utc))


def _serialize_f32(vector: list[float]) -> bytes:
    if len(vector) != 384:
        raise ValueError("memory capsule embeddings must have 384 dimensions")
    return struct.pack("384f", *vector)
