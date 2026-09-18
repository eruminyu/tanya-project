"""라우팅과 자동 기억을 실제 Brain 수명에서 조합한다. 모든 모델은 격리 표본이다."""
import asyncio
import copy
import json
import threading
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from rearchitecture.app import create_app
from rearchitecture.auto_memory_store import AutoMemoryRepository, default_settings
from rearchitecture.config import ConfigError
from rearchitecture.embedding import SQLiteVectorIndex
from rearchitecture.providers import ProviderChunk
from tests.test_rearchitecture_app import CLOUD, HEADERS, LOCAL, MODEL, config, message, completed
from tests.test_rearchitecture_persistence import context, new_conversation, new_source


class ContextProvider:
    def __init__(self):
        self.calls = []

    async def stream(self, binding, user_input, system_prompt, history):
        self.calls.append((binding.model, user_input, system_prompt, copy.deepcopy(history)))
        extracting = "기억 추출용 자료" in system_prompt
        text = json.dumps([{"category": "preference", "text": "차를 좋아한다.", "quote": "차"}], ensure_ascii=False) if extracting else "대화를 확인했어요."
        yield ProviderChunk(text, binding.model["model_id"], True)


class ContextEmbedding:
    def __init__(self, blocked=False):
        self.calls = []
        self.blocked = blocked
        self.started = threading.Event()
        self.cancelled = threading.Event()

    async def embed(self, binding, text):
        self.calls.append((binding.model, text))
        self.started.set()
        if self.blocked:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        return [1.0, 0.0]


def automatic_app(path, provider, embedding):
    local = replace(LOCAL, automatic_allowed=True, budget_units=2)
    cloud = replace(CLOUD, automatic_allowed=True, budget_units=1)
    vector = replace(local, model=MODEL | {"model_id": "context-embedding"}, supports_text=False,
                     supports_embeddings=True, budget_units=1)
    return create_app(config(data_dir=str(path), bindings=(local, cloud), embedding=vector),
                      provider=provider, embedding_provider=embedding)


def enable_routing(http, calls=100, units=1000):
    current = http.get("/v1/routing", headers=HEADERS).json()
    result = http.put("/v1/routing", headers=HEADERS, json={"enabled": True,
        "expected_revision": current["revision"], "daily_call_limit": calls, "daily_budget_units": units})
    assert result.status_code == 200, result.text
    return result.json()


def send_turn(ws, scope, text, turn, number, sources=None):
    incoming = message(scope, "input.finished", {"input_id": "input-" + turn, "kind": "text", "text": text}, number, turn)
    ws.send_json(incoming)
    assert ws.receive_json() == incoming
    started = message(scope, "turn.start", {"selection": {"model": MODEL, "source": "initial_local"},
        "context": sources or [], "routing_candidates": [LOCAL.model, CLOUD.model]}, number + 1, turn)
    ws.send_json(started)
    assert ws.receive_json() == started


def memory_ready(http):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = http.get("/v1/auto-memory", headers=HEADERS).json()
        if state["indexed_count"] and not state["pending_count"]:
            return state
        time.sleep(0.01)
    raise AssertionError("자동 추출과 색인이 끝나지 않음: " + repr(state))


def test_auto_memory_forces_local_route_preserves_manual_context_and_shares_budget(tmp_path):
    provider, embedding = ContextProvider(), ContextEmbedding()
    with TestClient(automatic_app(tmp_path, provider, embedding), client=("127.0.0.1", 50000)) as http:
        enable_routing(http)
        settings = default_settings() | {"enabled": True, "conversations": True, "retrieval_enabled": True}
        result = http.put("/v1/auto-memory", headers=HEADERS, json={"settings": settings, "expected_revision": 0})
        assert result.status_code == 200, result.text
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            send_turn(ws, scope, "나는 차를 좋아해.", "first-turn", 1)
            first = completed(ws)
            assert first[-1]["payload"]["status"] == "completed"
            assert first[0]["payload"]["actual_model"] == CLOUD.model
            evidence = memory_ready(http)["evidence"][0]
            manual = new_source(http, text="수동 참고도 보존한다.")
            baseline = http.get("/v1/routing", headers=HEADERS).json()
            enable_routing(http, baseline["calls_used"] + 2, baseline["budget_units_used"] + 3)
            send_turn(ws, scope, "내가 좋아하는 음료를 알려줘.", "second-turn", 10, [context(manual)])
            second = completed(ws)
            assert second[-1]["payload"]["status"] == "completed"
            assert second[0]["payload"]["actual_model"] == LOCAL.model
            assert second[0]["payload"]["routing_reason"] == "automatic_budget"
            chat_calls = [call for call in provider.calls if "기억 추출용 자료" not in call[2]]
            assert len(chat_calls) == 2
            assert "차를 좋아한다." in chat_calls[-1][2]
            assert manual["text"] in chat_calls[-1][2]
            used = http.get("/v1/routing", headers=HEADERS).json()
            assert used["calls_used"] == baseline["calls_used"] + 2
            assert used["budget_units_used"] == baseline["budget_units_used"] + 3
            usage = http.get("/v1/auto-memory", headers=HEADERS).json()["recent_usage"]
            assert any(row["turn_id"] == "second-turn" and row["source_id"] == evidence["source_id"] for row in usage)


