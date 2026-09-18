"""Injected deterministic providers test protocol behavior, not model quality."""
import asyncio
import copy
import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from rearchitecture.app import create_app
from rearchitecture.config import ConfigError, ModelBinding, V1Config
from rearchitecture.policy import ContextSource, PolicyError, resolve_context, select_model
from rearchitecture.providers import ProviderChunk


TOKEN = "synthetic-test-token-with-32-characters"
IDENTITY = {"instance_id": "fixture-instance", "mode": "personal", "principal_id": "fixture-owner"}
MODEL = {"provider_id": "ollama", "model_id": "fixture-model", "endpoint_id": "local"}
LOCAL = ModelBinding(MODEL, "Fixture local", "ollama", "http://127.0.0.1:11434", "local")
CLOUD = ModelBinding({"provider_id": "custom", "model_id": "cloud-model", "endpoint_id": "cloud"}, "Fixture cloud", "openai-compatible", "https://provider.invalid/v1", "cloud")
LAN = ModelBinding({"provider_id": "ollama", "model_id": "fixture-model", "endpoint_id": "lan"}, "Fixture LAN", "ollama", "http://192.168.1.20:11434", "private_lan")
HEADERS = {"Authorization": "Bearer " + TOKEN}


def config(**kwargs):
    values = dict(token=TOKEN, identity=IDENTITY, bindings=(LOCAL, CLOUD), default_selection={"model": MODEL, "source": "initial_local"})
    return V1Config(**(values | kwargs))


class FixtureProvider:
    def __init__(self, text="fixture answer", reported=None, done=True, block=False):
        self.text, self.reported, self.done, self.block = text, reported, done, block
        self.calls = []
        self.closed = False

    async def stream(self, binding, user_input, system_prompt, history):
        self.calls.append((binding.model, user_input, system_prompt, copy.deepcopy(history)))
        try:
            yield ProviderChunk(self.text, self.reported or binding.model["model_id"], self.done and not self.block)
            if self.block:
                await asyncio.Event().wait()
        finally:
            self.closed = True


def client(provider=None, **kwargs):
    return TestClient(create_app(config(**kwargs), provider or FixtureProvider()), client=("127.0.0.1", 50000))


def message(scope, kind, payload, number=1, turn="turn-1", **kwargs):
    return {
        "protocol": "kirian.rearchitecture.v1", "message_id": f"client-{number}", "request_id": f"request-{number}",
        "scope": scope, "kind": kind, "turn_id": turn, "intent_id": "intent-" + turn,
        "sequence": 0, "payload": payload, **kwargs,
    }


def start_turn(ws, scope, turn="turn-1", number=1, selection=None, context=None):
    incoming = message(scope, "input.finished", {"input_id": "input-" + turn, "kind": "text", "text": "hello"}, number, turn)
    ws.send_json(incoming)
    assert ws.receive_json() == incoming
    started = message(scope, "turn.start", {"selection": selection or {"model": MODEL, "source": "initial_local"}, "context": context or []}, number + 1, turn)
    ws.send_json(started)
    assert ws.receive_json() == started
    return incoming, started


def completed(ws):
    output = []
    while True:
        item = ws.receive_json()
        output.append(item)
        if item["kind"] == "turn.ended":
            return output


def test_configuration_auth_origin_and_loopback_boundary():
    with client() as http:
        assert http.get("/v1/config").status_code == 401
        assert http.get("/v1/config", headers=HEADERS | {"Origin": "https://example.invalid"}).status_code == 401
        data = http.get("/v1/config", headers=HEADERS).json()
        assert data["identity"] == IDENTITY
        assert set(data) == {"identity", "models", "default_selection"}
        assert TOKEN not in json.dumps(data)
        assert "url" not in json.dumps(data) and "api_key" not in json.dumps(data)
        with pytest.raises(WebSocketDisconnect):
            with http.websocket_connect("/v1/chat"):
                pass
        with pytest.raises(WebSocketDisconnect):
            with http.websocket_connect("/v1/chat", headers=HEADERS | {"Origin": "null"}):
                pass
    with TestClient(create_app(config(), FixtureProvider()), client=("192.168.1.2", 50000)) as remote:
        assert remote.get("/v1/config", headers=HEADERS).status_code == 401


