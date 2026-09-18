"""자동 화면 분석은 라우팅 설정과 독립적으로 host 허용·영속 예산을 적용한다."""
import asyncio
import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from rearchitecture.app import create_app
from rearchitecture.policy import PolicyError
from rearchitecture.routing import ModelRouter
from rearchitecture.storage import StorageError
from tests.test_rearchitecture_app import CLOUD, HEADERS, LAN, LOCAL, MODEL, TOKEN, FixtureProvider, config
from tests.test_rearchitecture_screen import ImageFixture, upload, upload_value


def auto_app(path, provider=None):
    binding = replace(LOCAL, supports_images=True, automatic_allowed=True, budget_units=2)
    alternative = replace(LAN, supports_images=True, automatic_allowed=True, budget_units=1)
    cloud = replace(CLOUD, supports_images=True, automatic_allowed=True, budget_units=0)
    return create_app(config(data_dir=str(path), bindings=(binding, alternative, cloud)),
                      FixtureProvider(), image_provider=provider or ImageFixture())


def auto_analyze(http, capture_id="capture-1", **changes):
    return http.post("/v1/screens/" + capture_id + "/auto-analyze", headers=HEADERS,
                     json={"revision": 1, "model": MODEL, "prompt": "설명해 줘."} | changes)


def set_limits(http, *, enabled=False, calls=10, units=20):
    state = http.get("/v1/routing", headers=HEADERS).json()
    result = http.put("/v1/routing", headers=HEADERS, json={
        "enabled": enabled, "expected_revision": state["revision"],
        "daily_call_limit": calls, "daily_budget_units": units,
    })
    assert result.status_code == 200, result.text


def test_fixed_auto_screen_is_charged_with_routing_off_and_keeps_durable_limit(tmp_path):
    provider = ImageFixture()
    with TestClient(auto_app(tmp_path, provider), client=("127.0.0.1", 50000)) as http:
        set_limits(http, calls=1, units=2)
        assert upload(http).status_code == 200
        response = auto_analyze(http)
        assert response.status_code == 200, response.text
        assert response.json()["actual_model"] == MODEL
        assert response.json()["routing_reason"] == "request_fixed"
        state = http.get("/v1/routing", headers=HEADERS).json()
        assert state["enabled"] is False and state["calls_used"] == 1 and state["budget_units_used"] == 2
        row = http.app.state.v1_service.router.db.execute("SELECT purpose FROM attempts").fetchone()
        assert row[0] == "screen_auto"
    with TestClient(auto_app(tmp_path, provider), client=("127.0.0.1", 50000)) as http:
        assert upload(http, capture_id="after-restart").status_code == 200
        assert auto_analyze(http, "after-restart").json() == {"detail": "routing_limit"}
        assert len(provider.calls) == 1
        # 수동 화면 분석의 기존 OFF 동작은 자동 작업의 소진 한도로 바꾸지 않는다.
        manual = http.post("/v1/screens/after-restart/analyze", headers=HEADERS,
                           json={"revision": 1, "model": MODEL, "prompt": "수동 요청"})
        assert manual.status_code == 200 and len(provider.calls) == 2
        assert http.get("/v1/routing", headers=HEADERS).json()["calls_used"] == 1


@pytest.mark.parametrize("changes,code", [
    ({"automatic_allowed": False}, "model_not_allowed"),
    ({"budget_units": None}, "routing_limit"),
    ({"supports_images": False}, "unsupported_model"),
])
def test_fixed_auto_screen_rejects_unapproved_unpriced_or_incapable_model(tmp_path, changes, code):
    provider = ImageFixture()
    # 중복 keyword 없이 host 설정의 능력/허용/비용만 변경한다.
    binding = replace(LOCAL, **({"supports_images": True, "automatic_allowed": True, "budget_units": 2} | changes))
    app = create_app(config(data_dir=str(tmp_path), bindings=(binding,)), FixtureProvider(), image_provider=provider)
    with TestClient(app, client=("127.0.0.1", 50000)) as http:
        assert upload(http).status_code == 200
        assert auto_analyze(http).json() == {"detail": code}
        assert provider.calls == []
        assert http.get("/v1/routing", headers=HEADERS).json()["calls_used"] == 0


def test_auto_screen_null_requires_routing_but_fixed_model_keeps_priority_and_cache(tmp_path):
    provider = ImageFixture()
    with TestClient(auto_app(tmp_path, provider), client=("127.0.0.1", 50000)) as http:
        assert upload(http, boundary="private_lan").status_code == 200
        assert auto_analyze(http, model=None).json() == {"detail": "routing_changed"}
        assert provider.calls == []
        set_limits(http, enabled=True)
        fixed = auto_analyze(http)
        assert fixed.status_code == 200 and fixed.json()["actual_model"] == MODEL
        assert auto_analyze(http).json() == fixed.json() | {"cached": True}
        assert len(provider.calls) == 1
        assert upload(http, capture_id="automatic", boundary="private_lan").status_code == 200
        automatic = auto_analyze(http, "automatic", model=None)
        assert automatic.status_code == 200 and automatic.json()["actual_model"] == LAN.model
        assert automatic.json()["routing_reason"] == "automatic_budget"
        state = http.get("/v1/routing", headers=HEADERS).json()
        assert state["calls_used"] == 2 and state["budget_units_used"] == 3


