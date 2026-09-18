"""Synthetic JPEG/HTTP/provider fixtures with real temporary SQLite; no screen or model quality claim."""
import asyncio
import base64
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from rearchitecture.app import create_app
from rearchitecture.config import ConfigError, V1Config
from rearchitecture.providers import HTTPTextProvider, ProviderChunk, ProviderError
from rearchitecture.screen import ScreenError, jpeg_bytes
from rearchitecture.storage import StorageError
from tests.test_rearchitecture_app import CLOUD, HEADERS, LAN, LOCAL, MODEL, TOKEN, FixtureProvider, config, completed, start_turn
from tests.test_rearchitecture_persistence import context, new_conversation, new_source, reference


# A generated 2x2 black System.Drawing JPEG, with no external or user image data.
JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q=="
VISION = replace(LOCAL, supports_images=True)
VISION_LAN = replace(LAN, supports_images=True)
VISION_CLOUD = replace(CLOUD, supports_images=True)


class ImageFixture:
    def __init__(self, text="화면에는 합성 표본이 보입니다.", done=True, reported=None, block=False, error=None):
        self.text, self.done, self.reported, self.block, self.error = text, done, reported, block, error
        self.calls, self.closed = [], False
        self.started = asyncio.Event()

    async def stream_image(self, binding, prompt, system_prompt, image_base64):
        self.calls.append((binding, prompt, system_prompt, image_base64))
        self.started.set()
        try:
            if self.error:
                raise self.error
            yield ProviderChunk(self.text, self.reported or binding.model["model_id"], self.done and not self.block)
            if self.block:
                await asyncio.Event().wait()
        finally:
            self.closed = True


def app_for(path, image=None, **overrides):
    return create_app(config(data_dir=str(path), bindings=(VISION, VISION_LAN, VISION_CLOUD), **overrides),
                      FixtureProvider(), image_provider=image or ImageFixture())


def client(path, image=None, **overrides):
    return TestClient(app_for(path, image, **overrides), client=("127.0.0.1", 50000))


def upload_value(**overrides):
    return {"expected_revision": 0, "title": "선택한 화면", "boundary": "local", "image_base64": JPEG,
            "captured_at": 1788800000000} | overrides


def upload(http, capture_id="capture-1", **overrides):
    return http.put("/v1/screens/" + capture_id, headers=HEADERS | {"Content-Type": "application/json"},
                    content=json.dumps(upload_value(**overrides)).encode())


def analyze(http, capture_id="capture-1", **overrides):
    return http.post("/v1/screens/" + capture_id + "/analyze", headers=HEADERS,
                     json={"revision": 1, "model": MODEL, "prompt": "화면을 설명해 줘."} | overrides)


def test_screen_auth_identity_metadata_and_ram_only_image(tmp_path):
    fixture = ImageFixture()
    with client(tmp_path, fixture) as http:
        assert http.get("/v1/screens").status_code == 401
        assert http.put("/v1/screens/capture-1", headers=HEADERS | {"Origin": "null"}, json=upload_value()).status_code == 401
        assert http.get("/v1/screens", headers=HEADERS).json() == {"screens": []}
        models = http.get("/v1/config", headers=HEADERS).json()["models"]
        assert models[0]["supports_images"] is True and models[0]["boundary"] == "local"
        root = upload(http).json()["source"]
        assert root["record"]["kind"] == "screen" and root["record"]["revision"] == 1 and root["text"] == ""
        metadata = http.get("/v1/screens/capture-1", headers=HEADERS).json()["screen"]
        assert metadata == {"capture_id": "capture-1", "source": root, "captured_at": 1788800000000,
                            "image_available": True, "analysis_source_id": None, "actual_model": None}
        result = analyze(http).json()
        assert result["screen_source"] == root and result["actual_model"] == MODEL
        assert result["source"]["record"]["source_id"].startswith("screen-analysis-")
        assert result["source"]["record"]["parents"] == [reference(root)]
        assert result["source"]["text"] == fixture.text
        assert len(fixture.calls) == 1 and fixture.calls[0][3] == JPEG
        assert "신뢰할 수 없는" in fixture.calls[0][2] and "실행 권한" in fixture.calls[0][2]
        assert http.get("/v1/sources", headers=HEADERS).json()["sources"] == [result["source"]]
        # SQLite and WAL contain neither original JPEG nor its base64 representation.
        for path in http.app.state.v1_store.path.parent.iterdir():
            if not path.name.startswith("brain.sqlite3"):
                continue
            data = path.read_bytes()
            assert JPEG.encode() not in data and base64.b64decode(JPEG) not in data
    with client(tmp_path, identity=config().identity | {"principal_id": "another"}) as http:
        assert http.get("/v1/screens", headers=HEADERS).json() == {"screens": []}


