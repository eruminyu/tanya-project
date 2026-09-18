"""격리 저장소의 제안 근거·권한·예산과 취소 검증."""
import asyncio
import json
from dataclasses import replace

import pytest

from rearchitecture.proactive import ProactiveService
from rearchitecture.auto_memory_store import AutoMemoryRepository
from rearchitecture.session import SessionService
from rearchitecture.storage import SQLiteStore
from rearchitecture.policy import PolicyError
from rearchitecture.providers import ProviderChunk
from tests.test_rearchitecture_app import config, IDENTITY, LOCAL, CLOUD, MODEL, FixtureProvider, HEADERS, client


@pytest.fixture
def subject(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    settings = config(data_dir=str(tmp_path), bindings=(replace(LOCAL, automatic_allowed=True, budget_units=1), replace(CLOUD, automatic_allowed=True, budget_units=1)))
    provider = FixtureProvider()
    owner = SessionService(settings, provider, {}, store=store)
    service = ProactiveService(owner)
    note = store.create_source('과제 원본', '내일 발표 자료를 준비해야 한다.', 'local', 'note', [])
    memory = AutoMemoryRepository(store).remember(note, [{'category':'task','text':'내일 발표 준비','quote':'발표 자료를 준비'}], MODEL)[0]
    yield service, provider, memory
    owner.router.close()
    store.close()


def request(source, **changes):
    return {'sources':[{'source_id':source['record']['source_id'], 'revision':1}], 'model':MODEL, 'attempt_id':'suggestion-one'} | changes


@pytest.mark.asyncio
async def test_grounded_suggestion_charged_with_routing_off_and_no_execution(subject):
    service, provider, memory = subject
    provider.text = json.dumps({'text':'발표 준비 항목을 정리해 볼까요?', 'source_id':memory['record']['source_id'], 'quote':'발표 준비'})
    result = await service.generate(request(memory))
    assert result['suggestion']['quote'] == '발표 준비'
    assert result['actual_model'] == MODEL and result['routing_reason'] == 'request_fixed'
    assert service.owner.router.snapshot()['calls_used'] == 1
    assert '실행' in provider.calls[0][2] and provider.calls[0][3] == []
    with pytest.raises(PolicyError, match='routing_duplicate_call'):
        await service.generate(request(memory))
    assert len(provider.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('response', ['{"text":"실행했어","source_id":"forged","quote":"발표"}', '{"text":"도움","source_id":"SOURCE","quote":"없는 근거"}', '{"text":"도움","source_id":"SOURCE","quote":"발표","execute":true}', '[]', '{"text":"\\ud800","source_id":"SOURCE","quote":"발표"}'])
async def test_invalid_output_cannot_invent_evidence_or_commands(subject, response):
    service, provider, memory = subject
    provider.text = response.replace('SOURCE', memory['record']['source_id'])
    with pytest.raises(PolicyError, match='invalid_suggestion'):
        await service.generate(request(memory))
    assert service.owner.router.snapshot()['calls_used'] == 1


@pytest.mark.asyncio
async def test_cloud_cannot_receive_local_ancestor_and_stale_source_is_rejected(subject):
    service, provider, memory = subject
    with pytest.raises(PolicyError, match='context_blocked'):
        await service.generate(request(memory, model=CLOUD.model))
    with pytest.raises(PolicyError, match='source_changed'):
        await service.generate(request(memory, sources=[{'source_id':memory['record']['source_id'],'revision':2}]))
    assert not provider.calls


@pytest.mark.asyncio
async def test_source_mutation_during_stream_discards_result(subject):
    service, provider, memory = subject
    async def stream(binding, *args):
        service.owner.store.delete_source(memory['record']['parents'][0]['source_id'], 1)
        yield ProviderChunk('null', binding.model['model_id'], True)
    provider.stream = stream
    with pytest.raises(PolicyError, match='source_changed'):
        await service.generate(request(memory))


@pytest.mark.asyncio
async def test_no_suggestion_and_wrong_actual_model(subject):
    service, provider, memory = subject
    provider.text = 'null'
    assert (await service.generate(request(memory)))['suggestion'] is None
    provider.reported = 'wrong'
    with pytest.raises(PolicyError, match='model_mismatch'):
        await service.generate(request(memory, attempt_id='second'))


def test_candidate_list_excludes_notes_and_deleted_memory(subject):
    service, _, memory = subject
    result = service.candidates()
    assert [s['source_id'] for s in result['sources']] == [memory['record']['source_id']]
    assert result['sources'][0]['kind'] == 'memory'
    assert 'text' not in result['sources'][0]
    service.owner.store.delete_source(memory['record']['parents'][0]['source_id'], 1)
    assert service.candidates()['sources'] == []


def test_http_auth_and_exact_request(tmp_path):
    with client(data_dir=str(tmp_path)) as http:
        assert http.get('/v1/proactive/sources').status_code == 401
        assert http.get('/v1/proactive/sources', headers=HEADERS).json()['sources'] == []
        assert http.post('/v1/proactive/generate', headers=HEADERS, json={'sources':[], 'model':MODEL, 'attempt_id':'one', 'execute':True}).status_code == 400

@pytest.mark.asyncio
async def test_silent_provider_is_cancelled_when_ancestor_is_revoked(subject):
    service, provider, memory = subject
    started, closed = asyncio.Event(), asyncio.Event()
    async def stream(binding, *args):
        try:
            started.set()
            await asyncio.Event().wait()
            yield ProviderChunk('null', binding.model['model_id'], True)
        finally:
            closed.set()
    provider.stream = stream
    job = asyncio.create_task(service.generate(request(memory)))
    await started.wait()
    service.owner.store.delete_source(memory['record']['parents'][0]['source_id'], 1)
    with pytest.raises(PolicyError, match='source_changed'):
        await asyncio.wait_for(job, 1)
    assert closed.is_set() and not service.busy

def test_shared_ancestor_graph_classification_is_bounded(subject):
    service, _, memory = subject
    store = service.owner.store
    refs = [memory['record']['parents'][0]]
    for i in range(15):
        source = store.create_source(str(i), '공유 맥락', 'local', 'memory', refs[-2:])
        refs.append({'source_id':source['record']['source_id'], 'revision':1})
    original, calls = store.catalog_entry, []
    def count(key):
        calls.append(key)
        return original(key)
    store.catalog_entry = count
    assert service._screen_derived(refs[-1]) is False
    assert len(calls) <= 16

def test_explicit_old_memory_stays_in_candidates_after_50_new_sources(subject):
    service, _, memory = subject
    for i in range(55):
        service.owner.store.create_source(str(i), '최근 기억', 'local', 'memory', [])
    result = service.candidates([memory['record']['source_id']])
    assert result['sources'][0]['source_id'] == memory['record']['source_id']
    assert len(result['sources']) == 50

@pytest.mark.asyncio
async def test_screen_analysis_descendants_keep_screen_classification_and_boundary(subject):
    service, provider, _ = subject
    store = service.owner.store
    store.put_screen('capture-test', 0, '검증용 창', 'private_lan', 1000)
    analysis = store.complete_screen('capture-test', 1, '발표 준비를 진행 중이다.', MODEL, 'prompt')['source']
    derived = store.create_source('화면 파생 기억', '발표 준비', 'private_lan', 'memory', [{'source_id':analysis['record']['source_id'], 'revision':1}])
    result = service.candidates([derived['record']['source_id']])
    assert result['sources'][0]['kind'] == 'screen'
    with pytest.raises(PolicyError, match='context_blocked'):
        await service.generate(request(derived, model=CLOUD.model))
    assert not provider.calls
    store.delete_screen('capture-test', 1)
    assert not any(s['source_id'] == derived['record']['source_id'] for s in service.candidates()['sources'])
