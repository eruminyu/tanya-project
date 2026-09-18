"""Atomic managed-note snapshots use synthetic documents and temporary SQLite only."""
from concurrent.futures import ThreadPoolExecutor

import pytest

from rearchitecture.policy import PolicyError, resolve_context
from rearchitecture.storage import StorageError
from tests.test_rearchitecture_app import CLOUD, HEADERS, LOCAL, MODEL, FixtureProvider, completed, config, start_turn
from tests.test_rearchitecture_persistence import client, context, new_conversation, new_source, reference


def document(path="notes/example.md", text="original note", title="Example"):
    return {"path": path, "title": title, "text": text}


def sync(http, documents, revision=0, collection_id="notes", boundary="local", label="My notes"):
    return http.put("/v1/collections/" + collection_id, headers=HEADERS,
                    json={"expected_revision": revision, "label": label, "boundary": boundary, "documents": documents})


def sources(http, query=""):
    result = http.get("/v1/sources", headers=HEADERS, params={"q": query})
    assert result.status_code == 200
    return result.json()["sources"]


def unavailable(http, collection_id="notes"):
    return http.put("/v1/collections/" + collection_id + "/availability", headers=HEADERS, json={"available": False})


def test_collection_auth_metadata_and_source_origin_are_strict_and_identity_bound(tmp_path):
    with client(tmp_path) as http:
        assert http.get("/v1/collections").status_code == 401
        assert http.get("/v1/collections", headers=HEADERS | {"Origin": "null"}).status_code == 401
        assert http.get("/v1/collections", headers=HEADERS).json() == {"collections": []}
        result = sync(http, [document()])
        assert result.status_code == 200
        collection = {"id": "notes", "label": "My notes", "boundary": "local", "revision": 1, "available": True, "source_count": 1}
        assert result.json() == {"collection": collection}
        assert http.get("/v1/collections", headers=HEADERS).json() == {"collections": [collection]}
        source = sources(http)[0]
        assert source["origin"] == {"collection_id": "notes", "collection_label": "My notes", "path": "notes/example.md", "chunk_index": 0, "chunk_count": 1}
        assert source["record"]["source_id"].startswith("managed-")
        assert source["record"]["kind"] == "note" and source["record"]["boundary"] == "local"
        model_identity = http.app.state.v1_store.identity | {"principal_id": "another-owner"}
    with client(tmp_path, identity=model_identity) as http:
        assert http.get("/v1/collections", headers=HEADERS).json() == {"collections": []}
        assert sources(http) == []


def test_chunking_is_lossless_stable_and_noop_scan_only_updates_collection_revision(tmp_path):
    text = "🙂" * 8192 + "한" * 8192 + " final\n"
    docs = [document(text=text), document("empty.md", "", "Empty")]
    with client(tmp_path) as http:
        assert sync(http, docs).json()["collection"]["source_count"] == 3
        before = sorted(sources(http), key=lambda item: item["origin"]["chunk_index"])
        assert [len(item["text"]) for item in before] == [8192, 8192, 7]
        assert "".join(item["text"] for item in before) == text
        assert sync(http, list(reversed(docs)), 1, label="Renamed").json()["collection"]["revision"] == 2
        after = sorted(sources(http), key=lambda item: item["origin"]["chunk_index"])
        assert [item["record"] for item in after] == [item["record"] for item in before]
        assert all(item["origin"]["collection_label"] == "Renamed" for item in after)


def test_changed_file_invalidates_every_chunk_derived_memory_and_reused_history(tmp_path):
    first_text = "a" * 8192 + "unchanged tail"
    with client(tmp_path) as http:
        assert sync(http, [document(text=first_text), document("other.md", "unrelated note")]).status_code == 200
        imported = sorted([item for item in sources(http) if item["origin"]["path"] == "notes/example.md"], key=lambda item: item["origin"]["chunk_index"])
        other = next(item for item in sources(http) if item["origin"]["path"] == "other.md")
        memory = new_source(http, "stale derived marker", kind="memory", parents=[reference(imported[1])])
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(imported[1])])
            completed(ws)
        assert sync(http, [document(text="b" * 8192 + "unchanged tail"), document("other.md", "unrelated note")], 1).status_code == 200
        store = http.app.state.v1_store
        for item in imported:
            assert store.get_source(item["record"]["source_id"])["record"]["revision"] == 2
        assert store.get_source(other["record"]["source_id"])["record"]["revision"] == 1
        assert store.catalog_entry(memory["record"]["source_id"])["record"]["deleted"] is True
        assert store.history(conversation["id"]) == []
        assert all(row["text"] == "" for row in store.messages(conversation["id"]))
        assert sources(http, "stale") == []


