"""T-068 실제 라우터와 자동 기억 서비스의 통합 TDD. 외부 모델은 합성 provider만 사용한다."""
import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from rearchitecture.auto_memory import AutoMemoryService
from rearchitecture.auto_memory_store import default_settings, context_item
from rearchitecture.routing import ModelRouter
from rearchitecture.storage import SourceCatalog
from tests.test_rearchitecture_app import config, LOCAL, MODEL, FixtureProvider
from tests.test_rearchitecture_auto_memory import database, completed_turn


class FixtureEmbedding:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.release = None

    async def embed(self, binding, text):
        self.calls.append((binding.model, text))
        self.started.set()
        if self.release:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                await self.release.wait()  # 취소를 늦게 반영하는 provider도 저장은 막아야 한다.
        return [0.8, 0.2]


@pytest.fixture
def owner(database, tmp_path):
    binding = replace(LOCAL, automatic_allowed=True, budget_units=1)
    embedding = replace(binding, supports_text=False, supports_embeddings=True, model=MODEL | {'model_id': 'embedding'})
    cfg = config(data_dir=str(tmp_path), bindings=(binding,), embedding=embedding)
    service = SimpleNamespace(config=cfg, store=database, catalog=SourceCatalog(database, {}),
                              provider=FixtureProvider(json.dumps([{'category': 'preference', 'text': '차를 마신다.', 'quote': '차'}])),
                              router=ModelRouter(cfg), effective_default=lambda: cfg.default_selection)
    yield service
    service.router.close()


async def drain(memory):
    for _ in range(100):
        await asyncio.sleep(0.01)
        if not memory.pending:
            return
    raise AssertionError('자동 작업이 종료되지 않음')


@pytest.mark.asyncio
async def test_automatic_completed_turn_extracts_indexes_and_retrieves(owner):
    embeddings = FixtureEmbedding()
    memory = AutoMemoryService(owner, embeddings)
    memory.configure({'settings': default_settings() | {'enabled': True, 'conversations': True, 'retrieval_enabled': True}, 'expected_revision': 0})
    conversation = completed_turn(owner.store)
    memory.schedule_turn(conversation, 'turn-one', [])
    await drain(memory)
    assert len(memory.repo.evidence()) == 1 and len(embeddings.calls) == 1
    manual = owner.store.create_source('수동', '보존', 'local', 'note', [])
    related = await memory.related('아침 음료', [context_item(manual)], [])
    assert related[0] == context_item(manual) and related[1]['text'] == '차를 마신다.'
    assert owner.router.snapshot()['calls_used'] == 3  # 추출, 색인, 검색이 같은 원장을 사용한다.
    await memory.shutdown()


@pytest.mark.asyncio
async def test_automatic_folder_and_screen_scope_polling(owner):
    owner.store.sync_collection('allowed', 0, '허용', 'local', [{'path': 'a.md', 'title': '차', 'text': '차'}])
    owner.store.sync_collection('excluded', 0, '제외', 'local', [{'path': 'a.md', 'title': '차', 'text': '차'}])
    memory = AutoMemoryService(owner, FixtureEmbedding())
    memory.configure({'settings': default_settings() | {'enabled': True, 'note_collection_ids': ['allowed']}, 'expected_revision': 0})
    memory.poll()
    await drain(memory)
    assert len(memory.repo.evidence()) == 1
    memory.poll()
    await drain(memory)
    assert len(owner.provider.calls) == 1
    await memory.shutdown()


@pytest.mark.asyncio
async def test_off_discards_late_embedding_and_search_results(owner):
    embeddings = FixtureEmbedding()
    embeddings.release = asyncio.Event()
    memory = AutoMemoryService(owner, embeddings)
    memory.configure({'settings': default_settings() | {'enabled': True, 'conversations': True}, 'expected_revision': 0})
    conversation = completed_turn(owner.store)
    memory.schedule_turn(conversation, 'turn-one', [])
    await embeddings.started.wait()
    memory.configure({'settings': default_settings(), 'expected_revision': 1})
    embeddings.release.set()
    await drain(memory)
    assert memory.snapshot()['indexed_count'] == 0
    assert await memory.related('차', [], []) == []
    await memory.shutdown()


