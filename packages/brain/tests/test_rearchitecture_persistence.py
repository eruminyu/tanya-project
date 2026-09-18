"""Real temporary SQLite/FTS5 with synthetic providers; no production data or inference."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from rearchitecture.app import create_app
from rearchitecture.config import V1Config
from rearchitecture.storage import SQLiteStore, StorageError
from tests.test_rearchitecture_app import CLOUD, HEADERS, IDENTITY, LOCAL, MODEL, TOKEN, FixtureProvider, config, message, start_turn, completed


def client(path, provider=None, **overrides):
    return TestClient(create_app(config(data_dir=str(path), **overrides), provider or FixtureProvider()), client=("127.0.0.1", 50000))


def new_conversation(http):
    result = http.post("/v1/conversations", headers=HEADERS, json={})
    assert result.status_code == 200
    data = result.json()
    assert data["messages"] == []
    return data["conversation"]


def new_source(http, text="고양이 기억", title="test note", boundary="local", kind="note", parents=None):
    response = http.post("/v1/sources", headers=HEADERS, json={"title": title, "text": text, "boundary": boundary, "kind": kind, "parents": parents or []})
    assert response.status_code == 200, response.text
    return response.json()["source"]


def reference(source):
    return {key: source["record"][key] for key in ("source_id", "revision")}


def context(source):
    return reference(source) | {"text": source["text"]}


def test_persistent_api_auth_and_sqlite_durability_configuration(tmp_path):
    with client(tmp_path) as http:
        assert http.get("/v1/conversations").status_code == 401
        assert http.get("/v1/sources", headers=HEADERS | {"Origin": "null"}).status_code == 401
        assert http.get("/v1/config", headers=HEADERS).json()["persistence"] is True
        store = http.app.state.v1_store
        assert store.connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert store.connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert store.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert TOKEN not in store.path.read_bytes().decode("latin1")


def test_legacy_mode_does_not_advertise_or_create_persistence():
    with TestClient(create_app(config(), FixtureProvider()), client=("127.0.0.1", 50000)) as http:
        assert "persistence" not in http.get("/v1/config", headers=HEADERS).json()
        assert http.get("/v1/conversations", headers=HEADERS).status_code == 503
        assert http.app.state.v1_store is None


def test_conversation_response_and_actual_model_survive_process_restart(tmp_path):
    with client(tmp_path) as http:
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope)
            assert completed(ws)[-1]["payload"]["status"] == "completed"
        detail = http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()
        assert [row["text"] for row in detail["messages"]] == ["hello", "fixture answer"]
        assert detail["messages"][-1]["actual_model"] == MODEL
    provider = FixtureProvider()
    with client(tmp_path, provider) as http:
        restored = http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()
        assert restored == detail
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            new_scope = ws.receive_json()["scope"]
            assert new_scope["session_id"] != scope["session_id"]
            assert provider.calls == []
            start_turn(ws, new_scope, turn="turn-2", number=20)
            completed(ws)
        assert [row["content"] for row in provider.calls[0][3]] == ["hello", "fixture answer"]


def test_complete_identity_separates_databases_and_all_domain_objects(tmp_path):
    with client(tmp_path) as http:
        first = new_conversation(http)
        note = new_source(http)
    other = IDENTITY | {"principal_id": "another-owner"}
    with client(tmp_path, identity=other) as http:
        assert http.get("/v1/conversations", headers=HEADERS).json() == {"conversations": []}
        assert http.get("/v1/sources", headers=HEADERS).json() == {"sources": []}
        assert http.get("/v1/conversations/" + first["id"], headers=HEADERS).status_code == 404
        assert http.delete("/v1/sources/" + note["record"]["source_id"] + "?revision=1", headers=HEADERS).status_code == 404


def test_crash_marks_unfinished_turn_cancelled_without_losing_verified_response(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    conversation = store.create_conversation()
    store.begin_turn(conversation["id"], "interrupted", "hello")
    store.start_turn(conversation["id"], "interrupted", [])
    store.complete_response(conversation["id"], "interrupted", "verified answer", MODEL, [])
    store.close()
    restored = SQLiteStore(str(tmp_path), IDENTITY)
    assert [row["status"] for row in restored.messages(conversation["id"])] == ["cancelled", "cancelled"]
    assert restored.messages(conversation["id"])[-1]["text"] == "verified answer"
    restored.close()


def test_second_writer_fails_without_mutating_running_turn_and_lock_releases_on_close(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    conversation = store.create_conversation()
    store.begin_turn(conversation["id"], "running", "question")
    store.start_turn(conversation["id"], "running", [])
    with pytest.raises(StorageError, match="storage_unavailable"):
        SQLiteStore(str(tmp_path), IDENTITY)
    assert store.connection.execute("SELECT status FROM turns WHERE id='running'").fetchone()[0] == "running"
    store.close()
    # A stale filename is harmless once the OS lock has been released.
    restored = SQLiteStore(str(tmp_path), IDENTITY)
    assert restored.connection.execute("SELECT status FROM turns WHERE id='running'").fetchone()[0] == "cancelled"
    restored.close()


def test_constructor_failure_releases_database_os_lock(tmp_path, monkeypatch):
    import rearchitecture.storage as storage
    connect = storage.sqlite3.connect
    def fail(*_args, **_kwargs):
        raise storage.sqlite3.OperationalError("synthetic failure")
    monkeypatch.setattr(storage.sqlite3, "connect", fail)
    with pytest.raises(StorageError):
        SQLiteStore(str(tmp_path), IDENTITY)
    monkeypatch.setattr(storage.sqlite3, "connect", connect)
    store = SQLiteStore(str(tmp_path), IDENTITY)
    store.close()


def test_process_crash_releases_os_lock_and_recovers_unfinished_turn(tmp_path):
    script = """
