from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest

from rearchitecture.policy import ContextSource, PolicyError
from rearchitecture.routing import ModelRouter
from tests.test_rearchitecture_app import config, LOCAL, LAN, CLOUD, MODEL, IDENTITY


def router(path, **kwargs):
    bindings = (replace(LOCAL, automatic_allowed=True, budget_units=4),
                replace(LAN, automatic_allowed=True, budget_units=2),
                replace(CLOUD, automatic_allowed=True, budget_units=1))
    return ModelRouter(config(data_dir=str(path), bindings=bindings, **kwargs))


def enable(r, **changes):
    state = r.snapshot()
    r.configure({"enabled": True, "daily_call_limit": 10, "daily_budget_units": 30,
                 "expected_revision": state["revision"]} | changes)


def source(boundary="local", parents=None, kind="note", key="source-1"):
    return ContextSource({"identity": IDENTITY, "source_id": key, "revision": 1,
        "kind": kind, "boundary": boundary, "deleted": False, "parents": parents or []}, "sensitive")


def test_off_uses_original_default_and_explicit_selection_wins(tmp_path):
    r = router(tmp_path)
    assert r.snapshot()["enabled"] is False
    assert r.choose(catalog={}).binding.model == MODEL
    enable(r)
    assert r.choose(catalog={}).binding.model == CLOUD.model
    assert r.choose(selection={"source": "request", "model": MODEL}, catalog={}).reason == "request_fixed"
    assert r.choose(selection={"source": "conversation", "model": MODEL}, catalog={}).binding.model == MODEL
    r.close()


def test_auto_filters_ancestors_history_and_input_capability(tmp_path):
    r = router(tmp_path)
    enable(r)
    catalog = {"source-1": source(), "derived": source("cloud", [{"source_id":"source-1","revision":1}], "memory", "derived")}
    history = [{"sources":[{"source_id":"derived","revision":1}]}]
    decision = r.choose(catalog=catalog, history=history)
    assert decision.binding.model == MODEL
    assert {ref["source_id"] for ref in decision.sources} == {"derived", "source-1"}
    with pytest.raises(PolicyError, match="routing_no_candidate"):
        r.choose(catalog={}, capability="images")
    r.close()


def test_no_allowed_unknown_cost_or_embedding_only_candidate(tmp_path):
    for changes in ({"automatic_allowed": False}, {"budget_units": None}, {"supports_text": False}):
        c = config(data_dir=str(tmp_path / str(len(str(changes)))), bindings=(replace(LOCAL, **changes),))
        r = ModelRouter(c)
        enable(r)
        with pytest.raises(PolicyError, match="routing_no_candidate"):
            r.choose(catalog={})
        r.close()


def test_revoke_or_changed_source_before_reservation_does_not_consume(tmp_path):
    r = router(tmp_path)
    enable(r)
    catalog = {"source-1": source()}
    decision = r.choose(catalog=catalog, history=[{"sources":[{"source_id":"source-1","revision":1}]}])
    r.configure({"enabled":False,"daily_call_limit":10,"daily_budget_units":30,"expected_revision":1})
    with pytest.raises(PolicyError, match="routing_changed"):
        r.reserve(decision, "call-revoked", catalog)
    enable(r)
    decision = r.choose(catalog=catalog, history=[{"sources":[{"source_id":"source-1","revision":1}]}])
    catalog["source-1"].record["deleted"] = True
    with pytest.raises(PolicyError, match="context_blocked"):
        r.reserve(decision, "call-changed", catalog)
    assert r.snapshot()["calls_used"] == 0
    r.close()


def test_atomic_shared_budget_restarts_failed_calls_and_duplicate_claims(tmp_path):
    r = router(tmp_path)
    enable(r, daily_call_limit=2, daily_budget_units=2)
    decisions = [r.choose(catalog={}) for _ in range(8)]
    def reserve(index):
        try:
            r.reserve(decisions[index], f"call-{index}", {})
            return True
        except PolicyError:
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(reserve, range(8))) == 2
    snapshot = r.snapshot()
    assert snapshot["calls_used"] == 2 and snapshot["budget_units_used"] == 2
    r.close()
    r = router(tmp_path)
    assert r.snapshot()["calls_used"] == 2
    with pytest.raises(PolicyError, match="routing_no_candidate"):
        r.choose(catalog={})
    r.close()


