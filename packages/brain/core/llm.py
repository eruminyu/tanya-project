"""LLM 관리자 — Provider 기반 Multi-LLM 지원.

Settings의 llm_provider 설정에 따라 적절한 Provider를 선택하고,
실패 시 Ollama 로컬로 자동 폴백한다.
"""

import logging
import typing

from config.settings import get_settings
from config.llm_profiles import LLMProfile, LLMProfileStore
from core.providers.llm_base import LLMProvider
from core.providers.gemini import GeminiProvider
from core.providers.openai_provider import OpenAIProvider
from core.providers.claude import ClaudeProvider
from core.providers.ollama import OllamaProvider
from core.mode import ModeClassifier, TanyaMode
from core.vision import VisionAnalysis, VisionUnavailableError

logger = logging.getLogger(__name__)


class LLMManager:
    """Multi-LLM 관리자.

    인터페이스(chat, analyze_image)는 기존과 동일하게 유지하여
    Orchestrator 및 기존 테스트와의 하위 호환성을 보장한다.
    """

    PROVIDER_MAP = {
        "gemini": "_create_gemini",
        "openai": "_create_openai",
        "claude": "_create_claude",
        "ollama": "_create_ollama",
        "vllm": "_create_vllm",
        "openai-compatible": "_create_openai_compatible",
    }
    _LOCAL_PROVIDERS = frozenset({"ollama", "vllm"})
    _CLOUD_PROVIDERS = frozenset({"gemini", "openai", "claude"})
    _ROUTE_PROVIDER_ATTR = "_tanya_route_provider"

    def __init__(self):
        settings = get_settings()
        self._settings = settings
        self._provider_name = settings.llm_provider
        self._primary = self._create_provider(self._provider_name, settings)
        self._fallback = self._create_ollama(settings)
        self._vision_enabled = getattr(settings, "enable_vision", False) is True
        self._vision_provider: OllamaProvider | None = None
        if self._vision_enabled and getattr(settings, "vision_configured", False):
            self._vision_provider = OllamaProvider(
                base_url=settings.vision_base_url,
                model_name=settings.vision_model,
            )

        # Phase 3.7: 모드별 Provider 캐시
        saved_profiles = self._load_saved_profiles(settings)
        casual_profile = saved_profiles.casual if saved_profiles else None
        task_profile = saved_profiles.task if saved_profiles else None
        self._casual_provider: LLMProvider | None = self._create_provider(
            casual_profile.provider
            if casual_profile
            else getattr(settings, "casual_llm_provider", "ollama"),
            settings,
            model_name=self._profile_setting(
                casual_profile, settings, "casual_llm_model"
            ),
            base_url=self._profile_setting(
                casual_profile, settings, "casual_llm_base_url"
            ),
            api_key=self._profile_setting(
                casual_profile, settings, "casual_llm_api_key"
            ),
        )
        self._task_provider: LLMProvider | None = self._create_provider(
            task_profile.provider
            if task_profile
            else getattr(settings, "task_llm_provider", self._provider_name),
            settings,
            model_name=self._profile_setting(
                task_profile, settings, "task_llm_model"
            ),
            base_url=self._profile_setting(
                task_profile, settings, "task_llm_base_url"
            ),
            api_key=self._profile_setting(
                task_profile, settings, "task_llm_api_key"
            ),
        )
        self._current_mode: TanyaMode = TanyaMode.CASUAL
        self._auto_detect: bool = bool(getattr(settings, "mode_auto_detect", True))
        self._mode_classifier = ModeClassifier()

        if self._primary and self._primary.is_available():
            logger.info("LLM Provider: %s ✓", self._primary.provider_name)
        elif self._primary:
            logger.warning(
                "LLM Provider: %s 사용 불가, Ollama 폴백",
                self._primary.provider_name,
            )
        else:
            logger.warning("LLM Provider: Ollama 폴백 (primary 없음)")

    def _create_provider(
        self,
        name: str,
        settings,
        *,
        model_name: str = "",
        base_url: str = "",
        api_key: str = "",
    ) -> LLMProvider | None:
        """설정에 따라 LLM Provider를 생성한다."""
        factory_name = self.PROVIDER_MAP.get(name)
        if factory_name:
            factory = getattr(self, factory_name)
            provider = factory(
                settings,
                model_name=model_name,
                base_url=base_url,
                api_key=api_key,
            )
            # vLLM과 OpenAI-compatible endpoint는 같은 OpenAI SDK adapter를
            # 사용하지만, 실제 실행 경로까지 OpenAI cloud인 것은 아니다.
            # 설정상의 provider identity를 adapter에 보존해 경로 공개 시 쓴다.
            if provider is not None:
                try:
                    setattr(provider, self._ROUTE_PROVIDER_ATTR, name)
                except (AttributeError, TypeError):
                    logger.debug(
                        "LLM provider route identity를 기록하지 못했습니다: %s",
                        name,
                    )
            return provider
        logger.warning("알 수 없는 LLM Provider: %s", name)
        return None

    @staticmethod
    def _profile_value(settings, field_name: str) -> str:
        """실제 문자열로 설정된 역할별 override만 반환한다."""
        value = getattr(settings, field_name, "")
        return value if isinstance(value, str) else ""

    @classmethod
    def _profile_setting(
        cls,
        profile: LLMProfile | None,
        settings,
        field_name: str,
    ) -> str:
        if profile is not None:
            attribute_name = field_name.rsplit("_llm_", maxsplit=1)[-1]
            return getattr(profile, attribute_name)
        return cls._profile_value(settings, field_name)

    @staticmethod
    def _load_saved_profiles(settings):
        path = getattr(settings, "llm_profiles_path", "")
        if not isinstance(path, str) or not path:
            return None
        try:
            return LLMProfileStore(path).load()
        except (OSError, ValueError) as error:
            logger.warning("저장된 LLM 프로필을 읽지 못했습니다: %s", error)
            return None

    @staticmethod
    def _create_gemini(
        settings, *, model_name: str = "", api_key: str = "", **_kwargs
    ) -> GeminiProvider:
        return GeminiProvider(
            api_key=api_key or settings.google_api_key,
            model_name=model_name or settings.gemini_model_name,
        )

    @staticmethod
    def _create_openai(
        settings,
        *,
        model_name: str = "",
        base_url: str = "",
        api_key: str = "",
    ) -> OpenAIProvider:
        return OpenAIProvider(
            api_key=api_key or settings.openai_api_key,
            model_name=model_name or settings.openai_model_name,
            base_url=base_url or None,
        )

    @staticmethod
    def _create_claude(
        settings, *, model_name: str = "", api_key: str = "", **_kwargs
    ) -> ClaudeProvider:
        return ClaudeProvider(
            api_key=api_key or settings.anthropic_api_key,
            model_name=model_name or settings.claude_model_name,
        )

    @staticmethod
    def _create_ollama(
        settings, *, model_name: str = "", base_url: str = "", **_kwargs
    ) -> OllamaProvider:
        return OllamaProvider(
            base_url=base_url or settings.ollama_base_url,
            model_name=model_name or settings.local_llm_model,
            think=getattr(settings, "ollama_think", False),
            num_ctx=getattr(settings, "ollama_num_ctx", 0),
        )

    @staticmethod
    def _create_vllm(
        settings,
        *,
        model_name: str = "",
        base_url: str = "",
        api_key: str = "",
    ) -> LLMProvider:
        from core.providers.openai_provider import OpenAIProvider
        return OpenAIProvider(
            api_key=api_key or "vllm-dummy",
            model_name=model_name or settings.local_llm_model,
            base_url=base_url
            or getattr(settings, "vllm_base_url", "http://localhost:8000/v1"),
        )

    @staticmethod
    def _create_openai_compatible(
        settings,
        *,
        model_name: str = "",
        base_url: str = "",
        api_key: str = "",
    ) -> OpenAIProvider:
        """OpenAI API 규약을 구현한 로컬·상용 endpoint를 생성한다."""
        return OpenAIProvider(
            api_key=api_key,
            model_name=model_name or settings.openai_model_name,
            base_url=base_url or None,
        )

    def _get_active_provider(self) -> LLMProvider:
        """사용 가능한 Provider를 반환한다 (primary → fallback)."""
        if self._primary and self._primary.is_available():
            return self._primary
        return self._fallback

    def _resolve_conversation_route(
        self,
        user_input: str,
    ) -> tuple[TanyaMode, LLMProvider, bool]:
        """모드와 실제 호출할 provider를 한 번에 결정한다."""
        mode = (
            self._mode_classifier.classify(user_input)
            if self._auto_detect
            else self._current_mode
        )
        provider = self.select_provider(mode)
        if provider.is_available():
            return mode, provider, False
        return mode, self._fallback, True

    def _get_conversation_provider(self, user_input: str) -> LLMProvider:
        """자동 분류 또는 수동 모드에 맞는 사용 가능한 provider를 반환한다."""
        mode, provider, fallback = self._resolve_conversation_route(user_input)
        route = self._describe_resolved_route(mode, provider, fallback)
        if not fallback:
            logger.info(
                "LLM route: mode=%s provider=%s",
                mode.value,
                route["provider"],
            )
            return provider
        logger.warning(
            "LLM route: mode=%s configured provider unavailable, %s fallback",
            mode.value,
            route["provider"],
        )
        return provider

    def describe_conversation_route(self, user_input: str) -> dict[str, object]:
        """클라이언트에 공개해도 안전한 실제 LLM 선택 경로를 반환한다."""
        mode, provider, fallback = self._resolve_conversation_route(user_input)
        return self._describe_resolved_route(mode, provider, fallback)

    @classmethod
    def _describe_resolved_route(
        cls,
        mode: TanyaMode,
        provider: LLMProvider,
        fallback: bool,
    ) -> dict[str, object]:
        """이미 결정된 provider의 논리적 identity와 실행 위치를 설명한다."""
        configured_name = getattr(provider, cls._ROUTE_PROVIDER_ATTR, None)
        if isinstance(configured_name, str) and configured_name.strip():
            provider_name = configured_name.strip().lower()
        else:
            raw_name = getattr(provider, "provider_name", "unknown")
            provider_name = (
                raw_name.strip().lower()
                if isinstance(raw_name, str) and raw_name.strip()
                else "unknown"
            )
        if provider_name in cls._LOCAL_PROVIDERS:
            execution = "local"
        elif provider_name in cls._CLOUD_PROVIDERS:
            execution = "cloud"
        else:
            execution = "custom"
        return {
            "mode": mode.value,
            "provider": provider_name,
            "execution": execution,
            "fallback": fallback,
        }

    async def chat(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> str:
        """대화 메시지를 처리하고 응답 텍스트를 반환한다.

        Primary Provider 실패 시 Ollama 폴백.
        인터페이스는 기존과 동일.
        """
        provider = self._get_conversation_provider(user_input)
        try:
            return await provider.chat(user_input, system_prompt, history)
        except Exception as e:
            if provider is not self._fallback:
                logger.warning("%s 오류: %s, Ollama 폴백", provider.provider_name, e)
                return await self._fallback.chat(
                    user_input, system_prompt, history
                )
            return f"LLM 오류: {e}"

    async def chat_stream(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
        on_route_change: typing.Callable[[dict[str, object]], None] | None = None,
    ) -> typing.AsyncGenerator[str, None]:
        """스트리밍 형태로 응답 텍스트를 반환한다.

        기존 문자열 스트림 계약은 유지한다. 선택적 callback에는 이 호출에서
        한 번만 결정한 최초 경로와 런타임 폴백 경로를 순서대로 알린다.
        """
        mode, provider, fallback = self._resolve_conversation_route(user_input)
        resolved_route = self._describe_resolved_route(mode, provider, fallback)
        if fallback:
            logger.warning(
                "LLM route: mode=%s configured provider unavailable, %s fallback",
                mode.value,
                resolved_route["provider"],
            )
        else:
            logger.info(
                "LLM route: mode=%s provider=%s",
                mode.value,
                resolved_route["provider"],
            )
        if on_route_change is not None:
            try:
                on_route_change(resolved_route)
            except Exception:
                logger.warning(
                    "초기 LLM 경로 callback 처리 실패",
                    exc_info=True,
                )
        try:
            async for chunk in provider.chat_stream(user_input, system_prompt, history):
                yield chunk
        except Exception as e:
            if provider is not self._fallback:
                logger.warning("%s 스트리밍 오류: %s, Ollama 폴백", provider.provider_name, e)
                if on_route_change is not None:
                    route = self._describe_resolved_route(
                        mode,
                        self._fallback,
                        True,
                    )
                    try:
                        on_route_change(route)
                    except Exception:
                        logger.warning(
                            "LLM 경로 변경 callback 처리 실패",
                            exc_info=True,
                        )
                async for chunk in self._fallback.chat_stream(user_input, system_prompt, history):
                    yield chunk
            else:
                yield " 거절할게... 오류가 났어."

    async def chat_casual(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> str:
        """분류를 거치지 않고 일상 모드 provider로 고정 호출한다 (ADR-0007).

        선제 발화 전용 경로다. `chat()`은 프롬프트 길이·키워드로 작업 모드를
        골라 클라우드 provider로 보낼 수 있는데, 사용자가 요청한 적 없는
        발화의 재료(일정 제목 등)가 그 경로로 나가서는 안 된다.
        """
        provider = self._casual_provider
        if provider is None or not provider.is_available():
            provider = self._fallback
        try:
            return await provider.chat(user_input, system_prompt, history)
        except Exception as e:
            if provider is not self._fallback:
                logger.warning(
                    "선제 발화 %s 오류: %s, Ollama 폴백", provider.provider_name, e
                )
                return await self._fallback.chat(user_input, system_prompt, history)
            return f"LLM 오류: {e}"

    async def analyze_image(
        self, base64_image: str, system_prompt: str = ""
    ) -> VisionAnalysis:
        """명시된 local Ollama vision만 호출하고 실패 시 닫는다."""
        provider = self._vision_provider
        if (
            not self._vision_enabled
            or provider is None
            or not isinstance(base64_image, str)
            or not base64_image.strip()
        ):
            raise VisionUnavailableError()
        try:
            if not provider.is_available():
                raise VisionUnavailableError()
            content = await provider.analyze_image(base64_image, system_prompt)
        except VisionUnavailableError:
            raise
        except Exception:
            logger.warning("로컬 vision provider 요청 실패")
            raise VisionUnavailableError() from None
        if not content.strip():
            raise VisionUnavailableError()
        return VisionAnalysis.local_ollama(content, provider.model_name)

    @property
    def active_provider_name(self) -> str:
        """현재 사용 중인 Provider 이름."""
        provider = self._get_active_provider()
        return str(
            self._describe_resolved_route(
                self._current_mode,
                provider,
                False,
            )["provider"]
        )

    # ------------------------------------------------------------------
    # Phase 3.7: 모드 기반 Provider 선택
    # ------------------------------------------------------------------

    def select_provider(self, mode: TanyaMode) -> LLMProvider:
        """모드에 맞는 Provider를 반환한다."""
        if mode == TanyaMode.CASUAL and self._casual_provider:
            return self._casual_provider
        if mode == TanyaMode.TASK and self._task_provider:
            return self._task_provider
        return self._get_active_provider()

    def set_mode(self, mode: TanyaMode) -> None:
        """수동으로 모드를 전환하고 auto_detect를 비활성화한다."""
        self._current_mode = mode
        self._auto_detect = False

    @property
    def current_mode(self) -> TanyaMode:
        return self._current_mode

    @property
    def auto_detect(self) -> bool:
        return self._auto_detect
