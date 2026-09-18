"""Synthetic host receipts and temporary SQLite; no external execution or accounts."""
import copy
import hashlib

import pytest
from fastapi.testclient import TestClient

from rearchitecture.app import create_app
from rearchitecture.auto_memory_store import AutoMemoryRepository
from rearchitecture.embedding import SQLiteVectorIndex
from rearchitecture.policy import PolicyError, resolve_context
from rearchitecture.storage import SQLiteStore, StorageError
from tests.test_rearchitecture_app import HEADERS, IDENTITY, LOCAL, MODEL, FixtureProvider, config


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def registration(parents=None, *, boundary="local", raw=None, canonical=None):
    raw = raw if raw is not None else '{ "text": "외부 fixture 결과", "count": 1.0 }'
    canonical = canonical if canonical is not None else '{"count":1,"text":"외부 fixture 결과"}'
    provenance = {
        "identity": copy.deepcopy(IDENTITY), "scope": IDENTITY | {"session_id": "session", "connection_id": "connection", "connection_epoch": 0},
        "turnId": "turn", "intentId": "intent", "proposalId": "proposal", "offerId": "offer", "draftId": "draft", "draftRevision": 1,
        "payloadSha256": "a" * 64, "executionId": "execution", "providerOperationId": "operation", "connectionId": "mcp-connection",
        "connectionGeneration": "generation", "accountId": "account", "toolName": "fixture", "toolFingerprint": "b" * 64,
        "boundary": boundary, "parents": parents or [], "offeredMetadata": [], "rawResultSha256": digest(raw), "canonicalResultSha256": digest(canonical),
    }
    provenance["offeredMetadata"] = [{key: provenance[key] for key in
        ("offerId", "connectionId", "connectionGeneration", "accountId", "toolName", "toolFingerprint", "boundary")}]
    receipt = {"execution_id": "execution", "draft_id": "draft", "draft_revision": 1, "identity": copy.deepcopy(IDENTITY),
               "executor_id": "kirian-external-v1", "payload_sha256": "a" * 64, "status": "succeeded", "provider_id": "mcp",
               "provider_operation_id": "operation", "error_code": None, "recorded_at_ms": 1}
    return {"provenance": provenance, "receipt": receipt, "rawResultJson": raw, "canonicalResultJson": canonical}


@pytest.fixture
def store(tmp_path):
    value = SQLiteStore(str(tmp_path), IDENTITY)
    yield value
    value.close()


def ref(source):
    return {key: source["record"][key] for key in ("source_id", "revision")}


def note(store, parents=None, boundary="local"):
    return store.create_source("fixture note", "fixture evidence", boundary, "note", parents or [])


def test_calendar_result_provider_must_match_chosen_metadata_and_receipt(store):
    value = registration()
    value["provenance"]["providerKind"] = "google_calendar"
    with pytest.raises(StorageError):
        store.register_tool_result(value)
    value["provenance"]["offeredMetadata"][0]["providerKind"] = "google_calendar"
    with pytest.raises(StorageError):
        store.register_tool_result(value)
    value["receipt"]["provider_id"] = "google_calendar"
    assert store.register_tool_result(value)["kind"] == "tool_result"


def test_exact_canonical_text_receipt_and_execution_are_durable_and_immutable(tmp_path):
    value = registration()
    store = SQLiteStore(str(tmp_path), IDENTITY)
    try:
        result = store.register_tool_result(value)
        assert result == store.register_tool_result(copy.deepcopy(value))
        assert result["kind"] == "tool_result" and result["text"] == value["canonicalResultJson"]
        assert result["rawResultSha256"] == digest(value["rawResultJson"])
        assert result["canonicalResultSha256"] == digest(result["text"])
        source = store.get_source(result["sourceRef"]["source_id"])
        assert source["record"]["kind"] == "tool_result"
        assert store.list_sources() == [] and store.list_sources("fixture") == []
        assert store.connection.execute("SELECT count(*) FROM external_tool_results").fetchone()[0] == 1
        with pytest.raises(StorageError, match="invalid_request"):
            store.update_source(result["sourceRef"]["source_id"], 1, "edited", "forgery", "local")
        with pytest.raises(StorageError, match="invalid_request"):
            store.create_source("forged", "forgery", "local", "tool_result", [])
        context = result["sourceRef"] | {"text": result["text"]}
        text, sources = resolve_context(config(), LOCAL, [context], store.catalog(), [])
        assert text == result["text"] and sources == [result["sourceRef"]]
    finally:
        store.close()
    restored = SQLiteStore(str(tmp_path), IDENTITY)
    try:
        assert restored.register_tool_result(value) == result
    finally:
        restored.close()


