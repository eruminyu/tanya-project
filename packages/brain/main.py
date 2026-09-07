import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.rate_limit import RateLimiter, client_key
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from channels.bot_base import BotChannel
from channels.discord_channel import DiscordChannel
from channels.manager import ChannelManager
from config.settings import get_settings
from config.llm_profiles import LLMProfileStore
from core.llm import LLMManager
from memory.embeddings import LocalEmbeddingProvider
from memory.long_term import LongTermMemory
from memory.capsule import (
    CouchDBMemoryCapsuleRepository,
    MemoryCapsuleService,
)
from core.proactive import ProactiveTriggerScheduler
from core.proactive_rules import (
    AchievementRule,
    LongIdleRule,
    LongSessionRule,
    MorningGreetingRule,
    NightCheckRule,
    RandomThoughtRule,
    StreakBreakRule,
    WorkReminderRule,
    UpcomingEventRule,
)
from core.orchestrator import Orchestrator
from core.scheduler import AutoFineTuneScheduler
from finetune.collector import FineTuneCollector
from finetune.filter import FineTuneFilter
from finetune.formatter import FineTuneFormatter
from memory.store import MemoryCapsuleIndexStore, MemoryStore
from tutorial.service import TutorialService
from tutorial.store import TutorialStore
from routers import websocket
from routers import feedback as feedback_router_module
from routers import live2d_compat as live2d_router_module
from routers import llm_settings as llm_settings_router_module
from routers import stt as stt_router_module
from core.providers.faster_whisper_provider import FasterWhisperProvider
from routers.websocket import set_channel_manager
from routers.live2d_compat import set_channel_manager as set_live2d_channel_manager
from web_client import default_web_client_dir, install_web_client, is_public_web_request

settings = get_settings()

# 싱글턴 — lifespan 외부에서도 참조 가능
proactive_scheduler: ProactiveTriggerScheduler | None = None
auto_finetune_scheduler: AutoFineTuneScheduler | None = None
_memory_store: MemoryStore | None = None
_memory_capsule_store: MemoryCapsuleIndexStore | None = None
_memory_capsule_service: MemoryCapsuleService | None = None
_tutorial_store: TutorialStore | None = None
_tutorial_service: TutorialService | None = None
_discord_channel: BotChannel | None = None


def _build_proactive_scheduler(persona_prompt: str = "") -> ProactiveTriggerScheduler:
    llm = LLMManager()
    rules = [
        MorningGreetingRule(),
        LongIdleRule(),
        RandomThoughtRule(),
        NightCheckRule(),
        LongSessionRule(),
        WorkReminderRule(),
        StreakBreakRule(),
        AchievementRule(),
        # T-013: 발화의 근거가 시계가 아니라 사용자의 실제 일정인 유일한 규칙.
        UpcomingEventRule(),
    ]
    return ProactiveTriggerScheduler(
        rules=rules,
        llm=llm,
        persona_prompt=persona_prompt,
        max_daily_fires=settings.proactive_max_daily,
        quiet_start_hour=settings.proactive_quiet_start,
        quiet_end_hour=settings.proactive_quiet_end,
    )


def _build_auto_finetune_scheduler(store: MemoryStore) -> AutoFineTuneScheduler:
    collector = FineTuneCollector(store)
    filter_ = FineTuneFilter()
    formatter = FineTuneFormatter()
    return AutoFineTuneScheduler(
        collector=collector,
        filter_=filter_,
        formatter=formatter,
        trigger_count=settings.finetune_trigger_count,
        schedule_hour=settings.finetune_schedule_hour,
        output_dir=settings.finetune_output_dir,
    )


def _build_memory_capsule_components() -> tuple[
    MemoryCapsuleIndexStore | None, MemoryCapsuleService | None
]:
    """격리 조건까지 유효할 때만 공개 캡슐 저장소와 서비스를 만든다."""
    if not settings.memory_capsule_configured:
        return None, None

    store = MemoryCapsuleIndexStore(settings.memory_capsule_index_db_path)
    try:
        repository = CouchDBMemoryCapsuleRepository(
            base_url=settings.memory_capsule_couchdb_url,
            database=settings.memory_capsule_couchdb_db_name,
            username=settings.memory_capsule_couchdb_user,
            password=settings.memory_capsule_couchdb_password,
            timeout_seconds=settings.memory_capsule_timeout_seconds,
        )
        embedding = LocalEmbeddingProvider(
            model_name=settings.embedding_model,
            cache_dir=settings.embedding_cache_dir or None,
        )
        service = MemoryCapsuleService(
            store=store,
            embedding_provider=embedding,
            repository=repository,
            ttl_seconds=settings.memory_capsule_ttl_seconds,
            approval_ttl_seconds=settings.memory_capsule_approval_ttl_seconds,
            sync_interval_seconds=settings.memory_capsule_sync_interval_seconds,
            rate_limit_per_action_per_minute=(
                settings.memory_capsule_rate_limit_per_action
            ),
        )
    except Exception:
        store.close()
        raise
    return store, service