def test_text_stream_echo_sequence_actual_model_and_exact_duplicate():
    provider = FixtureProvider()
    with client(provider) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        ready = ws.receive_json()
        assert ready["kind"] == "session.ready" and ready["payload"]["resume"] == "new_session"
        incoming, started = start_turn(ws, ready["scope"])
        output = completed(ws)
        assert [row["kind"] for row in output] == ["response.delta", "response.completed", "turn.ended"]
        assert [row["sequence"] for row in output[:2]] == [1, 2]
        assert all(row["request_id"] == started["request_id"] for row in output[:2])
        assert output[0]["payload"]["actual_model"] == MODEL
        ws.send_json(incoming)
        assert ws.receive_json() == incoming
        ws.send_json(started)
        assert ws.receive_json() == started
        assert len(provider.calls) == 1


@pytest.mark.parametrize("mutation", ["identity", "sequence", "forged_response", "request_reuse", "changed_duplicate"])
def test_client_forgery_and_binding_conflicts_close_before_inference(mutation):
    provider = FixtureProvider()
    with client(provider) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        incoming = message(scope, "input.finished", {"input_id": "input-1", "kind": "text", "text": "hello"})
        if mutation in ("request_reuse", "changed_duplicate"):
            ws.send_json(incoming)
            assert ws.receive_json() == incoming
        bad = copy.deepcopy(incoming)
        if mutation == "identity":
            bad["scope"]["principal_id"] = "different-owner"
        if mutation == "sequence":
            bad["sequence"] = 2
        if mutation == "forged_response":
            bad["kind"] = "response.delta"
            bad["payload"] = {"text": "forged answer", "actual_model": MODEL}
        if mutation == "request_reuse":
            bad["message_id"] = "new-message"
        if mutation == "changed_duplicate":
            bad["payload"]["text"] = "changed"
        ws.send_json(bad)
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert provider.calls == []


@pytest.mark.parametrize("provider,code", [
    (FixtureProvider(reported="different-model"), "model_mismatch"),
    (FixtureProvider(done=False), "incomplete_response"),
    (FixtureProvider(text=""), "empty_response"),
    (FixtureProvider(text="too long"), "response_limit"),
])
def test_provider_failures_never_claim_completion(provider, code):
    limits = {"max_response_characters": 3} if code == "response_limit" else {}
    with client(provider, **limits) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_turn(ws, scope)
        rows = completed(ws)
        assert rows[-1]["payload"] == {"status": "failed", "error_code": code}
        assert not any(row["kind"] == "response.completed" for row in rows)


def test_cancel_closes_provider_and_prevents_late_completion():
    provider = FixtureProvider(block=True)
    with client(provider) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_turn(ws, scope)
        assert ws.receive_json()["kind"] == "response.delta"
        cancel = message(scope, "turn.cancel", {"reason": "user"}, 3)
        ws.send_json(cancel)
        assert ws.receive_json() == cancel
        assert ws.receive_json()["payload"] == {"status": "cancelled"}
        time.sleep(0.01)
        assert provider.closed
        ws.send_json(cancel)
        assert ws.receive_json() == cancel


def test_reconnect_cancels_active_turn_and_never_replays_it():
    provider = FixtureProvider(block=True)
    with client(provider) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as first:
            scope = first.receive_json()["scope"]
            start_turn(first, scope)
            assert first.receive_json()["kind"] == "response.delta"
            with http.websocket_connect("/v1/chat?session_id=" + scope["session_id"], headers=HEADERS) as second:
                ready = second.receive_json()
                assert ready["payload"]["resume"] == "turns_cancelled"
                assert ready["scope"]["connection_epoch"] == 1
                assert ready["scope"]["connection_id"] != scope["connection_id"]
                with pytest.raises(WebSocketDisconnect):
                    first.receive_json()
                old_turn = message(ready["scope"], "turn.start", {"selection": {"model": MODEL, "source": "initial_local"}, "context": []}, 5)
                second.send_json(old_turn)
                with pytest.raises(WebSocketDisconnect):
                    second.receive_json()
        assert len(provider.calls) == 1


def test_session_count_ttl_and_event_budget():
    with client(max_sessions=1, session_ttl_seconds=0.04) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as first:
            first.receive_json()
            with http.websocket_connect("/v1/chat", headers=HEADERS) as excess:
                with pytest.raises(WebSocketDisconnect):
                    excess.receive_json()
            time.sleep(0.08)
            with pytest.raises(WebSocketDisconnect):
                first.receive_json()
        with http.websocket_connect("/v1/chat", headers=HEADERS) as fresh:
            assert fresh.receive_json()["kind"] == "session.ready"
    with client(max_events=2) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        ws.send_json(message(scope, "input.finished", {"input_id": "input-1", "kind": "text", "text": "q"}))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_generation_budget_failure_closes_without_self_await_or_retaining_the_provider():
    provider = FixtureProvider(block=True)
    with client(provider, max_events=5) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_turn(ws, scope)
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert provider.closed