def test_call_id_is_not_replay_authority_and_embedding_shares_ledger(tmp_path):
    embedding = replace(LOCAL, supports_text=False, supports_embeddings=True, automatic_allowed=True, budget_units=2)
    r = router(tmp_path, embedding=embedding)
    enable(r, daily_call_limit=2, daily_budget_units=3)
    d = r.choose(catalog={})
    r.reserve(d, "one", {})
    with pytest.raises(PolicyError, match="routing_duplicate_call"):
        r.reserve(d, "one", {})
    r.reserve_binding(embedding, purpose="embedding", call_id="two", items=[], catalog={}, history=[])
    assert r.snapshot()["calls_used"] == 2
    with pytest.raises(PolicyError, match="routing_limit"):
        r.reserve_binding(embedding, purpose="embedding", call_id="three", items=[], catalog={}, history=[])
    r.close()


def test_conversation_fallback_and_forged_default_never_enable_automatic(tmp_path):
    r = router(tmp_path)
    assert r.choose(catalog={}, conversation_model=LAN.model).binding.model == LAN.model
    enable(r)
    assert r.choose(catalog={}, conversation_model=LAN.model).reason == "conversation_fixed"
    with pytest.raises(PolicyError, match="model_not_allowed"):
        r.choose(catalog={}, selection={"source":"initial_local", "model":CLOUD.model})
    r.close()


def test_unpriced_or_unapproved_background_calls_block_even_when_router_off(tmp_path):
    embedding = replace(LOCAL, supports_embeddings=True, budget_units=0)
    r = ModelRouter(config(data_dir=str(tmp_path), embedding=embedding))
    with pytest.raises(PolicyError, match="model_not_allowed"):
        r.reserve_binding(embedding, purpose="embedding", call_id="one", items=[], catalog={}, history=[])
    with pytest.raises(PolicyError, match="model_not_allowed"):
        r.choose(catalog={}, purpose="memory_extract")
    r.close()


def test_settings_changes_invalidate_even_previously_uncharged_decisions(tmp_path):
    r = router(tmp_path)
    decision = r.choose(catalog={})
    enable(r)
    with pytest.raises(PolicyError, match="routing_changed"):
        r.reserve(decision, "one", {})
    assert r.snapshot()["calls_used"] == 0
    r.close()


def test_cross_instance_atomic_budget_and_clock_rollback(tmp_path):
    r = router(tmp_path)
    r.clock = lambda: 10 * 86400
    enable(r, daily_call_limit=1, daily_budget_units=1)
    other = router(tmp_path)
    other.clock = lambda: 10 * 86400
    decision = other.choose(catalog={})
    r.reserve(r.choose(catalog={}), "one", {})
    with pytest.raises(PolicyError, match="routing_limit"):
        other.reserve(decision, "two", {})
    other.clock = lambda: 9 * 86400
    assert other.snapshot()["calls_used"] == 1
    assert other.snapshot()["resets_at"] == 11 * 86400000
    other.close()
    r.close()


def test_routing_config_and_text_stream_host_verification(tmp_path):
    from tests.test_rearchitecture_app import client, HEADERS, FixtureProvider, message, completed
    provider = FixtureProvider()
    bindings = (replace(LOCAL, automatic_allowed=True, budget_units=4), replace(CLOUD, automatic_allowed=True, budget_units=1))
    with client(provider, data_dir=str(tmp_path), bindings=bindings) as http:
        assert http.get("/v1/routing").status_code == 401
        state = http.get("/v1/routing", headers=HEADERS).json()
        assert state["enabled"] is False
        changed = http.put("/v1/routing", headers=HEADERS, json={"enabled":True,"expected_revision":0,"daily_call_limit":2,"daily_budget_units":2})
        assert changed.status_code == 200
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            ws.send_json(message(scope, "input.finished", {"input_id":"input-1","kind":"text","text":"hello"}))
            ws.receive_json()
            ws.send_json(message(scope, "turn.start", {"selection":{"model":MODEL,"source":"initial_local"},"context":[],"routing_candidates":[LOCAL.model,CLOUD.model]}, 2))
            ws.receive_json()
            result = completed(ws)
            assert result[-1]["payload"]["status"] == "completed"
            assert result[0]["payload"]["actual_model"] == CLOUD.model
            assert result[0]["payload"]["routing_reason"] == "automatic_budget"
            assert result[1]["payload"]["routing_reason"] == "automatic_budget"
        assert len(provider.calls) == 1
        assert http.get("/v1/routing", headers=HEADERS).json()["calls_used"] == 1