@pytest.mark.asyncio
async def test_budget_denial_makes_no_provider_call_and_manual_context_survives(owner):
    owner.router.configure({'enabled': False, 'expected_revision': 0, 'daily_call_limit': 1, 'daily_budget_units': 0})
    memory = AutoMemoryService(owner, FixtureEmbedding())
    memory.configure({'settings': default_settings() | {'enabled': True, 'conversations': True, 'retrieval_enabled': True}, 'expected_revision': 0})
    conversation = completed_turn(owner.store)
    memory.schedule_turn(conversation, 'turn-one', [])
    await drain(memory)
    assert owner.provider.calls == [] and memory.snapshot()['status'] == 'routing_limit'
    manual = [context_item(owner.store.create_source('원문', '차', 'local', 'note', []))]
    assert await memory.related('차', manual, []) == manual
    await memory.shutdown()


@pytest.mark.asyncio
async def test_poll_advances_beyond_excluded_and_already_indexed_sources(owner):
    owner.store.sync_collection('excluded', 0, '제외', 'local', [{'path': f'{i}.md', 'title': '차', 'text': '차'} for i in range(520)])
    owner.store.sync_collection('allowed', 0, '허용', 'local', [{'path': 'a.md', 'title': '차', 'text': '차'}])
    memory = AutoMemoryService(owner, FixtureEmbedding())
    memory.configure({'settings': default_settings() | {'enabled': True, 'note_collection_ids': ['allowed']}, 'expected_revision': 0})
    memory.poll()
    await drain(memory)
    assert len(memory.repo.evidence()) == 1
    await memory.shutdown()


@pytest.mark.asyncio
async def test_long_completed_turn_preserves_full_original_and_extracts_later_chunk(owner):
    memory = AutoMemoryService(owner, FixtureEmbedding())
    owner.provider.text = json.dumps([{'category':'fact','text':'마지막 차','quote':'차'}])
    memory.configure({'settings': default_settings() | {'enabled': True, 'conversations': True}, 'expected_revision': 0})
    conversation = owner.store.create_conversation()['id']
    owner.store.begin_turn(conversation, 'long-turn', '차' * 8192)
    owner.store.start_turn(conversation, 'long-turn', [])
    owner.store.complete_response(conversation, 'long-turn', '차' * 8192, MODEL, [])
    owner.store.end_turn(conversation, 'long-turn', 'completed')
    memory.schedule_turn(conversation, 'long-turn', [])
    await drain(memory)
    assert len(owner.provider.calls) == 3
    with owner.store.transaction() as db:
        raw = db.execute("SELECT s.text FROM sources s JOIN auto_turn_sources t ON t.source_id=s.id").fetchone()[0]
    assert raw == '사용자: ' + '차' * 8192 + '\n키리안: ' + '차' * 8192
    assert len(memory.repo.evidence()) == 3
    await memory.shutdown()


@pytest.mark.asyncio
async def test_parent_delete_and_unknown_during_embedding_cannot_reintroduce_vector(owner):
    embeddings = FixtureEmbedding(); embeddings.release = asyncio.Event()
    owner.store.sync_collection('allowed', 0, '허용', 'local', [{'path': 'a.md', 'title': '차', 'text': '차'}])
    memory = AutoMemoryService(owner, embeddings)
    memory.configure({'settings': default_settings() | {'enabled': True, 'note_collection_ids': ['allowed']}, 'expected_revision': 0})
    await embeddings.started.wait()
    owner.store.collection_unavailable('allowed')
    owner.store.sync_collection('allowed', 1, '허용', 'local', [{'path': 'a.md', 'title': '차', 'text': '차'}])
    embeddings.release.set(); await drain(memory)
    assert len(memory.repo.evidence()) == 1 and memory.snapshot()['indexed_count'] == 0
    await memory.shutdown()


