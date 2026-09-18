"""Bounded authenticated conversation, speech generation and playback lifetimes."""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import time
import unicodedata
import uuid
from contextlib import aclosing, AsyncExitStack
from dataclasses import dataclass, field

from kirian_contracts import parse_message

from .config import V1Config
from .policy import ContextSource, PolicyError, resolve_context
from .providers import ProviderChunk, ProviderError, TextProvider
from .session_external_tools import ExternalToolSessionMixin, tool_prompt
from .audio import AudioError, HTTPAudioProvider, SpeechProvider, trim_silence, validate_wav
from .storage import SQLiteStore, StorageError, SourceCatalog
from .routing import ModelRouter


class ProtocolFailure(ValueError):
    def __init__(self, code: str = "invalid_request"):
        self.code = code
        super().__init__(code)


def identifier() -> str:
    return uuid.uuid4().hex


def contains_letters_or_numbers(text: str) -> bool:
    """Classify a final decorative tail without modifying the original wire text."""
    return any(unicodedata.category(character)[0] in ("L", "N")
               for character in unicodedata.normalize("NFKC", text))


@dataclass
class Sentence:
    sentence_id: str
    sentence_index: int
    request_id: str
    text: str
    generated: bool = False
    chunks: int = 0
    playback: str = "idle"
    playback_request_id: str | None = None
    playback_sequence: int = 0


@dataclass
class Turn:
    turn_id: str
    intent_id: str
    text: str = ""
    status: str = "input"
    request_id: str | None = None
    next_sequence: int = 1
    response: str = ""
    response_complete: bool = False
    speech_expected: bool = False
    speech_finished: bool = False
    speech_consumed: int = 0
    sentences: dict[str, Sentence] = field(default_factory=dict)
    sources: list[dict] = field(default_factory=list)
    actual_model: dict | None = None
    routing_reason: str | None = None
    external_tool: object | None = None


@dataclass
class Session:
    scope: dict
    websocket: object
    touched: float = field(default_factory=time.monotonic)
    turns: dict[str, Turn] = field(default_factory=dict)
    tasks: dict[tuple[str, str], asyncio.Task] = field(default_factory=dict)
    fingerprints: dict[str, str] = field(default_factory=dict)
    request_ids: set[str] = field(default_factory=set)
    input_ids: set[str] = field(default_factory=set)
    history: list[dict] = field(default_factory=list)
    conversation_model: dict | None = None
    events: int = 0
    bytes: int = 0
    exhausted: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    conversation_id: str | None = None