def test_capability_config_is_explicit_boolean_and_default_remains_text_only(tmp_path, monkeypatch):
    assert LOCAL.supports_images is False
    with pytest.raises(ConfigError):
        replace(LOCAL, supports_images=1)
    path = tmp_path / "host.json"
    path.write_text(json.dumps({"identity": config().identity, "bindings": [{"model": MODEL, "label": "Vision", "kind": "ollama",
        "url": LOCAL.url, "boundary": "local", "supports_images": True}]}))
    monkeypatch.setenv("KIRIAN_V1_CONFIG_FILE", str(path))
    monkeypatch.setenv("KIRIAN_V1_TOKEN", TOKEN)
    assert V1Config.from_env().bindings[0].supports_images is True


@pytest.mark.parametrize("overrides", [{"expected_revision": True}, {"expected_revision": -1}, {"captured_at": True},
    {"captured_at": 1.5}, {"captured_at": -1}, {"title": ""}, {"title": "a" * 121}, {"title": "\ud800"},
    {"boundary": "cloud"}, {"image_base64": "data:image/jpeg;base64," + JPEG}, {"image_base64": "garbage"},
    {"image_base64": base64.b64encode(b"\x89PNG\r\n").decode()}, {"image_base64": JPEG + "\n"}])
def test_bad_upload_does_not_register_any_source(tmp_path, overrides):
    with client(tmp_path) as http:
        response = upload(http, **overrides)
        assert response.status_code == 400, response.text
        assert http.get("/v1/screens", headers=HEADERS).json() == {"screens": []}


def test_jpeg_structure_and_dimensions_are_checked_without_pixel_allocation():
    data = bytearray(base64.b64decode(JPEG))
    assert jpeg_bytes(JPEG) == data
    for bad in (data[:-2], data + b"trailing", b"\xff\xd8fake\xff\xd9", b"\xff\xd8\xff\xe0\x00\xff\xff\xd9"):
        with pytest.raises(ScreenError):
            jpeg_bytes(base64.b64encode(bad).decode())
    frame = data.index(b"\xff\xc0")
    data[frame + 7:frame + 9] = (1601).to_bytes(2, "big")
    with pytest.raises(ScreenError, match="image_limit"):
        jpeg_bytes(base64.b64encode(data).decode())


@pytest.mark.parametrize("model,boundary,code", [(VISION_LAN.model, "local", "context_blocked"),
    (VISION_CLOUD.model, "private_lan", "context_blocked"), (MODEL | {"model_id": "unknown"}, "local", "model_not_allowed")])
def test_unsupported_boundary_or_model_never_dispatches(tmp_path, model, boundary, code):
    fixture = ImageFixture()
    with client(tmp_path, fixture) as http:
        assert upload(http, boundary=boundary).status_code == 200
        result = analyze(http, model=model)
        assert result.json() == {"detail": code}
        assert fixture.calls == []


