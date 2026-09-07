import logging
import os
import asyncio
import uuid
from datetime import datetime
from typing import Any, AsyncIterator
import yaml

from config.settings import get_settings
from core.llm import LLMManager
from core.audio import generate_tts_base64, TTSManager
from core.tts_text_preprocessor import TTS_SENTENCE_END_PATTERN, prepare_tts_text
from core.tts_text_translation import TtsTextTranslationError, TtsTextTranslator
from core.schemas import UserMessage, TanyaResponse, EmotionState, EmotionType
from core.vision import VisionAnalysis, VisionUnavailableError
from core.approval import ApprovalStore
from action.intent import IntentClassifier
from action.router import ActionRouter
from action.google_write_draft import GoogleWriteDraftExtractor
from action.google_demo import GoogleDemoError, GoogleDemoService
from action.skills.base import SkillRegistry
from security.policy import SecurityManager
from memory.engine import MemoryEngine
from emotion.engine import EmotionEngine

logger = logging.getLogger(__name__)

# LLM 오류 시 반환할 페르소나 일관성 있는 fallback 메시지
_FALLBACK_MESSAGE = "잠깐, 생각을 정리 중이야... 조금만 기다려줘. ❤️"
_FALLBACK_MARKER = "잠깐, 생각을 정리 중이야"
_QUALITY_USER_LEN_RANGE = (5, 100)
_QUALITY_ASST_LEN_RANGE = (20, 500)


def _is_public_llm_route(route: Any) -> bool:
    """웹 클라이언트에 전달 가능한 LLM 경로 payload인지 확인한다."""
    return (
        isinstance(route, dict)
        and route.get("mode") in {"casual", "task"}
        and route.get("execution") in {"local", "cloud", "custom"}
        and isinstance(route.get("provider"), str)
        and isinstance(route.get("fallback"), bool)
    )