def test_file_deletion_and_readdition_preserve_source_ids_but_never_reuse_old_revisions(tmp_path):
    with client(tmp_path) as http:
        assert sync(http, [document(text="a" * 8193)]).status_code == 200
        before = {item["origin"]["chunk_index"]: item for item in sources(http)}
        assert sync(http, [], 1).json()["collection"]["source_count"] == 0
        assert sources(http) == []
        assert sync(http, [document(text="readded")], 2).status_code == 200
        readded = sources(http)[0]
        assert readded["record"]["source_id"] == before[0]["record"]["source_id"]
        assert readded["record"]["revision"] == 3
        assert http.app.state.v1_store.catalog_entry(before[1]["record"]["source_id"])["record"]["deleted"] is True


def test_imported_sources_reject_manual_crud_while_manual_notes_remain_editable(tmp_path):
    with client(tmp_path) as http:
        sync(http, [document()])
        source = sources(http)[0]
        endpoint = "/v1/sources/" + source["record"]["source_id"]
        assert http.put(endpoint, headers=HEADERS, json={"expected_revision": 1, "title": "other", "text": "overwrite", "boundary": "local"}).status_code == 400
        assert http.delete(endpoint + "?revision=1", headers=HEADERS).status_code == 400
        assert sources(http)[0] == source
        manual = new_source(http)
        assert "origin" not in manual
        assert http.delete("/v1/sources/" + manual["record"]["source_id"] + "?revision=1", headers=HEADERS).status_code == 200


def test_availability_blocks_transitive_context_and_search_without_erasing_history(tmp_path):
    docs = [document(text="managed original")]
    with client(tmp_path) as http:
        sync(http, docs)
        source = sources(http)[0]
        direct_memory = new_source(http, "direct derived", kind="memory", parents=[reference(source)])
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(source)])
            completed(ws)
        root = {"source_id": "conversation-" + conversation["id"], "revision": 1}
        indirect_memory = new_source(http, "conversation derived", kind="memory", parents=[root])
        store, catalog = http.app.state.v1_store, http.app.state.v1_service.catalog
        history = store.history(conversation["id"])
        messages = store.messages(conversation["id"])
        assert unavailable(http).json()["collection"] == {"id": "notes", "label": "My notes", "boundary": "local", "revision": 1, "available": False, "source_count": 1}
        assert sources(http) == [] and sources(http, "managed") == [] and sources(http, "derived") == []
        assert store.history(conversation["id"]) == history and store.messages(conversation["id"]) == messages
        for item in (source, direct_memory, indirect_memory):
            key = item["record"]["source_id"]
            assert store.get_source(key)["record"]["deleted"] is False
            assert catalog[key].record["deleted"] is True and catalog[key].text == ""
            with pytest.raises(PolicyError, match="context_blocked"):
                resolve_context(config(), LOCAL, [context(item)], catalog, [])
        rejected = http.post("/v1/sources", headers=HEADERS, json={"title": "blocked", "text": "new derived", "boundary": "local", "kind": "memory", "parents": [root]})
        assert rejected.status_code == 409
        assert sync(http, docs, 1).json()["collection"]["available"] is True
        assert len(sources(http)) == 3
        assert catalog[source["record"]["source_id"]].record["revision"] == 1
        assert store.history(conversation["id"]) == history
        assert resolve_context(config(), LOCAL, [context(indirect_memory)], catalog, [])[0] == indirect_memory["text"]


def test_unavailable_collection_cancels_active_provider_but_preserves_actual_partial_text(tmp_path):
    provider = FixtureProvider(block=True)
    with client(tmp_path, provider) as http:
        sync(http, [document()])
        source = sources(http)[0]
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(source)])
            assert ws.receive_json()["kind"] == "response.delta"
            assert unavailable(http).status_code == 200
            assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "source_changed"}
            assert ws.receive_json()["kind"] == "context.invalidated"
            assert ws.receive_json()["kind"] == "context.invalidated"
            assert provider.closed is True
        detail = http.get("/v1/conversations/" + conversation["id"], headers=HEADERS).json()
        assert [item["text"] for item in detail["messages"]] == ["hello", "fixture answer"]
        assert all(item["status"] == "failed" for item in detail["messages"])