def test_text_only_model_is_rejected_and_explicit_lan_succeeds(tmp_path):
    fixture = ImageFixture()
    app = create_app(config(data_dir=str(tmp_path)), FixtureProvider(), image_provider=fixture)
    with TestClient(app, client=("127.0.0.1", 50000)) as http:
        upload(http)
        assert analyze(http).json() == {"detail": "unsupported_model"}
        assert fixture.calls == []
    with client(tmp_path / "lan", fixture) as http:
        upload(http, boundary="private_lan")
        assert analyze(http, model=VISION_LAN.model).json()["actual_model"] == VISION_LAN.model


@pytest.mark.parametrize("fixture,code", [(ImageFixture(done=False), "incomplete_response"),
    (ImageFixture(text="  "), "empty_response"), (ImageFixture(reported="alias"), "model_mismatch"),
    (ImageFixture(text="a" * 8193), "response_limit"), (ImageFixture(text="\ud800"), "provider_error"),
    (ImageFixture(error=RuntimeError("private provider details")), "provider_error"),
    (ImageFixture(error=ProviderError("provider_unavailable")), "provider_unavailable")])
def test_failed_analysis_never_persists_partial_memory_or_raw_error(tmp_path, fixture, code):
    with client(tmp_path, fixture) as http:
        upload(http)
        response = analyze(http)
        assert response.json() == {"detail": code}
        assert "private provider" not in response.text
        assert http.get("/v1/sources", headers=HEADERS).json() == {"sources": []}
        assert fixture.closed


def test_exact_cached_analysis_survives_restart_but_changed_prompt_or_model_does_not_reuse(tmp_path):
    fixture = ImageFixture(text="🙂" * 8192)
    with client(tmp_path, fixture) as http:
        upload(http, boundary="private_lan")
        result = analyze(http).json()
        assert analyze(http).json() == result | {"cached": True} and len(fixture.calls) == 1
        assert analyze(http, prompt="다른 질문").json() == {"detail": "source_changed"}
        assert analyze(http, model=VISION_LAN.model).json() == {"detail": "source_changed"}
        upload(http, capture_id="unfinished")
    with client(tmp_path, fixture) as http:
        rows = http.get("/v1/screens", headers=HEADERS).json()["screens"]
        assert len(rows) == 1 and rows[0]["capture_id"] == "capture-1" and rows[0]["image_available"] is False
        assert analyze(http).json() == result | {"cached": True} and len(fixture.calls) == 1
        assert http.get("/v1/screens/unfinished", headers=HEADERS).json()["screen"]["source"]["record"]["deleted"] is True