@pytest.mark.parametrize("model", [LAN.model, CLOUD.model])
def test_auto_screen_source_boundary_blocks_before_reservation(tmp_path, model):
    provider = ImageFixture()
    with TestClient(auto_app(tmp_path, provider), client=("127.0.0.1", 50000)) as http:
        assert upload(http).status_code == 200
        response = auto_analyze(http, model=model)
        assert response.status_code == 403 and response.json() == {"detail": "context_blocked"}
        assert provider.calls == [] and http.get("/v1/routing", headers=HEADERS).json()["calls_used"] == 0


def test_auto_screen_failed_attempt_consumes_budget_without_fallback(tmp_path):
    provider = ImageFixture(done=False)
    with TestClient(auto_app(tmp_path, provider), client=("127.0.0.1", 50000)) as http:
        assert upload(http).status_code == 200
        assert auto_analyze(http).json() == {"detail": "incomplete_response"}
        assert len(provider.calls) == 1 and provider.calls[0][0].model == MODEL
        assert http.get("/v1/routing", headers=HEADERS).json()["calls_used"] == 1
        assert http.get("/v1/sources", headers=HEADERS).json() == {"sources": []}


def test_auto_screen_route_requires_auth_and_rejects_wire_permission_overrides(tmp_path):
    provider = ImageFixture()
    with TestClient(auto_app(tmp_path, provider), client=("127.0.0.1", 50000)) as http:
        value = {"revision": 1, "model": MODEL, "prompt": "q"}
        path = "/v1/screens/capture-1/auto-analyze"
        assert http.post(path, json=value).status_code == 401
        assert http.post(path, headers=HEADERS, json=value | {"background": False}).status_code == 400
        assert http.post(path + "?background=false", headers=HEADERS, json=value).status_code == 400
        assert provider.calls == []


def test_auto_screen_reservation_rechecks_source_settings_and_shared_embedding_budget(tmp_path):
    from tests.test_rearchitecture_routing import source
    binding = replace(LOCAL, supports_images=True, automatic_allowed=True, budget_units=2)
    embedding = replace(LOCAL, supports_embeddings=True, automatic_allowed=True, budget_units=1)
    router = ModelRouter(config(data_dir=str(tmp_path), bindings=(binding,), embedding=embedding))
    catalog = {"source-1": source()}
    try:
        router.configure({"enabled": False, "expected_revision": 0, "daily_call_limit": 1, "daily_budget_units": 2})
        def choose():
            return router.choose(catalog=catalog, selection={"source": "request", "model": MODEL},
                                 history=[{"sources": [{"source_id": "source-1", "revision": 1}]}],
                                 purpose="screen_auto", capability="images")
        decision = choose()
        assert decision.charged and not decision.automatic
        router.reserve_binding(embedding, purpose="embedding", call_id="embedding-one", items=[], catalog=catalog, history=[])
        with pytest.raises(PolicyError, match="routing_limit"):
            router.reserve(decision, "screen-limited", catalog)
        router.configure({"enabled": False, "expected_revision": 1, "daily_call_limit": 10, "daily_budget_units": 20})
        with pytest.raises(PolicyError, match="routing_changed"):
            router.reserve(decision, "screen-stale", catalog)
        decision = choose()
        catalog["source-1"].record["deleted"] = True
        with pytest.raises(PolicyError, match="context_blocked"):
            router.reserve(decision, "screen-deleted", catalog)
        assert router.snapshot()["calls_used"] == 1
    finally:
        router.close()


@pytest.mark.asyncio
async def test_auto_screen_cancel_discards_partial_analysis_and_keeps_attempt(tmp_path):
    provider = ImageFixture(block=True)
    app = auto_app(tmp_path, provider)
    async with app.router.lifespan_context(app):
        screens = app.state.v1_screens
        await screens.put("capture-1", **upload_value())
        job = asyncio.create_task(screens.analyze("capture-1", 1, MODEL, "q", background=True))
        await asyncio.wait_for(provider.started.wait(), 1)
        await screens.cancel("capture-1", 1)
        with pytest.raises(StorageError, match="source_changed"):
            await asyncio.wait_for(job, 1)
        assert provider.closed and not screens.tasks and app.state.v1_store.list_sources() == []
        assert app.state.v1_service.router.snapshot()["calls_used"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("simultaneous", [False, True])
async def test_auto_screen_http_disconnect_cancels_without_persisting(tmp_path, simultaneous):
    provider = ImageFixture(block=not simultaneous)
    app = auto_app(tmp_path, provider)
    async with app.router.lifespan_context(app):
        await app.state.v1_screens.put("capture-1", **upload_value())
        queue, sent = asyncio.Queue(), []
        await queue.put({"type": "http.request", "body": json.dumps({"revision": 1, "model": MODEL, "prompt": "q"}).encode(), "more_body": False})
        if simultaneous:
            await queue.put({"type": "http.disconnect"})
        async def send(event):
            sent.append(event)
        path = "/v1/screens/capture-1/auto-analyze"
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
                 "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "", "server": ("127.0.0.1", 8099),
                 "client": ("127.0.0.1", 50001), "headers": [(b"authorization", ("Bearer " + TOKEN).encode()), (b"content-type", b"application/json")]}
        task = asyncio.create_task(app(scope, queue.get, send))
        if not simultaneous:
            await asyncio.wait_for(provider.started.wait(), 1)
            await queue.put({"type": "http.disconnect"})
        await asyncio.wait_for(task, 1)
        assert next(event for event in sent if event["type"] == "http.response.start")["status"] == 499
        assert app.state.v1_store.list_sources() == [] and not app.state.v1_screens.tasks
        assert len(provider.calls) <= 1
        assert app.state.v1_service.router.snapshot()["calls_used"] == len(provider.calls)