def test_failure_terminal_budget_exhaustion_closes_socket_and_requires_fresh_session():
    provider = FixtureProvider(done=False)
    with client(provider, max_events=6) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope)
            assert ws.receive_json()["kind"] == "response.delta"
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.reason == "fresh_session_required"
        with http.websocket_connect("/v1/chat?session_id=" + scope["session_id"], headers=HEADERS) as resumed:
            with pytest.raises(WebSocketDisconnect) as closed:
                resumed.receive_json()
            assert closed.value.reason == "fresh_session_required"
    assert provider.closed


def test_turn_timeout_closes_the_stream_and_returns_safe_terminal_error():
    provider = FixtureProvider(block=True)
    with client(provider, turn_timeout_seconds=0.02) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_turn(ws, scope)
        output = completed(ws)
        assert output[-1]["payload"] == {"status": "failed", "error_code": "turn_timeout"}
        assert not any(row["kind"] == "response.completed" for row in output)
    assert provider.closed


def test_binary_frame_is_rejected_without_an_application_exception():
    with client() as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        ws.receive_json()
        ws.send_bytes(b"not a protocol text frame")
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def source(kind="note", boundary="local", parents=None):
    return ContextSource({"source_id": "note-1", "revision": 1, "identity": copy.deepcopy(IDENTITY), "kind": kind, "boundary": boundary, "deleted": False, "parents": parents or []}, "trusted local note")


def test_model_priority_and_host_allowlist():
    cfg = config()
    assert select_model(cfg, cfg.default_selection, None) == LOCAL
    for origin in ("request", "conversation"):
        assert select_model(cfg, {"model": CLOUD.model, "source": origin}, MODEL) == CLOUD
    for selected in [
        {"model": CLOUD.model, "source": "initial_local"},
        {"model": MODEL, "source": "saved_default"},
        {"model": MODEL | {"model_id": "unlisted"}, "source": "request"},
    ]:
        with pytest.raises(PolicyError):
            select_model(cfg, selected, None)
    assert select_model(cfg, cfg.default_selection, CLOUD.model) == LOCAL


@pytest.mark.parametrize("default_source", ["initial_local", "saved_default"])
def test_explicit_default_reset_clears_conversation_choice_but_request_override_preserves_it(default_source):
    provider = FixtureProvider()
    host_default = {"model": MODEL, "source": default_source}
    with client(provider, default_selection=host_default) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        active = http.app.state.v1_service.sessions[scope["session_id"]]
        start_turn(ws, scope, selection={"model": CLOUD.model, "source": "conversation"})
        assert completed(ws)[-1]["payload"] == {"status": "completed"}
        assert active.conversation_model == CLOUD.model
        start_turn(ws, scope, turn="turn-2", number=10, selection={"model": MODEL, "source": "request"})
        assert completed(ws)[-1]["payload"] == {"status": "completed"}
        assert active.conversation_model == CLOUD.model
        start_turn(ws, scope, turn="turn-3", number=20, selection=host_default)
        output = completed(ws)
        assert output[-1]["payload"] == {"status": "completed"}
        assert output[0]["payload"]["actual_model"] == MODEL
        assert active.conversation_model is None
        assert [call[0] for call in provider.calls] == [CLOUD.model, MODEL, MODEL]


@pytest.mark.parametrize("entry", ["direct", "derived", "history"])
@pytest.mark.parametrize("boundary,destination,allowed", [
    ("local", LOCAL, True), ("local", LAN, False), ("local", CLOUD, False),
    ("private_lan", LOCAL, True), ("private_lan", LAN, True), ("private_lan", CLOUD, False),
    ("cloud", CLOUD, True),
])
def test_context_boundaries_apply_to_direct_derived_and_history_sources(entry, boundary, destination, allowed):
    original = source(boundary=boundary)
    catalog = {"note-1": original}
    reference = {"source_id": "note-1", "revision": 1, "text": original.text}
    if entry != "direct":
        derived = ContextSource({
            **copy.deepcopy(original.record), "source_id": "derived", "kind": "memory", "boundary": "cloud",
            "parents": [{"source_id": "note-1", "revision": 1}],
        }, "trusted derived summary")
        catalog["derived"] = derived
        reference = {"source_id": "derived", "revision": 1, "text": derived.text}
    items = [] if entry == "history" else [reference]
    history = [{"role": "assistant", "content": "older response", "sources": [
        {"source_id": reference["source_id"], "revision": 1},
    ]}] if entry == "history" else []
    if allowed:
        resolve_context(config(), destination, items, catalog, history)
    else:
        with pytest.raises(PolicyError, match="context_blocked"):
            resolve_context(config(), destination, items, catalog, history)