def test_analysis_is_immutable_ancestry_cannot_widen_and_root_delete_redacts_history(tmp_path):
    with client(tmp_path) as http:
        root = upload(http).json()["source"]
        memory = analyze(http).json()["source"]
        assert http.put("/v1/sources/" + memory["record"]["source_id"], headers=HEADERS, json={
            "expected_revision": 1, "title": "edited", "text": "edited", "boundary": "cloud"}).status_code == 400
        copy = new_source(http, "derived original", kind="memory", parents=[reference(memory)])
        assert http.put("/v1/sources/" + copy["record"]["source_id"], headers=HEADERS, json={
            "expected_revision": 1, "title": "edited", "text": "edited", "boundary": "private_lan"}).status_code == 403
        assert http.delete("/v1/sources/" + root["record"]["source_id"], headers=HEADERS, params={"revision": 1}).status_code == 400
        conversation = new_conversation(http)
        with http.websocket_connect("/v1/chat?conversation_id=" + conversation["id"], headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_turn(ws, scope, context=[context(copy)])
            completed(ws)
        assert http.delete("/v1/screens/capture-1?revision=1", headers=HEADERS).json() == {"ok": True}
        assert http.app.state.v1_store.history(conversation["id"]) == []
        assert all(row["text"] == "" for row in http.app.state.v1_store.messages(conversation["id"]))
        assert http.get("/v1/sources", headers=HEADERS).json() == {"sources": []}
        assert http.delete("/v1/screens/capture-1?revision=1", headers=HEADERS).json() == {"ok": True}
        assert upload(http).json() == {"detail": "source_changed"}


def test_replacement_invalidates_previous_analysis_and_stale_revisions(tmp_path):
    with client(tmp_path) as http:
        first = upload(http).json()["source"]
        memory = analyze(http).json()["source"]
        replacement = upload(http, expected_revision=1, title="새 화면").json()["source"]
        assert replacement["record"]["source_id"] == first["record"]["source_id"] and replacement["record"]["revision"] == 2
        assert http.app.state.v1_store.catalog_entry(memory["record"]["source_id"])["record"]["deleted"] is True
        assert analyze(http).json() == {"detail": "source_changed"}
        assert analyze(http, revision=2).status_code == 200


@pytest.mark.parametrize("action", ["delete", "cancel"])
def test_unknown_capture_fence_prevents_late_upload_and_survives_restart(tmp_path, action):
    with client(tmp_path) as http:
        result = (http.delete("/v1/screens/capture-1?revision=1", headers=HEADERS) if action == "delete" else
                  http.post("/v1/screens/capture-1/cancel", headers=HEADERS, json={"revision": 1}))
        assert result.status_code == 200 and result.json()["ok"] is True
        assert upload(http).json() == {"detail": "source_changed"}
    with client(tmp_path) as http:
        assert upload(http).json() == {"detail": "source_changed"}


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["delete", "cancel", "replace", "shutdown"])
async def test_cancel_delete_replace_and_shutdown_close_provider_and_block_late_commit(tmp_path, action):
    fixture = ImageFixture(block=True)
    app = app_for(tmp_path, fixture)
    async with app.router.lifespan_context(app):
        screens = app.state.v1_screens
        await screens.put("capture-1", **upload_value())
        job = asyncio.create_task(screens.analyze("capture-1", 1, MODEL, "question"))
        await asyncio.wait_for(fixture.started.wait(), 1)
        if action == "delete":
            await screens.delete("capture-1", 1)
        elif action == "cancel":
            assert (await screens.cancel("capture-1", 1))["screen"]["image_available"] is False
        elif action == "replace":
            await screens.put("capture-1", **upload_value(expected_revision=1))
        else:
            await screens.shutdown()
        with pytest.raises(StorageError, match="source_changed"):
            await asyncio.wait_for(job, 1)
        assert fixture.closed and screens.tasks == set()
        assert app.state.v1_store.list_sources() == []
        if action == "cancel":
            with pytest.raises(StorageError, match="source_changed"):
                await screens.analyze("capture-1", 1, MODEL, "question")


@pytest.mark.asyncio
async def test_ram_expiry_invalidates_staged_but_retains_completed_analysis(tmp_path):
    app = app_for(tmp_path)
    async with app.router.lifespan_context(app):
        screens = app.state.v1_screens
        clock = [0]
        screens.clock, screens.ttl = lambda: clock[0], 5
        await screens.put("done", **upload_value())
        await screens.analyze("done", 1, MODEL, "q")
        await screens.put("staged", **upload_value())
        clock[0] = 6
        await screens.expire()
        assert screens.images == {}
        assert len(await screens.list()) == 1
        assert (await screens.get("done"))["image_available"] is False
        assert (await screens.get("staged"))["source"]["record"]["deleted"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("simultaneous", [False, True])
async def test_asgi_disconnect_closes_analysis_without_persisting(tmp_path, simultaneous):
    fixture = ImageFixture(block=not simultaneous)
    app = app_for(tmp_path, fixture)
    async with app.router.lifespan_context(app):
        await app.state.v1_screens.put("capture-1", **upload_value())
        queue, sent = asyncio.Queue(), []
        await queue.put({"type": "http.request", "body": json.dumps({"revision": 1, "model": MODEL, "prompt": "q"}).encode(), "more_body": False})
        if simultaneous:
            await queue.put({"type": "http.disconnect"})
        async def send(event):
            sent.append(event)
        path = "/v1/screens/capture-1/analyze"
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
                 "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "", "server": ("127.0.0.1", 8099),
                 "client": ("127.0.0.1", 50001), "headers": [(b"authorization", ("Bearer " + TOKEN).encode()), (b"content-type", b"application/json")]}
        task = asyncio.create_task(app(scope, queue.get, send))
        if not simultaneous:
            await asyncio.wait_for(fixture.started.wait(), 1)
            await queue.put({"type": "http.disconnect"})
        await asyncio.wait_for(task, 1)
        assert next(event for event in sent if event["type"] == "http.response.start")["status"] == 499
        assert app.state.v1_store.list_sources() == [] and not app.state.v1_screens.tasks


