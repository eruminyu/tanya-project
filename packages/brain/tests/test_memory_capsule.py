"""T-025 공개 기억 캡슐 백엔드 계약·격리·정합성 테스트."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from unittest.mock import patch

import pytest

from memory.capsule import (
    CouchDBMemoryCapsuleRepository,
    CouchDBRepositoryError,
    MemoryCapsuleApprovalStore,
    MemoryCapsuleError,
    MemoryCapsuleRateLimiter,
    MemoryCapsuleService,
    _content_for,
    _owner_hash,
)
from memory.store import MemoryCapsuleIndexStore


SESSION_A = "webchat:550e8400-e29b-41d4-a716-446655440000"
SESSION_B = "webchat:8c6f6ec6-5d0e-4c95-9eb6-3c12b27f61c8"


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 9, 2, 3, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now


class FakeEmbedding:
    dimension = 384

    async def embed(self, text: str) -> list[float]:
        vector = [0.0] * 384
        vector[sum(ord(char) for char in text) % 384] = 1.0
        # 캡슐 문장과 고정 회상 문구에 공통 의미 축을 준다.
        vector[0] = 1.0
        norm = sum(value * value for value in vector) ** 0.5
        return [value / norm for value in vector]


class FakeRepository:
    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}
        self.events: list[dict] = []
        self.sequence = 0
        self.ready = True
        self.ensure_calls = 0
        self.deleted_ids: list[str] = []

    def ensure_database(self) -> None:
        self.ensure_calls += 1
        if not self.ready:
            raise CouchDBRepositoryError("secret http://couchdb:5984 response")

    def get(self, doc_id: str):
        doc = self.docs.get(doc_id)
        return deepcopy(doc) if doc else None

    def put(self, document: dict):
        self.sequence += 1
        saved = deepcopy(document)
        saved["_rev"] = f"1-{self.sequence:08x}"
        self.docs[saved["_id"]] = saved
        self.events.append({
            "seq": self.sequence,
            "id": saved["_id"],
            "changes": [{"rev": saved["_rev"]}],
            "doc": deepcopy(saved),
        })
        return deepcopy(saved)

    def delete(self, doc_id: str, *, expected_revision: str | None = None):
        current = self.docs.get(doc_id)
        if current is None:
            return False
        if expected_revision is not None and current.get("_rev") != expected_revision:
            raise CouchDBRepositoryError("revision conflict")
        del self.docs[doc_id]
        self.deleted_ids.append(doc_id)
        self.sequence += 1
        self.events.append({
            "seq": self.sequence,
            "id": doc_id,
            "deleted": True,
            "changes": [{"rev": f"2-{self.sequence:08x}"}],
        })
        return True

    def changes(self, since, *, limit: int = 100):
        selected = [event for event in self.events if event["seq"] > int(since)][:limit]
        last = selected[-1]["seq"] if selected else self.sequence
        pending = len([event for event in self.events if event["seq"] > last])
        return deepcopy(selected), last, pending

    def find_by_owner(self, owner_hash: str):
        return [
            deepcopy(doc)
            for doc in self.docs.values()
            if doc.get("type") == "tanya_public_memory_capsule_v1"
            and doc.get("owner_hash") == owner_hash
        ]

    def find_expired(self, now_epoch: float, *, limit: int = 100):
        return [
            deepcopy(doc)
            for doc in self.docs.values()
            if doc.get("type") == "tanya_public_memory_capsule_v1"
            and isinstance(doc.get("expires_at_epoch"), (int, float))
            and doc["expires_at_epoch"] <= now_epoch
        ][:limit]


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return deepcopy(self._payload)


class FakeTransport:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, str, dict]] = []

    def request(self, method: str, url: str, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


@pytest.fixture
def capsule_setup():
    store = MemoryCapsuleIndexStore(":memory:")
    clock = Clock()
    repository = FakeRepository()
    service = MemoryCapsuleService(
        store=store,
        embedding_provider=FakeEmbedding(),
        repository=repository,
        ttl_seconds=1800,
        approval_ttl_seconds=120,
        rate_limit_per_action_per_minute=100,
        clock=clock,
    )
    yield service, store, repository, clock
    store.close()


async def save_capsule(service: MemoryCapsuleService, session: str, minutes: int):
    draft = await service.prepare(session, minutes)
    return await service.approve(session, draft["approvalToken"])


@pytest.mark.asyncio
async def test_prepare_is_choice_only_and_does_not_write(capsule_setup):
    service, store, repository, clock = capsule_setup

    draft = await service.prepare(SESSION_A, 20)

    assert draft["preparationMinutes"] == 20
    assert draft["content"] == _content_for(20)
    assert draft["sessionScoped"] is True
    assert draft["source"] == {
        "type": "explicit_choice",
        "label": "준비 시간 선택",
        "sessionScoped": True,
        "createdAt": "2026-09-02T03:00:00Z",
    }
    assert datetime.fromisoformat(draft["expiresAt"].replace("Z", "+00:00")) > clock()
    assert repository.docs == {}
    assert store.get_memory_capsule(_owner_hash(SESSION_A)) is None

    for invalid in (0, 15, 40, True, "20", None):
        with pytest.raises(MemoryCapsuleError) as error:
            await service.prepare(SESSION_A, invalid)
        assert error.value.code == "invalid"


@pytest.mark.asyncio
async def test_non_crypto_local_session_cannot_use_capsule(capsule_setup):
    service, *_ = capsule_setup
    with pytest.raises(MemoryCapsuleError) as error:
        await service.prepare("webchat:local-demo-1234567890", 20)
    assert error.value.code == "invalid"


@pytest.mark.asyncio
async def test_approve_persists_couchdb_and_both_indexes(capsule_setup):
    service, store, repository, _ = capsule_setup

    saved = await save_capsule(service, SESSION_A, 20)

    assert saved["capsule"] == {
        "preparationMinutes": 20,
        "content": _content_for(20),
    }
    assert saved["source"]["type"] == "explicit_choice"
    assert saved["source"]["label"] == "준비 시간 선택"
    assert saved["source"]["sessionScoped"] is True
    created = datetime.fromisoformat(saved["source"]["createdAt"].replace("Z", "+00:00"))
    synced = datetime.fromisoformat(saved["syncedAt"].replace("Z", "+00:00"))
    expires = datetime.fromisoformat(saved["expiresAt"].replace("Z", "+00:00"))
    assert created <= synced <= expires
    assert len(repository.docs) == 1
    row = store.get_memory_capsule(_owner_hash(SESSION_A))
    assert row is not None
    assert store.execute_scalar(
        "SELECT count(*) FROM memory_capsules_vec WHERE rowid = ?", (row["id"],)
    ) == 1
    assert store.execute_scalar(
        "SELECT count(*) FROM memory_capsules_fts WHERE rowid = ?", (row["id"],)
    ) == 1
    assert store.get_memory_capsule_checkpoint() > 0


@pytest.mark.asyncio
async def test_two_sessions_recall_only_owned_unexpired_candidate(capsule_setup):
    service, store, _, _ = capsule_setup
    await save_capsule(service, SESSION_A, 10)
    await save_capsule(service, SESSION_B, 30)

    recalled_a = await service.recall(SESSION_A)
    recalled_b = await service.recall(SESSION_B)

    assert recalled_a["capsule"]["preparationMinutes"] == 10
    assert recalled_b["capsule"]["preparationMinutes"] == 30
    assert 0.0 <= recalled_a["relevance"] <= 1.0
    assert 0.0 <= recalled_b["relevance"] <= 1.0
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules") == 2


@pytest.mark.asyncio
async def test_wrong_session_replay_reject_and_pending_cap(capsule_setup):
    service, _, repository, _ = capsule_setup
    first = await service.prepare(SESSION_A, 10)
    replacement = await service.prepare(SESSION_A, 20)

    with pytest.raises(MemoryCapsuleError) as stale:
        await service.approve(SESSION_A, first["approvalToken"])
    assert stale.value.code == "invalid"

    with pytest.raises(MemoryCapsuleError) as wrong_owner:
        await service.approve(SESSION_B, replacement["approvalToken"])
    assert wrong_owner.value.code == "invalid"

    await service.reject(SESSION_A, replacement["approvalToken"])
    with pytest.raises(MemoryCapsuleError):
        await service.approve(SESSION_A, replacement["approvalToken"])
    assert repository.docs == {}


@pytest.mark.asyncio
async def test_forget_removes_canonical_fts_and_vector_and_discards_draft(capsule_setup):
    service, store, repository, _ = capsule_setup
    await save_capsule(service, SESSION_A, 20)
    stale = await service.prepare(SESSION_A, 30)

    assert await service.forget(SESSION_A) == {}

    assert repository.docs == {}
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules") == 0
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules_fts") == 0
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules_vec") == 0
    with pytest.raises(MemoryCapsuleError):
        await service.approve(SESSION_A, stale["approvalToken"])


@pytest.mark.asyncio
async def test_expired_capsule_is_never_returned_and_cleanup_is_verified(capsule_setup):
    service, store, repository, clock = capsule_setup
    await save_capsule(service, SESSION_A, 20)
    clock.now += timedelta(seconds=1801)

    with pytest.raises(MemoryCapsuleError) as expired:
        await service.recall(SESSION_A)

    assert expired.value.code == "expired"
    assert repository.docs == {}
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules") == 0


@pytest.mark.asyncio
async def test_unavailable_never_emits_local_success(capsule_setup):
    service, store, repository, _ = capsule_setup
    repository.ready = False

    with pytest.raises(MemoryCapsuleError) as unavailable:
        await service.prepare(SESSION_A, 20)

    assert unavailable.value.code == "unavailable"
    assert "couchdb" not in unavailable.value.message.lower()
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules") == 0


@pytest.mark.asyncio
async def test_malformed_or_ttl_abuse_document_is_not_indexed_or_deleted(capsule_setup):
    service, store, repository, clock = capsule_setup
    owner = _owner_hash(SESSION_A)
    malicious = {
        "_id": "memory-capsule-" + "x" * 32,
        "_rev": "1-malicious",
        "type": "tanya_public_memory_capsule_v1",
        "owner_hash": owner,
        "generation": "a" * 32,
        "preparation_minutes": 20,
        "content": _content_for(20),
        "source": {
            "type": "explicit_choice",
            "label": "준비 시간 선택",
            "session_scoped": True,
            "created_at_epoch": clock().timestamp(),
        },
        "created_at_epoch": clock().timestamp(),
        "expires_at_epoch": (clock() + timedelta(days=365)).timestamp(),
    }
    repository.docs[malicious["_id"]] = deepcopy(malicious)
    repository.sequence += 1
    repository.events.append({
        "seq": repository.sequence,
        "id": malicious["_id"],
        "doc": deepcopy(malicious),
    })

    await service.sync_once()

    assert malicious["_id"] in repository.docs
    assert malicious["_id"] not in repository.deleted_ids
    assert store.execute_scalar("SELECT count(*) FROM memory_capsules") == 0


@pytest.mark.asyncio
async def test_new_generation_survives_old_delete_change(capsule_setup):
    service, store, repository, _ = capsule_setup
    await save_capsule(service, SESSION_A, 10)
    old_id = next(iter(repository.docs))
    await save_capsule(service, SESSION_A, 30)

    current = store.get_memory_capsule(_owner_hash(SESSION_A))
    assert current is not None
    assert current["preparation_minutes"] == 30
    assert current["couchdb_doc_id"] != old_id
    assert old_id not in repository.docs
    assert len(repository.docs) == 1


@pytest.mark.asyncio
async def test_delete_commits_before_checkpoint_and_replay_is_idempotent(capsule_setup):
    service, store, repository, _ = capsule_setup
    await save_capsule(service, SESSION_A, 20)
    document = next(iter(repository.docs.values()))
    checkpoint_before = store.get_memory_capsule_checkpoint()
    repository.delete(document["_id"], expected_revision=document["_rev"])

    with patch.object(
        store,
        "set_memory_capsule_checkpoint",
        side_effect=RuntimeError("simulated checkpoint failure"),
    ):
        with pytest.raises(MemoryCapsuleError):
            await service.sync_once()

    assert store.get_memory_capsule(_owner_hash(SESSION_A)) is None
    assert store.get_memory_capsule_checkpoint() == checkpoint_before

    await service.sync_once()
    assert store.get_memory_capsule(_owner_hash(SESSION_A)) is None
    assert store.get_memory_capsule_checkpoint() == repository.sequence


@pytest.mark.asyncio
async def test_concurrent_approve_then_forget_finishes_consistent(capsule_setup):
    service, store, repository, _ = capsule_setup
    draft = await service.prepare(SESSION_A, 20)

    approve_task = asyncio.create_task(
        service.approve(SESSION_A, draft["approvalToken"])
    )
    await asyncio.sleep(0)
    forget_task = asyncio.create_task(service.forget(SESSION_A))
    saved, forgotten = await asyncio.gather(approve_task, forget_task)

    assert saved["capsule"]["preparationMinutes"] == 20
    assert forgotten == {}
    assert repository.docs == {}
    assert store.get_memory_capsule(_owner_hash(SESSION_A)) is None


def test_approval_store_and_limiter_have_hard_caps():
    clock = Clock()
    approvals = MemoryCapsuleApprovalStore(ttl_seconds=15, clock=clock)
    for index in range(2200):
        approvals.create(
            session_hash=f"{index:064x}"[-64:],
            preparation_minutes=20,
            created_at=clock(),
            expires_at=clock() + timedelta(minutes=30),
        )
    assert len(approvals._tokens) <= 2048
    assert len(approvals._session_tokens) <= 2048

    limiter = MemoryCapsuleRateLimiter(per_action_per_minute=100, max_keys=32)
    for index in range(100):
        limiter.check(
            session_hash=f"{index:064x}"[-64:],
            client_identity=f"192.0.2.{index}",
            action="prepare",
        )
    assert len(limiter._hits) <= 32
    assert len(limiter._last_seen) <= 32


def test_approval_expiry_is_distinct_from_invalid():
    clock = Clock()
    approvals = MemoryCapsuleApprovalStore(ttl_seconds=15, clock=clock)
    token = approvals.create(
        session_hash="a" * 64,
        preparation_minutes=20,
        created_at=clock(),
        expires_at=clock() + timedelta(minutes=30),
    )
    clock.now += timedelta(seconds=16)

    with pytest.raises(MemoryCapsuleError) as error:
        approvals.consume(token, session_hash="a" * 64)

    assert error.value.code == "expired"


def test_settings_require_dedicated_couch_and_sqlite_names():
    from config.settings import Settings

    memory_db_path = Settings.model_fields["memory_db_path"].get_default()
    couchdb_db_name = Settings.model_fields["couchdb_db_name"].get_default()
    capsule_index_db_path = Settings.model_fields[
        "memory_capsule_index_db_path"
    ].get_default()
    capsule_couchdb_db_name = Settings.model_fields[
        "memory_capsule_couchdb_db_name"
    ].get_default()
    assert all(
        isinstance(value, str)
        for value in (
            memory_db_path,
            couchdb_db_name,
            capsule_index_db_path,
            capsule_couchdb_db_name,
        )
    )

    common = {
        "_env_file": None,
        "memory_db_path": memory_db_path,
        "couchdb_db_name": couchdb_db_name,
        "enable_memory_capsule": True,
        "memory_capsule_index_db_path": capsule_index_db_path,
        "memory_capsule_couchdb_url": "http://127.0.0.1:5984",
        "memory_capsule_couchdb_user": "demo",
        "memory_capsule_couchdb_password": "secret",
        "memory_capsule_couchdb_db_name": capsule_couchdb_db_name,
    }
    assert Settings(**common).memory_capsule_configured is True
    assert Settings(
        **{**common, "memory_capsule_couchdb_db_name": couchdb_db_name},
    ).memory_capsule_configured is False
    assert Settings(
        **{**common, "memory_capsule_index_db_path": memory_db_path},
    ).memory_capsule_configured is False
    assert Settings(
        **{**common, "memory_capsule_index_db_path": f"./{memory_db_path}"},
    ).memory_capsule_configured is False


def test_personal_memory_store_does_not_create_public_capsule_tables():
    from memory.store import MemoryStore

    with MemoryStore(":memory:") as personal:
        assert "memory_capsules" not in personal.get_table_names()
    with MemoryCapsuleIndexStore(":memory:") as public:
        assert "memory_capsules" in public.get_table_names()


def test_invalid_capsule_config_never_opens_any_capsule_store():
    import main as main_module

    with (
        patch.object(
            main_module,
            "settings",
            SimpleNamespace(memory_capsule_configured=False),
        ),
        patch.object(main_module, "MemoryCapsuleIndexStore") as store_class,
        patch.object(main_module, "CouchDBMemoryCapsuleRepository") as repository_class,
        patch.object(main_module, "LocalEmbeddingProvider") as embedding_class,
    ):
        store, service = main_module._build_memory_capsule_components()

    assert store is None
    assert service is None
    store_class.assert_not_called()
    repository_class.assert_not_called()
    embedding_class.assert_not_called()


def test_couchdb_transport_creates_dedicated_database_index_and_reads_changes():
    transport = FakeTransport([
        FakeResponse(404),
        FakeResponse(201, {"ok": True}),
        FakeResponse(200, {"result": "created"}),
        FakeResponse(200, {"results": [], "last_seq": "3-g1", "pending": 0}),
    ])
    repository = CouchDBMemoryCapsuleRepository(
        base_url="http://127.0.0.1:5984",
        database="public capsules",
        username="demo",
        password="secret",
        transport=transport,
    )

    repository.ensure_database()
    changes, sequence, pending = repository.changes(0)

    assert [call[0] for call in transport.calls] == ["GET", "PUT", "POST", "GET"]
    assert transport.calls[0][1].endswith("/public%20capsules")
    assert transport.calls[2][1].endswith("/_index")
    assert transport.calls[3][1].endswith("/_changes")
    assert transport.calls[3][2]["params"]["include_docs"] == "true"
    assert changes == []
    assert sequence == "3-g1"
    assert pending == 0


def test_couchdb_transport_errors_do_not_include_response_body():
    transport = FakeTransport([FakeResponse(401, {"reason": "admin secret"})])
    repository = CouchDBMemoryCapsuleRepository(
        base_url="http://private.example:5984",
        database="capsules",
        username="demo",
        password="secret",
        transport=transport,
    )

    with pytest.raises(CouchDBRepositoryError) as error:
        repository.ensure_database()

    assert "secret" not in str(error.value)
    assert "private.example" not in str(error.value)


@pytest.mark.asyncio
async def test_websocket_contract_uses_server_session_and_no_empty_response(capsule_setup):
    from channels.webchat import WebChatChannel
    from starlette.websockets import WebSocketDisconnect

    service, *_ = capsule_setup
    websocket = MagicMock()
    websocket.accept = AsyncMock()
    websocket.send_text = AsyncMock()
    websocket.headers = {"x-real-ip": "192.0.2.10"}
    websocket.client = SimpleNamespace(host="127.0.0.1")
    websocket.app = SimpleNamespace(
        state=SimpleNamespace(memory_capsule_service=service)
    )
    messages = [{
        "action": "memory_capsule_prepare",
        "payload": {
            "operation_id": "4e219ea3-e308-45c4-91d2-ae88e8efaf2c",
            "preparation_minutes": 20,
            "owner": SESSION_B,
            "session_key": SESSION_B,
        },
    }]

    async def receive_text():
        if messages:
            import json

            return json.dumps(messages.pop(0))
        raise WebSocketDisconnect()

    websocket.receive_text = receive_text
    orchestrator = MagicMock()
    orchestrator.handle_message_stream = MagicMock()

    await WebChatChannel(
        orchestrator=orchestrator, session_key=SESSION_A
    ).handle(websocket)

    import json

    sent = [json.loads(call.args[0]) for call in websocket.send_text.call_args_list]
    assert len(sent) == 1
    assert sent[0]["event"] == "memory_capsule_approval_required"
    assert sent[0]["payload"]["operationId"] == (
        "4e219ea3-e308-45c4-91d2-ae88e8efaf2c"
    )
    assert sent[0]["payload"]["preparationMinutes"] == 20
    assert not any(message.get("type") == "response" for message in sent)
    orchestrator.handle_message_stream.assert_not_called()


@pytest.mark.asyncio
async def test_websocket_rejects_invalid_operation_id_without_storage_call(
    capsule_setup,
):
    from channels.webchat import WebChatChannel
    from starlette.websockets import WebSocketDisconnect

    service, *_ = capsule_setup
    websocket = MagicMock()
    websocket.accept = AsyncMock()
    websocket.send_text = AsyncMock()
    websocket.headers = {}
    websocket.client = None
    websocket.app = SimpleNamespace(
        state=SimpleNamespace(memory_capsule_service=service)
    )
    messages = [{
        "action": "memory_capsule_prepare",
        "payload": {"operation_id": "not-a-uuid", "preparation_minutes": 20},
    }]

    async def receive_text():
        if messages:
            import json

            return json.dumps(messages.pop(0))
        raise WebSocketDisconnect()

    websocket.receive_text = receive_text
    orchestrator = MagicMock()
    await WebChatChannel(
        orchestrator=orchestrator, session_key=SESSION_A
    ).handle(websocket)

    import json

    sent = json.loads(websocket.send_text.call_args.args[0])
    assert sent == {
        "type": "event",
        "event": "memory_capsule_error",
        "payload": {
            "operationId": "",
            "code": "invalid",
            "message": "요청 식별자를 확인할 수 없습니다.",
        },
    }
    assert repository_count(service) == 0


def repository_count(service: MemoryCapsuleService) -> int:
    """operation-id 검증이 service 호출 전에 끝났는지 확인하는 작은 helper."""
    repository = service._repository
    return len(repository.docs) if isinstance(repository, FakeRepository) else -1


@pytest.mark.asyncio
async def test_websocket_echoes_operation_id_for_every_capsule_result():
    from channels.webchat import WebChatChannel
    from starlette.websockets import WebSocketDisconnect

    operation_ids = [
        "4e219ea3-e308-45c4-91d2-ae88e8efaf2c",
        "5d341142-e580-4adc-9f7c-ab8fc598a307",
        "0f9b27dd-f176-4932-8ccf-aa617417d689",
        "fbaebf65-e3b6-480b-a2e9-38aef9f8c505",
        "c7f7a8d9-531b-42d2-bfd4-6ca91896983c",
    ]
    actions = [
        "memory_capsule_prepare",
        "memory_capsule_approve",
        "memory_capsule_reject",
        "memory_capsule_recall",
        "memory_capsule_forget",
    ]
    messages = [
        {
            "action": action,
            "payload": {
                "operation_id": operation_id,
                "preparation_minutes": 20,
                "approval_token": "token",
            },
        }
        for action, operation_id in zip(actions, operation_ids, strict=True)
    ]
    service = SimpleNamespace(
        prepare=AsyncMock(return_value={"approvalToken": "token"}),
        approve=AsyncMock(return_value={"capsule": None}),
        reject=AsyncMock(return_value={}),
        recall=AsyncMock(return_value={"capsule": None}),
        forget=AsyncMock(return_value={}),
    )
    websocket = MagicMock()
    websocket.accept = AsyncMock()
    websocket.send_text = AsyncMock()
    websocket.headers = {}
    websocket.client = None
    websocket.app = SimpleNamespace(
        state=SimpleNamespace(memory_capsule_service=service)
    )

    async def receive_text():
        if messages:
            import json

            return json.dumps(messages.pop(0))
        raise WebSocketDisconnect()

    websocket.receive_text = receive_text
    await WebChatChannel(
        orchestrator=MagicMock(), session_key=SESSION_A
    ).handle(websocket)

    import json

    sent = [json.loads(call.args[0]) for call in websocket.send_text.call_args_list]
    assert [message["payload"]["operationId"] for message in sent] == operation_ids
    assert [message["event"] for message in sent] == [
        "memory_capsule_approval_required",
        "memory_capsule_saved",
        "memory_capsule_rejected",
        "memory_capsule_recalled",
        "memory_capsule_forgotten",
    ]


@pytest.mark.asyncio
async def test_websocket_error_echoes_valid_operation_id():
    from channels.webchat import WebChatChannel
    from starlette.websockets import WebSocketDisconnect

    operation_id = "fbaebf65-e3b6-480b-a2e9-38aef9f8c505"
    service = SimpleNamespace(
        recall=AsyncMock(
            side_effect=MemoryCapsuleError("unavailable", "저장소 점검 중입니다.")
        )
    )
    websocket = MagicMock()
    websocket.accept = AsyncMock()
    websocket.send_text = AsyncMock()
    websocket.headers = {}
    websocket.client = None
    websocket.app = SimpleNamespace(
        state=SimpleNamespace(memory_capsule_service=service)
    )
    messages = [{
        "action": "memory_capsule_recall",
        "payload": {"operation_id": operation_id},
    }]

    async def receive_text():
        if messages:
            import json

            return json.dumps(messages.pop(0))
        raise WebSocketDisconnect()

    websocket.receive_text = receive_text
    await WebChatChannel(
        orchestrator=MagicMock(), session_key=SESSION_A
    ).handle(websocket)

    import json

    sent = json.loads(websocket.send_text.call_args.args[0])
    assert sent["event"] == "memory_capsule_error"
    assert sent["payload"] == {
        "operationId": operation_id,
        "code": "unavailable",
        "message": "저장소 점검 중입니다.",
    }