@pytest.mark.parametrize("change", [
    lambda v: v["provenance"].update(identity=IDENTITY | {"principal_id": "other"}),
    lambda v: v["provenance"]["scope"].update(principal_id="other"),
    lambda v: v["provenance"].update(draftRevision=True),
    lambda v: v["provenance"].update(rawResultSha256="f" * 64),
    lambda v: v["provenance"].update(canonicalResultSha256="f" * 64),
    lambda v: v["provenance"].update(toolFingerprint="f" * 64),
    lambda v: v["provenance"].update(offerId="other"),
    lambda v: v["provenance"].update(offeredMetadata=[]),
    lambda v: v["provenance"]["offeredMetadata"].append(copy.deepcopy(v["provenance"]["offeredMetadata"][0])),
    lambda v: v["receipt"].update(status="failed"),
    lambda v: v["receipt"].update(status="unknown"),
    lambda v: v["receipt"].update(draft_id="other"),
    lambda v: v["receipt"].update(draft_revision=2),
    lambda v: v["receipt"].update(execution_id="other"),
    lambda v: v["receipt"].update(payload_sha256="f" * 64),
    lambda v: v["receipt"].update(provider_operation_id="other"),
    lambda v: v["receipt"].update(executor_id="other"),
    lambda v: v["receipt"].update(provider_id="google_calendar"),
    lambda v: v["receipt"].update(identity=IDENTITY | {"principal_id": "other"}),
    lambda v: v.update(extra="untrusted"),
])
def test_invalid_provenance_receipt_or_body_never_registers(store, change):
    value = registration()
    change(value)
    with pytest.raises(StorageError, match="invalid_request"):
        store.register_tool_result(value)
    assert store.connection.execute("SELECT count(*) FROM external_tool_results").fetchone()[0] == 0


@pytest.mark.parametrize("raw,canonical", [
    ('{"n":true}', '{"n":1}'),
    ('{"n":1}', '{"n":2}'),
    ('{"n":NaN}', '{"n":NaN}'),
    ('1e400', '1e400'),
    ('"\\ud800"', '"\\ud800"'),
    ('"\\u0000"', '"\\u0000"'),
    ('{"__proto__":{}}', '{"__proto__":{}}'),
    ('[' * 26 + '0' + ']' * 26, '[' * 26 + '0' + ']' * 26),
    ('"' + 'x' * 8191 + '"', '"' + 'x' * 8191 + '"'),
])
def test_invalid_lossy_or_oversized_result_is_rejected(store, raw, canonical):
    with pytest.raises(StorageError, match="invalid_request"):
        store.register_tool_result(registration(raw=raw, canonical=canonical))


def test_equivalent_js_numbers_and_unicode_key_order_are_preserved(store):
    raw = '{"😀": 0.0000001, "한": 1e21, "zero": -0, "nested":[true,null,{}]}'
    canonical = '{"zero":0,"😀":1e-7,"한":1e+21,"nested":[true,null,{}]}'
    result = store.register_tool_result(registration(raw=raw, canonical=canonical))
    assert result["text"] == canonical


def test_execution_and_draft_claim_cannot_be_rewritten_or_duplicated(store):
    value = registration()
    store.register_tool_result(value)
    changed = copy.deepcopy(value)
    changed["receipt"]["recorded_at_ms"] = 2
    with pytest.raises(StorageError, match="source_changed"):
        store.register_tool_result(changed)
    for key in ("executionId", "draftId", "proposalId"):
        changed = copy.deepcopy(value)
        changed["provenance"][key] = "other"
        receipt_key = {"executionId": "execution_id", "draftId": "draft_id"}.get(key)
        if receipt_key:
            changed["receipt"][receipt_key] = "other"
        with pytest.raises(StorageError, match="source_changed"):
            store.register_tool_result(changed)
    assert store.connection.execute("SELECT count(*) FROM external_tool_results").fetchone()[0] == 1