@pytest.mark.asyncio
async def test_actual_ollama_http_image_payload_and_explicit_finish(tmp_path):
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, content=b'{"model":"fixture-model","message":{"content":"visible text"},"done":true}\n')
    provider = HTTPTextProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    app = app_for(tmp_path, provider)
    async with app.router.lifespan_context(app):
        await app.state.v1_screens.put("capture-1", **upload_value())
        result = await app.state.v1_screens.analyze("capture-1", 1, MODEL, "explain")
        assert result["source"]["text"] == "visible text"
        payload = json.loads(seen[0].content)
        assert payload["messages"][-1] == {"role": "user", "content": "explain", "images": [JPEG]}
        assert len(payload["messages"]) == 2 and payload["think"] is False
        assert seen[0].url.path == "/api/chat"


@pytest.mark.asyncio
async def test_openai_compatible_image_payload_uses_only_approved_local_endpoint():
    seen = []
    binding = replace(VISION, kind="openai-compatible", url="http://127.0.0.1:8000/v1")
    def respond(request):
        seen.append(request)
        return httpx.Response(200, content=b'data: {"model":"fixture-model","choices":[{"delta":{"content":"text"},"finish_reason":"stop"}]}\n\n')
    provider = HTTPTextProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    chunks = [chunk async for chunk in provider.stream_image(binding, "q", "system", JPEG)]
    assert chunks[-1].done
    assert json.loads(seen[0].content)["messages"][-1]["content"] == [
        {"type": "text", "text": "q"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + JPEG}}]
    assert seen[0].url.path == "/v1/chat/completions"


def test_upload_body_image_ram_and_capture_counts_are_bounded(tmp_path, monkeypatch):
    import rearchitecture.screen as module
    with client(tmp_path) as http:
        response = http.put("/v1/screens/oversized", headers=HEADERS, content=b"x" * (6 * 1024 * 1024 + 1))
        assert response.status_code == 413
        for index in range(8):
            assert upload(http, capture_id="capture-" + str(index)).status_code == 200
        assert upload(http, capture_id="ninth").json() == {"detail": "image_limit"}
        assert len(http.app.state.v1_screens.images) == 8
        assert http.post("/v1/screens/capture-0/cancel", headers=HEADERS, json={"revision": 1}).status_code == 200
        assert upload(http, capture_id="ninth").status_code == 200
    with client(tmp_path / "ram") as http:
        monkeypatch.setattr(module, "MAX_RAM_BYTES", len(base64.b64decode(JPEG)) * 2)
        assert upload(http, capture_id="one").status_code == 200
        assert upload(http, capture_id="two").status_code == 200
        assert upload(http, capture_id="three").json() == {"detail": "image_limit"}
        assert upload(http, capture_id="one", expected_revision=1).status_code == 200
    with client(tmp_path / "metadata") as http:
        for index in range(32):
            key = "capture-" + str(index)
            assert upload(http, capture_id=key).status_code == 200
            assert http.post("/v1/screens/" + key + "/cancel", headers=HEADERS, json={"revision": 1}).status_code == 200
        assert upload(http, capture_id="overflow").json() == {"detail": "screen_limit"}
        assert len(http.get("/v1/screens", headers=HEADERS).json()["screens"]) == 32