class SessionService(ExternalToolSessionMixin):
    def __init__(self, config: V1Config, provider: TextProvider, catalog: dict[str, ContextSource], speech_provider: SpeechProvider | None = None, store: SQLiteStore | None = None):
        self.config = config
        self.provider = provider
        self.catalog = SourceCatalog(store, catalog) if store else catalog
        self.speech_provider = speech_provider or HTTPAudioProvider()
        self.sessions: dict[str, Session] = {}
        self.lock = asyncio.Lock()
        self.speech_slots = asyncio.Semaphore(2)
        self.store = store
        self.router = ModelRouter(config)
        self.auto_memory = None

    def effective_default(self):
        model = self.store.saved_default() if self.store else None
        return {"model": model, "source": "saved_default"} if model is not None else copy.deepcopy(self.config.default_selection)

    def persist_end(self, session: Session, turn: Turn, status: str, error_code=None):
        if self.store and session.conversation_id:
            self.store.end_turn(session.conversation_id, turn.turn_id, status, turn.response, error_code, turn.actual_model, turn.routing_reason)

    async def mutate_sources(self, operation, reason: str, conversation_id: str | None = None,
                             preserve_history: bool = False, bounded_notifications: bool = False):
        """Exclude new dispatch while originals, indexes and cached histories change."""
        cancelled = []
        async with self.lock, AsyncExitStack() as locks:
            for session in self.sessions.values():
                await locks.enter_async_context(session.lock)
            result, affected = operation()
            for session in self.sessions.values():
                async def notify(message):
                    try:
                        await self.write(session, message)
                    except Exception:
                        # The committed HTTP mutation must still return its actual result.
                        # Do not close the shared connection and abort the caller's REST request.
                        session.exhausted = True
                deleted_conversation = conversation_id is not None and session.conversation_id == conversation_id
                for turn in session.turns.values():
                    if deleted_conversation or any(ref["source_id"] in affected for ref in turn.sources):
                        if turn.status in ("input", "running"):
                            turn.status = "failed"
                            self.cancel_turn_tasks(session, turn)
                            cancelled.extend(task for (key, _), task in session.tasks.items() if key == turn.turn_id)
                            code = "source_changed"
                            if preserve_history:
                                try:
                                    self.persist_end(session, turn, "failed", code)
                                except StorageError:
                                    code = "storage_unavailable"
                            if session.websocket is not None:
                                await notify(self.message(session, "turn.ended", {"status": "failed", "error_code": code}, turn))
                        if not preserve_history:
                            turn.text = turn.response = ""
                if deleted_conversation:
                    session.history = []
                elif session.conversation_id:
                    try:
                        session.history = self.store.history(session.conversation_id, self.config.max_history_messages, self.config.max_history_characters)
                    except StorageError as error:
                        if error.code != "not_found":
                            raise
                        session.history = []
                else:
                    session.history = [row for row in session.history if not any(ref["source_id"] in affected for ref in row.get("sources", []))]
                if session.websocket is not None:
                    notifications = affected
                    if bounded_notifications and len(affected) > 128:
                        # One invalidation already makes the client reload its entire library.
                        # Cancellation above still covers every affected turn, independent of fanout.
                        relevant = {ref["source_id"] for turn in session.turns.values() for ref in turn.sources
                                    if ref["source_id"] in affected}
                        notifications = set(sorted(relevant)[:127]) | {min(affected)}
                    for source_id in sorted(notifications):
                        record = self.catalog[source_id].record
                        await notify(self.message(session, "context.invalidated", {
                            "source_id": source_id, "revision": record["revision"],
                            "reason": "deleted" if record["deleted"] else "updated",
                        }))
        if cancelled:
            await asyncio.gather(*cancelled, return_exceptions=True)
        return result

    def message(self, session: Session, kind: str, payload: dict, turn: Turn | None = None, request_id: str | None = None, sequence: int = 0) -> dict:
        return {
            "protocol": "kirian.rearchitecture.v1", "message_id": "server-" + identifier(),
            "request_id": request_id or "server-request-" + identifier(), "scope": copy.deepcopy(session.scope),
            "kind": kind, "turn_id": turn.turn_id if turn else None, "intent_id": turn.intent_id if turn else None,
            "sequence": sequence, "payload": payload,
        }

    def charge(self, session: Session, size: int):
        if session.exhausted or session.events >= self.config.max_events or size > self.config.max_bytes - session.bytes:
            session.exhausted = True
            raise ProtocolFailure("session_limit")
        session.events += 1
        session.bytes += size
        session.touched = time.monotonic()

    @staticmethod
    def fingerprint(message: dict) -> str:
        return hashlib.sha256(json.dumps(message, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()

    async def write(self, session: Session, message: dict):
        """Caller owns session.lock; validate every outgoing envelope, including echoes."""
        validated = parse_message(message)
        raw = json.dumps(validated, ensure_ascii=False, separators=(",", ":"))
        if validated["kind"] != "speech.chunk":
            self.charge(session, len(raw.encode("utf-8")))
            fingerprint = self.fingerprint(validated)
            previous = session.fingerprints.get(validated["message_id"])
            if previous is not None and previous != fingerprint:
                raise ProtocolFailure()
            session.fingerprints[validated["message_id"]] = fingerprint
        # Streamed audio is bounded per sentence by validate_wav and per turn by the response limits.
        # Charging it to the session budget closed every voice session after about three minutes of
        # speech; chunk envelopes carry fresh server ids, so the echo fingerprint map is not needed.
        if session.websocket is None:
            raise ProtocolFailure()
        await session.websocket.send_text(raw)

    async def open(self, websocket, previous_id: str | None, conversation_id: str | None = None) -> Session:
        await self.expire()
        cancelled = []
        async with self.lock:
            session = self.sessions.get(previous_id) if previous_id else None
            if previous_id and (session is None or session.exhausted):
                raise ProtocolFailure("fresh_session_required")
            if session is not None and conversation_id is not None and session.conversation_id != conversation_id:
                raise ProtocolFailure("invalid_request")
            if self.store is None and conversation_id is not None:
                raise ProtocolFailure("invalid_request")
            if self.store:
                target_id = session.conversation_id if session is not None else conversation_id
                if target_id:
                    self.store.get_conversation(target_id)
                    # A durable conversation has one active transport owner at a time.
                    for previous in list(self.sessions.values()):
                        if previous is not session and previous.conversation_id == target_id and previous.websocket is not None:
                            await self.close(previous, "replaced_connection")
            if session is None:
                if self.store and len(self.sessions) >= self.config.max_sessions:
                    inactive = [item for item in self.sessions.values() if item.websocket is None]
                    if inactive:
                        oldest = min(inactive, key=lambda item: item.touched)
                        del self.sessions[oldest.scope["session_id"]]
                if len(self.sessions) >= self.config.max_sessions:
                    raise ProtocolFailure("session_limit")
                scope = {
                    **copy.deepcopy(self.config.identity), "session_id": identifier(),
                    "connection_id": identifier(), "connection_epoch": 0,
                }
                session = Session(scope, websocket)
                if self.store:
                    conversation = self.store.get_conversation(conversation_id) if conversation_id else self.store.create_conversation()
                    session.conversation_id = conversation["id"]
                    session.conversation_model = conversation["model"]
                    session.history = self.store.history(session.conversation_id, self.config.max_history_messages, self.config.max_history_characters)
                self.sessions[scope["session_id"]] = session
                resume = "new_session"
            else:
                async with session.lock:
                    if session.exhausted:
                        raise ProtocolFailure("fresh_session_required")
                    old = session.websocket
                    cancelled = self.cancel_active(session)
                    session.websocket = None
                    if old is not None:
                        try:
                            await old.close(code=1000, reason="replaced_connection")
                        except Exception:
                            pass
                    session.scope = {
                        **session.scope, "connection_id": identifier(),
                        "connection_epoch": session.scope["connection_epoch"] + 1,
                    }
                    session.websocket = websocket
                    session.touched = time.monotonic()
                resume = "turns_cancelled"
            async with session.lock:
                await self.write(session, self.message(session, "session.ready", {
                    "client_kind": "web" if self.config.identity["mode"] == "public_demo" else "electron", "resume": resume,
                    "capabilities": ["text"] + (["audio_output"] if self.config.speech is not None else []),
                }))
        if cancelled:
            await asyncio.gather(*cancelled, return_exceptions=True)
        return session

    def cancel_active(self, session: Session) -> list[asyncio.Task]:
        for turn in session.turns.values():
            if turn.status in ("input", "running"):
                turn.status = "cancelled"
                try:
                    self.persist_end(session, turn, "cancelled")
                except StorageError:
                    pass  # Transport cleanup still cancels work; startup marks interrupted rows.
        tasks = [task for task in session.tasks.values() if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        return tasks

    async def detach(self, session: Session, websocket):
        async with session.lock:
            if session.websocket is not websocket:
                return
            tasks = self.cancel_active(session)
            session.websocket = None
            session.touched = time.monotonic()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def expire(self):
        expired = []
        async with self.lock:
            now = time.monotonic()
            for key, session in list(self.sessions.items()):
                if now - session.touched >= self.config.session_ttl_seconds:
                    del self.sessions[key]
                    expired.append(session)
        for session in expired:
            await self.close(session, "expired")

    async def close(self, session: Session, reason: str):
        async with session.lock:
            tasks = self.cancel_active(session)
            websocket, session.websocket = session.websocket, None
            if websocket is not None:
                try:
                    await websocket.close(code=1008, reason=reason)
                except Exception:
                    pass
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def shutdown(self):
        for session in list(self.sessions.values()):
            await self.close(session, "shutdown")
        self.sessions.clear()

    def task(self, session: Session, turn: Turn, name: str, coroutine):
        key = (turn.turn_id, name)
        task = asyncio.create_task(coroutine)
        session.tasks[key] = task
        def done(finished):
            if session.tasks.get(key) is finished:
                session.tasks.pop(key, None)
        task.add_done_callback(done)
        return task

    @staticmethod
    def cancel_turn_tasks(session: Session, turn: Turn):
        for (turn_id, _), task in list(session.tasks.items()):
            if turn_id == turn.turn_id and task is not asyncio.current_task():
                task.cancel()

    async def fail_turn_locked(self, session: Session, turn: Turn, code: str):
        """Caller holds lock. A failed terminal write propagates to the transport owner."""
        if turn.status != "running":
            return
        turn.status = "failed"
        self.cancel_turn_tasks(session, turn)
        try:
            self.persist_end(session, turn, "failed", code)
        except StorageError:
            code = "storage_unavailable"
        await self.write(session, self.message(session, "turn.ended", {"status": "failed", "error_code": code}, turn))

    async def complete_turn_locked(self, session: Session, turn: Turn):
        if turn.status != "running" or not turn.response_complete:
            return
        if turn.speech_expected and (not turn.speech_finished or any(not row.generated or row.playback != "completed" for row in turn.sentences.values())):
            return
        self.persist_end(session, turn, "completed")
        await self.write(session, self.message(session, "turn.ended", {"status": "completed"}, turn))
        turn.status = "completed"
        self.cancel_turn_tasks(session, turn)

    async def receive(self, session: Session, websocket, value: dict, byte_count: int):
        message = parse_message(value)
        async with session.lock:
            if session.websocket is not websocket:
                raise ProtocolFailure("stale_connection")
            self.charge(session, byte_count)
            if message["scope"] != session.scope:
                raise ProtocolFailure()
            if message["kind"] not in ("input.finished", "turn.start", "turn.cancel", "speech.request", "speech.finished", "playback.state", "tool.offers", "tool.resolved"):
                raise ProtocolFailure()
            fingerprint = self.fingerprint(message)
            prior = session.fingerprints.get(message["message_id"])
            if prior is not None:
                if prior != fingerprint:
                    raise ProtocolFailure()
                await self.write(session, message)
                return
            turn = session.turns.get(message["turn_id"])
            if turn is not None and turn.intent_id != message["intent_id"]:
                raise ProtocolFailure()
            if message["kind"] in ("speech.request", "speech.finished", "playback.state"):
                await self.receive_speech_locked(session, turn, message, fingerprint)
                return
            if message["kind"] in ("tool.offers", "tool.resolved"):
                await self.receive_tools_locked(session, turn, message, fingerprint)
                return
            if message["sequence"] != 0 or message["request_id"] in session.request_ids:
                raise ProtocolFailure()
            if message["kind"] == "input.finished":
                payload = message["payload"]
                if turn is not None or payload["kind"] != "text" or not payload["text"].strip() or payload["input_id"] in session.input_ids:
                    raise ProtocolFailure()
                turn = Turn(message["turn_id"], message["intent_id"], payload["text"])
                if self.store:
                    self.store.begin_turn(session.conversation_id, turn.turn_id, turn.text)
                session.turns[turn.turn_id] = turn
                session.input_ids.add(payload["input_id"])
            elif message["kind"] == "turn.start":
                if turn is None or turn.status != "input":
                    raise ProtocolFailure()
                turn.request_id = message["request_id"]
                turn.status = "running"
                turn.speech_expected = message["payload"].get("speech", False)
            else:
                if turn is None:
                    turn = Turn(message["turn_id"], message["intent_id"])
                    session.turns[turn.turn_id] = turn
                if turn.status in ("completed", "failed", "cancelled"):
                    # Terminal work is not revived and an execution is never implied.
                    session.request_ids.add(message["request_id"])
                    session.fingerprints[message["message_id"]] = fingerprint
                    await self.write(session, message)
                    return
                turn.status = "cancelled"
                self.cancel_turn_tasks(session, turn)
                self.persist_end(session, turn, "cancelled")
            session.request_ids.add(message["request_id"])
            session.fingerprints[message["message_id"]] = fingerprint
            await self.write(session, message)
            if message["kind"] == "turn.cancel":
                await self.write(session, self.message(session, "turn.ended", {"status": "cancelled"}, turn))
            elif message["kind"] == "turn.start":
                self.task(session, turn, "llm", self.prepare_generation(session, turn, message["payload"], session.scope["connection_id"]))

    async def prepare_generation(self, session: Session, turn: Turn, payload: dict, connection_id: str):
        def current():
            return session.websocket is not None and session.scope["connection_id"] == connection_id and turn.status == "running"
        try:
            async with session.lock:
                if not current():
                    return
                if sum(item.status == "running" for item in session.turns.values()) > 4:
                    raise PolicyError("session_limit")
                if self.store:
                    session.conversation_model = self.store.get_conversation(session.conversation_id)["model"]
                    session.history = self.store.history(session.conversation_id, self.config.max_history_messages, self.config.max_history_characters)
                selection, history = payload["selection"], copy.deepcopy(session.history)
                effective_default = self.effective_default()
                items = payload["context"]
                def choose(context_items):
                    return self.router.choose(selection=selection, conversation_model=session.conversation_model,
                        effective_default=effective_default, items=context_items, catalog=self.catalog, history=history,
                        candidates=payload.get("routing_candidates"))
                initial = choose(items)
                if initial.automatic and "routing_candidates" not in payload:
                    raise PolicyError("routing_changed")
                # Invalidation can cancel preparation while retrieval is in flight.
                turn.sources = copy.deepcopy(initial.sources)
                if turn.speech_expected and self.config.speech is None:
                    raise PolicyError("speech_unavailable")
            if self.auto_memory is not None:
                async with asyncio.timeout(self.config.turn_timeout_seconds):
                    items = await self.auto_memory.related(turn.text, items, history)
            async with session.lock:
                if not current():
                    return
                if self.router.snapshot()["revision"] != initial.revision or self.effective_default() != effective_default:
                    raise PolicyError("routing_changed")
                decision = choose(items)
                context, sources = decision.context, decision.sources
                turn.sources = copy.deepcopy(sources)
                if self.store:
                    self.store.start_turn(session.conversation_id, turn.turn_id, sources)
                if selection["source"] == "conversation":
                    session.conversation_model = copy.deepcopy(selection["model"])
                elif selection == effective_default:
                    session.conversation_model = None
                if self.store and (selection["source"] == "conversation" or selection == effective_default):
                    self.store.set_conversation_model(session.conversation_id, session.conversation_model)
            if payload.get("external_tools") is True and decision.binding.supports_tools and self.store is not None:
                await self.prepare_external_turn(session, turn, decision, history, connection_id)
            else:
                await self.generate(session, turn, decision, context, sources, history, connection_id)
        except asyncio.CancelledError:
            return
        except Exception as error:
            code = error.code if isinstance(error, (PolicyError, StorageError)) else ("turn_timeout" if isinstance(error, TimeoutError) else "provider_error")
            await self.background_failure(session, turn, connection_id, "source_changed" if code == "not_found" else code)

    async def receive_speech_locked(self, session: Session, turn: Turn | None, message: dict, fingerprint: str):
        if turn is None or not turn.speech_expected:
            raise ProtocolFailure()
        if turn.status in ("cancelled", "failed", "completed"):
            return  # Late client callbacks do not revive cancelled work.
        if turn.status != "running":
            raise ProtocolFailure()
        kind, payload = message["kind"], message["payload"]
        if kind != "playback.state" and (message["sequence"] != 0 or message["request_id"] in session.request_ids):
            raise ProtocolFailure()
        if kind == "speech.request":
            binding = self.config.speech
            if binding is None or payload["model"] != binding.model:
                raise ProtocolFailure()
            text = payload["text"]
            if (turn.speech_finished or len(turn.sentences) >= 128 or payload["sentence_id"] in turn.sentences
                    or payload["sentence_index"] != len(turn.sentences) or len(text) > 1500 or not text.strip()
                    or not turn.response[turn.speech_consumed:].startswith(text)):
                raise ProtocolFailure()
            if sum(not sentence.generated for row in session.turns.values() if row.status == "running" for sentence in row.sentences.values()) >= 4:
                raise ProtocolFailure()
            try:
                resolve_context(self.config, binding, [], self.catalog, [{"sources": turn.sources}])
            except PolicyError:
                await self.fail_turn_locked(session, turn, "context_blocked")
                return
            sentence = Sentence(payload["sentence_id"], payload["sentence_index"], message["request_id"], text)
            turn.sentences[sentence.sentence_id] = sentence
            turn.speech_consumed += len(text)
        elif kind == "speech.finished":
            if (not turn.response_complete or turn.speech_finished or payload["sentence_count"] != len(turn.sentences)
                    or contains_letters_or_numbers(turn.response[turn.speech_consumed:])):
                raise ProtocolFailure()
            turn.speech_finished = True
        else:
            sentence = turn.sentences.get(payload["sentence_id"])
            if sentence is None:
                raise ProtocolFailure()
            if sentence.playback_request_id is None:
                if message["request_id"] in session.request_ids:
                    raise ProtocolFailure()
            elif message["request_id"] != sentence.playback_request_id:
                raise ProtocolFailure()
            if message["sequence"] != sentence.playback_sequence:
                raise ProtocolFailure()
            next_state = payload["state"]
            valid = ((sentence.playback == "idle" and next_state == "queued")
                     or (sentence.playback == "queued" and next_state in ("playing", "cancelled", "failed"))
                     or (sentence.playback == "playing" and next_state in ("completed", "cancelled", "failed")))
            if not valid:
                raise ProtocolFailure()
            if next_state == "playing" and (not sentence.chunks or any(row.sentence_index < sentence.sentence_index and row.playback != "completed" for row in turn.sentences.values())):
                raise ProtocolFailure()
            if next_state == "completed" and not sentence.generated:
                raise ProtocolFailure()
            sentence.playback_request_id = message["request_id"]
            sentence.playback_sequence += 1
            sentence.playback = next_state
        session.request_ids.add(message["request_id"])
        session.fingerprints[message["message_id"]] = fingerprint
        await self.write(session, message)
        if kind == "speech.request":
            self.task(session, turn, "speech:" + sentence.sentence_id,
                      self.generate_speech(session, turn, sentence, session.scope["connection_id"]))
        elif kind == "playback.state" and payload["state"] in ("failed", "cancelled"):
            await self.fail_turn_locked(session, turn, "playback_failed")
        else:
            await self.complete_turn_locked(session, turn)

    async def background_failure(self, session: Session, turn: Turn, connection_id: str, code: str):
        close_required = False
        async with session.lock:
            if session.websocket is not None and session.scope["connection_id"] == connection_id and turn.status == "running":
                try:
                    await self.fail_turn_locked(session, turn, code)
                except Exception:
                    session.exhausted = True
                    close_required = True
        if close_required:
            await self.close(session, "fresh_session_required")

    async def generate_speech(self, session: Session, turn: Turn, sentence: Sentence, connection_id: str):
        binding = self.config.speech
        try:
            async with asyncio.timeout(binding.timeout_seconds):
                async with self.speech_slots:
                    async with session.lock:
                        if session.websocket is None or session.scope["connection_id"] != connection_id or turn.status != "running":
                            return
                        resolve_context(self.config, binding, [], self.catalog, [{"sources": turn.sources}])
                    audio = await self.speech_provider.synthesize(binding, sentence.text)
                    # Validate injected providers too; sample rate comes from decoded metadata.
                    audio = trim_silence(validate_wav(audio.data))
                    async with session.lock:
                        if session.websocket is None or session.scope["connection_id"] != connection_id or turn.status != "running":
                            return
                        for index, offset in enumerate(range(0, len(audio.data), 48 * 1024), start=1):
                            part = audio.data[offset:offset + 48 * 1024]
                            final = offset + len(part) == len(audio.data)
                            await self.write(session, self.message(session, "speech.chunk", {
                                "sentence_id": sentence.sentence_id, "sentence_index": sentence.sentence_index,
                                "codec": "wav", "sample_rate_hz": audio.sample_rate_hz,
                                "audio_base64": base64.b64encode(part).decode("ascii"), "final": final,
                            }, turn, sentence.request_id, index))
                            sentence.chunks += 1
                        sentence.generated = True
        except asyncio.CancelledError:
            return
        except ProtocolFailure:
            await self.close(session, "fresh_session_required")
        except Exception as error:
            code = "context_blocked" if isinstance(error, PolicyError) else (
                "speech_unavailable" if isinstance(error, TimeoutError) or isinstance(error, AudioError) and error.code == "speech_unavailable" else "speech_error")
            await self.background_failure(session, turn, connection_id, code)

    async def playback_timeout(self, session: Session, turn: Turn, connection_id: str):
        try:
            await asyncio.sleep(self.config.speech_turn_timeout_seconds)
            await self.background_failure(session, turn, connection_id, "playback_failed")
        except asyncio.CancelledError:
            return

    async def generate(self, session: Session, turn: Turn, decision, context: str, sources: list[dict], history: list[dict], connection_id: str,
                       *, offers=None, fixed_text=None, reservation_suffix="", user_input=None):
        binding = decision.binding
        user_text = turn.text if user_input is None else user_input
        try:
            async with asyncio.timeout(self.config.turn_timeout_seconds):
                prompt = self.config.system_prompt + ("\n\n참고 맥락:\n" + context if context else "")
                if offers is not None:
                    prompt += "\n\n" + tool_prompt()
                done = False
                if session.websocket is None or session.scope["connection_id"] != connection_id or turn.status != "running":
                    return
                if fixed_text is None:
                    self.router.reserve(decision, "chat:" + session.scope["session_id"] + ":" + turn.request_id + reservation_suffix, self.catalog)
                if fixed_text is not None:
                    async def fixed_response():
                        yield ProviderChunk(fixed_text, binding.model["model_id"], True)
                    response_stream = fixed_response()
                elif offers is not None:
                    response_stream = self.provider.stream_tools(binding, turn.text, prompt, history, offers)
                else:
                    response_stream = self.provider.stream(binding, user_text, prompt, history)
                async with aclosing(response_stream) as stream:
                    async for chunk in stream:
                        if not isinstance(chunk.text, str) or type(chunk.done) is not bool:
                            raise ProviderError()
                        if chunk.reported_model != binding.model["model_id"]:
                            raise ProviderError("model_mismatch")
                        turn.actual_model = copy.deepcopy(binding.model)
                        turn.routing_reason = decision.reason
                        async with session.lock:
                            if session.websocket is None or session.scope["connection_id"] != connection_id or turn.status != "running":
                                return
                            if getattr(chunk, "tool_call", None) is not None:
                                if offers is None:
                                    raise ProviderError()
                                await self.propose_external_tool_locked(session, turn, chunk, offers)
                                return True
                            if len(turn.response) + len(chunk.text) > self.config.max_response_characters:
                                raise ProviderError("response_limit")
                            if chunk.text:
                                turn.response += chunk.text
                                await self.write(session, self.message(session, "response.delta", {
                                    "text": chunk.text, "actual_model": copy.deepcopy(binding.model),
                                    "routing_reason": decision.reason,
                                }, turn, turn.request_id, turn.next_sequence))
                                turn.next_sequence += 1
                            if chunk.done:
                                done = True
                                break
                if not done:
                    raise ProviderError("incomplete_response")
                if not turn.response.strip():
                    raise ProviderError("empty_response")
                async with session.lock:
                    if session.websocket is None or session.scope["connection_id"] != connection_id or turn.status != "running":
                        return
                    if self.store:
                        self.store.complete_response(session.conversation_id, turn.turn_id, turn.response, binding.model, sources, decision.reason)
                    await self.write(session, self.message(session, "response.completed", {
                        "actual_model": copy.deepcopy(binding.model),
                        "routing_reason": decision.reason,
                    }, turn, turn.request_id, turn.next_sequence))
                    turn.response_complete = True
                    session.history += [
                        {"role": "user", "content": turn.text, "sources": copy.deepcopy(sources)},
                        {"role": "assistant", "content": turn.response, "sources": copy.deepcopy(sources)},
                    ]
                    while len(session.history) > self.config.max_history_messages or sum(len(row["content"]) for row in session.history) > self.config.max_history_characters:
                        session.history.pop(0)
                    if self.auto_memory is not None and session.conversation_id:
                        self.auto_memory.schedule_turn(session.conversation_id, turn.turn_id, copy.deepcopy(history))
                    if turn.speech_expected:
                        self.task(session, turn, "playback-timeout", self.playback_timeout(session, turn, connection_id))
                    await self.complete_turn_locked(session, turn)
        except asyncio.CancelledError:
            return
        except ProtocolFailure:
            await self.close(session, "fresh_session_required")
        except Exception as error:
            safe = error.code if isinstance(error, (ProviderError, PolicyError, StorageError)) else ("turn_timeout" if isinstance(error, TimeoutError) else "provider_error")
            allowed = {"provider_unavailable", "provider_error", "model_mismatch", "incomplete_response", "empty_response", "response_limit", "turn_timeout", "source_changed", "storage_unavailable", "context_blocked", "routing_changed", "routing_limit", "routing_duplicate_call", "persistence_unavailable"}
            if safe not in allowed:
                safe = "provider_error"
            await self.background_failure(session, turn, connection_id, safe)
