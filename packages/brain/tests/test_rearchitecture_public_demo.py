"""Public demo mode: a Brain instance for anonymous web visitors behind the gateway.

The identity contract already allows ``mode: public_demo``; this mode keeps the loopback+bearer authentication,
refuses cloud models, automatic routing and embedding/transcription, and exposes only per-visitor conversations
plus the external-tool handshake from the store (which the deployment keeps on tmpfs).
"""
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from rearchitecture.app import create_app
from kirian_contracts.protocol import ContractValidationError
from rearchitecture.config import ConfigError, ModelBinding, V1Config, SpeechBinding, TranscriptionBinding
from tests.test_rearchitecture_app import CLOUD, HEADERS, LOCAL, MODEL, TOKEN, FixtureProvider, message, start_turn, completed
from tests.test_rearchitecture_external_tools import OFFER, begin_external, mock_provider, offer_and_propose, registration

PUBLIC = {"instance_id": "public-demo-v1", "mode": "public_demo", "principal_id": "visitor"}
AUTOMATIC = ModelBinding(MODEL, "Fixture automatic", "ollama", "http://127.0.0.1:11434", "local", automatic_allowed=True)
EMBEDDING = ModelBinding({"provider_id": "ollama", "model_id": "embed", "endpoint_id": "local"}, "Embed", "ollama", "http://127.0.0.1:11434", "local",
                         supports_text=False, supports_embeddings=True)


def public_config(**overrides):
    values = dict(token=TOKEN, identity=PUBLIC, bindings=(LOCAL,), default_selection={"model": MODEL, "source": "initial_local"})
    return V1Config(**(values | overrides))


def test_public_demo_accepts_only_a_local_text_configuration(tmp_path):
    assert public_config().identity["mode"] == "public_demo"
    assert public_config(data_dir=str(tmp_path)).data_dir == str(tmp_path)
    assert public_config(speech=SpeechBinding({"provider_id": "tts", "model_id": "voice", "endpoint_id": "tts"}, "Voice", "http://127.0.0.1:19882/tts", "local", "Korean", "Sohee")).speech is not None
    with pytest.raises(ConfigError, match="public_demo_requires_local_models"):
        public_config(bindings=(LOCAL, CLOUD))
    with pytest.raises(ConfigError, match="public_demo_forbids_automatic_routing"):
        public_config(bindings=(AUTOMATIC,))
    with pytest.raises(ConfigError, match="public_demo_forbids_embedding_and_transcription"):
        public_config(bindings=(LOCAL, EMBEDDING), embedding=EMBEDDING)
    with pytest.raises(ConfigError, match="public_demo_forbids_embedding_and_transcription"):
        public_config(transcription=TranscriptionBinding("http://127.0.0.1:18098/stt", "local", "STT"))
    with pytest.raises(ContractValidationError):
        public_config(identity=PUBLIC | {"mode": "shared"})


def test_public_demo_keeps_loopback_authentication_and_disables_every_stored_feature(tmp_path):
    with TestClient(create_app(public_config(data_dir=str(tmp_path)), FixtureProvider()), client=("127.0.0.1", 50000)) as http:
        assert http.get("/v1/config").status_code == 401
        assert http.get("/v1/config", headers=HEADERS | {"Origin": "https://demo.invalid"}).status_code == 401
        data = http.get("/v1/config", headers=HEADERS).json()
        assert data["identity"] == PUBLIC
        assert data["persistence"] is True
        assert [item["boundary"] for item in data["models"]] == ["local"]
        for method, path, body in (("get", "/v1/sources", None), ("post", "/v1/sources", {"title": "t", "text": "x", "boundary": "local", "kind": "note", "parents": []}),
                                   ("get", "/v1/screens", None), ("get", "/v1/auto-memory", None), ("get", "/v1/proactive/sources", None),
                                   ("get", "/v1/collections", None),
                                   ("put", "/v1/preferences", {"model": MODEL}), ("put", "/v1/routing", {"enabled": True, "expected_revision": 0, "daily_call_limit": None, "daily_budget_units": None})):
            response = getattr(http, method)(path, headers=HEADERS, **({"json": body} if body is not None else {}))
            assert (response.status_code, response.json()["detail"]) == (403, "public_demo_disabled"), (method, path, response.text)
        assert http.post("/v1/transcriptions", headers=HEADERS | {"content-type": "audio/wav"}, content=b"RIFF").status_code == 503
        # Per-visitor conversations and the tool handshake stay available to the gateway.
        created = http.post("/v1/conversations", headers=HEADERS, json={})
        assert created.status_code == 200, created.text
        conversation_id = created.json()["conversation"]["id"]
        assert http.get("/v1/conversations", headers=HEADERS).status_code == 200
        assert http.get("/v1/conversations/" + conversation_id, headers=HEADERS).status_code == 200
        assert http.post("/v1/external-tools/sources", headers=HEADERS, json={"refs": []}).status_code == 200
        assert http.get("/v1/external-tools/turns/missing", headers=HEADERS).status_code in (404, 409)
        assert http.delete("/v1/conversations/" + conversation_id, headers=HEADERS).json() == {"ok": True}
        assert http.get("/v1/conversations", headers=HEADERS).json()["conversations"] == []