@pytest.mark.parametrize("depth,allowed", [(64, True), (65, False)])
def test_context_ancestry_depth_matches_shared_64_node_limit(depth, allowed):
    catalog = {}
    for index in range(depth):
        record = {
            **copy.deepcopy(source().record), "source_id": f"source-{index}", "kind": "memory",
            "parents": [{"source_id": f"source-{index + 1}", "revision": 1}] if index + 1 < depth else [],
        }
        catalog[record["source_id"]] = ContextSource(record, "trusted source")
    items = [{"source_id": "source-0", "revision": 1, "text": "trusted source"}]
    if allowed:
        assert len(resolve_context(config(), LOCAL, items, catalog, [])[1]) == depth
    else:
        with pytest.raises(PolicyError, match="context_blocked"):
            resolve_context(config(), LOCAL, items, catalog, [])


@pytest.mark.parametrize("problem", ["unknown", "modified", "deleted", "identity", "cloud", "text", "parent"])
def test_context_is_host_owned_and_fails_before_provider(problem):
    trusted = source()
    catalog = {"note-1": trusted}
    item = {"source_id": "note-1", "revision": 1, "text": trusted.text}
    selected = {"model": MODEL, "source": "initial_local"}
    if problem == "unknown":
        item["source_id"] = "unknown"
    if problem == "modified":
        item["revision"] = 2
    if problem == "deleted":
        trusted.record["deleted"] = True
    if problem == "identity":
        trusted.record["identity"]["principal_id"] = "other"
    if problem == "cloud":
        selected = {"model": CLOUD.model, "source": "request"}
    if problem == "text":
        item["text"] = "injected caller text"
    if problem == "parent":
        trusted.record["parents"] = [{"source_id": "missing-parent", "revision": 1}]
    provider = FixtureProvider()
    with TestClient(create_app(config(), provider, catalog), client=("127.0.0.1", 50000)) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, selection=selected, context=[item])
            assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "context_blocked"}
    assert provider.calls == []


def test_sensitive_history_remains_local_after_model_switch():
    trusted = source()
    provider = FixtureProvider()
    with TestClient(create_app(config(), provider, {"note-1": trusted}), client=("127.0.0.1", 50000)) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[{"source_id": "note-1", "revision": 1, "text": trusted.text}])
            assert completed(ws)[-1]["payload"]["status"] == "completed"
            assert trusted.text in provider.calls[0][2]
            start_turn(ws, scope, turn="turn-2", number=10, selection={"model": CLOUD.model, "source": "request"})
            assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "context_blocked"}
            assert len(provider.calls) == 1


def test_deleted_source_in_previous_history_is_not_reused_on_next_turn():
    trusted = source()
    provider = FixtureProvider()
    with TestClient(create_app(config(), provider, {"note-1": trusted}), client=("127.0.0.1", 50000)) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[{"source_id": "note-1", "revision": 1, "text": trusted.text}])
            completed(ws)
            trusted.record["deleted"] = True
            start_turn(ws, scope, turn="turn-2", number=10)
            assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "context_blocked"}
            assert len(provider.calls) == 1


@pytest.mark.parametrize("url,boundary", [
    ("http://example.invalid", "local"), ("http://192.168.1.2", "local"),
    ("http://8.8.8.8", "private_lan"), ("http://169.254.169.254", "private_lan"),
    ("http://provider.invalid/v1", "cloud"), ("https://user:secret@provider.invalid", "cloud"),
])
def test_binding_url_cannot_mislabel_trust_boundary(url, boundary):
    with pytest.raises(ConfigError):
        ModelBinding(MODEL, "bad", "ollama", url, boundary)


def test_config_file_keeps_credentials_out_of_public_metadata(monkeypatch, tmp_path):
    path = tmp_path / "synthetic-host-config.json"
    path.write_text(json.dumps({"identity": IDENTITY, "bindings": [{
        "model": CLOUD.model, "label": "API", "kind": "openai-compatible", "url": CLOUD.url,
        "boundary": "cloud", "api_key_env": "SYNTHETIC_PROVIDER_KEY",
    }], "saved_default": CLOUD.model}), encoding="utf-8")
    monkeypatch.setenv("KIRIAN_V1_TOKEN", TOKEN)
    monkeypatch.setenv("KIRIAN_V1_CONFIG_FILE", str(path))
    monkeypatch.setenv("SYNTHETIC_PROVIDER_KEY", "synthetic-key-never-return")
    cfg = V1Config.from_env()
    assert cfg.default_selection == {"model": CLOUD.model, "source": "saved_default"}
    assert "synthetic-key-never-return" not in repr(cfg)
    assert TOKEN not in repr(cfg)