@pytest.mark.parametrize("changes", [{"supports_text":1}, {"automatic_allowed":1}, {"budget_units":True}, {"budget_units":-1}])
def test_host_rejects_invalid_capability_and_budget(changes):
    from rearchitecture.config import ConfigError
    with pytest.raises(ConfigError):
        replace(LOCAL, **changes)


def test_screen_automatic_uses_image_capability_boundary_and_shared_budget(tmp_path):
    from tests.test_rearchitecture_screen import upload, ImageFixture, HEADERS
    from rearchitecture.app import create_app
    from fastapi.testclient import TestClient
    provider = ImageFixture()
    bindings = (replace(LOCAL, supports_images=True, automatic_allowed=True, budget_units=2),
                replace(CLOUD, supports_images=True, automatic_allowed=True, budget_units=0))
    with TestClient(create_app(config(data_dir=str(tmp_path), bindings=bindings), image_provider=provider), client=("127.0.0.1", 50000)) as http:
        assert http.put('/v1/routing', headers=HEADERS, json={'enabled':True,'expected_revision':0,'daily_call_limit':1,'daily_budget_units':2}).status_code == 200
        assert upload(http).status_code == 200
        result = http.post('/v1/screens/capture-1/analyze', headers=HEADERS, json={'revision':1,'model':None,'prompt':'설명'} )
        assert result.status_code == 200, result.text
        assert result.json()['actual_model'] == LOCAL.model
        assert result.json()['routing_reason'] == 'automatic_budget'
        assert len(provider.calls) == 1
        assert http.get('/v1/routing', headers=HEADERS).json()['calls_used'] == 1


@pytest.mark.asyncio
async def test_pending_memory_preparation_is_cancellable_without_chat_call_or_reservation(tmp_path):
    import asyncio
    from tests.test_rearchitecture_app import FixtureProvider, message
    from rearchitecture.session import SessionService
    class Socket:
        async def send_text(self, raw): pass
    class Memory:
        started = asyncio.Event()
        cancelled = False
        async def related(self, query, manual_context, history):
            self.started.set()
            try: await asyncio.Event().wait()
            finally: self.cancelled = True
    provider = FixtureProvider()
    cfg = config(data_dir=str(tmp_path), bindings=(replace(LOCAL, automatic_allowed=True, budget_units=1),))
    service = SessionService(cfg, provider, {})
    enable(service.router)
    memory = Memory(); service.auto_memory = memory
    socket = Socket(); session = await service.open(socket, None)
    await service.receive(session,socket,message(session.scope,'input.finished',{'input_id':'one','kind':'text','text':'hello'}),1)
    start = message(session.scope,'turn.start',{'selection':cfg.default_selection,'context':[],'routing_candidates':[MODEL]},2)
    try:
        await asyncio.wait_for(service.receive(session,socket,start,1),.3)
        await asyncio.wait_for(memory.started.wait(),.3)
        await asyncio.wait_for(service.receive(session,socket,message(session.scope,'turn.cancel',{'reason':'user'},3),1),.3)
        await asyncio.sleep(0)
        assert memory.cancelled and session.turns['turn-1'].status == 'cancelled'
        assert provider.calls == [] and service.router.snapshot()['calls_used'] == 0
    finally:
        for task in session.tasks.values(): task.cancel()
        await asyncio.gather(*session.tasks.values(),return_exceptions=True)
        service.router.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['settings', 'source'])
async def test_preparation_revalidates_settings_and_sources_after_await(tmp_path, change):
    import asyncio, json
    from tests.test_rearchitecture_app import FixtureProvider, message
    from rearchitecture.session import SessionService
    class Socket:
        events = []
        async def send_text(self, raw): self.events.append(json.loads(raw))
    class Memory:
        started = asyncio.Event()
        release = asyncio.Event()
        async def related(self, query, manual_context, history):
            self.started.set(); await self.release.wait(); return manual_context
    provider = FixtureProvider(); catalog = {'source-1':source()}
    cfg = config(data_dir=str(tmp_path),bindings=(replace(LOCAL,automatic_allowed=True,budget_units=1),))
    service = SessionService(cfg,provider,catalog); enable(service.router)
    memory = Memory(); service.auto_memory = memory
    socket = Socket(); session = await service.open(socket,None)
    await service.receive(session,socket,message(session.scope,'input.finished',{'input_id':'one','kind':'text','text':'hello'}),1)
    await service.receive(session,socket,message(session.scope,'turn.start',{'selection':cfg.default_selection,
        'context':[{'source_id':'source-1','revision':1,'text':'sensitive'}],'routing_candidates':[MODEL]},2),1)
    await asyncio.wait_for(memory.started.wait(),.3)
    if change == 'settings': service.router.configure({'enabled':False,'expected_revision':1,'daily_call_limit':10,'daily_budget_units':30})
    else: catalog['source-1'].record['revision'] = 2
    pending = list(session.tasks.values()); memory.release.set()
    await asyncio.wait_for(asyncio.gather(*pending),.5)
    assert session.turns['turn-1'].status == 'failed'
    assert socket.events[-1]['payload']['error_code'] == ('routing_changed' if change == 'settings' else 'routing_no_candidate')
    assert provider.calls == [] and service.router.snapshot()['calls_used'] == 0
    service.router.close()