class Orchestrator:
    """타냐의 중앙 파이프라인 코디네이터.

    모든 요청은 이 클래스를 통해 처리된다.
    Feature Flag에 따라 각 시스템(페르소나, 메모리, 감정 등)을 활성화/비활성화한다.
    """

    def __init__(self):
        self._settings = get_settings()
        self._llm = LLMManager()
        self._tts_text_translator = TtsTextTranslator(
            self._llm,
            target_language=self._settings.tts_target_language,
        )
        self._memory = MemoryEngine()
        self._emotion = EmotionEngine() if self._settings.enable_emotion else None
        self._persona_prompt = self._load_persona()
        self._last_vision_analysis = ""
        self._last_vision_route: dict[str, str | bool] | None = None
        self._long_term = None  # Phase 3.5: enable_long_term_memory 시 주입
        self._store = None      # Phase 7: enable_finetune_scoring 시 주입

        # Phase 4-B: ActionRouter 연동
        _registry = SkillRegistry()
        _security = SecurityManager() if self._settings.enable_security else None
        self._intent_classifier = IntentClassifier()
        self._action_router = ActionRouter(registry=_registry, security_manager=_security)
        self._approval_store = ApprovalStore()
        self._google_write_drafts = GoogleWriteDraftExtractor(self._llm)
        self._google_demo_approvals = ApprovalStore(ttl_seconds=300)
        self._google_demo = GoogleDemoService.from_settings(self._settings)

    def prepare_google_draft(self, draft: dict[str, Any]) -> dict[str, Any]:
        """초안을 실행 환경에 맞는 승인 계약으로 감싼다.

        데스크톱은 기존 Rust/Windows Credential Manager 실행 경로를 유지해야 하므로
        서버 데모 계정이 꺼져 있으면 초안을 전혀 바꾸지 않는다. 공개 서버에서 데모
        계정이 완전히 설정된 경우에만 세션 Orchestrator의 1회용 토큰을 붙인다.
        """
        prepared = dict(draft)
        if (
            getattr(
                getattr(self, "_settings", None),
                "hackathon_tutorial_configured",
                False,
            )
            is True
        ):
            # 통합 공개 튜토리얼은 SQLite 승인 상태기계만 사용한다. 원본 초안은
            # 그대로 반환해 Tauri의 native Credential Manager 실행은 유지한다.
            return prepared
        if not self._google_demo.configured:
            return prepared

        request_id = str(uuid.uuid4())
        approval_token = self._google_demo_approvals.create(
            skill="google_demo_write",
            payload={"request_id": request_id, "draft": prepared},
        )
        return {
            **prepared,
            "requestId": request_id,
            "approvalToken": approval_token,
            "executor": "brain",
        }

    def _load_persona(self) -> str:
        """persona.yaml을 읽어서 시스템 프롬프트 문자열로 변환한다."""
        if not self._settings.enable_persona:
            return ""

        config_path = self._settings.persona_config_path
        # main.py 기준 상대 경로 해석
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        full_path = os.path.join(base_dir, config_path)

        try:
            with open(full_path, "r", encoding="utf-8") as f:
                persona = yaml.safe_load(f)
        except FileNotFoundError:
            logger.warning("Persona config not found at %s", full_path)
            return ""

        parts = []
        parts.append(f"# {persona.get('name', 'Tanya')}")
        parts.append("")

        if identity := persona.get("identity"):
            parts.append("## 정체성")
            parts.append(identity.strip())
            parts.append("")

        if personality := persona.get("personality"):
            parts.append("## 성격")
            for key, value in personality.items():
                parts.append(f"- {key}: {value}")
            parts.append("")

        if rules := persona.get("rules"):
            parts.append("## 규칙")
            for rule in rules:
                parts.append(f"- {rule}")
            parts.append("")

        if values := persona.get("core_values"):
            parts.append("## 핵심 가치")
            for value in values:
                parts.append(f"- {value}")
            parts.append("")

        if goal := persona.get("goal"):
            parts.append("## 목표")
            parts.append(goal.strip())

        return "\n".join(parts)

    async def handle_message(self, raw_data: dict) -> TanyaResponse | None:
        """수신된 메시지를 처리하고 응답을 생성한다.

        Args:
            raw_data: 클라이언트로부터 받은 JSON 데이터

        Returns:
            TanyaResponse 또는 None (vision 메시지는 응답 없음)
        """
        msg = self._parse_message(raw_data)

        # Vision 메시지 처리
        if msg.type == "vision":
            self._last_vision_analysis = ""
            self._last_vision_route = None
            if not msg.image:
                raise VisionUnavailableError()
            analysis = await self._llm.analyze_image(
                msg.image, self._persona_prompt
            )
            self._remember_local_vision(analysis)
            return None

        # 텍스트 메시지 처리
        if msg.content:
            return await self._handle_text(msg.content)

        return None

    async def handle_message_stream(
        self,
        raw_data: dict,
        include_audio: bool = True,
    ) -> AsyncIterator[tuple[str, Any]]:
        """스트리밍 응답 제너레이터.

        yield 순서:
            ("emotion",           EmotionState)            — 감정 먼저
            ("text",              str)                     — LLM 응답 텍스트
            ("tts_chunk",         (int, bytes, bool))      — (chunk_index, bytes, is_last) × N
            ("conv_id",           int)                     — DB row id (피드백용)
            ("approval_required", dict)                    — 승인 필요 (skill, reason, token)
            ("skill_result",      dict)                    — 스킬 실행 결과
            ("error",             str)                     — 오류 메시지
        """
        # 웹 체험판 Google 데모 계정 승인/거절. 일반 스킬 승인 저장소와 분리해
        # 토큰 목적을 섞지 않고, 거절도 토큰을 소비해 이후 실행을 확실히 막는다.
        action = raw_data.get("action", "")
        if action in {"google_write_approve", "google_write_reject"}:
            payload = raw_data.get("payload", {})
            if not isinstance(payload, dict):
                payload = {}
            token = payload.get("approval_token", "")
            entry = self._google_demo_approvals.consume(
                token if isinstance(token, str) else ""
            )
            if entry is None or entry.get("skill") != "google_demo_write":
                yield ("google_write_error", {
                    "message": "Google 쓰기 승인 토큰이 유효하지 않거나 만료되었습니다.",
                })
                return

            stored = entry.get("payload", {})
            request_id = stored.get("request_id", "")
            draft = stored.get("draft", {})
            if action == "google_write_reject":
                yield ("google_write_cancelled", {"requestId": request_id})
                return

            try:
                receipt = await asyncio.to_thread(
                    self._google_demo.create,
                    request_id,
                    draft,
                )
            except GoogleDemoError as exc:
                yield ("google_write_error", {"message": str(exc)})
            except Exception:
                logger.exception("Google 데모 쓰기 실행 중 예기치 않은 오류")
                yield ("google_write_error", {
                    "message": "Google 데모 항목을 생성하지 못했습니다.",
                })
            else:
                yield ("google_write_result", receipt)
                # 공개 웹에서 실제로 생성된 Calendar 항목만 일정 문맥으로 되먹인다.
                # providerId는 Google 생성 성공 영수증에서 가져오므로 가짜 일정이나
                # 승인 전 초안이 선제 발화의 근거가 될 수 없다.
                if draft.get("kind") == "calendar":
                    yield ("schedule_created", {
                        "id": receipt["providerId"],
                        "title": draft["title"],
                        "startsAt": draft["startAt"],
                        "allDay": False,
                    })
            return

        # Phase 4-B: approve 액션 처리
        if action == "approve":
            payload = raw_data.get("payload", {})
            token = payload.get("approval_token", "")
            entry = self._approval_store.consume(token)
            if entry is None:
                yield ("error", "승인 토큰이 유효하지 않거나 만료되었습니다.")
                return
            # 저장된 intent로 ActionRouter 재실행
            from action.intent import Intent
            intent = Intent(name=entry["skill"], payload=entry["payload"])
            session_key = raw_data.get("session_key", "")
            result = await self._action_router.route(intent, session_key=session_key)
            if result is not None:
                yield ("skill_result", result)
            return

        msg = self._parse_message(raw_data)

        if msg.type == "vision":
            self._last_vision_analysis = ""
            self._last_vision_route = None
            if not msg.image:
                error = VisionUnavailableError()
                yield ("vision_error", {
                    "code": error.code,
                    "message": error.public_message,
                })
                return
            try:
                analysis = await self._llm.analyze_image(
                    msg.image, self._persona_prompt
                )
            except VisionUnavailableError as error:
                yield ("vision_error", {
                    "code": error.code,
                    "message": error.public_message,
                })
                return
            self._remember_local_vision(analysis)
            yield ("vision_result", {
                "content": analysis.content,
                "route": analysis.route.to_dict(),
            })
            return

        if not msg.content:
            return

        user_text = msg.content

        # 데스크톱은 로컬 실행용 초안을, 공개 웹은 서버 데모 승인 토큰을 받는다.
        context = raw_data.get("context", {})
        if not isinstance(context, dict):
            context = {}
        now = context.get("now")
        timezone = context.get("timeZone")
        if not isinstance(now, str) or len(now) > 80:
            now = datetime.now().astimezone().isoformat()
        if not isinstance(timezone, str) or not timezone.strip() or len(timezone) > 80:
            timezone = "local"
        google_draft = await self._google_write_drafts.extract(user_text, now, timezone)
        if google_draft is not None:
            if clarification := google_draft.get("clarification"):
                yield ("text", clarification)
            else:
                yield ("google_write_draft", self.prepare_google_draft(google_draft))
                yield ("text", "초안을 만들었습니다. Agent Dock에서 내용을 확인하고 승인해 주세요.")
            return

        # Phase 4-B: Intent 분류 → ActionRouter (enable_action_router=True 시)
        if self._settings.enable_action_router:
            intent = self._intent_classifier.classify(user_text)
            if intent.name != "chat":
                session_key = raw_data.get("session_key", "")
                result = await self._action_router.route(intent, session_key=session_key)
                if result is not None:
                    if result.get("approval_required"):
                        token = self._approval_store.create(
                            skill=result["skill"],
                            payload=intent.payload,
                        )
                        yield ("approval_required", {
                            "skill": result["skill"],
                            "reason": result.get("reason", ""),
                            "approval_token": token,
                        })
                        return
                    # 스킬 실행 완료
                    yield ("skill_result", result)
                    return
                # result가 None이면 LLM 처리로 fallthrough

        # 1. 감정 분석
        emotion_result = None
        if self._settings.enable_emotion and self._emotion:
            emotion_result = self._emotion.process_user_message(user_text)

        if emotion_result:
            yield ("emotion", emotion_result["current_mood"])
        else:
            yield ("emotion", EmotionState(type=EmotionType.NEUTRAL, intensity=0.5))

        # 3. 메모리 히스토리
        history = []
        if self._settings.enable_memory:
            history = self._memory.get_history()

        # 4. 장기 기억 컨텍스트
        system_prompt = self._persona_prompt
        if self._settings.enable_long_term_memory and self._long_term is not None:
            try:
                memories = await self._long_term.search(user_text, top_k=3)
                if memories:
                    memory_lines = [f"- {m.content}" for m in memories]
                    memory_context = "## 관련 기억\n" + "\n".join(memory_lines)
                    system_prompt = (
                        f"{system_prompt}\n\n{memory_context}"
                        if system_prompt
                        else memory_context
                    )
            except Exception:
                logger.warning("장기 기억 검색 실패 (stream)", exc_info=True)

        # 6 & 7. LLM Streaming & Chunk TTS 병렬 파이프라인 (멀티플렉싱)
        if emotion_result:
            tts_params = emotion_result["tts_params"]
            rate, pitch = tts_params["rate"], tts_params["pitch"]
        else:
            rate, pitch = 1.0, 0.0

        import re

        out_queue = asyncio.Queue()
        tts_queue = asyncio.Queue()
        state = {"full_response_text": "", "response_buffer": ""}

        def on_llm_route_change(changed_route: dict[str, object]) -> None:
            # LLMManager가 실제 enriched_input으로 provider를 한 번 결정한 직후와
            # 런타임 폴백 직후 호출한다. 같은 queue로 경로와 텍스트 순서를 보존한다.
            if _is_public_llm_route(changed_route):
                out_queue.put_nowait(("llm_route", changed_route))
            else:
                logger.warning("잘못된 LLM 경로 변경 payload 무시: %r", changed_route)

        async def llm_worker():
            chunk_idx = 0
            try:
                async for token in self._llm.chat_stream(
                    user_input=user_text,
                    system_prompt=system_prompt,
                    history=history,
                    on_route_change=on_llm_route_change,
                ):
                    token_str = self._extract_pure_text(token)
                    out_queue.put_nowait(("text_stream", token_str))
                    state["response_buffer"] += token_str
                    state["full_response_text"] += token_str

                    while match := TTS_SENTENCE_END_PATTERN.search(
                        state["response_buffer"]
                    ):
                        # 문장 끝 직후의 이모지가 다음 토큰으로 도착할 수 있으므로
                        # 버퍼 끝에서는 한 토큰 더 기다리고 스트림 종료 시 flush한다.
                        if match.end() == len(state["response_buffer"]):
                            break
                        end_idx = match.end()
                        sentence = state["response_buffer"][:end_idx].strip()
                        state["response_buffer"] = state["response_buffer"][end_idx:]

                        if sentence:
                            out_queue.put_nowait(("text", sentence))
                            if include_audio:
                                tts_queue.put_nowait((chunk_idx, sentence))
                            chunk_idx += 1

                if state["response_buffer"].strip():
                    sentence = state["response_buffer"].strip()
                    out_queue.put_nowait(("text", sentence))
                    if include_audio:
                        tts_queue.put_nowait((chunk_idx, sentence))
                    chunk_idx += 1

                if include_audio:
                    tts_queue.put_nowait(("DONE", None))
                out_queue.put_nowait(("llm_worker_done", None))
            except Exception:
                logger.error("스트리밍 LLM 오류", exc_info=True)
                out_queue.put_nowait(("text_stream", _FALLBACK_MESSAGE))
                out_queue.put_nowait(("text", _FALLBACK_MESSAGE))
                state["full_response_text"] = _FALLBACK_MESSAGE
                if include_audio and not self._settings.tts_target_language:
                    tts_queue.put_nowait((0, _FALLBACK_MESSAGE))
                if include_audio:
                    tts_queue.put_nowait(("DONE", None))
                out_queue.put_nowait(("llm_worker_done", None))

        async def tts_worker():
            try:
                tts_manager = TTSManager()
                while True:
                    item = await tts_queue.get()
                    if item[0] == "DONE":
                        break

                    c_idx, c_sentence = item

                    prepared_tts = prepare_tts_text(c_sentence)
                    if not prepared_tts.text:
                        continue

                    c_rate, c_pitch = rate, pitch
                    if self._settings.enable_emotion and self._emotion:
                        chunk_emotion = self._emotion.process_user_message(c_sentence)
                        c_rate = chunk_emotion["tts_params"]["rate"]
                        c_pitch = chunk_emotion["tts_params"]["pitch"]

                    try:
                        tts_sentence = await self._tts_text_translator.translate(
                            prepared_tts.text
                        )
                    except TtsTextTranslationError:
                        logger.warning(
                            "TTS 문장 번역 실패: chunk=%s text=%r",
                            c_idx,
                            c_sentence,
                            exc_info=True,
                        )
                        continue

                    # 자막 동기화용: 실제 합성되는 문장만, 오디오보다 먼저 알린다.
                    # 화면 표시용이므로 이모지를 유지한 원문을 보낸다 (T-010).
                    out_queue.put_nowait(
                        ("tts_sentence", {"chunk_index": c_idx, "text": c_sentence})
                    )

                    pending_audio_chunk: bytes | None = None
                    async for audio_chunk in tts_manager.generate_stream(
                        tts_sentence,
                        rate=c_rate,
                        pitch=c_pitch,
                        voice=prepared_tts.tone,
                    ):
                        if pending_audio_chunk is not None:
                            out_queue.put_nowait(
                                ("tts_chunk", (c_idx, pending_audio_chunk, False))
                            )
                        pending_audio_chunk = audio_chunk
                    if pending_audio_chunk is not None:
                        out_queue.put_nowait(
                            ("tts_chunk", (c_idx, pending_audio_chunk, True))
                        )

                out_queue.put_nowait(("tts_chunk", (9999, b"", True)))
                out_queue.put_nowait(("tts_worker_done", None))
            except Exception:
                logger.error("스트리밍 백그라운드 TTS 오류", exc_info=True)
                out_queue.put_nowait(("tts_chunk", (9999, b"", True)))
                out_queue.put_nowait(("tts_worker_done", None))

        asyncio.create_task(llm_worker())
        if include_audio:
            asyncio.create_task(tts_worker())

        llm_finished = False
        tts_finished = not include_audio

        while not (llm_finished and tts_finished):
            cmd, payload = await out_queue.get()
            if cmd == "llm_worker_done":
                llm_finished = True
            elif cmd == "tts_worker_done":
                tts_finished = True
            else:
                yield (cmd, payload)

        response_text = state["full_response_text"]

        # 7. 메모리 저장
        if self._settings.enable_memory:
            emotion_state = (
                emotion_result["current_mood"]
                if emotion_result
                else EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)
            )
            self._memory.add_turn(user_text, response_text, emotion_state)

        # 8. 대화 DB 저장 + 파인튜닝 quality_score 저장
        if self._store is not None:
            conv_id = self._store.save_conversation(
                session_key="default",
                user_msg=user_text,
                assistant_msg=response_text,
            )
            if self._settings.enable_finetune_scoring:
                emotion_intensity = (
                    emotion_result["current_mood"].intensity if emotion_result else None
                )
                q_score = self._estimate_quality(user_text, response_text, emotion_intensity)
                self._store.update_quality_score(conv_id, q_score)
                threshold = getattr(self._settings, "finetune_candidate_threshold", 0.6)
                if q_score >= threshold:
                    self._store.update_finetune_candidate([conv_id])
            yield ("conv_id", conv_id)

    async def _handle_text(self, user_text: str) -> TanyaResponse:
        """텍스트 메시지에 대한 응답을 생성한다."""
        # 1. 감정 엔진: 사용자 메시지 분석 (enable_emotion이 True일 때만)
        emotion_result = None
        if self._settings.enable_emotion and self._emotion:
            emotion_result = self._emotion.process_user_message(user_text)

        # 2. 메모리에서 대화 히스토리 조회
        history = []
        if self._settings.enable_memory:
            history = self._memory.get_history()

        # 3. 장기 기억 검색 → system prompt에 주입
        system_prompt = self._persona_prompt
        if self._settings.enable_long_term_memory and self._long_term is not None:
            try:
                memories = await self._long_term.search(user_text, top_k=3)
                if memories:
                    memory_lines = [f"- {m.content}" for m in memories]
                    memory_context = "## 관련 기억\n" + "\n".join(memory_lines)
                    system_prompt = (
                        f"{system_prompt}\n\n{memory_context}"
                        if system_prompt
                        else memory_context
                    )
            except Exception:
                logger.warning("장기 기억 검색 실패 (text)", exc_info=True)

        try:
            raw_response = await self._llm.chat(
                user_input=user_text,
                system_prompt=system_prompt,
                history=history,
            )
            response_text = self._extract_pure_text(raw_response)
            if not response_text.strip():
                response_text = _FALLBACK_MESSAGE
        except Exception as e:
            logger.error("LLM 텍스트 추출/파싱 오류: %s", e)
            response_text = _FALLBACK_MESSAGE

        # 6. TTS 생성 (감정 파라미터 적용)
        try:
            tts_text = await self._tts_text_translator.translate(response_text)
            if emotion_result:
                tts_params = emotion_result["tts_params"]
                mood_type = emotion_result["current_mood"].type.value
                audio_base64 = await generate_tts_base64(
                    tts_text,
                    rate=tts_params["rate"],
                    pitch=tts_params["pitch"],
                    voice=mood_type
                )
            else:
                audio_base64 = await generate_tts_base64(tts_text, voice="neutral")
        except Exception as e:
            logger.error("TTS 생성 런타임 오류: %s", e)
            audio_base64 = ""

        # 7. 메모리에 대화 저장 (감정 포함)
        if self._settings.enable_memory:
            emotion_state = (
                emotion_result["current_mood"]
                if emotion_result
                else EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)
            )
            self._memory.add_turn(user_text, response_text, emotion_state)

        # 8. 대화 DB 저장 + 파인튜닝 quality_score 저장
        saved_conv_id: int | None = None
        if self._store is not None:
            saved_conv_id = self._store.save_conversation(
                session_key="default",
                user_msg=user_text,
                assistant_msg=response_text,
            )
            if self._settings.enable_finetune_scoring:
                emotion_intensity = (
                    emotion_result["current_mood"].intensity
                    if emotion_result
                    else None
                )
                q_score = self._estimate_quality(user_text, response_text, emotion_intensity)
                self._store.update_quality_score(saved_conv_id, q_score)
                threshold = getattr(self._settings, "finetune_candidate_threshold", 0.6)
                if q_score >= threshold:
                    self._store.update_finetune_candidate([saved_conv_id])

        # 10. 응답 구성
        if emotion_result:
            emotion = emotion_result["current_mood"]
            animation_intent = emotion_result["animation_intent"]
        else:
            emotion = EmotionState(type=EmotionType.NEUTRAL, intensity=0.5)
            animation_intent = "idle"

        return TanyaResponse(
            type="response",
            content=response_text,
            audio=audio_base64,
            emotion=emotion,
            animation_intent=animation_intent,
            conv_id=saved_conv_id,
        )

    def _remember_local_vision(self, analysis: VisionAnalysis) -> None:
        self._last_vision_analysis = analysis.content
        self._last_vision_route = analysis.route.to_dict()
        logger.info(
            "로컬 화면 분석 완료 provider=%s model=%s",
            analysis.route.provider,
            analysis.route.model,
        )

    def _estimate_quality(
        self,
        user_text: str,
        response_text: str,
        emotion_intensity: float | None = None,
    ) -> float:
        """대화 품질을 암묵적으로 추정한다 (0.0 ~ 1.0).

        채점 기준:
        - baseline: 0.5
        - user_msg 길이 5~100자: +0.1
        - assistant_msg 길이 20~500자: +0.2
        - fallback 메시지 포함: -0.5
        - emotion_intensity >= 0.6: +0.1
        """
        score = 0.5

        lo, hi = _QUALITY_USER_LEN_RANGE
        if lo <= len(user_text) <= hi:
            score += 0.1

        lo, hi = _QUALITY_ASST_LEN_RANGE
        if lo <= len(response_text) <= hi:
            score += 0.2

        if _FALLBACK_MARKER in response_text:
            score -= 0.5

        if emotion_intensity is not None and emotion_intensity >= 0.6:
            score += 0.1

        return max(0.0, min(1.0, score))

    def _parse_message(self, raw_data: dict) -> UserMessage:
        """raw JSON을 UserMessage로 파싱한다."""
        msg_type = raw_data.get("type", "text")

        # 기존 프로토콜 호환: "content" 키만 있는 경우
        if msg_type != "vision" and "content" in raw_data:
            msg_type = "text"

        # V2 프로토콜: payload.message 에서 content 추출
        payload = raw_data.get("payload", {})
        content = (
            raw_data.get("content")
            or raw_data.get("text")
            or (payload.get("message") if isinstance(payload, dict) else None)
        )

        return UserMessage(
            type=msg_type,
            content=content,
            image=raw_data.get("image"),
            session_id=raw_data.get("session_id"),
        )

    def _extract_pure_text(self, response: Any) -> str:
        """LLM 반환값이 Gemini의 JSON이나 객체 리스트 구조일 경우 순수 텍스트만 추출한다."""
        if not response:
            return ""

        # 이미 문자열인 경우 - 문자열로 직렬화된 JSON 리스트 구조를 의심해 파싱 시도
        if isinstance(response, str):
            res_str_stripped = response.strip()
            if res_str_stripped.startswith("[{") or res_str_stripped.startswith("{'"):
                try:
                    import ast
                    parsed = ast.literal_eval(res_str_stripped)
                    return self._extract_pure_text(parsed)
                except Exception:
                    pass  # 파싱 실패 시 원본 리턴
            return response

        # 파싱된 List 구조 순회
        if isinstance(response, list):
            chunks = []
            for item in response:
                chunks.append(self._extract_pure_text(item))
            return " ".join(chunk for chunk in chunks if chunk)

        # Dictionary 내에서 content나 text 필드 추출
        if isinstance(response, dict):
            # 'text'나 'content' 키를 찾음
            ext_text = response.get('text') or response.get('content') or ""
            return str(ext_text)

        return str(response)

    @property
    def persona_prompt(self) -> str:
        return self._persona_prompt

    @property
    def memory(self) -> MemoryEngine:
        return self._memory
