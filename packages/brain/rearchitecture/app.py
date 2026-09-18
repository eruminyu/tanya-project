"""Run with uvicorn rearchitecture.app:create_app --factory --host 127.0.0.1."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from kirian_contracts import ContractValidationError, assert_definition

from .config import V1Config
from .audio import AudioError, HTTPAudioProvider, MAX_AUDIO_BYTES, SpeechProvider, TranscriptionProvider, normalize_transcript
from .policy import ContextSource, PolicyError
from .providers import HTTPTextProvider, ImageProvider, TextProvider
from .screen import MAX_UPLOAD_BODY, ScreenError, ScreenService
from .session import ProtocolFailure, SessionService
from .storage import SQLiteStore, StorageError
from .auto_memory import AutoMemoryService
from .embedding import EmbeddingProvider
from .proactive import ProactiveService
from .tool_results import validate_registration


def authenticated(connection, config: V1Config) -> bool:
    try:
        local = ipaddress.ip_address(connection.client.host).is_loopback
    except (ValueError, AttributeError):
        local = False
    supplied = connection.headers.get("authorization", "")
    expected = "Bearer " + config.token
    return local and "origin" not in connection.headers and secrets.compare_digest(supplied.encode(), expected.encode())


def create_app(config: V1Config | None = None, provider: TextProvider | None = None, catalog: dict[str, ContextSource] | None = None,
               speech_provider: SpeechProvider | None = None, transcription_provider: TranscriptionProvider | None = None,
               image_provider: ImageProvider | None = None, embedding_provider: EmbeddingProvider | None = None) -> FastAPI:
    config = config or V1Config.from_env()
    store = SQLiteStore(config.data_dir, config.identity) if config.data_dir else None
    service = SessionService(config, provider or HTTPTextProvider(), catalog if catalog is not None else {}, speech_provider, store)
    auto_memory = AutoMemoryService(service, embedding_provider) if store else None
    service.auto_memory = auto_memory
    proactive = ProactiveService(service) if store else None
    transcriber = transcription_provider or HTTPAudioProvider()
    transcription_slots = asyncio.Semaphore(2)
    transcription_tasks: set[asyncio.Task] = set()
    screens = ScreenService(service, image_provider or service.provider)
    screen_requests: set[asyncio.Task] = set()
    screen_uploads = asyncio.Semaphore(2)

    @asynccontextmanager
    async def lifespan(_app):
        if auto_memory:
            auto_memory.start()
        async def cleanup():
            while True:
                await asyncio.sleep(min(60, config.session_ttl_seconds / 2))
                await service.expire()
                await screens.expire()
        task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            # 검색 취소가 수동 맥락으로 돌아와도 종료할 대화를 다시 시작하지 않는다.
            await service.shutdown()
            if auto_memory:
                await auto_memory.shutdown()
            await screens.shutdown()
            for pending in list(screen_requests):
                pending.cancel()
            await asyncio.gather(*screen_requests, return_exceptions=True)
            for pending in list(transcription_tasks):
                pending.cancel()
            await asyncio.gather(*transcription_tasks, return_exceptions=True)
            service.router.close()
            if store:
                store.close()

    app = FastAPI(title="Kirian Personal Protocol v1", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.v1_service = service
    app.state.v1_store = store
    app.state.v1_screens = screens
    app.state.v1_auto_memory = auto_memory

    @app.exception_handler(PolicyError)
    async def routing_error(_request, error):
        statuses = {"invalid_request":400, "routing_changed":409, "routing_limit":429,
                    "routing_no_candidate":409, "routing_duplicate_call":409, "storage_unavailable":503,
                    "persistence_unavailable":503, "model_not_allowed":403, "context_blocked":403, "unsupported_model":400,
                    "source_changed":409, "proactive_busy":429, "invalid_suggestion":502, "model_mismatch":502,
                    "incomplete_response":502, "provider_error":502, "provider_unavailable":503, "turn_timeout":504}
        code = error.code if error.code in statuses else "invalid_request"
        return JSONResponse({"detail":code}, status_code=statuses[code])

    @app.exception_handler(StorageError)
    async def storage_error(_request, error):
        statuses = {"not_found": 404, "invalid_request": 400, "source_changed": 409, "settings_changed": 409, "context_blocked": 403, "storage_unavailable": 503, "screen_limit": 429}
        code = error.code if error.code in statuses else "storage_unavailable"
        return JSONResponse({"detail": code}, status_code=statuses[code])

    @app.exception_handler(ScreenError)
    async def screen_error(_request, error):
        statuses = {"invalid_request": 400, "image_limit": 413, "screen_busy": 429, "screen_unavailable": 503,
                    "unsupported_model": 400, "model_not_allowed": 400, "context_blocked": 403,
                    "provider_unavailable": 503, "provider_error": 502, "model_mismatch": 502,
                    "incomplete_response": 502, "empty_response": 502, "response_limit": 502,
                    "turn_timeout": 504, "screen_cancelled": 499}
        code = error.code if error.code in statuses else "provider_error"
        return JSONResponse({"detail": code}, status_code=statuses[code])

    def persistent(request, *, public=False):
        if not authenticated(request, config):
            raise HTTPException(status_code=401, detail="unauthorized")
        if config.identity["mode"] == "public_demo" and not public:
            # A public demo keeps only what the gateway needs for visitors: per-visitor conversations and the
            # external-tool handshake. Sources, memory, screens, proactive and preferences stay off.
            raise HTTPException(status_code=403, detail="public_demo_disabled")
        if store is None:
            raise HTTPException(status_code=503, detail="persistence_unavailable")
        return store

    async def body(request, keys, limit=48 * 1024, *, public=False):
        persistent(request, public=public)
        raw = bytearray()
        async for part in request.stream():
            if len(raw) + len(part) > limit:
                raise HTTPException(status_code=413, detail="invalid_request")
            raw.extend(part)
        try:
            def reject(_value):
                raise ValueError()
            value = json.loads(raw, parse_constant=reject)
            if not isinstance(value, dict) or set(value) != set(keys):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise HTTPException(status_code=400, detail="invalid_request") from None

    def approved_model(model):
        try:
            assert_definition("ModelRef", model)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_request") from None
        if not any(binding.model == model and binding.supports_text for binding in config.bindings):
            raise HTTPException(status_code=400, detail="model_not_allowed")
        return model

    @app.get("/v1/config")
    async def get_config(request: Request):
        if not authenticated(request, config):
            raise HTTPException(status_code=401, detail="unauthorized")
        result = {
            "identity": config.identity,
            "models": [{"model": binding.model, "label": binding.label, "supports_images": binding.supports_images,
                        "supports_text": binding.supports_text, "supports_tools": binding.supports_tools and store is not None,
                        "automatic_allowed": binding.automatic_allowed,
                        "budget_units": binding.budget_units,
                        "boundary": binding.boundary} for binding in config.bindings],
            "default_selection": service.effective_default(),
        }
        if config.speech is not None:
            result["speech"] = {"model": config.speech.model, "label": config.speech.label}
        if config.transcription is not None:
            result["transcription"] = {"label": config.transcription.model_label}
        if store is not None:
            result["persistence"] = True
            result["routing"] = service.router.snapshot()
        return result

    @app.get("/v1/routing")
    async def routing_state(request: Request):
        if not authenticated(request, config):
            raise HTTPException(status_code=401, detail="unauthorized")
        return service.router.snapshot()

    @app.put("/v1/routing")
    async def routing_settings(request: Request):
        value = await body(request, {"enabled", "expected_revision", "daily_call_limit", "daily_budget_units"})
        return service.router.configure(value)

    @app.put("/v1/preferences")
    async def preferences(request: Request):
        value = await body(request, {"model"})
        model = approved_model(value["model"])
        return {"default_selection": store.set_default(model)}

    @app.get("/v1/conversations")
    async def conversations(request: Request):
        return {"conversations": persistent(request, public=True).list_conversations()}

    @app.post("/v1/conversations")
    async def new_conversation(request: Request):
        await body(request, set(), public=True)
        async with service.lock:
            conversation = store.create_conversation()
        return {"conversation": conversation, "messages": []}

    @app.get("/v1/conversations/{conversation_id}")
    async def conversation(request: Request, conversation_id: str):
        database = persistent(request, public=True)
        return {"conversation": database.get_conversation(conversation_id), "messages": database.messages(conversation_id)}

    @app.delete("/v1/conversations/{conversation_id}")
    async def delete_conversation(request: Request, conversation_id: str):
        persistent(request, public=True)
        def operation():
            return {"ok": True}, store.delete_conversation(conversation_id)
        return await service.mutate_sources(operation, "deleted", conversation_id)

    @app.put("/v1/conversations/{conversation_id}/model")
    async def conversation_model(request: Request, conversation_id: str):
        value = await body(request, {"model"})
        model = approved_model(value["model"]) if value["model"] is not None else None
        async with service.lock:
            result = store.set_conversation_model(conversation_id, model)
            for session in service.sessions.values():
                if session.conversation_id == conversation_id:
                    session.conversation_model = model
        return {"conversation": result}

    @app.get("/v1/sources")
    async def sources(request: Request, q: str = ""):
        persistent(request)
        if len(q) > 256 or set(request.query_params) - {"q"}:
            raise HTTPException(status_code=400, detail="invalid_request")
        return {"sources": store.list_sources(q)}

    @app.post("/v1/external-tools/sources")
    async def external_tool_sources(request: Request):
        value = await body(request, {"refs"}, 32768, public=True)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        async with service.lock:
            return {"sources": store.effective_source_records(value["refs"])}

    @app.get("/v1/external-tools/turns/{context_id}")
    async def external_tool_turn(request: Request, context_id: str):
        persistent(request, public=True)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        try:
            assert_definition("SourceRef", {"source_id": context_id, "revision": 1})
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_request") from None
        return await service.get_tool_observation(context_id)

    @app.post("/v1/external-tools/results")
    async def register_external_tool_result(request: Request):
        value = await body(request, {"provenance", "rawResultJson", "canonicalResultJson", "receipt"}, 256 * 1024, public=True)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        value = validate_registration(value, config.identity)
        # No await between live observation validation, the durable commit, and
        # remembering the source eligible for this exact proposal's continuation.
        async with service.lock:
            conversation_id = service.validate_external_tool_result(value["provenance"])
            result = store.register_tool_result(value, conversation_id)
            service.remember_external_tool_result(value["provenance"], result["sourceRef"])
        return result

    @app.get("/v1/auto-memory")
    async def auto_memory_state(request: Request):
        persistent(request)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        return auto_memory.snapshot()

    @app.get("/v1/proactive/sources")
    async def proactive_sources(request: Request):
        persistent(request)
        if set(request.query_params) - {'include'} or len(request.query_params.getlist('include')) > 1:
            raise PolicyError('invalid_request')
        included = request.query_params.get('include', '')
        return proactive.candidates(included.split(',') if included else [])

    @app.post("/v1/proactive/generate")
    async def proactive_generate(request: Request):
        value = await body(request, {'sources','model','attempt_id'}, 8192)
        if request.query_params:
            raise PolicyError('invalid_request')
        async def disconnected():
            while True:
                if (await request.receive())['type'] == 'http.disconnect':
                    raise HTTPException(status_code=499, detail='proactive_cancelled')
        watcher = asyncio.create_task(disconnected())
        job = asyncio.create_task(proactive.generate(value))
        pending = {watcher, job}
        screen_requests.update(pending)
        try:
            finished, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            return (watcher if watcher in finished else job).result()
        finally:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            screen_requests.difference_update(pending)

    @app.put("/v1/auto-memory")
    async def configure_auto_memory(request: Request):
        value = await body(request, {"settings", "expected_revision"}, 8192)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        def operation():
            result = auto_memory.configure(value)
            return result, auto_memory.repo.changed_sources
        return await service.mutate_sources(operation, "updated", bounded_notifications=True)

    @app.post("/v1/auto-memory/search")
    async def semantic_search(request: Request):
        value = await body(request, {"query", "context"}, 160 * 1024)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        return await auto_memory.search(value["query"], value["context"])

    @app.post("/v1/sources")
    async def create_source(request: Request):
        value = await body(request, {"title", "text", "boundary", "kind", "parents"})
        async with service.lock:
            try:
                source = store.create_source(**value)
            except (ValueError, TypeError, KeyError):
                raise HTTPException(status_code=400, detail="invalid_request") from None
        return {"source": source}

    @app.put("/v1/sources/{source_id}")
    async def update_source(request: Request, source_id: str):
        value = await body(request, {"expected_revision", "title", "text", "boundary"})
        def operation():
            source, affected = store.update_source(source_id, **value)
            return {"source": source}, affected
        return await service.mutate_sources(operation, "updated")

    @app.delete("/v1/sources/{source_id}")
    async def delete_source(request: Request, source_id: str, revision: int):
        persistent(request)
        if set(request.query_params) != {"revision"}:
            raise HTTPException(status_code=400, detail="invalid_request")
        def operation():
            return {"ok": True}, store.delete_source(source_id, revision)
        return await service.mutate_sources(operation, "deleted")

    @app.get("/v1/collections")
    async def collections(request: Request):
        database = persistent(request)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        return {"collections": database.list_collections()}

    @app.put("/v1/collections/{collection_id}")
    async def sync_collection(request: Request, collection_id: str):
        value = await body(request, {"expected_revision", "label", "boundary", "documents"}, 24 * 1024 * 1024)
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        def operation():
            collection, affected = store.sync_collection(collection_id, **value)
            return {"collection": collection}, affected
        return await service.mutate_sources(operation, "updated", bounded_notifications=True)

    @app.put("/v1/collections/{collection_id}/availability")
    async def collection_availability(request: Request, collection_id: str):
        value = await body(request, {"available"})
        if value["available"] is not False or request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        def operation():
            collection, affected = store.collection_unavailable(collection_id)
            return {"collection": collection}, affected
        return await service.mutate_sources(operation, "deleted", preserve_history=True, bounded_notifications=True)

    @app.delete("/v1/collections/{collection_id}")
    async def delete_collection(request: Request, collection_id: str, revision: int):
        persistent(request)
        if set(request.query_params) != {"revision"}:
            raise HTTPException(status_code=400, detail="invalid_request")
        def operation():
            return {"ok": True}, store.delete_collection(collection_id, revision)
        return await service.mutate_sources(operation, "deleted", bounded_notifications=True)

    @app.get("/v1/screens")
    async def list_screens(request: Request):
        persistent(request)
        if request.query_params:
            raise ScreenError()
        return {"screens": await screens.list()}

    @app.get("/v1/screens/{capture_id}")
    async def get_screen(request: Request, capture_id: str):
        persistent(request)
        if request.query_params:
            raise ScreenError()
        return {"screen": await screens.get(capture_id)}

    @app.put("/v1/screens/{capture_id}")
    async def put_screen(request: Request, capture_id: str):
        persistent(request)
        if request.query_params:
            raise ScreenError()
        if screen_uploads.locked():
            raise ScreenError("screen_busy")
        async with screen_uploads:
            value = await body(request, {"expected_revision", "title", "boundary", "image_base64", "captured_at"}, MAX_UPLOAD_BODY)
            return await screens.put(capture_id, **value)

    @app.delete("/v1/screens/{capture_id}")
    async def delete_screen(request: Request, capture_id: str, revision: int):
        persistent(request)
        if set(request.query_params) != {"revision"}:
            raise ScreenError()
        return await screens.delete(capture_id, revision)

    @app.post("/v1/screens/{capture_id}/cancel")
    async def cancel_screen(request: Request, capture_id: str):
        value = await body(request, {"revision"})
        if request.query_params:
            raise ScreenError()
        return await screens.cancel(capture_id, value["revision"])

    async def run_screen_analysis(request: Request, capture_id: str, *, background=False):
        value = await body(request, {"revision", "model", "prompt"})
        if request.query_params:
            raise ScreenError()
        disconnected_event = asyncio.Event()

        async def disconnected():
            while True:
                event = await request.receive()
                if event["type"] == "http.disconnect":
                    disconnected_event.set()
                    raise ScreenError("screen_cancelled")

        disconnect_task = asyncio.create_task(disconnected())
        analysis_task = asyncio.create_task(screens.analyze(
            capture_id, **value, disconnected=disconnected_event, background=background))
        pending = {disconnect_task, analysis_task}
        screen_requests.update(pending)
        try:
            finished, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            return (disconnect_task if disconnect_task in finished else analysis_task).result()
        finally:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            screen_requests.difference_update(pending)

    @app.post("/v1/screens/{capture_id}/analyze")
    async def analyze_screen(request: Request, capture_id: str):
        return await run_screen_analysis(request, capture_id)

    @app.post("/v1/screens/{capture_id}/auto-analyze")
    async def auto_analyze_screen(request: Request, capture_id: str):
        return await run_screen_analysis(request, capture_id, background=True)

    @app.post("/v1/transcriptions")
    async def transcribe(request: Request):
        if not authenticated(request, config):
            raise HTTPException(status_code=401, detail="unauthorized")
        binding = config.transcription
        if binding is None:
            raise HTTPException(status_code=503, detail="transcription_unavailable")
        content_type = request.headers.get("content-type", "").lower()
        if content_type.split(";", 1)[0].strip() not in ("audio/webm", "audio/wav", "audio/x-wav"):
            raise HTTPException(status_code=415, detail="unsupported_audio")
        if request.query_params:
            raise HTTPException(status_code=400, detail="invalid_request")
        supplied_length = request.headers.get("content-length")
        if supplied_length is not None:
            try:
                length = int(supplied_length)
                if length < 0:
                    raise ValueError()
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid_request") from None
            if length > MAX_AUDIO_BYTES:
                raise HTTPException(status_code=413, detail="audio_limit")
        if transcription_slots.locked():
            raise HTTPException(status_code=429, detail="transcription_busy")
        async with transcription_slots:
            data = bytearray()
            async for part in request.stream():
                if len(data) + len(part) > MAX_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="audio_limit")
                data.extend(part)
            if not data:
                raise HTTPException(status_code=400, detail="empty_audio")

            async def run_transcription():
                async with asyncio.timeout(binding.timeout_seconds):
                    return normalize_transcript(await transcriber.transcribe(binding, bytes(data), content_type))

            async def disconnected():
                # The request body is fully consumed; only disconnect remains.
                # Direct receive preserves task cancellation across ASGI transports.
                while True:
                    event = await request.receive()
                    if event["type"] == "http.disconnect":
                        raise HTTPException(status_code=499, detail="transcription_cancelled")

            transcription_task = asyncio.create_task(run_transcription())
            disconnect_task = asyncio.create_task(disconnected())
            pending = {transcription_task, disconnect_task}
            transcription_tasks.update(pending)
            try:
                finished, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                # A simultaneous disconnect wins over a just-completed transcript.
                result = (disconnect_task if disconnect_task in finished else transcription_task).result()
                return {"text": result}
            except AudioError as error:
                code = "transcription_unavailable" if error.code == "transcription_unavailable" else "transcription_error"
                raise HTTPException(status_code=503 if code == "transcription_unavailable" else 422, detail=code) from None
            except TimeoutError:
                raise HTTPException(status_code=503, detail="transcription_unavailable") from None
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(status_code=503, detail="transcription_error") from None
            finally:
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                transcription_tasks.difference_update(pending)

    @app.websocket("/v1/chat")
    async def chat(websocket: WebSocket):
        if not authenticated(websocket, config):
            await websocket.close(code=1008, reason="unauthorized")
            return
        if set(websocket.query_params) - {"session_id", "conversation_id"}:
            await websocket.close(code=1008, reason="invalid_request")
            return
        previous = websocket.query_params.get("session_id")
        conversation_id = websocket.query_params.get("conversation_id")
        if previous is not None and (not previous or len(previous) > 128):
            await websocket.close(code=1008, reason="invalid_request")
            return
        if conversation_id is not None and (not conversation_id or len(conversation_id) > 128):
            await websocket.close(code=1008, reason="invalid_request")
            return
        await websocket.accept()
        session = None
        try:
            session = await service.open(websocket, previous, conversation_id)
            while True:
                raw = await websocket.receive_text()
                count = len(raw.encode("utf-8"))
                if count > config.max_message_bytes:
                    raise ProtocolFailure("session_limit")
                def reject_constant(_value):
                    raise ValueError("non_json_number")
                value = json.loads(raw, parse_constant=reject_constant)
                await service.receive(session, websocket, value, count)
        except WebSocketDisconnect:
            pass
        except (ProtocolFailure, StorageError, ContractValidationError, ValueError, TypeError) as error:
            reason = error.code if isinstance(error, (ProtocolFailure, StorageError)) else "invalid_request"
            if reason == "session_limit":
                reason = "fresh_session_required"
            try:
                await websocket.close(code=1008, reason=reason)
            except Exception:
                pass
        except Exception:
            # Invalid binary frames or a transport failure must not expose exceptions.
            try:
                await websocket.close(code=1008, reason="invalid_request")
            except Exception:
                pass
        finally:
            if session is not None:
                await service.detach(session, websocket)

    return app