@pytest.mark.asyncio
async def test_unrelated_source_edit_does_not_cancel_ongoing_index(owner):
    embeddings = FixtureEmbedding(); embeddings.release = asyncio.Event()
    memory = AutoMemoryService(owner,embeddings)
    other = owner.store.create_source('별개','무관','local','note',[])
    memory.configure({'settings':default_settings() | {'enabled':True,'conversations':True},'expected_revision':0})
    conversation = completed_turn(owner.store); memory.schedule_turn(conversation,'turn-one',[])
    await embeddings.started.wait()
    owner.store.update_source(other['record']['source_id'],1,'별개','수정','local')
    embeddings.release.set(); await drain(memory)
    assert memory.snapshot()['indexed_count'] == 1
    await memory.shutdown()


@pytest.mark.asyncio
async def test_semantic_top_k_filters_scope_before_ranking(owner):
    memory = AutoMemoryService(owner,FixtureEmbedding())
    for name in ('excluded','allowed'):
        owner.store.sync_collection(name,0,name,'local',[{'path':f'{i}.md','title':'차','text':'차'} for i in range(51 if name=='excluded' else 1)])
    with owner.store.transaction() as db:
        ids = [row[0] for row in db.execute('SELECT source_id FROM collection_chunks')]
    for source_id in ids:
        source = owner.store.get_source(source_id)
        entry = memory.repo.remember(source,[{'category':'fact','text':'차','quote':'차'}],MODEL)[0]
        memory.index.put(entry,owner.config.embedding.model,[0.8,0.2] if source['origin']['collection_id']=='excluded' else [0.75,0.25])
    memory.configure({'settings':default_settings() | {'retrieval_enabled':True,'note_collection_ids':['allowed']},'expected_revision':0})
    result = await memory.search('차',[])
    assert len(result['results']) == 1
    parent_id = memory.repo.evidence({result['results'][0]['source_id']})[0]['parent']['source_id']
    assert owner.store.get_source(parent_id)['origin']['collection_id'] == 'allowed'
    await memory.shutdown()


@pytest.mark.asyncio
async def test_transient_embedding_outage_keeps_the_original_and_reindexes_after_backoff(owner, monkeypatch):
    from rearchitecture.embedding import EmbeddingError
    from rearchitecture import auto_memory as module

    class OutageEmbedding(FixtureEmbedding):
        def __init__(self):
            super().__init__()
            self.down = True

        async def embed(self, binding, text):
            self.calls.append((binding.model, text))
            if self.down:
                raise EmbeddingError("embedding_unavailable")
            return [0.8, 0.2]

    embeddings = OutageEmbedding()
    monkeypatch.setattr(module, "RETRY_BACKOFF_SECONDS", 0.05)
    memory = AutoMemoryService(owner, embeddings)
    memory.configure({'settings': default_settings() | {'enabled': True, 'conversations': True, 'retrieval_enabled': True}, 'expected_revision': 0})
    conversation = completed_turn(owner.store)
    memory.schedule_turn(conversation, 'turn-one', [])
    await drain(memory)
    state = memory.snapshot()
    assert state['status'] == 'embedding_unavailable' and state['memory_count'] == 1 and state['indexed_count'] == 0
    with owner.store.transaction() as db:
        assert db.execute("SELECT count(*) FROM auto_memory_attempts WHERE status='started'").fetchone()[0] == 0
    assert (await memory.related('아침 음료', [], []))  == []  # search reports the outage instead of guessing
    embeddings.down = False
    for _ in range(50):
        await asyncio.sleep(0.02)
        memory.poll()
        await drain(memory)
        if memory.snapshot()['indexed_count'] == 1:
            break
    state = memory.snapshot()
    assert state['indexed_count'] == 1 and state['status'] == 'ready', state
    assert len(memory.repo.evidence()) == 1  # the original memory was kept, not re-extracted or duplicated
    assert (await memory.related('아침 음료', [], []))[0]['text'] == '차를 마신다.'
    await memory.shutdown()
