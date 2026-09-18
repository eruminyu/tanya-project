"""격리 SQLite와 합성 provider로 자동 기억의 수명·전송 경계를 검증한다."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from rearchitecture.auto_memory_store import AutoMemoryRepository, default_settings
from rearchitecture.embedding import HTTPEmbeddingProvider, SQLiteVectorIndex, EmbeddingError
from rearchitecture.storage import SQLiteStore, StorageError
from tests.test_rearchitecture_app import IDENTITY, LOCAL, MODEL
from tests.test_rearchitecture_persistence import reference
from tests.test_rearchitecture_app import client, HEADERS
from tests.test_rearchitecture_app import CLOUD


@pytest.fixture
def database(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    yield store
    store.close()


def completed_turn(store, refs=None):
    conversation = store.create_conversation()
    store.begin_turn(conversation['id'], 'turn-one', '나는 아침에 차를 마셔.')
    store.start_turn(conversation['id'], 'turn-one', refs or [])
    store.complete_response(conversation['id'], 'turn-one', '기억할게.', MODEL, refs or [])
    store.end_turn(conversation['id'], 'turn-one', 'completed')
    return conversation['id']


def test_settings_default_off_persist_and_reject_unknown_scopes(database):
    repo = AutoMemoryRepository(database)
    assert not repo.settings()['enabled'] and not repo.settings()['retrieval_enabled']
    settings = default_settings() | {'enabled': True, 'conversations': True}
    assert repo.set_settings(settings) == settings
    assert AutoMemoryRepository(database).settings() == settings
    with pytest.raises(StorageError):
        repo.set_settings(settings | {'categories': ['execute']})
    with pytest.raises(StorageError):
        repo.set_settings(settings | {'note_collection_ids': ['missing-folder']})


def test_turn_anchor_exact_history_parents_and_conversation_delete(database):
    repo = AutoMemoryRepository(database)
    note = database.create_source('원본', '아침 기록', 'local', 'note', [])
    conversation = completed_turn(database, [reference(note)])
    source = repo.capture_turn(conversation, 'turn-one', 'local', [])
    assert source['text'] == '사용자: 나는 아침에 차를 마셔.\n키리안: 기억할게.'
    assert source['record']['parents'] == [reference(note)]
    memory = repo.remember(source, [{'category': 'preference', 'text': '아침에 차를 마신다.', 'quote': '나는 아침에 차를 마셔.'}], MODEL)[0]
    assert memory['record']['parents'] == [reference(source)]
    affected = database.delete_conversation(conversation)
    assert memory['record']['source_id'] in affected
    assert repo.evidence() == []
    assert database.catalog_entry(memory['record']['source_id'])['record']['deleted']


def test_turn_snapshot_cannot_weaken_any_history_ancestor_boundary(database):
    repo = AutoMemoryRepository(database)
    note = database.create_source('민감', '원문', 'local', 'note', [])
    conversation = completed_turn(database)
    with pytest.raises(StorageError, match='context_blocked'):
        repo.capture_turn(conversation, 'turn-one', 'cloud', [{'sources': [reference(note)]}])


def test_original_update_invalidates_vectors_and_derived_quotes(database):
    repo = AutoMemoryRepository(database)
    source = database.create_source('차', '아침에 차를 마신다.', 'local', 'note', [])
    memory = repo.remember(source, [{'category': 'preference', 'text': '차를 좋아한다.', 'quote': '차를 마신다.'}], MODEL)[0]
    index = SQLiteVectorIndex(database)
    index.put(memory, MODEL, [1.0, 0.0])
    assert index.search(MODEL, [1.0, 0.0])[0][0]['record'] == memory['record']
    database.update_source(source['record']['source_id'], 1, '차', '물을 마신다.', 'local')
    assert index.search(MODEL, [1.0, 0.0]) == []
    assert repo.evidence() == []


def test_quote_must_be_verbatim_and_memories_are_immutable(database):
    repo = AutoMemoryRepository(database)
    source = database.create_source('원문', '내일 책 읽기', 'local', 'note', [])
    with pytest.raises(StorageError, match='invalid_extraction'):
        repo.remember(source, [{'category': 'task', 'text': '권한 허용', 'quote': '실행 승인'}], MODEL)
    memory = repo.remember(source, [{'category': 'task', 'text': '책 읽기', 'quote': '내일 책 읽기'}], MODEL)[0]
    with pytest.raises(StorageError):
        database.update_source(memory['record']['source_id'], 1, 'edited', 'changed', 'local')


def test_settings_cas_off_wins_over_delayed_enable(database):
    repo = AutoMemoryRepository(database)
    settings = default_settings() | {'enabled': True}
    repo.set_settings(settings, expected_revision=0)
    repo.set_settings(default_settings(), expected_revision=0)  # 긴급 OFF는 최신 값을 덮을 수 있다.
    with pytest.raises(StorageError, match='settings_changed'):
        repo.set_settings(settings, expected_revision=1)
    assert not repo.settings()['enabled']


def test_unavailable_blocks_then_verified_unchanged_scan_restores_existing_memory(database):
    collection, _ = database.sync_collection('folder', 0, '폴더', 'local', [{'path': 'a.md', 'title': '차', 'text': '차를 마신다.'}])
    source = database.list_sources()[0]
    repo = AutoMemoryRepository(database)
    generation = repo.source_generation()
    memory = repo.remember(source, [{'category': 'fact', 'text': '차를 마신다.', 'quote': '차를 마신다.'}], MODEL)[0]
    index = SQLiteVectorIndex(database)
    index.put(memory, MODEL, [1, 2])
    database.collection_unavailable('folder')
    assert repo.evidence() == [] and index.search(MODEL, [1, 2]) == []
    database.sync_collection('folder', collection['revision'], '폴더', 'local', [{'path': 'a.md', 'title': '차', 'text': '차를 마신다.'}])
    assert repo.evidence()[0]['source_id'] == memory['record']['source_id']
    assert index.search(MODEL, [1, 2])[0][0]['record'] == memory['record']
    assert repo.source_generation() != generation


def test_normal_restart_keeps_same_evidence_and_vector_after_complete_scan(tmp_path):
    store = SQLiteStore(str(tmp_path), IDENTITY)
    docs = [{'path':'a.md','title':'차','text':'차를 마신다.'}]
    store.sync_collection('folder',0,'폴더','local',docs)
    repo = AutoMemoryRepository(store)
    memory = repo.remember(store.list_sources()[0], [{'category':'fact','text':'차','quote':'차'}], MODEL)[0]
    SQLiteVectorIndex(store).put(memory,MODEL,[1,2])
    before = repo.evidence()
    store.close()
    store = SQLiteStore(str(tmp_path),IDENTITY)
    try:
        repo = AutoMemoryRepository(store)
        assert repo.evidence() == [] and SQLiteVectorIndex(store).search(MODEL,[1,2]) == []
        store.sync_collection('folder',1,'폴더','local',docs)
        assert repo.evidence() == before
        assert SQLiteVectorIndex(store).search(MODEL,[1,2])[0][0] == memory
    finally:
        store.close()


def test_narrowing_conversation_boundary_retires_cloud_derivatives(database):
    repo = AutoMemoryRepository(database)
    repo.set_settings(default_settings() | {'enabled':True,'conversations':True,'conversation_boundary':'cloud'})
    conversation = completed_turn(database)
    source = repo.capture_turn(conversation,'turn-one','cloud',[])
    memory = repo.remember(source,[{'category':'fact','text':'차','quote':'차'}],MODEL)[0]
    repo.set_settings(repo.settings() | {'conversation_boundary':'local'},expected_revision=1)
    assert database.catalog_entry(memory['record']['source_id'])['record']['deleted']
    current = database.catalog_entry(source['record']['source_id'])
    assert current['record']['boundary'] == 'local' and current['record']['revision'] > source['record']['revision']


def test_boundary_narrowing_preserves_raw_history_chain_for_next_turn(database):
    repo = AutoMemoryRepository(database)
    repo.set_settings(default_settings() | {'enabled':True,'conversations':True,'conversation_boundary':'cloud'})
    conversation = completed_turn(database)
    first = repo.capture_turn(conversation,'turn-one','cloud',[])
    history = database.history(conversation)
    database.begin_turn(conversation,'turn-two','다음 이야기')
    database.start_turn(conversation,'turn-two',[])
    database.complete_response(conversation,'turn-two','두 번째 답변',MODEL,[])
    database.end_turn(conversation,'turn-two','completed')
    second = repo.capture_turn(conversation,'turn-two','cloud',history)
    repo.set_settings(repo.settings() | {'conversation_boundary':'local'},expected_revision=1)
    first_now = database.catalog_entry(first['record']['source_id'])
    second_now = database.catalog_entry(second['record']['source_id'])
    assert not second_now['record']['deleted'] and second_now['text'] == second['text']
    assert second_now['record']['boundary'] == 'local'
    assert second_now['record']['parents'] == [reference(first_now)]
    history = database.history(conversation)
    database.begin_turn(conversation,'turn-three','마지막 이야기')
    database.start_turn(conversation,'turn-three',[])
    database.complete_response(conversation,'turn-three','세 번째 답변',MODEL,[])
    database.end_turn(conversation,'turn-three','completed')
    third = repo.capture_turn(conversation,'turn-three','local',history)
    assert third['record']['boundary'] == 'local' and len(third['record']['parents']) == 2


def test_dedupe_is_atomic_per_full_text_and_parent_not_ui_latest_50(database):
    repo = AutoMemoryRepository(database)
    first = database.create_source('차','차','local','note',[])
    item = {'category':'fact','text':'가' * 120 + '차','quote':'차'}
    repo.remember(first,[item],MODEL)
    for i in range(51):
        source = database.create_source(str(i),'차','local','note',[])
        repo.remember(source,[item],MODEL)
    assert repo.remember(first,[item],MODEL) == []
    assert len(repo.remember(first,[item | {'text':'가' * 120 + '다른 차'}],MODEL)) == 1


def test_identical_history_text_maps_to_actual_recent_turn_not_oldest(database):
    conversation = completed_turn(database)
    for turn in ('turn-two','turn-three'):
        database.begin_turn(conversation,turn,'나는 아침에 차를 마셔.')
        database.start_turn(conversation,turn,[])
        database.complete_response(conversation,turn,'기억할게.',MODEL,[])
        database.end_turn(conversation,turn,'completed')
    repo = AutoMemoryRepository(database)
    history = [{'role':'user','content':'나는 아침에 차를 마셔.','sources':[]},{'role':'assistant','content':'기억할게.','sources':[]}]
    latest = repo.capture_turn(conversation,'turn-three','local',history)
    parent = latest['record']['parents'][0]['source_id']
    with database.transaction() as db:
        assert db.execute('SELECT turn_id FROM auto_turn_sources WHERE source_id=?',(parent,)).fetchone()[0] == 'turn-two'
    assert database.history(conversation)[-1]['_turn_id'] == 'turn-three'


def test_cancel_after_response_invalidates_turn_snapshot(database):
    repo = AutoMemoryRepository(database)
    conversation = completed_turn(database)
    source = repo.capture_turn(conversation, 'turn-one', 'private_lan', [])
    assert source['record']['boundary'] == 'private_lan'
    memory = repo.remember(source, [{'category': 'fact', 'text': '차', 'quote': '차'}], MODEL)[0]
    database.end_turn(conversation, 'turn-one', 'cancelled')
    assert database.catalog_entry(memory['record']['source_id'])['record']['deleted']


def test_vector_shape_model_version_and_exact_cosine(database):
    index = SQLiteVectorIndex(database)
    source = database.create_source('A', '사과', 'local', 'note', [])
    index.put(source, MODEL, [3.0, 4.0])
    assert index.search(MODEL, [3.0, 4.0])[0][1] == pytest.approx(1)
    assert index.search(MODEL | {'model_id': 'another'}, [3.0, 4.0]) == []
    assert index.search(MODEL, [3.0, 4.0, 5.0]) == []
    for vector in ([0.0, 0.0], [float('nan')], [True], []):
        with pytest.raises(EmbeddingError):
            index.put(source, MODEL, vector)


@pytest.mark.asyncio
async def test_real_ollama_embedding_adapter_uses_model_and_validates_response():
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={'model': MODEL['model_id'], 'embeddings': [[0.25, 0.75]]})
    provider = HTTPEmbeddingProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    assert await provider.embed(LOCAL, '차') == [0.25, 0.75]
    assert seen[0].url.path == '/api/embed'
    assert json.loads(seen[0].content) == {'model': MODEL['model_id'], 'input': '차', 'truncate': False}


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [
    {'model': 'other', 'embeddings': [[1, 2]]}, {'model': MODEL['model_id'], 'embeddings': [[0, 0]]},
    {'model': MODEL['model_id'], 'embeddings': [[1], [2]]}, {'embeddings': [[1, 2]]},
])
async def test_embedding_rejects_missing_mismatched_or_invalid_vectors(payload):
    provider = HTTPEmbeddingProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))))
    with pytest.raises(EmbeddingError):
        await provider.embed(LOCAL, '입력')


@pytest.mark.asyncio
async def test_openai_compatible_embedding_request_and_reported_model():
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200,json={'object':'list','model':CLOUD.model['model_id'],
            'data':[{'object':'embedding','index':0,'embedding':[0.5,0.25]}]})
    provider = HTTPEmbeddingProvider(lambda:httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    assert await provider.embed(CLOUD,'입력') == [0.5,0.25]
    assert seen[0].url.path == '/v1/embeddings'
    assert json.loads(seen[0].content) == {'model':CLOUD.model['model_id'],'input':'입력','encoding_format':'float'}


def test_auto_memory_rest_is_authenticated_bounded_and_cas_checked(tmp_path):
    with client(data_dir=str(tmp_path)) as http:
        assert http.get('/v1/auto-memory').status_code == 401
        state = http.get('/v1/auto-memory', headers=HEADERS).json()
        assert state['settings'] == default_settings() and state['status'] == 'disabled'
        assert state['embedding_model'] is None and state['recent_usage'] == []
        settings = default_settings() | {'enabled': True, 'conversations': True}
        update = http.put('/v1/auto-memory', headers=HEADERS, json={'settings': settings, 'expected_revision': 0})
        assert update.status_code == 200 and update.json()['revision'] == 1
        assert http.put('/v1/auto-memory', headers=HEADERS, json={'settings': settings, 'expected_revision': 0}).status_code == 409
        assert http.put('/v1/auto-memory', headers=HEADERS, json={'settings': default_settings(), 'expected_revision': 0}).status_code == 200
        for payload in ({'query': '', 'context': []}, {'query': '차' * 257, 'context': []}, {'query': '차', 'context': [], 'history': []}):
            assert http.post('/v1/auto-memory/search', headers=HEADERS, json=payload).status_code == 400
        assert http.post('/v1/auto-memory/search', headers=HEADERS, json={'query': '차', 'context': []}).json() == {'results': [], 'status': 'disabled'}
