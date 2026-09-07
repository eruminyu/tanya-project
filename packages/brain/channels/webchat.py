"""Phase 6-A: WebChatChannel — WebChat/Tauri 공용 채널.
Phase 9-B: ProactiveTriggerScheduler 연동 추가.

- 기본 WebChat은 텍스트 전용, Tauri 요청에서만 TTS 청크 활성화
- 레거시 JSON 수신/송신 (브라우저 호환 우선)
- audio 필드 제외하여 페이로드 경량화
"""

import base64
import json
import logging
import uuid
from datetime import datetime

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from channels.base import Channel
from core.audio import TTSManager
from core.orchestrator import Orchestrator
from core.pending_offer import PendingOffer, build_preparation_draft, is_acceptance
from core.rate_limit import client_key
from core.schedule_context import parse_schedule_events
from core.tts_text_preprocessor import prepare_tts_text
from core.vision import VisionTransportUntrustedError
from memory.capsule import MemoryCapsuleError

logger = logging.getLogger(__name__)

_TUTORIAL_ACTIONS = {
    "tutorial_start",
    "tutorial_resume",
    "tutorial_preferences_prepare",
    "tutorial_approve",
    "tutorial_reject",
    "tutorial_google_prepare",
    "tutorial_google_skip",
    "tutorial_answer_generate",
    "tutorial_receipt_get",
    "tutorial_forget",
}
_TUTORIAL_RETIRED_ACTIONS = {
    "memory_capsule_prepare",
    "memory_capsule_approve",
    "memory_capsule_reject",
    "memory_capsule_recall",
    "memory_capsule_forget",
    "google_write_approve",
    "google_write_reject",
}