def test_restart_requires_complete_rescan_before_managed_history_can_be_used(tmp_path):
    docs = [document()]
    with client(tmp_path) as http:
        sync(http, docs)
        source = sources(http)[0]
        new_source(http, "manual visible")
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            start_turn(ws, ws.receive_json()["scope"], context=[context(source)])
            completed(ws)
    provider = FixtureProvider()
    with client(tmp_path, provider) as http:
        assert http.get("/v1/collections", headers=HEADERS).json()["collections"][0]["available"] is False
        assert [item["text"] for item in sources(http)] == ["manual visible"]
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, turn="blocked")
            assert completed(ws)[-1]["payload"]["error_code"] == "context_blocked"
        assert provider.calls == []
        assert sync(http, docs, 1).status_code == 200
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            start_turn(ws, ws.receive_json()["scope"], turn="after-rescan")
            assert completed(ws)[-1]["payload"]["status"] == "completed"
        assert len(provider.calls) == 1
        assert provider.calls[0][3][0]["content"] == "hello"


def test_collection_delete_is_explicit_revision_checked_and_invalidates_derived_content(tmp_path):
    with client(tmp_path) as http:
        sync(http, [document()])
        source = sources(http)[0]
        derived = new_source(http, "derived secretmarker", kind="memory", parents=[reference(source)])
        assert http.delete("/v1/collections/notes?revision=2", headers=HEADERS).status_code == 409
        assert http.delete("/v1/collections/notes?revision=1", headers=HEADERS).json() == {"ok": True}
        assert http.get("/v1/collections", headers=HEADERS).json() == {"collections": []}
        assert sources(http) == []
        assert http.app.state.v1_store.catalog_entry(derived["record"]["source_id"])["record"]["deleted"] is True
        assert sync(http, [document()]).status_code == 409


def test_failed_snapshot_rolls_back_sources_fts_metadata_history_and_availability(tmp_path, monkeypatch):
    with client(tmp_path) as http:
        sync(http, [document()])
        before = sources(http)
        new_source(http, "derived original", kind="memory", parents=[reference(before[0])])
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            start_turn(ws, ws.receive_json()["scope"], context=[context(before[0])])
            completed(ws)
        history = http.app.state.v1_store.history(conversation["id"])
        unavailable(http)
        store = http.app.state.v1_store
        invalidate = store._invalidate
        def fail(db, affected, preserve=None):
            invalidate(db, affected, preserve)
            raise StorageError()
        monkeypatch.setattr(store, "_invalidate", fail)
        assert sync(http, [document(text="replacement")], 1).status_code == 503
        collection = http.get("/v1/collections", headers=HEADERS).json()["collections"][0]
        assert collection["revision"] == 1 and collection["available"] is False
        assert sources(http) == []
        assert store.get_source(before[0]["record"]["source_id"])["text"] == before[0]["text"]
        assert store.connection.execute("SELECT count(*) FROM sources_fts").fetchone()[0] == 2
        assert store.history(conversation["id"]) == history


@pytest.mark.parametrize("path", ["/absolute.md", "../escape.md", "a/../escape.md", "a/./note.md", "a//note.md", "C:/note.md", "a\\note.md", "a.md\n", "notes.txt", "x" * 1022 + ".md"])
def test_invalid_document_paths_do_not_commit_any_snapshot(tmp_path, path):
    with client(tmp_path) as http:
        assert sync(http, [document(), document(path)]).status_code == 400
        assert http.get("/v1/collections", headers=HEADERS).json() == {"collections": []}
        assert sources(http) == []


@pytest.mark.parametrize("mutation", ["duplicate", "cloud", "boolean-revision", "document-bytes", "total-bytes", "document-count", "title", "extra-field", "surrogate"])
def test_snapshot_input_limits_are_enforced_before_any_source_changes(tmp_path, mutation):
    with client(tmp_path) as http:
        docs, boundary, revision = [document()], "local", 0
        if mutation == "duplicate": docs.append(document())
        elif mutation == "cloud": boundary = "cloud"
        elif mutation == "boolean-revision": revision = False
        elif mutation == "document-bytes": docs[0]["text"] = "🙂" * 65537
        elif mutation == "total-bytes": docs = [document(f"{i}.md", "x" * (256 * 1024)) for i in range(65)]
        elif mutation == "document-count": docs = [document(f"{i}.md", "") for i in range(1001)]
        elif mutation == "title": docs[0]["title"] = "x" * 121
        elif mutation == "extra-field": docs[0]["url"] = "https://example.invalid"
        elif mutation == "surrogate": docs[0]["text"] = "\ud800"
        if mutation == "surrogate":
            import json
            response = http.put("/v1/collections/notes", headers=HEADERS | {"Content-Type": "application/json"},
                                content=json.dumps({"expected_revision": revision, "label": "Notes", "boundary": boundary, "documents": docs}))
        else:
            response = sync(http, docs, revision, boundary=boundary)
        assert response.status_code == 400
        assert http.get("/v1/collections", headers=HEADERS).json() == {"collections": []}