def test_public_demo_answers_text_turns_from_in_memory_history_only():
    provider = FixtureProvider("공개 답변")
    with TestClient(create_app(public_config(), provider), client=("127.0.0.1", 50000)) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            ready = ws.receive_json()
            assert ready["kind"] == "session.ready"
            assert ready["payload"]["client_kind"] == "web"
            scope = ready["scope"]
            start_turn(ws, scope)
            output = completed(ws)
            assert output[-1]["payload"]["status"] == "completed"
            assert any(item["kind"] == "response.delta" and item["payload"]["text"] == "공개 답변" for item in output)
            start_turn(ws, scope, turn="turn-2", number=20)
            assert completed(ws)[-1]["payload"]["status"] == "completed"
        # The second turn saw the first exchange as history, and nothing was written anywhere.
        assert [row["content"] for row in provider.calls[1][3]] == ["hello", "공개 답변"]
        assert provider.calls[0][3] == []
        assert getattr(http.app.state, "v1_store", None) is None


def test_public_demo_session_context_references_are_blocked():
    with TestClient(create_app(public_config(), FixtureProvider()), client=("127.0.0.1", 50000)) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            incoming = message(scope, "input.finished", {"input_id": "input-turn-1", "kind": "text", "text": "hello"})
            ws.send_json(incoming)
            assert ws.receive_json() == incoming
            started = message(scope, "turn.start", {"selection": {"model": MODEL, "source": "initial_local"},
                                                     "context": [{"source_id": "note-1", "revision": 1, "text": "방문자가 보낸 참조 본문"}]}, 2)
            ws.send_json(started)
            assert ws.receive_json() == started
            ended = completed(ws)[-1]
            assert ended["payload"]["status"] == "failed"
            assert ended["payload"]["error_code"] in ("context_blocked", "context_unavailable")


def test_public_demo_runs_the_external_tool_handshake_for_a_visitor_conversation(tmp_path):
    seen = []
    app = create_app(public_config(data_dir=str(tmp_path), bindings=(replace(LOCAL, supports_tools=True),)), mock_provider(seen=seen))
    with TestClient(app, client=("127.0.0.1", 50000)) as http:
        assert http.get("/v1/config", headers=HEADERS).json()["models"][0]["supports_tools"] is True
        conversation_id = http.post("/v1/conversations", headers=HEADERS, json={}).json()["conversation"]["id"]
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation_id, headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            assert scope["mode"] == "public_demo"
            begin_external(ws, scope)
            proposed, url, observed = offer_and_propose(http, ws, scope, OFFER | {"provider_kind": "google_calendar"})
            body = registration(proposed, observed)
            body["provenance"]["identity"] = PUBLIC
            body["receipt"]["identity"] = PUBLIC
            body["provenance"]["providerKind"] = "google_calendar"
            body["provenance"]["offeredMetadata"][0]["providerKind"] = "google_calendar"
            body["receipt"]["provider_id"] = "google_calendar"
            registered = http.post("/v1/external-tools/results", headers=HEADERS, json=body)
            assert registered.status_code == 200, registered.text
            resolved = message(scope, "tool.resolved", {"proposal_id": proposed["payload"]["proposal_id"], "state": "succeeded",
                                                       "source_ref": registered.json()["sourceRef"]}, 4)
            ws.send_json(resolved)
            assert ws.receive_json() == resolved
            rows = completed(ws)
            assert rows[-1]["payload"] == {"status": "completed"}
        assert len(seen) == 2 and "tools" in seen[0] and "tools" not in seen[1]
        # The visitor's conversation is deleted by the gateway when the session ends; nothing else is reachable.
        assert http.delete("/v1/conversations/" + conversation_id, headers=HEADERS).json() == {"ok": True}
        assert http.get("/v1/sources", headers=HEADERS).status_code == 403


def test_host_file_may_set_the_persona_prompt(tmp_path, monkeypatch):
    import json
    path = tmp_path / "host.json"
    path.write_text(json.dumps({"identity": PUBLIC, "bindings": [{"model": MODEL, "label": "Fixture", "kind": "ollama", "url": "http://127.0.0.1:11434",
                                "boundary": "local"}], "system_prompt": "너는 타냐(Tanya), 공개 데모의 동반자야."}), encoding="utf-8")
    monkeypatch.setenv("KIRIAN_V1_TOKEN", TOKEN)
    monkeypatch.setenv("KIRIAN_V1_CONFIG_FILE", str(path))
    monkeypatch.delenv("KIRIAN_V1_DATA_DIR", raising=False)
    config = V1Config.from_env()
    assert config.system_prompt.startswith("너는 타냐(Tanya)")
    assert "키리안" in public_config().system_prompt
    with pytest.raises(ConfigError, match="invalid_system_prompt"):
        public_config(system_prompt="x" * 4001)
    with pytest.raises(ConfigError, match="invalid_system_prompt"):
        public_config(system_prompt="   ")