class WebChatChannel(Channel):
    """WebChat/Tauri 공용 채널. 오디오는 생성자 옵션으로 분리한다."""

    def __init__(
        self,
        orchestrator: Orchestrator,
        session_key: str = "",
        include_audio: bool = False,
        enable_proactive: bool = True,
        allow_vision: bool = False,
    ) -> None:
        self._orch = orchestrator
        self._session_key = session_key
        self._include_audio = include_audio
        self._enable_proactive = enable_proactive
        # 공개 WebSocket은 화면 이미지의 신뢰 경계를 증명하지 못한다. 별도의
        # 인증된 로컬 transport가 명시적으로 허용할 때만 vision을 전달한다.
        self._allow_vision = allow_vision
        # T-015: 방금 보낸 선제 제안이 가리키는 일정. 수락 답변을 초안으로 잇는다.
        self._pending_offer: PendingOffer | None = None

    def _get_scheduler(self, websocket: WebSocket):
        """앱 상태에서 선제 제안 스케줄러를 꺼낸다. 없으면 None."""
        state = getattr(getattr(websocket, "app", None), "state", None)
        return getattr(state, "proactive_scheduler", None) if state else None

    def _get_memory_capsule_service(self, websocket: WebSocket):
        state = getattr(getattr(websocket, "app", None), "state", None)
        if state is None:
            return None
        try:
            return getattr(state, "memory_capsule_service")
        except AttributeError:
            return None

    def _get_tutorial_service(self, websocket: WebSocket):
        state = getattr(getattr(websocket, "app", None), "state", None)
        if state is None:
            return None
        values = getattr(state, "_state", None)
        if isinstance(values, dict):
            return values.get("tutorial_service")
        return vars(state).get("tutorial_service")

    async def _send_tutorial_event(
        self, websocket: WebSocket, event: str, payload: dict
    ) -> None:
        await websocket.send_text(json.dumps({
            "type": "event", "event": event, "payload": payload,
        }, ensure_ascii=False))

    @staticmethod
    def _safe_tutorial_id(value) -> str:
        if not isinstance(value, str):
            return ""
        try:
            parsed = uuid.UUID(value)
        except (ValueError, AttributeError):
            return ""
        return str(parsed) if parsed.version == 4 and str(parsed) == value else ""

    async def _handle_tutorial(
        self, websocket: WebSocket, raw_data: dict
    ) -> bool:
        action = raw_data.get("action")
        service = self._get_tutorial_service(websocket)
        if action in _TUTORIAL_RETIRED_ACTIONS and service is not None:
            payload = raw_data.get("payload")
            payload = payload if isinstance(payload, dict) else {}
            await self._send_tutorial_event(websocket, "tutorial_error", {
                "flowId": self._safe_tutorial_id(payload.get("flow_id")),
                "operationId": self._safe_tutorial_id(
                    payload.get("operation_id")
                ),
                "code": "deprecated",
                "message": "통합 튜토리얼의 새 단계로 다시 시작해 주세요.",
            })
            return True
        if action not in _TUTORIAL_ACTIONS:
            return False

        payload = raw_data.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        operation_id = self._safe_tutorial_id(payload.get("operation_id"))
        flow_id = self._safe_tutorial_id(payload.get("flow_id"))
        if service is None:
            await self._send_tutorial_event(websocket, "tutorial_error", {
                "flowId": flow_id,
                "operationId": operation_id,
                "code": "unavailable",
                "message": "통합 튜토리얼을 사용할 수 없습니다.",
            })
            return True

        state = getattr(getattr(websocket, "app", None), "state", None)
        limiter = getattr(state, "rate_limiter", None) if state else None
        socket_host = (
            websocket.client.host
            if getattr(websocket, "client", None) is not None
            else None
        )
        identity = client_key(getattr(websocket, "headers", {}), socket_host)
        if limiter is not None:
            decision = limiter.check(identity)
            if not decision.allowed:
                await self._send_tutorial_event(websocket, "tutorial_error", {
                    "flowId": flow_id,
                    "operationId": operation_id,
                    "code": "rate_limited",
                    "message": "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
                    "retryAfter": decision.retry_after,
                })
                return True
        try:
            events = await service.handle(self._session_key, action, payload)
        except Exception:
            logger.warning("통합 튜토리얼 adapter가 요청을 안전하게 종료했습니다")
            events = [("tutorial_error", {
                "flowId": flow_id,
                "operationId": operation_id,
                "code": "unavailable",
                "message": "통합 튜토리얼 요청을 처리하지 못했습니다.",
            })]
        for event, event_payload in events:
            await self._send_tutorial_event(websocket, event, event_payload)
        return True

    async def _send_capsule_event(
        self, websocket: WebSocket, event: str, payload: dict
    ) -> None:
        await websocket.send_text(json.dumps({
            "type": "event", "event": event, "payload": payload,
        }, ensure_ascii=False))

    async def _handle_memory_capsule(
        self, websocket: WebSocket, raw_data: dict
    ) -> bool:
        """캡슐 action을 LLM에 보내지 않고 서버 session 경계에서 처리한다."""
        action = raw_data.get("action")
        events = {
            "memory_capsule_prepare": "memory_capsule_approval_required",
            "memory_capsule_approve": "memory_capsule_saved",
            "memory_capsule_reject": "memory_capsule_rejected",
            "memory_capsule_recall": "memory_capsule_recalled",
            "memory_capsule_forget": "memory_capsule_forgotten",
        }
        if action not in events:
            return False

        payload = raw_data.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        raw_operation_id = payload.get("operation_id")
        try:
            operation_uuid = uuid.UUID(str(raw_operation_id))
            if (
                operation_uuid.version != 4
                or str(operation_uuid) != str(raw_operation_id).lower()
            ):
                raise ValueError("operation_id is not a canonical UUID v4")
            operation_id = str(raw_operation_id)
        except (ValueError, AttributeError, TypeError):
            await self._send_capsule_event(websocket, "memory_capsule_error", {
                "operationId": "",
                "code": "invalid",
                "message": "요청 식별자를 확인할 수 없습니다.",
            })
            return True

        service = self._get_memory_capsule_service(websocket)
        if service is None:
            await self._send_capsule_event(websocket, "memory_capsule_error", {
                "operationId": operation_id,
                "code": "unavailable",
                "message": "기억 저장소가 아직 연결되지 않았습니다.",
            })
            return True

        socket_host = (
            websocket.client.host
            if getattr(websocket, "client", None) is not None
            else None
        )
        identity = client_key(getattr(websocket, "headers", {}), socket_host)
        try:
            if action == "memory_capsule_prepare":
                result = await service.prepare(
                    self._session_key,
                    payload.get("preparation_minutes"),
                    client_identity=identity,
                )
            elif action == "memory_capsule_approve":
                result = await service.approve(
                    self._session_key,
                    payload.get("approval_token"),
                    client_identity=identity,
                )
            elif action == "memory_capsule_reject":
                result = await service.reject(
                    self._session_key,
                    payload.get("approval_token"),
                    client_identity=identity,
                )
            elif action == "memory_capsule_recall":
                result = await service.recall(
                    self._session_key, client_identity=identity
                )
            else:
                result = await service.forget(
                    self._session_key, client_identity=identity
                )
        except MemoryCapsuleError as exc:
            await self._send_capsule_event(websocket, "memory_capsule_error", {
                "operationId": operation_id,
                "code": exc.code,
                "message": exc.message,
            })
            return True
        except Exception:
            logger.exception("기억 캡슐 처리 실패")
            await self._send_capsule_event(websocket, "memory_capsule_error", {
                "operationId": operation_id,
                "code": "storage_error",
                "message": "기억 저장소 요청을 처리하지 못했습니다.",
            })
            return True

        await self._send_capsule_event(
            websocket, events[action], {**result, "operationId": operation_id}
        )
        return True

    async def _speak(self, websocket: WebSocket, text: str) -> None:
        """선제 발화를 대화 응답과 같은 tts 이벤트 형식으로 흘린다 (T-014).

        새 이벤트 타입을 만들지 않는다. 클라이언트의 자막·립싱크·speaking 파이프라인이
        이미 tts_sentence/tts_chunk를 처리하므로 같은 계약을 재사용한다.
        합성이 실패해도 제안 자체는 반드시 전달되어야 하므로 여기서 예외를 삼킨다.
        """
        prepared = prepare_tts_text(text)
        if not prepared.text:
            return
        try:
            # 자막용 원문은 이모지를 유지한다 (spec v1.2 §4.1).
            await websocket.send_text(json.dumps({
                "type": "event",
                "event": "tts_sentence",
                "payload": {"chunk_index": 0, "text": text},
            }, ensure_ascii=False))

            async for audio in TTSManager().generate_stream(prepared.text, voice=prepared.tone):
                await websocket.send_text(json.dumps({
                    "type": "event",
                    "event": "tts_chunk",
                    "payload": {
                        "chunk_index": 0,
                        "data": base64.b64encode(audio).decode("ascii"),
                        "is_last": False,
                    },
                }))
        except Exception:
            logger.warning("선제 발화 음성 합성 실패", exc_info=True)
        finally:
            # 종료 센티널이 없으면 클라이언트의 speaking이 true로 남는다.
            await websocket.send_text(json.dumps({
                "type": "event",
                "event": "tts_chunk",
                "payload": {"chunk_index": 9999, "data": "", "is_last": True},
            }))

    def _remember_offer(self, meta: dict | None) -> None:
        """제안 대상을 붙들어 둔다. 문맥이 없는 규칙이면 이전 제안을 지운다."""
        event = (meta or {}).get("event")
        if not isinstance(event, dict) or not event.get("id"):
            self._pending_offer = None
            return
        self._pending_offer = PendingOffer(
            event_id=str(event["id"]),
            title=str(event.get("title") or "일정"),
            starts_at=event["starts_at"],
            created_at=datetime.now(),
        )

    async def _try_accept_offer(self, websocket: WebSocket, raw_data: dict) -> bool:
        """수락 답변이면 LLM을 거치지 않고 초안을 방출한다. 처리했으면 True."""
        offer = self._pending_offer
        if offer is None:
            return False
        content = raw_data.get("content") or ""
        if not offer.is_alive(datetime.now()) or not is_acceptance(content):
            # 다른 이야기를 시작했으므로 제안을 흘려보낸다.
            self._pending_offer = None
            return False

        self._pending_offer = None
        draft = self._orch.prepare_google_draft(
            build_preparation_draft(offer, datetime.now())
        )
        await websocket.send_text(json.dumps({
            "type": "event", "event": "google_write_draft", "payload": draft,
        }, ensure_ascii=False))
        await websocket.send_text(json.dumps({
            "type": "response",
            "content": "초안을 만들었습니다. Agent Dock에서 확인하고 승인해 주세요.",
            "emotion": "happy",
            "animation_intent": "idle",
        }, ensure_ascii=False))
        return True

    def _apply_schedule_context(self, scheduler, context) -> None:
        """일정 스냅샷을 스케줄러에 반영한다. 실패해도 연결을 끊지 않는다."""
        if scheduler is None or not isinstance(context, dict):
            return
        try:
            events = parse_schedule_events(context.get("events"))
            scheduler.update_schedule(
                events, datetime.now(), session_key=self._session_key
            )
        except Exception:
            logger.warning("일정 스냅샷 적용 실패", exc_info=True)

    async def _apply_created_schedule(self, scheduler, payload) -> None:
        """실제 생성된 Calendar 항목을 반영하고 해당 규칙만 즉시 평가한다.

        Google 생성 영수증은 이 내부 이벤트보다 먼저 전달된다. 여기서 파싱이나
        선제 발화가 실패해도 성공한 외부 쓰기의 결과를 실패로 바꾸지 않는다.
        """
        if scheduler is None or not isinstance(payload, dict):
            return
        try:
            events = parse_schedule_events([payload])
            if not events:
                logger.warning("생성 일정 문맥이 유효하지 않아 즉시 평가를 건너뜀")
                return
            created = events[0]
            scheduler.upsert_schedule_event(
                created, datetime.now(), session_key=self._session_key
            )
            await scheduler.evaluate_rule_now(
                "upcoming_event",
                session_key=self._session_key,
                event_id=created.id,
            )
        except Exception:
            logger.warning("생성 일정의 즉시 선제 평가 실패", exc_info=True)

    async def handle(self, websocket: WebSocket) -> None:
        await websocket.accept()

        scheduler = (
            self._get_scheduler(websocket) if self._enable_proactive else None
        )
        proactive_sender = None

        if scheduler is not None and self._enable_proactive:
            async def send_proactive(text: str, meta: dict | None = None) -> None:
                self._remember_offer(meta)
                # 음성을 먼저 흘린 뒤 제안을 보낸다. 순서가 뒤집히면 자막보다
                # 대화 목록이 먼저 갱신되어 화면이 튄다.
                if self._include_audio:
                    await self._speak(websocket, text)
                payload = {
                    "type": "event",
                    "event": "proactive_suggestion",
                    "payload": {"text": text},
                }
                await websocket.send_text(json.dumps(payload, ensure_ascii=False))

            proactive_sender = send_proactive
            scheduler.set_connection(proactive_sender, self._session_key)

        try:
            while True:
                raw_text = await websocket.receive_text()
                raw_data = json.loads(raw_text)

                if raw_data.get("type") == "vision" and not self._allow_vision:
                    error = VisionTransportUntrustedError()
                    await websocket.send_text(json.dumps({
                        "type": "event",
                        "event": "vision_error",
                        "payload": {
                            "code": error.code,
                            "message": error.public_message,
                        },
                    }, ensure_ascii=False))
                    continue

                # 일정 스냅샷은 대화가 아니다. 상태만 갱신하고 아무것도 보내지 않는다 (T-013).
                if raw_data.get("type") == "context":
                    self._apply_schedule_context(scheduler, raw_data.get("context"))
                    continue

                if await self._handle_tutorial(websocket, raw_data):
                    continue

                if await self._handle_memory_capsule(websocket, raw_data):
                    continue

                # T-015: 방금 한 제안에 대한 수락이면 초안으로 바로 잇는다.
                if await self._try_accept_offer(websocket, raw_data):
                    if scheduler is not None:
                        scheduler.update_last_conversation(
                            session_key=self._session_key
                        )
                    continue

                # V2 멀티플렉싱 스트림 지원으로 전환
                response_content = ""
                final_emotion = "neutral"
                final_animation = "idle"
                conv_id = None

                async for event_type, data in self._orch.handle_message_stream(
                    raw_data,
                    include_audio=self._include_audio,
                ):
                    if event_type == "emotion":
                        final_emotion = data.type.value
                    elif event_type == "text_stream":
                        # 브라우저에서 타다닥 찍히도록 실시간 이벤트 발송
                        stream_payload = {
                            "type": "event",
                            "event": "text_stream",
                            "payload": {"text": data}
                        }
                        await websocket.send_text(json.dumps(stream_payload, ensure_ascii=False))
                    elif event_type == "text":
                        if response_content:
                            response_content += " " + data
                        else:
                            response_content = data
                    elif event_type == "conv_id":
                        conv_id = data
                    elif event_type == "tts_chunk":
                        chunk_index, audio_bytes, is_last = data
                        tts_payload = {
                            "type": "event",
                            "event": "tts_chunk",
                            "payload": {
                                "chunk_index": chunk_index,
                                "data": base64.b64encode(audio_bytes).decode("ascii"),
                                "is_last": is_last,
                            },
                        }
                        await websocket.send_text(json.dumps(tts_payload))
                    elif event_type == "schedule_created":
                        # 서버 내부 연결 이벤트다. 브라우저 공개 계약에는 노출하지 않는다.
                        await self._apply_created_schedule(scheduler, data)
                    elif event_type in {
                        "approval_required",
                        "skill_result",
                        "google_write_draft",
                        "google_write_result",
                        "google_write_cancelled",
                        "google_write_error",
                        "tts_sentence",
                        "llm_route",
                        "vision_result",
                        "vision_error",
                    }:
                        await websocket.send_text(json.dumps({
                            "type": "event",
                            "event": event_type,
                            "payload": data,
                        }, ensure_ascii=False))
                    elif event_type == "error":
                        await websocket.send_text(json.dumps({
                            "type": "event",
                            "event": "error",
                            "payload": {"message": str(data)},
                        }, ensure_ascii=False))

                if scheduler is not None:
                    scheduler.update_last_conversation(session_key=self._session_key)

                # Google 승인/거절은 Agent Dock 상태만 바꾼다. 빈 대화 응답을 추가하면
                # 브라우저에 내용 없는 타냐 메시지가 생기므로 최종 response를 보내지 않는다.
                if raw_data.get("action") in {
                    "google_write_approve",
                    "google_write_reject",
                }:
                    continue
                if raw_data.get("type") == "vision":
                    continue

                # 마지막 완료 페이로드 (통응답)
                payload = {
                    "type": "response",
                    "content": response_content,
                    "emotion": final_emotion,
                    "animation_intent": final_animation,
                }
                if conv_id is not None:
                    payload["conv_id"] = conv_id

                await websocket.send_text(json.dumps(payload, ensure_ascii=False))

        except WebSocketDisconnect:
            pass
        finally:
            if scheduler is not None and self._enable_proactive:
                scheduler.clear_connection(self._session_key, proactive_sender)