def _build_tutorial_components() -> tuple[
    TutorialStore | None, TutorialService | None
]:
    """설정 경계가 완전할 때만 통합 튜토리얼 singleton을 만든다."""
    if not settings.hackathon_tutorial_configured:
        return None, None
    store = TutorialStore(
        settings.tutorial_db_path,
        hmac_secret=settings.tutorial_hmac_secret,
    )
    try:
        service = TutorialService.from_settings(settings, store=store)
    except Exception:
        store.close()
        raise
    return store, service


@asynccontextmanager
async def lifespan(app: FastAPI):
    global proactive_scheduler, auto_finetune_scheduler, _memory_store
    global _memory_capsule_store, _memory_capsule_service, _discord_channel
    global _tutorial_store, _tutorial_service

    app.state.llm_profile_store = LLMProfileStore(settings.llm_profiles_path)
    app.state.settings_api_token = settings.settings_api_token
    app.state.stt_provider = (
        FasterWhisperProvider(
            model_size=settings.stt_model_size,
            device=getattr(settings, "stt_device", "cpu"),
            compute_type=getattr(settings, "stt_compute_type", ""),
            vad_filter=getattr(settings, "stt_vad_filter", False),
            initial_prompt=getattr(settings, "stt_initial_prompt", ""),
        )
        if settings.enable_stt and settings.stt_provider == "faster-whisper"
        else None
    )

    # 기본 ChannelManager (store 없음) — Phase 8 봇 채널에서도 참조
    channel_manager = ChannelManager()

    # Phase 7: MemoryStore 초기화 + ChannelManager에 store 주입
    if settings.enable_finetune_scoring or settings.enable_auto_finetune or settings.enable_long_term_memory:
        _memory_store = MemoryStore(settings.memory_db_path)
        app.state.memory_store = _memory_store

    # Phase 6(완료): 장기 기억 채널 간 공유
    _long_term = None
    if settings.enable_long_term_memory and _memory_store is not None:
        _embedding = LocalEmbeddingProvider(
            model_name=settings.embedding_model,
            cache_dir=settings.embedding_cache_dir or None,
        )
        _long_term = LongTermMemory(store=_memory_store, embedding_provider=_embedding)
        app.state.long_term_memory = _long_term

    if _memory_store is not None or _long_term is not None:
        channel_manager = ChannelManager(store=_memory_store, long_term=_long_term)
        set_channel_manager(channel_manager)
        set_live2d_channel_manager(channel_manager)

    # T-027: 통합 튜토리얼은 하나의 SQLite/service/cleanup worker만 연다.
    _tutorial_store = None
    _tutorial_service = None
    app.state.tutorial_service = None
    _tutorial_store, _tutorial_service = _build_tutorial_components()
    if _tutorial_service is not None:
        app.state.tutorial_service = _tutorial_service
        await _tutorial_service.start()

    # T-025: 공개 기억은 개인 장기 기억과 별도 SQLite connection/file 및
    # 전용 CouchDB DB를 사용한다. 격리 조건을 포함한 설정이 완전하지 않으면
    # 어떤 캡슐 저장소도 열지 않는 fail-closed 경계다. 통합 튜토리얼이
    # 활성화되면 legacy capsule runtime은 만들지 않는다.
    _memory_capsule_store = None
    _memory_capsule_service = None
    app.state.memory_capsule_service = None
    if _tutorial_service is None:
        _memory_capsule_store, _memory_capsule_service = (
            _build_memory_capsule_components()
        )
    if _memory_capsule_service is not None:
        app.state.memory_capsule_service = _memory_capsule_service
        await _memory_capsule_service.start()

    # Phase 7: AutoFineTuneScheduler 시작
    if settings.enable_auto_finetune and _memory_store is not None:
        auto_finetune_scheduler = _build_auto_finetune_scheduler(_memory_store)
        await auto_finetune_scheduler.start()
        app.state.auto_finetune_scheduler = auto_finetune_scheduler

    # Phase 10: 페르소나 로드 — Orchestrator를 통해 persona.yaml 읽기
    _persona_prompt = Orchestrator().persona_prompt if settings.enable_persona else ""

    # Phase 9: ProactiveTriggerScheduler 시작
    if settings.enable_proactive:
        proactive_scheduler = _build_proactive_scheduler(persona_prompt=_persona_prompt)
        if _memory_store is not None:
            proactive_scheduler.set_memory_store(_memory_store)
        await proactive_scheduler.start()
        app.state.proactive_scheduler = proactive_scheduler

    # Phase 8: Discord 봇 채널 시작
    if settings.enable_discord and settings.discord_bot_token:
        _discord_channel = DiscordChannel(
            channel_manager=channel_manager,
            token=settings.discord_bot_token,
            allowed_channel_ids=settings.discord_allowed_channel_ids or [],
            proactive_scheduler=proactive_scheduler,
        )
        await _discord_channel.start()
        app.state.discord_channel = _discord_channel

    yield

    if _discord_channel is not None:
        await _discord_channel.stop()

    if proactive_scheduler is not None:
        await proactive_scheduler.stop()

    if auto_finetune_scheduler is not None:
        await auto_finetune_scheduler.stop()

    if _tutorial_service is not None:
        await _tutorial_service.stop()

    if _tutorial_store is not None:
        _tutorial_store.close()
    _tutorial_service = None
    _tutorial_store = None
    app.state.tutorial_service = None

    if _memory_capsule_service is not None:
        await _memory_capsule_service.stop()

    if _memory_capsule_store is not None:
        _memory_capsule_store.close()
    _memory_capsule_service = None
    _memory_capsule_store = None

    if _memory_store is not None:
        _memory_store.close()