def test_parent_revision_boundary_and_complete_ancestor_closure_are_revalidated(store):
    parent = note(store)
    child = note(store, [ref(parent)])
    records = store.effective_source_records([ref(child)])
    assert {r["source_id"] for r in records} == {ref(parent)["source_id"], ref(child)["source_id"]}
    with pytest.raises(StorageError, match="context_blocked"):
        store.register_tool_result(registration([ref(child)], boundary="cloud"))
    changed, _ = store.update_source(ref(parent)["source_id"], 1, "updated", "new evidence", "local")
    with pytest.raises(StorageError):
        store.register_tool_result(registration([ref(child)]))
    current = store.effective_source_records([ref(child)])
    assert next(r for r in current if r["source_id"] == ref(child)["source_id"])["deleted"] is True
    assert next(r for r in current if r["source_id"] == ref(parent)["source_id"])["revision"] == 2


@pytest.mark.parametrize("operation", ["delete_result", "update_parent", "delete_parent", "delete_conversation"])
def test_deletion_propagates_through_results_memory_and_history_and_cannot_resurrect(store, operation):
    parent = note(store)
    origin = store.create_conversation()
    value = registration([ref(parent)])
    result = store.register_tool_result(value, origin["id"])
    memory = store.create_source("derived", "result memory", "local", "memory", [result["sourceRef"]])
    conversation = store.create_conversation()
    store.begin_turn(conversation["id"], "summary", "summarize tool result")
    store.start_turn(conversation["id"], "summary", [result["sourceRef"]])
    store.complete_response(conversation["id"], "summary", "summary from result", MODEL, [result["sourceRef"]])
    store.end_turn(conversation["id"], "summary", "completed")
    repo = AutoMemoryRepository(store)
    turn_source = repo.capture_turn(conversation["id"], "summary", "local", [])
    auto_memory = repo.remember(turn_source, [{"category": "fact", "quote": "summary from result", "text": "remembered tool result"}], MODEL)[0]
    index = SQLiteVectorIndex(store)
    index.put(auto_memory, MODEL, [1.0, 0.0])
    assert repo.evidence() and index.search(MODEL, [1.0, 0.0])
    if operation == "delete_result":
        store.delete_source(result["sourceRef"]["source_id"], 1)
    elif operation == "update_parent":
        store.update_source(ref(parent)["source_id"], 1, "new", "new evidence", "local")
    elif operation == "delete_parent":
        store.delete_source(ref(parent)["source_id"], 1)
    else:
        store.delete_conversation(origin["id"])
    assert store.catalog_entry(result["sourceRef"]["source_id"])["record"]["deleted"]
    assert store.catalog_entry(ref(memory)["source_id"])["record"]["deleted"]
    assert store.catalog_entry(result["sourceRef"]["source_id"])["text"] == ""
    assert store.history(conversation["id"]) == []
    assert repo.evidence() == [] and index.search(MODEL, [1.0, 0.0]) == []
    assert store.catalog_entry(ref(auto_memory)["source_id"])["record"]["deleted"]
    assert store.messages(conversation["id"])[0]["error_code"] == "source_changed"
    with pytest.raises(StorageError, match="source_changed"):
        store.register_tool_result(value, origin["id"])


def test_unavailable_collection_overlay_blocks_registration_and_keeps_tombstone_evidence(store):
    collection, _ = store.sync_collection("folder", 0, "fixture", "local", [{"path": "note.md", "title": "note", "text": "fixture"}])
    parent = store.list_sources()[0]
    value = registration([ref(parent)])
    result = store.register_tool_result(value)
    store.collection_unavailable("folder")
    records = store.effective_source_records([result["sourceRef"]])
    assert len(records) == 2 and all(record["deleted"] for record in records)
    assert store.catalog_entry(result["sourceRef"]["source_id"])["text"] == ""
    with pytest.raises(StorageError, match="source_changed"):
        store.register_tool_result(value)