def test_cancel_during_real_auto_memory_embedding_prevents_chat_and_late_context(tmp_path):
    provider, embedding = ContextProvider(), ContextEmbedding(blocked=True)
    with TestClient(automatic_app(tmp_path, provider, embedding), client=("127.0.0.1", 50000)) as http:
        enable_routing(http)
        store = http.app.state.v1_store
        store.sync_collection("cancel-fixture", 0, "취소 검사", "local", [{"path": "a.md", "title": "차", "text": "차를 좋아한다."}])
        source = store.list_sources("")[0]
        memory = AutoMemoryRepository(store).remember(source,
            [{"category": "preference", "text": "차를 좋아한다.", "quote": "차"}], LOCAL.model)[0]
        vector_model = http.app.state.v1_service.config.embedding.model
        SQLiteVectorIndex(store).put(memory, vector_model, [1.0, 0.0])
        settings = default_settings() | {"note_collection_ids": ["cancel-fixture"], "retrieval_enabled": True}
        result = http.put("/v1/auto-memory", headers=HEADERS, json={"settings": settings, "expected_revision": 0})
        assert result.status_code == 200, result.text
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            send_turn(ws, scope, "취소할 기억 검색", "cancel-turn", 1)
            assert embedding.started.wait(2), "실제 AutoMemoryService가 embedding을 시작하지 않음"
            cancel = message(scope, "turn.cancel", {"reason": "user"}, 3, "cancel-turn")
            ws.send_json(cancel)
            assert ws.receive_json() == cancel
            assert ws.receive_json()["payload"] == {"status": "cancelled"}
            assert embedding.cancelled.wait(2), "turn 취소가 embedding으로 전파되지 않음"
            assert provider.calls == []
            usage = http.get("/v1/routing", headers=HEADERS).json()
            assert usage["calls_used"] == 1  # 이미 시작한 embedding만 기록하며 chat은 호출하지 않는다.
            assert usage["budget_units_used"] == 1


@pytest.mark.asyncio
async def test_lifespan_shutdown_cancels_memory_search_without_starting_chat(tmp_path):
    class Socket:
        def __init__(self):
            self.events = []
            self.closed = False

        async def send_text(self, raw):
            self.events.append(json.loads(raw))

        async def close(self, code, reason):
            self.closed = True

    provider, embedding = ContextProvider(), ContextEmbedding(blocked=True)
    app = automatic_app(tmp_path, provider, embedding)
    service, store = app.state.v1_service, app.state.v1_store
    async with app.router.lifespan_context(app):
        service.router.configure({"enabled": True, "expected_revision": 0,
                                  "daily_call_limit": 100, "daily_budget_units": 1000})
        store.sync_collection("shutdown-fixture", 0, "종료 검사", "local",
                              [{"path": "a.md", "title": "차", "text": "차를 좋아한다."}])
        source = store.list_sources("")[0]
        memory = AutoMemoryRepository(store).remember(source,
            [{"category": "preference", "text": "차를 좋아한다.", "quote": "차"}], LOCAL.model)[0]
        SQLiteVectorIndex(store).put(memory, service.config.embedding.model, [1.0, 0.0])
        app.state.v1_auto_memory.configure({"settings": default_settings() | {
            "note_collection_ids": ["shutdown-fixture"], "retrieval_enabled": True}, "expected_revision": 0})
        socket = Socket()
        session = await service.open(socket, None)
        await service.receive(session, socket, message(session.scope, "input.finished",
            {"input_id": "shutdown-input", "kind": "text", "text": "종료할 기억 검색"}), 1)
        await service.receive(session, socket, message(session.scope, "turn.start",
            {"selection": service.config.default_selection, "context": [],
             "routing_candidates": [LOCAL.model, CLOUD.model]}, 2), 1)
        async with asyncio.timeout(2):
            while not embedding.started.is_set():
                await asyncio.sleep(0)
        assert provider.calls == []
    assert embedding.cancelled.is_set()
    assert provider.calls == []
    assert session.turns["turn-1"].status == "cancelled"
    assert socket.closed and not service.sessions
    assert not any(event["kind"] == "response.completed" for event in socket.events)