def test_snapshot_http_body_limit_and_availability_cannot_be_bypassed(tmp_path):
    with client(tmp_path) as http:
        response = http.put("/v1/collections/notes", headers=HEADERS, content=b" " * (24 * 1024 * 1024 + 1))
        assert response.status_code == 413
        sync(http, [document()])
        for value in (True, 0, 1, None, "false"):
            assert http.put("/v1/collections/notes/availability", headers=HEADERS, json={"available": value}).status_code == 400
        assert sync(http, [document(text="stale overwrite")], 0).status_code == 409
        assert sources(http)[0]["text"] == "original note"


def test_imported_local_and_lan_notes_never_gain_cloud_permission(tmp_path):
    with client(tmp_path) as http:
        sync(http, [document()], boundary="private_lan")
        source = sources(http)[0]
        catalog = http.app.state.v1_service.catalog
        with pytest.raises(PolicyError, match="context_blocked"):
            resolve_context(config(), CLOUD, [context(source)], catalog, [])
        assert resolve_context(config(), LOCAL, [context(source)], catalog, [])[0] == source["text"]
        assert sync(http, [document()], 1, boundary="local").status_code == 200
        assert sources(http)[0]["record"]["revision"] == 2


def test_large_collection_invalidation_has_bounded_wire_fanout(tmp_path):
    docs = [document(f"{index}.md", f"note {index}") for index in range(150)]
    with client(tmp_path, max_events=140) as http:
        sync(http, docs)
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            ws.receive_json()
            assert unavailable(http).status_code == 200
            assert ws.receive_json()["kind"] == "context.invalidated"
            # An idle session only needs the representative invalidation to reload its library.
            session = next(iter(http.app.state.v1_service.sessions.values()))
            assert session.exhausted is False and session.events == 2
        assert sources(http) == []


@pytest.mark.parametrize("limit", ["document-bytes", "total-bytes", "document-count"])
def test_exact_document_and_snapshot_limits_are_accepted(tmp_path, limit):
    if limit == "document-bytes":
        docs, expected = [document(text="🙂" * 65536)], 8
    elif limit == "total-bytes":
        docs, expected = [document(f"{index}.md", "x" * (256 * 1024)) for index in range(64)], 2048
    else:
        docs, expected = [document(f"{index}.md", "text") for index in range(1000)], 1000
    with client(tmp_path) as http:
        result = sync(http, docs)
        assert result.status_code == 200
        assert result.json()["collection"]["source_count"] == expected
        assert len(sources(http)) == min(50, expected)


def test_concurrent_snapshot_revision_has_one_winner_without_partial_interleaving(tmp_path):
    with client(tmp_path) as http:
        sync(http, [document()])
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda text: sync(http, [document(text=text)], 1), ["first complete", "second complete"]))
        assert sorted(result.status_code for result in results) == [200, 409]
        current = sources(http)[0]
        assert current["record"]["revision"] == 2
        assert current["text"] in ("first complete", "second complete")
        assert http.get("/v1/collections", headers=HEADERS).json()["collections"][0]["revision"] == 2


def test_rescanning_one_collection_does_not_unblock_another_unavailable_ancestor(tmp_path):
    with client(tmp_path) as http:
        sync(http, [document(text="first original")], collection_id="first")
        sync(http, [document(text="second original")], collection_id="second")
        parents = [reference(item) for item in sources(http)]
        memory = new_source(http, "combined memory", kind="memory", parents=parents)
        unavailable(http, "first")
        unavailable(http, "second")
        assert sources(http) == []
        assert sync(http, [document(text="first original")], 1, collection_id="first").status_code == 200
        assert [item["text"] for item in sources(http)] == ["first original"]
        assert http.app.state.v1_service.catalog[memory["record"]["source_id"]].record["deleted"] is True
        assert sync(http, [document(text="second original")], 1, collection_id="second").status_code == 200
        assert len(sources(http)) == 3
        assert http.app.state.v1_service.catalog[memory["record"]["source_id"]].record["deleted"] is False


def test_active_collection_count_is_bounded_and_deleted_slots_can_be_replaced(tmp_path):
    with client(tmp_path) as http:
        for index in range(32):
            assert sync(http, [], collection_id=f"collection-{index}").status_code == 200
        assert sync(http, [], collection_id="too-many").status_code == 400
        assert http.delete("/v1/collections/collection-0?revision=1", headers=HEADERS).status_code == 200
        assert sync(http, [], collection_id="replacement").status_code == 200
        assert len(http.get("/v1/collections", headers=HEADERS).json()["collections"]) == 32