def test_metadata_boundary_and_duplicate_parent_are_rejected(store):
    value = registration(boundary="cloud")
    value["provenance"]["offeredMetadata"][0]["boundary"] = "local"
    with pytest.raises(StorageError, match="context_blocked"):
        store.register_tool_result(value)
    parent = note(store)
    with pytest.raises(StorageError, match="invalid_request"):
        store.register_tool_result(registration([ref(parent), ref(parent)]))


def test_demo_identity_registers_external_execution_only_under_its_own_identity(tmp_path):
    # Decision 2026-09-17: the public web demo executes through a gateway-owned demo account (or a hand-off),
    # so a public_demo store accepts registrations for its own identity and still refuses any other.
    identity = IDENTITY | {"mode": "public_demo"}
    store = SQLiteStore(str(tmp_path), identity)
    try:
        foreign = registration()
        with pytest.raises(StorageError, match="invalid_request"):
            store.register_tool_result(foreign)
        value = registration()
        value["provenance"]["identity"] = identity
        value["provenance"]["scope"].update(mode="public_demo")
        value["receipt"]["identity"] = identity
        conversation = store.create_conversation()
        registered = store.register_tool_result(value, conversation["id"])
        assert registered["sourceRef"]["source_id"]
    finally:
        store.close()


def test_host_apis_enforce_loopback_origin_bearer_and_persistence(tmp_path):
    for address, headers in (("192.0.2.1", HEADERS), ("127.0.0.1", {}), ("127.0.0.1", HEADERS | {"Origin": "null"})):
        app = create_app(config(data_dir=str(tmp_path)), FixtureProvider())
        with TestClient(app, client=(address, 50000)) as http:
            assert http.post("/v1/external-tools/results", headers=headers, json=registration()).status_code == 401
            assert http.post("/v1/external-tools/sources", headers=headers, json={"refs": []}).status_code == 401
            assert http.get("/v1/external-tools/turns/context", headers=headers).status_code == 401
    with TestClient(create_app(config(), FixtureProvider()), client=("127.0.0.1", 50000)) as http:
        assert http.post("/v1/external-tools/results", headers=HEADERS, json=registration()).status_code == 503


def test_registered_host_result_requires_live_observation_and_remembers_only_after_commit(tmp_path, monkeypatch):
    app = create_app(config(data_dir=str(tmp_path)), FixtureProvider())
    service = app.state.v1_service
    calls = []
    def validate(provenance):
        calls.append(("validate", provenance["proposalId"]))
    def remember(provenance, reference):
        assert app.state.v1_store.get_source(reference["source_id"])["text"] == registration()["canonicalResultJson"]
        calls.append(("remember", reference))
    monkeypatch.setattr(service, "validate_external_tool_result", validate, raising=False)
    monkeypatch.setattr(service, "remember_external_tool_result", remember, raising=False)
    with TestClient(app, client=("127.0.0.1", 50000)) as http:
        response = http.post("/v1/external-tools/results", headers=HEADERS, json=registration())
        assert response.status_code == 200, response.text
        result = response.json()
        assert [item[0] for item in calls] == ["validate", "remember"]
        records = http.post("/v1/external-tools/sources", headers=HEADERS, json={"refs": [result["sourceRef"]]})
        assert records.status_code == 200 and records.json()["sources"][0]["kind"] == "tool_result"
        def reject(_provenance):
            raise PolicyError("source_changed")
        monkeypatch.setattr(service, "validate_external_tool_result", reject)
        assert http.post("/v1/external-tools/results", headers=HEADERS, json=registration()).status_code == 409
        assert len(calls) == 2
        assert http.post("/v1/external-tools/results?unsafe=1", headers=HEADERS, json=registration()).status_code == 400
        assert http.post("/v1/external-tools/sources", headers=HEADERS, json={"refs": [{"source_id": "missing", "revision": 1}]}).status_code == 404
        assert http.post("/v1/external-tools/sources", headers=HEADERS, json={"refs": [result["sourceRef"], result["sourceRef"]]}).status_code == 400