def test_embedding_prefixes_are_host_declared_and_applied_once_per_side(tmp_path):
    provider, embedding = ContextProvider(), ContextEmbedding()
    local = replace(LOCAL, automatic_allowed=True, budget_units=2)
    vector = replace(local, model=MODEL | {"model_id": "context-embedding"}, supports_text=False, supports_embeddings=True,
                     budget_units=1, query_prefix="Instruct: 사용자 기억 검색\nQuery: ", document_prefix="")
    app = create_app(config(data_dir=str(tmp_path), bindings=(local, replace(CLOUD, automatic_allowed=True, budget_units=1)), embedding=vector),
                     provider=provider, embedding_provider=embedding)
    with TestClient(app, client=("127.0.0.1", 50000)) as http:
        enable_routing(http)
        settings = default_settings() | {"enabled": True, "conversations": True, "retrieval_enabled": True}
        assert http.put("/v1/auto-memory", headers=HEADERS, json={"settings": settings, "expected_revision": 0}).status_code == 200
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            send_turn(ws, scope, "나는 차를 좋아해.", "first-turn", 1)
            assert completed(ws)[-1]["payload"]["status"] == "completed"
            memory_ready(http)
            send_turn(ws, scope, "내가 좋아하는 음료를 알려줘.", "second-turn", 10)
            assert completed(ws)[-1]["payload"]["status"] == "completed"
    texts = [text for _, text in embedding.calls]
    assert any(text == "차를 좋아한다." for text in texts), texts  # document side: no prefix declared
    assert any(text.startswith("Instruct: 사용자 기억 검색\nQuery: ") and text.count("Query: ") == 1 for text in texts), texts
    with pytest.raises(ConfigError):
        replace(local, query_prefix="Instruct: x")  # prefixes belong to embedding bindings only
    with pytest.raises(ConfigError):
        replace(vector, document_prefix="x" * 513)
    for score in (-0.1, 1.5, True, "0.4"):
        with pytest.raises(ConfigError):
            replace(vector, min_score=score)
    assert replace(vector, min_score=0.4).min_score == 0.4 and vector.min_score == 0.25


def test_fenced_extraction_json_is_accepted_and_other_wrapping_still_rejected(tmp_path):
    from rearchitecture.auto_memory import unfenced
    assert json.loads(unfenced("```json\n[{\"category\":\"fact\",\"text\":\"t\",\"quote\":\"q\"}]\n```")) == [{"category": "fact", "text": "t", "quote": "q"}]
    assert json.loads(unfenced("```\n[]\n```")) == []
    for wrapped in ("설명: []", "```json\n[]\n```\n덧붙임", "``json\n[]\n``"):
        with pytest.raises(ValueError):
            json.loads(unfenced(wrapped))

    class FencedProvider(ContextProvider):
        async def stream(self, binding, user_input, system_prompt, history):
            self.calls.append((binding.model, user_input, system_prompt, copy.deepcopy(history)))
            if "기억 추출용 자료" in system_prompt:
                assert "코드 블록 표시 없이" in system_prompt
                yield ProviderChunk("```json\n" + json.dumps([{"category": "preference", "text": "차를 좋아한다.", "quote": "차"}], ensure_ascii=False) + "\n```", binding.model["model_id"], True)
            else:
                yield ProviderChunk("대화를 확인했어요.", binding.model["model_id"], True)
    provider, embedding = FencedProvider(), ContextEmbedding()
    with TestClient(automatic_app(tmp_path, provider, embedding), client=("127.0.0.1", 50000)) as http:
        enable_routing(http)
        settings = default_settings() | {"enabled": True, "conversations": True, "retrieval_enabled": True}
        assert http.put("/v1/auto-memory", headers=HEADERS, json={"settings": settings, "expected_revision": 0}).status_code == 200
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            send_turn(ws, scope, "나는 차를 좋아해.", "first-turn", 1)
            assert completed(ws)[-1]["payload"]["status"] == "completed"
            state = memory_ready(http)
            assert state["evidence"][0]["category"] == "preference" and state["status"] == "ready"
