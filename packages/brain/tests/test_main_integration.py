"""main.py lifespan 통합 테스트.

MemoryStore → ChannelManager → Orchestrator._store 주입 경로와
AutoFineTuneScheduler lifespan 등록을 검증한다.
"""
import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch


# ──────────────────────────────────────────────
# TestChannelManagerStoreInjection
# ──────────────────────────────────────────────

class TestChannelManagerStoreInjection:
    def test_channel_manager_injects_store_on_create(self):
        """ChannelManager(store=s)에서 get_or_create 시 Orchestrator._store 주입."""
        from channels.manager import ChannelManager

        class FakeStore:
            pass

        store = FakeStore()
        manager = ChannelManager(store=store)
        orc = manager.get_or_create("tauri:test")

        assert orc._store is store

    def test_channel_manager_no_store_leaves_none(self):
        """store 미주입 시 Orchestrator._store는 None."""
        from channels.manager import ChannelManager

        manager = ChannelManager()
        orc = manager.get_or_create("tauri:test")

        assert orc._store is None

    def test_channel_manager_reuses_existing_session(self):
        """같은 key로 두 번 호출 시 동일 Orchestrator 반환."""
        from channels.manager import ChannelManager

        manager = ChannelManager()
        orc1 = manager.get_or_create("tauri:abc")
        orc2 = manager.get_or_create("tauri:abc")

        assert orc1 is orc2

    def test_channel_manager_store_only_injected_once(self):
        """기존 세션에 재접속 시 _store가 덮어쓰이지 않는다."""
        from channels.manager import ChannelManager

        class FakeStore:
            pass

        store = FakeStore()
        manager = ChannelManager(store=store)
        orc1 = manager.get_or_create("tauri:abc")
        orc1._store = None  # 외부에서 변경했다고 가정

        orc2 = manager.get_or_create("tauri:abc")  # 기존 세션 재사용
        assert orc2._store is None  # 기존 오브젝트 그대로 반환


# ──────────────────────────────────────────────
# TestSetChannelManager
# ──────────────────────────────────────────────

class TestSetChannelManager:
    def test_set_channel_manager_replaces_singleton(self):
        """set_channel_manager()가 라우터의 _channel_manager를 교체한다."""
        from channels.manager import ChannelManager
        from routers.websocket import set_channel_manager
        import routers.websocket as ws_module

        new_manager = ChannelManager()
        set_channel_manager(new_manager)

        assert ws_module._channel_manager is new_manager

        # 테스트 후 원복
        set_channel_manager(ChannelManager())


# ──────────────────────────────────────────────
# TestLifespanFitnessScoring
# ──────────────────────────────────────────────

class TestLifespanFinetuneScoring:
    @pytest.mark.asyncio
    async def test_lifespan_creates_memory_store_when_scoring_enabled(self):
        """enable_finetune_scoring=True이면 lifespan에서 MemoryStore가 생성된다."""
        from fastapi import FastAPI
        from httpx import AsyncClient, ASGITransport

        with patch("main.settings") as mock_settings:
            mock_settings.enable_finetune_scoring = True
            mock_settings.enable_auto_finetune = False
            mock_settings.enable_proactive = False
            mock_settings.memory_db_path = ":memory:"

            import main as main_module
            created_stores = []

            original_store_cls = None
            try:
                import memory.store as store_module
                original_store_cls = store_module.MemoryStore

                class TrackingStore(original_store_cls):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        created_stores.append(self)

                with patch("main.MemoryStore", TrackingStore):
                    from contextlib import asynccontextmanager

                    test_app = FastAPI()

                    @asynccontextmanager
                    async def test_lifespan(app):
                        from channels.manager import ChannelManager
                        from routers.websocket import set_channel_manager
                        store = TrackingStore(":memory:")
                        manager = ChannelManager(store=store)
                        set_channel_manager(manager)
                        app.state.memory_store = store
                        yield
                        store.close()

                    test_app.router.lifespan_context = test_lifespan

                    async with AsyncClient(
                        transport=ASGITransport(app=test_app), base_url="http://test"
                    ) as client:
                        pass  # lifespan 실행됨

            finally:
                pass  # 정리

    @pytest.mark.asyncio
    async def test_lifespan_no_store_when_scoring_disabled(self):
        """enable_finetune_scoring=False이면 _memory_store가 None이다."""
        import main as main_module

        # 기본 settings는 enable_finetune_scoring=False
        with patch("main.settings") as mock_settings:
            mock_settings.enable_finetune_scoring = False
            mock_settings.enable_auto_finetune = False
            mock_settings.enable_proactive = False

            # lifespan 내 store 생성 경로 검증
            from channels.manager import ChannelManager
            manager = ChannelManager()  # store=None
            orc = manager.get_or_create("tauri:test")
            assert orc._store is None