def test_failed_automatic_provider_attempt_is_charged_without_fallback(tmp_path):
    from tests.test_rearchitecture_app import client, HEADERS, FixtureProvider, message, completed
    provider = FixtureProvider(done=False)
    bindings = (replace(LOCAL,automatic_allowed=True,budget_units=2),replace(CLOUD,automatic_allowed=True,budget_units=1))
    with client(provider,data_dir=str(tmp_path),bindings=bindings) as http:
        http.put('/v1/routing',headers=HEADERS,json={'enabled':True,'expected_revision':0,'daily_call_limit':10,'daily_budget_units':30})
        with http.websocket_connect('/v1/chat',headers=HEADERS) as ws:
            scope = ws.receive_json()['scope']
            ws.send_json(message(scope,'input.finished',{'input_id':'one','kind':'text','text':'hello'})); ws.receive_json()
            ws.send_json(message(scope,'turn.start',{'selection':config().default_selection,'context':[],'routing_candidates':[MODEL,CLOUD.model]},2)); ws.receive_json()
            result = completed(ws)
            assert result[-1]['payload'] == {'status':'failed','error_code':'incomplete_response'}
        assert len(provider.calls) == 1 and provider.calls[0][0] == CLOUD.model
        assert http.get('/v1/routing',headers=HEADERS).json()['calls_used'] == 1


def test_old_call_id_stays_consumed_after_day_rollover(tmp_path):
    r = router(tmp_path); r.clock = lambda: 10 * 86400; enable(r)
    r.reserve(r.choose(catalog={}), 'one', {})
    r.clock = lambda: 20 * 86400
    assert r.snapshot()['calls_used'] == 0
    with pytest.raises(PolicyError,match='routing_duplicate_call'):
        r.reserve(r.choose(catalog={}), 'one', {})
    r.close()


def test_routing_evidence_migrates_and_survives_restart_without_inventing_legacy_reason(tmp_path):
    from rearchitecture.storage import SQLiteStore
    store = SQLiteStore(str(tmp_path), IDENTITY)
    conversation = store.create_conversation()['id']
    store.begin_turn(conversation,'old','old question'); store.start_turn(conversation,'old',[])
    store.complete_response(conversation,'old','old answer',MODEL,[])
    store.end_turn(conversation,'old','completed')
    # Simulate a database created before routing evidence existed.
    for table in ('turns','screen_captures'):
        if any(row[1] == 'routing_reason' for row in store.connection.execute('PRAGMA table_info(' + table + ')')):
            store.connection.execute('ALTER TABLE ' + table + ' DROP COLUMN routing_reason')
    store.connection.commit(); store.close()
    store = SQLiteStore(str(tmp_path), IDENTITY)
    store.begin_turn(conversation,'new','new question'); store.start_turn(conversation,'new',[])
    store.complete_response(conversation,'new','new answer',CLOUD.model,[],routing_reason='automatic_budget')
    store.end_turn(conversation,'new','completed')
    store.put_screen('one',0,'screen','local',1)
    store.complete_screen('one',1,'analysis',MODEL,'hash',routing_reason='request_fixed')
    store.close(); store = SQLiteStore(str(tmp_path), IDENTITY)
    messages = {row['turn_id']:row for row in store.messages(conversation) if row['role'] == 'assistant'}
    assert 'routing_reason' not in messages['old']
    assert messages['new']['routing_reason'] == 'automatic_budget' and messages['new']['actual_model'] == CLOUD.model
    assert store.completed_screen('one',1,MODEL,'hash')['routing_reason'] == 'request_fixed'
    store.close()