app = FastAPI(title="Tanya Brain - AI Companion OS", lifespan=lifespan)

_cors_origins = settings.cors_origins if settings.cors_origins else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# T-017: 공개 배포 시 무인증 엔드포인트를 총량으로 보호한다.
# 심사위원이 로그인할 수 없으므로 인증 대신 한도를 건다.
_rate_limiter = RateLimiter(
    per_minute=settings.rate_limit_per_minute,
    daily_total=settings.rate_limit_daily_total,
    max_connections_per_client=settings.rate_limit_max_connections,
    enabled=settings.enable_rate_limit,
)
_stt_limiter = RateLimiter(
    per_minute=settings.rate_limit_stt_per_minute,
    daily_total=settings.rate_limit_daily_total,
    max_connections_per_client=settings.rate_limit_max_connections,
    enabled=settings.enable_rate_limit,
)
app.state.rate_limiter = _rate_limiter
app.state.stt_rate_limiter = _stt_limiter


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """HTTP 요청 한도. STT는 더 무거우므로 별도 한도를 쓴다."""
    if not settings.enable_rate_limit or is_public_web_request(request.url.path, request.method):
        return await call_next(request)

    key = client_key(request.headers, request.client.host if request.client else None)
    limiter = _stt_limiter if request.url.path.startswith("/stt/") else _rate_limiter
    decision = limiter.check(key)
    if not decision.allowed:
        return JSONResponse(
            status_code=429,
            content={"detail": decision.message},
            headers={"Retry-After": str(decision.retry_after)},
        )
    return await call_next(request)


app.include_router(websocket.router)
app.include_router(feedback_router_module.router)
app.include_router(live2d_router_module.router)
app.include_router(llm_settings_router_module.router)
app.include_router(stt_router_module.router)

# Phase 4: WebChat 정적 파일 서빙
_static_dir = Path(__file__).parent / "static"
_static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


@app.get("/webchat", include_in_schema=False)
def webchat_ui():
    """WebChat 브라우저 UI 제공."""
    return FileResponse(str(_static_dir / "webchat.html"))


def _status_payload():
    return {
        "status": "Tanya Brain is running",
        "model": settings.local_llm_model,
        "llm_provider": settings.llm_provider,
        "brain_port": settings.port,
        "features": {
            "persona": settings.enable_persona,
            "memory": settings.enable_memory,
            "emotion": settings.enable_emotion,
            "action_router": settings.enable_action_router,
            "security": settings.enable_security,
            "finetune_scoring": settings.enable_finetune_scoring,
            "auto_finetune": settings.enable_auto_finetune,
            "proactive": settings.enable_proactive,
            "stt": settings.enable_stt,
            "google_demo": settings.google_demo_configured,
            "memory_capsule": settings.memory_capsule_configured,
            "hackathon_tutorial": settings.hackathon_tutorial_configured,
        },
    }


_web_client_dir = (
    Path(settings.web_client_dir).expanduser()
    if settings.web_client_dir
    else default_web_client_dir()
)
install_web_client(app, dist_dir=_web_client_dir, status_payload=_status_payload)


if __name__ == "__main__":
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