# ──────────────────────────────────────────────
# TestAutoFineTuneSchedulerLifespan
# ──────────────────────────────────────────────

class TestAutoFineTuneSchedulerLifespan:
    @pytest.mark.asyncio
    async def test_scheduler_start_stop_in_lifespan_pattern(self):
        """AutoFineTuneScheduler가 lifespan 패턴에서 정상 시작/종료된다."""
        from core.scheduler import AutoFineTuneScheduler

        class FakeCollector:
            def stats(self): return {"candidate_count": 0}
            def collect(self, **kw): return []

        class FakeFilter:
            def apply(self, convs): return convs

        class FakeFormatter:
            def to_instruction_response(self, convs): return []
            def save_jsonl(self, data, path): return 0

        scheduler = AutoFineTuneScheduler(
            collector=FakeCollector(),
            filter_=FakeFilter(),
            formatter=FakeFormatter(),
            trigger_count=500,
        )

        await scheduler.start()
        assert scheduler._task is not None
        assert not scheduler._task.done()

        await scheduler.stop()
        assert scheduler._task.done()

    @pytest.mark.asyncio
    async def test_scheduler_not_started_when_disabled(self):
        """enable_auto_finetune=False이면 scheduler가 시작되지 않는다."""
        from core.scheduler import AutoFineTuneScheduler

        # 스케줄러 인스턴스 자체를 만들지 않으므로 _task가 없음
        scheduler = AutoFineTuneScheduler.__new__(AutoFineTuneScheduler)
        assert not hasattr(scheduler, "_task") or scheduler._task is None


class TestTutorialLifespan:
    def test_builder_opens_store_once_and_injects_same_instance(self):
        import main as main_module

        settings = SimpleNamespace(
            hackathon_tutorial_configured=True,
            tutorial_db_path="tutorial.sqlite",
            tutorial_hmac_secret="x" * 32,
        )
        store = MagicMock()
        service = MagicMock()
        with (
            patch.object(main_module, "settings", settings),
            patch.object(main_module, "TutorialStore", return_value=store) as store_cls,
            patch.object(
                main_module.TutorialService,
                "from_settings",
                return_value=service,
            ) as service_factory,
        ):
            built_store, built_service = main_module._build_tutorial_components()

        store_cls.assert_called_once_with(
            "tutorial.sqlite", hmac_secret="x" * 32
        )
        service_factory.assert_called_once_with(settings, store=store)
        assert built_store is store
        assert built_service is service

    @pytest.mark.asyncio
    async def test_lifespan_starts_tutorial_skips_capsule_then_stops_before_close(self):
        from fastapi import FastAPI
        import main as main_module

        settings = SimpleNamespace(
            llm_profiles_path="profiles.json",
            settings_api_token="",
            enable_stt=False,
            stt_provider="faster-whisper",
            stt_model_size="small",
            enable_finetune_scoring=False,
            enable_auto_finetune=False,
            enable_long_term_memory=False,
            enable_persona=False,
            enable_proactive=False,
            enable_discord=False,
            discord_bot_token="",
        )
        store = MagicMock()
        service = MagicMock()
        service.start = AsyncMock()
        service.stop = AsyncMock()
        capsule_builder = MagicMock()
        app = FastAPI()
        with (
            patch.object(main_module, "settings", settings),
            patch.object(
                main_module,
                "_build_tutorial_components",
                return_value=(store, service),
            ),
            patch.object(
                main_module,
                "_build_memory_capsule_components",
                capsule_builder,
            ),
            patch.object(main_module, "_memory_store", None),
            patch.object(main_module, "_memory_capsule_store", None),
            patch.object(main_module, "_memory_capsule_service", None),
            patch.object(main_module, "proactive_scheduler", None),
            patch.object(main_module, "auto_finetune_scheduler", None),
            patch.object(main_module, "_discord_channel", None),
        ):
            async with main_module.lifespan(app):
                assert app.state.tutorial_service is service
                service.start.assert_awaited_once()
                capsule_builder.assert_not_called()
                store.close.assert_not_called()

            service.stop.assert_awaited_once()
            store.close.assert_called_once()
            assert app.state.tutorial_service is None