import json,os,sys
from rearchitecture.storage import SQLiteStore
store=SQLiteStore(sys.argv[1],json.loads(sys.argv[2]))
conversation=store.create_conversation()
store.begin_turn(conversation['id'],'crashed-turn','synthetic input')
store.start_turn(conversation['id'],'crashed-turn',[])
os._exit(7)
"""
    process = subprocess.run([sys.executable, "-c", script, str(tmp_path), json.dumps(IDENTITY)],
                             cwd=Path(__file__).resolve().parents[1], capture_output=True, timeout=10)
    assert process.returncode == 7
    store = SQLiteStore(str(tmp_path), IDENTITY)
    conversation = store.list_conversations()[0]
    assert store.messages(conversation["id"])[0]["status"] == "cancelled"
    store.close()


def test_turn_ids_are_scoped_to_the_durable_conversation(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    first, second = store.create_conversation(), store.create_conversation()
    store.begin_turn(first["id"], "same-turn-id", "first")
    store.begin_turn(second["id"], "same-turn-id", "second")
    assert store.messages(first["id"])[0]["text"] == "first"
    assert store.messages(second["id"])[0]["text"] == "second"
    store.close()


@pytest.mark.parametrize("operation", ["cancel", "failure"])
def test_partial_response_persists_real_status_without_invented_completion(tmp_path, operation):
    provider = FixtureProvider(block=operation == "cancel", done=operation != "failure")
    with client(tmp_path, provider) as http:
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope)
            assert ws.receive_json()["kind"] == "response.delta"
            if operation == "cancel":
                cancel = message(scope, "turn.cancel", {"reason": "user"}, 3)
                ws.send_json(cancel)
                assert ws.receive_json() == cancel
            terminal = ws.receive_json()
            assert terminal["kind"] == "turn.ended"
        rows = http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()["messages"]
        assert rows[-1]["text"] == "fixture answer"
        assert rows[-1]["status"] == ("cancelled" if operation == "cancel" else "failed")
        assert http.app.state.v1_store.history(conversation["id"]) == []


def test_wire_dedup_and_cross_connection_turn_id_reuse_do_not_duplicate_storage(tmp_path):
    with client(tmp_path) as http:
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            incoming, _ = start_turn(ws, scope)
            completed(ws)
            ws.send_json(incoming)
            assert ws.receive_json() == incoming
        assert len(http.app.state.v1_store.messages(conversation["id"])) == 2
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            ws.send_json(message(scope, "input.finished", {"input_id": "other-input", "kind": "text", "text": "duplicate"}, 40))
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        assert len(http.app.state.v1_store.messages(conversation["id"])) == 2


def test_previous_wire_session_cannot_bind_to_another_conversation(tmp_path):
    with client(tmp_path) as http:
        first, second = new_conversation(http), new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + first["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            with http.websocket_connect("/v1/chat?session_id=" + scope["session_id"] + "&conversation_id=" + second["id"], headers=HEADERS) as other:
                with pytest.raises(WebSocketDisconnect):
                    other.receive_json()


def test_new_transport_for_same_conversation_cancels_previous_owner(tmp_path):
    provider = FixtureProvider(block=True)
    with client(tmp_path, provider) as http:
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as first:
            scope = first.receive_json()["scope"]
            start_turn(first, scope)
            assert first.receive_json()["kind"] == "response.delta"
            with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as second:
                assert second.receive_json()["kind"] == "session.ready"
                with pytest.raises(WebSocketDisconnect):
                    first.receive_json()
                assert provider.closed
                assert http.app.state.v1_store.messages(conversation["id"])[-1]["status"] == "cancelled"


def test_switching_durable_conversations_recycles_inactive_transport_budget(tmp_path):
    with client(tmp_path, max_sessions=1) as http:
        first, second = new_conversation(http), new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + first["id"], headers=HEADERS) as ws:
            previous = ws.receive_json()["scope"]["session_id"]
        with http.websocket_connect("/v1/chat?conversation_id=" + second["id"], headers=HEADERS) as ws:
            assert ws.receive_json()["kind"] == "session.ready"
        with http.websocket_connect("/v1/chat?session_id=" + previous, headers=HEADERS) as ws:
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.reason == "fresh_session_required"


def test_saved_default_and_conversation_model_priority_survive_restart(tmp_path):
    with client(tmp_path) as http:
        conversation = new_conversation(http)
        saved = http.put("/v1/preferences", headers=HEADERS, json={"model": CLOUD.model}).json()["default_selection"]
        assert saved == {"model": CLOUD.model, "source": "saved_default"}
        http.put("/v1/conversations/" + conversation["id"] + "/model", headers=HEADERS, json={"model": MODEL})
    with client(tmp_path) as http:
        assert http.get("/v1/config", headers=HEADERS).json()["default_selection"] == saved
        assert http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()["conversation"]["model"] == MODEL
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, selection={"model": CLOUD.model, "source": "request"})
            completed(ws)
            assert http.app.state.v1_store.get_conversation(conversation["id"])["model"] == MODEL
            start_turn(ws, scope, turn="turn-2", number=20, selection=saved)
            completed(ws)
            assert http.app.state.v1_store.get_conversation(conversation["id"])["model"] is None


def test_removed_saved_default_is_preserved_and_never_automatically_replaced(tmp_path):
    with client(tmp_path) as http:
        http.put("/v1/preferences", headers=HEADERS, json={"model": CLOUD.model})
        conversation = new_conversation(http)
    provider = FixtureProvider()
    with client(tmp_path, provider, bindings=(LOCAL,)) as http:
        saved = http.get("/v1/config", headers=HEADERS).json()["default_selection"]
        assert saved["model"] == CLOUD.model
        assert http.put("/v1/preferences", headers=HEADERS, json={"model": CLOUD.model}).status_code == 400
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, selection=saved)
            assert completed(ws)[-1]["payload"]["error_code"] == "model_not_allowed"
        assert provider.calls == []


def test_real_fts_search_update_and_recursive_delete_are_atomic(tmp_path):
    with client(tmp_path) as http:
        note = new_source(http, "고양이 원본", "original")
        derived = new_source(http, "고양이 기억", "derived", kind="memory", parents=[reference(note)])
        descendant = new_source(http, "고양이 요약", "summary", kind="memory", parents=[reference(derived)])
        assert len(http.get("/v1/sources?q=고양이", headers=HEADERS).json()["sources"]) == 3
        changed = http.put("/v1/sources/" + note["record"]["source_id"], headers=HEADERS,
                           json={"expected_revision": 1, "title": "updated", "text": "강아지 원본", "boundary": "local"})
        assert changed.status_code == 200
        assert changed.json()["source"]["record"]["revision"] == 2
        assert http.get("/v1/sources?q=고양이", headers=HEADERS).json()["sources"] == []
        assert len(http.get("/v1/sources?q=강아지", headers=HEADERS).json()["sources"]) == 1
        assert http.delete("/v1/sources/" + note["record"]["source_id"] + "?revision=1", headers=HEADERS).status_code == 409
        assert http.delete("/v1/sources/" + note["record"]["source_id"] + "?revision=2", headers=HEADERS).json() == {"ok": True}
        assert http.get("/v1/sources", headers=HEADERS).json()["sources"] == []
        store = http.app.state.v1_store
        assert store.connection.execute("SELECT count(*) FROM derived_memories").fetchone()[0] == 0
        assert store.connection.execute("SELECT count(*) FROM sources_fts").fetchone()[0] == 0
        assert all(row.record["deleted"] for row in store.catalog().values())


def test_failed_source_update_rolls_back_original_descendants_and_fts(tmp_path, monkeypatch):
    with client(tmp_path) as http:
        note = new_source(http, "original searchable content")
        new_source(http, "derived searchable content", kind="memory", parents=[reference(note)])
        store = http.app.state.v1_store
        invalidate = store._invalidate
        def fail(db, affected, preserve=None):
            invalidate(db, affected, preserve)
            raise StorageError()
        monkeypatch.setattr(store, "_invalidate", fail)
        result = http.put("/v1/sources/" + note["record"]["source_id"], headers=HEADERS,
                          json={"expected_revision": 1, "title": "changed", "text": "replacement", "boundary": "local"})
        assert result.status_code == 503
        assert len(http.get("/v1/sources?q=searchable", headers=HEADERS).json()["sources"]) == 2
        assert store.get_source(note["record"]["source_id"])["record"]["revision"] == 1


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_source_invalidation_follows_conversation_memory_ancestry_transitively(tmp_path, operation):
    with client(tmp_path) as http:
        source = new_source(http, "original secretmarker")
        first, second = new_conversation(http), new_conversation(http)
        first_root = {"source_id": "conversation-" + first["id"], "revision": 1}
        second_root = {"source_id": "conversation-" + second["id"], "revision": 1}
        with http.websocket_connect("/v1/chat?conversation_id=" + first["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(source)])
            completed(ws)
        memory = new_source(http, "derived secretmarker", kind="memory", parents=[first_root])
        with http.websocket_connect("/v1/chat?conversation_id=" + second["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(memory)])
            completed(ws)
        descendant = new_source(http, "transitive secretmarker", kind="memory", parents=[second_root])
        endpoint = "/v1/sources/" + source["record"]["source_id"]
        with http.websocket_connect("/v1/chat?conversation_id=" + first["id"], headers=HEADERS) as ws:
            ws.receive_json()
            if operation == "update":
                response = http.put(endpoint, headers=HEADERS, json={"expected_revision": 1, "title": "changed", "text": "replacement", "boundary": "local"})
            else:
                response = http.delete(endpoint + "?revision=1", headers=HEADERS)
            notifications = [ws.receive_json() for _ in range(5)]
            for root in (first_root, second_root):
                event = next(item for item in notifications if item["payload"]["source_id"] == root["source_id"])
                assert event["kind"] == "context.invalidated"
                assert event["payload"]["reason"] == "updated" and event["payload"]["revision"] == 2
        assert response.status_code == 200
        store = http.app.state.v1_store
        for derived in (memory, descendant):
            removed = store.catalog_entry(derived["record"]["source_id"])
            assert removed["record"]["deleted"] is True
            assert removed["text"] == ""
        assert http.get("/v1/sources?q=secretmarker", headers=HEADERS).json()["sources"] == []
        assert store.connection.execute("SELECT count(*) FROM derived_memories").fetchone()[0] == 0
        for conversation, root in ((first, first_root), (second, second_root)):
            assert store.history(conversation["id"]) == []
            assert all(row["text"] == "" for row in store.messages(conversation["id"]))
            current = store.get_source(root["source_id"])["record"]
            assert current["deleted"] is False and current["revision"] == 2
            stale = http.post("/v1/sources", headers=HEADERS, json={"title": "stale", "text": "stale content", "boundary": "local", "kind": "memory", "parents": [root]})
            assert stale.status_code == 409
            new_source(http, "fresh content", kind="memory", parents=[root | {"revision": 2}])
    with client(tmp_path) as http:
        assert http.get("/v1/sources?q=secretmarker", headers=HEADERS).json()["sources"] == []
        assert all(item["text"] == "fresh content" or item["text"] == "replacement" for item in http.get("/v1/sources", headers=HEADERS).json()["sources"])


def test_source_search_accepts_256_characters_and_rejects_257(tmp_path):
    with client(tmp_path) as http:
        assert http.get("/v1/sources", params={"q": "x" * 256}, headers=HEADERS).status_code == 200
        assert http.get("/v1/sources", params={"q": "x" * 257}, headers=HEADERS).status_code == 400


def test_self_reused_conversation_memory_update_cannot_return_a_stale_parent(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    try:
        conversation = store.create_conversation()
        root = {"source_id": "conversation-" + conversation["id"], "revision": 1}
        memory = store.create_source("memory", "original content", "local", "memory", [root])
        store.begin_turn(conversation["id"], "uses-own-memory", "question")
        store.start_turn(conversation["id"], "uses-own-memory", [reference(memory)])
        store.complete_response(conversation["id"], "uses-own-memory", "answer", MODEL, [reference(memory)])
        store.end_turn(conversation["id"], "uses-own-memory", "completed")
        with pytest.raises(StorageError, match="source_changed"):
            store.update_source(memory["record"]["source_id"], 1, "changed", "new content", "local")
        assert store.get_source(root["source_id"])["record"]["revision"] == 1
        assert store.get_source(memory["record"]["source_id"])["text"] == "original content"
        assert len(store.history(conversation["id"])) == 2
        # Deleting the old memory is still possible, then a fresh anchor revision is usable.
        store.delete_source(memory["record"]["source_id"], 1)
        fresh = store.create_source("fresh", "fresh content", "local", "memory", [root | {"revision": 2}])
        assert fresh["record"]["deleted"] is False
    finally:
        store.close()


def test_persistent_catalog_reads_current_revision_without_retaining_source_bodies(tmp_path):
    with client(tmp_path) as http:
        note = new_source(http)
        catalog = http.app.state.v1_service.catalog
        assert catalog[note["record"]["source_id"]].text == note["text"]
        assert not isinstance(catalog, dict)
        http.put("/v1/sources/" + note["record"]["source_id"], headers=HEADERS,
                 json={"expected_revision": 1, "title": "updated", "text": "current text", "boundary": "local"})
        assert catalog[note["record"]["source_id"]].record["revision"] == 2
        assert catalog[note["record"]["source_id"]].text == "current text"


@pytest.mark.parametrize("boundary", ["private_lan", "cloud"])
def test_derived_memory_cannot_upgrade_local_parent_boundary(tmp_path, boundary):
    with client(tmp_path) as http:
        source = new_source(http)
        result = http.post("/v1/sources", headers=HEADERS, json={"title": "derived", "text": "private text", "boundary": boundary, "kind": "memory", "parents": [reference(source)]})
        assert result.status_code == 403
        assert len(http.get("/v1/sources", headers=HEADERS).json()["sources"]) == 1


def test_source_change_erases_persistent_and_active_history_and_cancels_provider(tmp_path):
    provider = FixtureProvider(block=True)
    with client(tmp_path, provider) as http:
        conversation = new_conversation(http)
        source = new_source(http, "sensitive original")
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(source)])
            assert ws.receive_json()["kind"] == "response.delta"
            changed = http.put("/v1/sources/" + source["record"]["source_id"], headers=HEADERS,
                               json={"expected_revision": 1, "title": "new", "text": "replacement", "boundary": "local"})
            assert changed.status_code == 200
            assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "source_changed"}
            assert ws.receive_json()["kind"] == "context.invalidated"
            assert provider.closed
            detail = http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()
            assert all(row["text"] == "" for row in detail["messages"])
            assert http.app.state.v1_store.history(conversation["id"]) == []
    with client(tmp_path) as http:
        detail = http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()
        assert all(row["text"] == "" for row in detail["messages"])


def test_restored_sensitive_history_is_not_sent_to_cloud(tmp_path):
    with client(tmp_path) as http:
        conversation = new_conversation(http)
        source = new_source(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(source)])
            completed(ws)
    provider = FixtureProvider()
    with client(tmp_path, provider) as http, http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_turn(ws, scope, turn="cloud-attempt", number=20, selection={"model": CLOUD.model, "source": "request"})
        assert completed(ws)[-1]["payload"]["error_code"] == "context_blocked"
        assert provider.calls == []


def test_conversation_delete_removes_derived_memory_and_keeps_socket_open_for_notifications(tmp_path):
    provider = FixtureProvider(block=True)
    with client(tmp_path, provider) as http:
        conversation = new_conversation(http)
        root = {"source_id": "conversation-" + conversation["id"], "revision": 1}
        derived = new_source(http, "derived from conversation", kind="memory", parents=[root])
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope)
            assert ws.receive_json()["kind"] == "response.delta"
            assert http.delete("/v1/conversations/" + conversation["id"], headers=HEADERS).json() == {"ok": True}
            assert ws.receive_json()["payload"]["error_code"] == "source_changed"
            assert ws.receive_json()["kind"] == "context.invalidated"
            assert ws.receive_json()["kind"] == "context.invalidated"
            assert provider.closed
        assert http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).status_code == 404
        assert http.get("/v1/sources", headers=HEADERS).json()["sources"] == []
        assert http.app.state.v1_store.connection.execute("SELECT count(*) FROM turns").fetchone()[0] == 0


def test_source_change_http_commit_succeeds_even_when_notification_budget_is_exhausted(tmp_path):
    with client(tmp_path, max_events=1) as http:
        conversation = new_conversation(http)
        source = new_source(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            ws.receive_json()
            response = http.put("/v1/sources/" + source["record"]["source_id"], headers=HEADERS,
                                json={"expected_revision": 1, "title": "changed", "text": "new text", "boundary": "local"})
            assert response.status_code == 200
            assert response.json()["source"]["record"]["revision"] == 2


def test_previously_deleted_conversation_session_does_not_break_later_source_edits(tmp_path):
    with client(tmp_path) as http:
        conversation = new_conversation(http)
        note = new_source(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            ws.receive_json()
            assert http.delete("/v1/conversations/" + conversation["id"], headers=HEADERS).status_code == 200
            assert ws.receive_json()["kind"] == "context.invalidated"
            result = http.put("/v1/sources/" + note["record"]["source_id"], headers=HEADERS,
                              json={"expected_revision": 1, "title": "later", "text": "new text", "boundary": "local"})
            assert result.status_code == 200
            assert ws.receive_json()["kind"] == "context.invalidated"


def test_saved_response_failure_does_not_emit_completed_or_success(tmp_path, monkeypatch):
    with client(tmp_path) as http:
        conversation = new_conversation(http)
        def fail(*_args):
            raise StorageError()
        monkeypatch.setattr(http.app.state.v1_store, "complete_response", fail)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope)
            rows = completed(ws)
            assert rows[-1]["payload"] == {"status": "failed", "error_code": "storage_unavailable"}
            assert not any(row["kind"] == "response.completed" for row in rows)


def test_detail_message_limits_preserve_whole_bodies_and_stable_order(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    conversation = store.create_conversation()
    for index in range(60):
        turn = f"turn-{index}"
        store.begin_turn(conversation["id"], turn, f"question {index}")
        store.start_turn(conversation["id"], turn, [])
        store.complete_response(conversation["id"], turn, f"answer {index}", MODEL, [])
        store.end_turn(conversation["id"], turn, "completed")
    rows = store.messages(conversation["id"])
    assert len(rows) == 100
    assert rows[0]["text"] == "question 10" and rows[-1]["text"] == "answer 59"
    long_turn = "x" * 128
    store.begin_turn(conversation["id"], long_turn, "question")
    store.start_turn(conversation["id"], long_turn, [])
    store.complete_response(conversation["id"], long_turn, "a" * 32768, MODEL, [])
    store.end_turn(conversation["id"], long_turn, "completed")
    rows = store.messages(conversation["id"])
    assert len(rows) == 1 and len(rows[0]["text"]) == 32768
    assert len(rows[0]["id"]) <= 128
    store.close()


@pytest.mark.parametrize("field,value", [("text", "x" * 8193), ("title", "x" * 121), ("boundary", "remote"), ("kind", "screen")],
                         ids=["text-limit", "title-limit", "boundary", "host-kind"])
def test_source_input_limits_are_enforced(tmp_path, field, value):
    with client(tmp_path) as http:
        body = {"title": "note", "text": "text", "boundary": "local", "kind": "note", "parents": []}
        body[field] = value
        assert http.post("/v1/sources", headers=HEADERS, json=body).status_code == 400
        assert http.get("/v1/sources", headers=HEADERS).json() == {"sources": []}


def test_data_dir_environment_overrides_host_file(tmp_path, monkeypatch):
    host = tmp_path / "host.json"
    host.write_text(json.dumps({"identity": IDENTITY, "bindings": [{"model": MODEL, "label": "local", "kind": "ollama", "url": LOCAL.url, "boundary": "local"}],
                               "data_dir": str(tmp_path / "file-setting")}))
    monkeypatch.setenv("KIRIAN_V1_TOKEN", TOKEN)
    monkeypatch.setenv("KIRIAN_V1_CONFIG_FILE", str(host))
    monkeypatch.setenv("KIRIAN_V1_DATA_DIR", str(tmp_path / "environment-setting"))
    assert V1Config.from_env().data_dir == str(tmp_path / "environment-setting")
