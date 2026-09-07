import ipaddress
import logging
from pathlib import Path
from urllib.parse import urlparse

from pydantic_settings import BaseSettings
from pydantic import Field, model_validator

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    # Server
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=8098)
    # 비우면 저장소의 packages/client/dist를 사용한다.
    web_client_dir: str = Field(default="")

    # LLM Provider 선택 (gemini | openai | claude | vllm | ollama)
    llm_provider: str = Field(default="ollama")

    # LLM - Gemini
    google_api_key: str = Field(default="")
    gemini_model_name: str = Field(default="gemini-2.5-flash-preview-05-20")

    # LLM - OpenAI
    openai_api_key: str = Field(default="")
    openai_model_name: str = Field(default="gpt-4o")

    # LLM - Claude
    anthropic_api_key: str = Field(default="")
    claude_model_name: str = Field(default="claude-sonnet-4-20250514")

    # LLM - Ollama (Local)
    ollama_base_url: str = Field(default="http://localhost:11434")
    # 사고를 생성하는 모델은 답하기 전에 수백 토큰을 더 만든다. 2026-09-06 운영 모델
    # 실측에서 같은 질문이 사고 켜짐 3.21초 / 꺼짐 0.57초였다. 대화형 동반자에게는
    # 지연이 더 비싸므로 기본값을 끈다. 사고를 지원하지 않는 모델에도 안전하게 전달된다.
    ollama_think: bool = Field(default=False)
    # Ollama 기본 num_ctx는 4096이다. 값을 보내지 않으면 128K 모델도 4K만 쓴다.
    # 2026-09-06 운영 GPU 실측: 단독 상주 시 4096에서 4,141 MiB, 65,536에서 4,561 MiB,
    # 131,072에서도 5,009 MiB로 전 구간 100% GPU였다. 8 GiB 카드에서 65,536은 여유가 있고
    # STT·TTS 이전 여지도 3 GiB 이상 남는다. 더 작은 장비는 OLLAMA_NUM_CTX로 낮춘다.
    ollama_num_ctx: int = Field(default=65_536, ge=512, le=131_072)
    local_llm_model: str = Field(default="qwen2.5:7b")

    # 화면 이미지는 일반 task provider와 분리된 local-only 경로만 허용한다.
    enable_vision: bool = Field(default=False)
    vision_provider: str = Field(default="ollama")
    vision_base_url: str = Field(default="")
    vision_model: str = Field(default="")

    # TTS Provider 선택 (기본값은 GPU를 사용하지 않는 한국어 edge-tts)
    tts_provider: str = Field(default="edge-tts")

    # TTS - Voice
    tts_voice: str = Field(default="ko-KR-SunHiNeural")
    fish_speech_url: str = Field(default="http://127.0.0.1:8080/v1/tts")
    fish_speech_reference_id: str = Field(default="tanya")
    fish_speech_timeout_seconds: float = Field(default=30.0)
    aivis_speech_url: str = Field(default="http://127.0.0.1:10101")
    aivis_speech_style_id: int = Field(default=1878365379)
    aivis_speech_timeout_seconds: float = Field(default=30.0)
    gpt_sovits_url: str = Field(default="http://127.0.0.1:9881/tts")
    gpt_sovits_reference_audio_path: str = Field(default="")
    gpt_sovits_prompt_text: str = Field(
        default=""
    )
    gpt_sovits_timeout_seconds: float = Field(default=45.0)
    gpt_sovits_seed: int = Field(default=12345)
    gpt_sovits_reference_metadata_path: str = Field(default="")
    tts_target_language: str = Field(default="")

    # Memory
    memory_short_term_max_turns: int = Field(default=20)
    memory_db_path: str = Field(default="tanya_memory.db")
    enable_obsidian_sync: bool = Field(default=False)
    couchdb_url: str = Field(default="http://127.0.0.1:5984")
    couchdb_user: str = Field(default="")
    couchdb_password: str = Field(default="")
    couchdb_db_name: str = Field(default="demo_notes")

    # 공개 기억 캡슐. 개인 Obsidian CouchDB와 DB·SQLite 파일을 공유하지 않는다.
    enable_memory_capsule: bool = Field(default=False)
    memory_capsule_index_db_path: str = Field(
        default="tanya_public_memory_capsules.db"
    )
    memory_capsule_couchdb_url: str = Field(default="")
    memory_capsule_couchdb_user: str = Field(default="")
    memory_capsule_couchdb_password: str = Field(default="")
    memory_capsule_couchdb_db_name: str = Field(
        default="tanya_public_memory_capsules"
    )
    memory_capsule_ttl_seconds: int = Field(default=1800, ge=60, le=86400)
    memory_capsule_approval_ttl_seconds: int = Field(default=120, ge=15, le=600)
    memory_capsule_sync_interval_seconds: float = Field(
        default=5.0, ge=1.0, le=60.0
    )
    memory_capsule_timeout_seconds: float = Field(default=5.0, ge=1.0, le=30.0)
    memory_capsule_rate_limit_per_action: int = Field(default=10, ge=1, le=60)

    # 공개 해커톤 통합 튜토리얼. 개인 기억·T-025 캡슐과 SQLite를 공유하지 않는다.
    enable_hackathon_tutorial: bool = Field(default=False)
    tutorial_db_path: str = Field(default="tutorial.sqlite")
    tutorial_hmac_secret: str = Field(default="", repr=False)
    tutorial_ollama_base_url: str = Field(default="")
    tutorial_ollama_model: str = Field(default="")
    tutorial_ollama_timeout_seconds: float = Field(default=60.0, ge=1.0, le=180.0)
    tutorial_cleanup_poll_seconds: float = Field(default=30.0, ge=5.0, le=300.0)

    # Feature Flags
    enable_persona: bool = Field(default=True)
    enable_memory: bool = Field(default=True)
    enable_emotion: bool = Field(default=True)
    enable_action_router: bool = Field(default=False)
    enable_security: bool = Field(default=False)

    # Security
    security_secret_key: str = Field(default="tanya-default-secret-change-in-production")
    security_token_expires: int = Field(default=3600)  # 초
    enable_long_term_memory: bool = Field(default=False)
    enable_compaction: bool = Field(default=False)
    session_soft_threshold: int = Field(default=15)
    enable_wire_protocol_v2: bool = Field(default=False)

    # Phase 3.7: 일상/작업 모드 전환
    casual_llm_provider: str = Field(default="ollama")
    casual_llm_model: str = Field(default="")
    casual_llm_base_url: str = Field(default="")
    casual_llm_api_key: str = Field(default="")
    task_llm_provider: str = Field(default="gemini")
    task_llm_model: str = Field(default="")
    task_llm_base_url: str = Field(default="")
    task_llm_api_key: str = Field(default="")
    llm_profiles_path: str = Field(default="llm_profiles.json")
    settings_api_token: str = Field(default="")
    vllm_base_url: str = Field(default="http://localhost:8081/v1")
    mode_auto_detect: bool = Field(default=True)
    mode_task_threshold: float = Field(default=0.7)

    # Embedding (Phase 3.1)
    embedding_provider: str = Field(default="local")
    embedding_model: str = Field(default="paraphrase-multilingual-MiniLM-L12-v2")
    embedding_cache_dir: str = Field(default="")

    # STT Provider (Phase 5-C)
    stt_provider: str = Field(default="faster-whisper")
    enable_stt: bool = Field(default=False)

    # T-017: 공개 배포용 요청 제한. 내부망·데스크톱에는 필요 없으므로 기본은 꺼짐이다.
    enable_rate_limit: bool = Field(default=False)
    rate_limit_per_minute: int = Field(default=30)
    rate_limit_daily_total: int = Field(default=2000)
    rate_limit_max_connections: int = Field(default=3)
    rate_limit_stt_per_minute: int = Field(default=5)
    stt_model_size: str = Field(default="small")
    # STT 실행 장치. 기본은 CPU다. GPU로 옮기려면 Brain venv에 CUDA 런타임이
    # 있어야 하고(2026-09-06 기준 libcublas 부재) VRAM을 Ollama·TTS와 나눠야 한다.
    stt_device: str = Field(default="cpu")
    # 빈 값이면 device에 맞는 기본값을 쓴다. cpu는 int8, cuda는 float16.
    stt_compute_type: str = Field(default="")
    # Silero VAD로 무음·잡음 구간을 잘라낸 뒤 Whisper에 넣는다. 무음 구간에서
    # 없는 말을 지어내는 hallucination을 줄이고 처리량도 준다. 잘못 잡으면
    # 작게 시작하는 발화의 첫 음절이 잘릴 수 있어 기본값은 측정 뒤 정한다.
    stt_vad_filter: bool = Field(default=False)
    # 공개 튜토리얼은 어휘가 고정돼 있다. 그 문장들을 decoding 힌트로 주면 인식률이
    # 크게 오른다. 2026-09-06 실측(합성음 5문장): 힌트 없음 1/5 -> 힌트 있음 4/5.
    # `이 1점으로 등록해줘` -> `이 일정으로 등록해줘`, `지금이자죠` -> `지금 잊어줘`가
    # 이 힌트로 교정됐다. 일반 대화에 쓰려면 빈 값으로 두면 된다.
    stt_initial_prompt: str = Field(
        default=(
            "체험 시작할게. 기본으로. 설정 미리보기. 이대로 저장해줘. "
            "캘린더 해볼게. 건너뛸게. 이 일정으로 등록해줘. 등록하지 마. "
            "할일도 만들어줘. 답변 보여줘. 실행 결과 보여줘. 지금 잊어줘. "
            "알림은 10분 전. 정보는 구체적으로."
        )
    )

    # 웹 체험판 전용 Google 데모 계정. 개인 OAuth 토큰과 완전히 분리한다.
    enable_google_demo: bool = Field(default=False)
    google_demo_client_id: str = Field(default="")
    google_demo_client_secret: str = Field(default="")
    google_demo_refresh_token: str = Field(default="")
    google_demo_calendar_id: str = Field(default="primary")
    google_demo_task_list_id: str = Field(default="@default")
    google_demo_receipts_path: str = Field(default="google_demo_receipts.json")
    google_demo_timeout_seconds: float = Field(default=10.0)

    # Persona
    persona_config_path: str = Field(default="config/persona.yaml")

    # Phase 7: 파인튜닝 파이프라인
    enable_finetune_scoring: bool = Field(default=False)
    finetune_candidate_threshold: float = Field(default=0.6)
    enable_auto_finetune: bool = Field(default=False)
    finetune_trigger_count: int = Field(default=500)
    finetune_schedule_hour: int = Field(default=2)   # 새벽 2시 시작
    finetune_output_dir: str = Field(default="finetune_data")

    # Phase 8: 외부 봇 채널
    enable_discord: bool = Field(default=False)
    discord_bot_token: str = Field(default="")
    discord_allowed_channel_ids: list[int] = Field(default=[])

    # Phase 9: Proactive Trigger
    enable_proactive: bool = Field(default=False)
    proactive_max_daily: int = Field(default=5)
    proactive_quiet_start: int = Field(default=2)   # 야간 조용 모드 시작 (시)
    proactive_quiet_end: int = Field(default=7)     # 야간 조용 모드 종료 (시)

    # Phase 6-B: CORS 화이트리스트
    # 비어있으면 ["*"] 폴백 (개발 편의 + 하위 호환)
    # 예: ["http://localhost:3000", "http://192.168.1.100:8080"]
    cors_origins: list[str] = Field(default_factory=list)

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def _warn_default_secret_key(self) -> "Settings":
        if self.vision_provider.strip().casefold() != "ollama":
            raise ValueError("VISION_PROVIDER는 local Ollama만 허용합니다.")
        if self.enable_vision:
            if not self.vision_base_url.strip() or not self.vision_model.strip():
                raise ValueError(
                    "화면 분석을 켜려면 VISION_BASE_URL과 VISION_MODEL이 필요합니다."
                )
            if not _is_local_vision_url(self.vision_base_url):
                raise ValueError(
                    "VISION_BASE_URL은 loopback 또는 사설망 endpoint여야 합니다."
                )
        if (
            self.enable_security
            and self.security_secret_key == "tanya-default-secret-change-in-production"
        ):
            logger.warning(
                "보안이 활성화되었지만 기본 시크릿 키를 사용 중입니다. "
                ".env에서 SECURITY_SECRET_KEY를 변경하세요."
            )
        if self.enable_google_demo and not self.google_demo_configured:
            logger.warning(
                "Google 데모가 활성화되었지만 OAuth 환경 변수 세 개가 모두 "
                "설정되지 않아 웹 Google 쓰기를 비활성화합니다."
            )
        if self.enable_memory_capsule and not self.memory_capsule_configured:
            logger.warning(
                "기억 캡슐이 활성화되었지만 전용 CouchDB 설정이 없거나 개인 "
                "Obsidian DB와 이름이 같아 기능을 비활성화합니다."
            )
        if self.enable_hackathon_tutorial and not self.hackathon_tutorial_configured:
            logger.warning(
                "해커톤 튜토리얼 설정이 불완전합니다. 전용 SQLite·HMAC secret·"
                "local Ollama·Google 데모 계정 경계를 확인하세요."
            )
        return self

    @property
    def vision_configured(self) -> bool:
        return bool(
            self.enable_vision
            and self.vision_provider.strip().casefold() == "ollama"
            and self.vision_base_url.strip()
            and self.vision_model.strip()
            and _is_local_vision_url(self.vision_base_url)
        )

    @property
    def google_demo_configured(self) -> bool:
        return bool(
            self.enable_google_demo
            and self.google_demo_client_id.strip()
            and self.google_demo_client_secret.strip()
            and self.google_demo_refresh_token.strip()
        )

    @property
    def memory_capsule_configured(self) -> bool:
        try:
            index_is_separate = (
                Path(self.memory_capsule_index_db_path).expanduser().resolve()
                != Path(self.memory_db_path).expanduser().resolve()
            )
        except (OSError, RuntimeError):
            index_is_separate = False
        return bool(
            self.enable_memory_capsule
            and self.memory_capsule_couchdb_url.strip()
            and self.memory_capsule_couchdb_user.strip()
            and self.memory_capsule_couchdb_password.strip()
            and self.memory_capsule_couchdb_db_name.strip()
            and self.memory_capsule_index_db_path.strip()
            and index_is_separate
            and self.memory_capsule_couchdb_db_name.strip()
            .casefold()
            != self.couchdb_db_name.strip().casefold()
        )

    @property
    def hackathon_tutorial_configured(self) -> bool:
        try:
            tutorial_path = Path(self.tutorial_db_path).expanduser().resolve()
            separate_database = tutorial_path not in {
                Path(self.memory_db_path).expanduser().resolve(),
                Path(self.memory_capsule_index_db_path).expanduser().resolve(),
            }
        except (OSError, RuntimeError):
            separate_database = False
        return bool(
            self.enable_hackathon_tutorial
            and self.tutorial_db_path.strip()
            and separate_database
            and len(self.tutorial_hmac_secret.encode("utf-8")) >= 32
            and self.tutorial_ollama_base_url.strip()
            and _is_local_vision_url(self.tutorial_ollama_base_url)
            and self.tutorial_ollama_model.strip()
            and self.google_demo_configured
        )


_LOCAL_VISION_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "10.0.0.0/8",
        "127.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def _is_local_vision_url(value: str) -> bool:
    try:
        parsed = urlparse(value.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            return False
        if parsed.hostname.casefold() == "localhost":
            return True
        address = ipaddress.ip_address(parsed.hostname)
        return any(address in network for network in _LOCAL_VISION_NETWORKS)
    except ValueError:
        return False


# 싱글턴 인스턴스
_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