@pytest.mark.asyncio
async def test_analysis_concurrency_and_same_revision_inflight_are_bounded(tmp_path):
    fixture = ImageFixture(block=True)
    app = app_for(tmp_path, fixture)
    async with app.router.lifespan_context(app):
        screens = app.state.v1_screens
        for key in ("one", "two", "three"):
            await screens.put(key, **upload_value())
        first = asyncio.create_task(screens.analyze("one", 1, MODEL, "q"))
        await fixture.started.wait()
        with pytest.raises(ScreenError, match="screen_busy"):
            await screens.analyze("one", 1, MODEL, "q")
        second = asyncio.create_task(screens.analyze("two", 1, MODEL, "q"))
        while len(fixture.calls) != 2:
            await asyncio.sleep(0)
        with pytest.raises(ScreenError, match="screen_busy"):
            await screens.analyze("three", 1, MODEL, "q")
        await screens.cancel("one", 1)
        await screens.cancel("two", 1)
        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(result, StorageError) for result in results)
        assert len(fixture.calls) == 2 and screens.tasks == set()


@pytest.mark.asyncio
async def test_delete_during_streamed_initial_upload_fences_late_commit(tmp_path):
    app = app_for(tmp_path)
    async with app.router.lifespan_context(app):
        arrived, resume = asyncio.Event(), asyncio.Event()
        raw = json.dumps(upload_value()).encode()
        async def body():
            yield raw[:20]
            arrived.set()
            await resume.wait()
            yield raw[20:]
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)), base_url="http://127.0.0.1") as http:
            pending = asyncio.create_task(http.put("/v1/screens/capture-1", headers=HEADERS, content=body()))
            await asyncio.wait_for(arrived.wait(), 1)
            assert (await http.delete("/v1/screens/capture-1?revision=1", headers=HEADERS)).json() == {"ok": True}
            resume.set()
            assert (await asyncio.wait_for(pending, 1)).json() == {"detail": "source_changed"}
            assert app.state.v1_screens.images == {} and app.state.v1_store.list_screens() == []


@pytest.mark.asyncio
async def test_cancel_closes_real_async_http_image_response(tmp_path):
    from tests.test_rearchitecture_providers import BlockingBody
    body = BlockingBody()
    provider = HTTPTextProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=body))))
    app = app_for(tmp_path, provider)
    async with app.router.lifespan_context(app):
        screens = app.state.v1_screens
        await screens.put("capture-1", **upload_value())
        pending = asyncio.create_task(screens.analyze("capture-1", 1, MODEL, "q"))
        await asyncio.wait_for(body.waiting.wait(), 1)
        await screens.cancel("capture-1", 1)
        with pytest.raises(StorageError, match="source_changed"):
            await asyncio.wait_for(pending, 1)
        assert body.closed and app.state.v1_store.list_sources() == []


def test_cancel_after_success_retains_result_and_exact_retry_is_safe(tmp_path):
    fixture = ImageFixture()
    with client(tmp_path, fixture) as http:
        upload(http)
        completed = analyze(http).json()
        result = http.post("/v1/screens/capture-1/cancel", headers=HEADERS, json={"revision": 1}).json()
        assert result["ok"] and result["screen"]["image_available"] is False
        assert result["screen"]["analysis_source_id"] == completed["source"]["record"]["source_id"]
        assert analyze(http).json() == completed | {"cached": True} and len(fixture.calls) == 1


@pytest.mark.asyncio
async def test_timeout_closes_stream_and_does_not_persist(tmp_path):
    fixture = ImageFixture(block=True)
    app = app_for(tmp_path, fixture, turn_timeout_seconds=0.01)
    async with app.router.lifespan_context(app):
        await app.state.v1_screens.put("capture-1", **upload_value())
        with pytest.raises(ScreenError, match="turn_timeout"):
            await app.state.v1_screens.analyze("capture-1", 1, MODEL, "q")
        assert fixture.closed and app.state.v1_store.list_sources() == []
