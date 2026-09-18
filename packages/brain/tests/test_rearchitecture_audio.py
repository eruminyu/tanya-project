"""Synthetic PCM and HTTP fixtures validate transport/policy, not voice quality."""
import asyncio
import base64
import copy
import io
import json
import time
import wave
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from rearchitecture.app import create_app
from rearchitecture.audio import AudioError, HTTPAudioProvider, SpeechAudio, validate_wav
from rearchitecture.config import ConfigError, SpeechBinding, TranscriptionBinding, V1Config
from rearchitecture.session import contains_letters_or_numbers
from tests.test_rearchitecture_app import HEADERS, IDENTITY, MODEL, TOKEN, FixtureProvider, config, message, source


VOICE_MODEL = {"provider_id": "qwen3-tts", "model_id": "fixture-voice", "endpoint_id": "fixture-tts"}
VOICE = SpeechBinding(VOICE_MODEL, "Synthetic voice fixture", "http://127.0.0.1:19882/tts", "local",
                      "Korean", "Sohee", instruct="synthetic instruct")
STT = TranscriptionBinding("http://127.0.0.1:8098/stt/transcriptions", "local", "Synthetic STT fixture")


def wav_bytes(frames=40000):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(32000)
        audio.writeframes(b"\x01\x00" * frames)
    return output.getvalue()


class FixtureSpeech:
    def __init__(self, *, block=False, error=None):
        self.calls = []
        self.block, self.error, self.closed = block, error, False

    async def synthesize(self, binding, text):
        self.calls.append((binding, text))
        try:
            if self.block:
                await asyncio.Event().wait()
            if self.error:
                raise AudioError(self.error)
            return SpeechAudio(wav_bytes(), 123)  # Backend must derive rate from WAV.
        finally:
            self.closed = True


def audio_client(speech=None, provider=None, catalog=None, **kwargs):
    return TestClient(create_app(config(speech=VOICE, **kwargs), provider or FixtureProvider(), catalog,
                                 speech_provider=speech or FixtureSpeech()), client=("127.0.0.1", 50100))


def start_voice(ws, scope, context=None):
    incoming = message(scope, "input.finished", {"input_id": "input-1", "kind": "text", "text": "hello"}, 1)
    ws.send_json(incoming)
    assert ws.receive_json() == incoming
    started = message(scope, "turn.start", {"selection": {"model": MODEL, "source": "initial_local"}, "context": context or [], "speech": True}, 2)
    ws.send_json(started)
    assert ws.receive_json() == started
    return started


def response_done(ws):
    rows = []
    while True:
        row = ws.receive_json()
        rows.append(row)
        if row["kind"] == "response.completed":
            return rows


def speech_request(scope, index=0, text="fixture answer", number=10):
    return message(scope, "speech.request", {"sentence_id": f"sentence-{index}", "sentence_index": index, "text": text, "model": VOICE_MODEL}, number)


def receive_audio(ws):
    rows = []
    while True:
        row = ws.receive_json()
        rows.append(row)
        if row["kind"] == "speech.chunk" and row["payload"]["final"]:
            return rows


def playback(ws, scope, sentence=0, number=30, states=("queued", "playing", "completed")):
    for sequence, state in enumerate(states):
        row = message(scope, "playback.state", {"sentence_id": f"sentence-{sentence}", "state": state},
                      number + sequence, request_id=f"playback-{sentence}", sequence=sequence)
        ws.send_json(row)
        assert ws.receive_json() == row


def test_voice_turn_waits_for_submission_and_actual_playback_with_chunk_metadata_and_dedup():
    speech = FixtureSpeech()
    with audio_client(speech) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        ready = ws.receive_json()
        assert "audio_output" in ready["payload"]["capabilities"]
        scope = ready["scope"]
        start_voice(ws, scope)
        rows = response_done(ws)
        assert all(row["kind"] != "turn.ended" for row in rows)
        active = http.app.state.v1_service.sessions[scope["session_id"]].turns["turn-1"]
        assert active.status == "running"
        request = speech_request(scope)
        ws.send_json(request)
        assert ws.receive_json() == request
        chunks = receive_audio(ws)
        assert [row["sequence"] for row in chunks] == list(range(1, len(chunks) + 1))
        assert all(row["request_id"] == request["request_id"] for row in chunks)
        assert all(row["payload"]["sample_rate_hz"] == 32000 for row in chunks)
        assert all(len(base64.b64decode(row["payload"]["audio_base64"])) <= 48 * 1024 for row in chunks)
        assert b"".join(base64.b64decode(row["payload"]["audio_base64"]) for row in chunks) == wav_bytes()
        assert all(not row["payload"]["final"] for row in chunks[:-1])
        ws.send_json(request)
        assert ws.receive_json() == request
        assert len(speech.calls) == 1
        finished = message(scope, "speech.finished", {"sentence_count": 1}, 20)
        ws.send_json(finished)
        assert ws.receive_json() == finished
        assert active.status == "running"
        playback(ws, scope)
        assert ws.receive_json()["payload"] == {"status": "completed"}


@pytest.mark.parametrize("mutation", ["prefix", "model", "index", "length", "early-finish"])
def test_client_cannot_synthesize_unrelated_text_or_forge_voice_binding(mutation):
    speech = FixtureSpeech()
    with audio_client(speech) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        request = speech_request(scope)
        if mutation == "prefix":
            request["payload"]["text"] = "unrelated private text"
        elif mutation == "model":
            request["payload"]["model"] = VOICE_MODEL | {"model_id": "unlisted"}
        elif mutation == "index":
            request["payload"]["sentence_index"] = 1
        elif mutation == "length":
            request["payload"]["text"] = "x" * 1501
        else:
            request = message(scope, "speech.finished", {"sentence_count": 0}, 10)
        ws.send_json(request)
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert speech.calls == []


def test_lossless_prefix_and_trailing_whitespace_are_accepted():
    with audio_client(provider=FixtureProvider(text=" leading text \n")) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        request = speech_request(scope, text=" leading text")
        ws.send_json(request)
        assert ws.receive_json() == request
        receive_audio(ws)
        playback(ws, scope)
        finished = message(scope, "speech.finished", {"sentence_count": 1}, 50)
        ws.send_json(finished)
        assert ws.receive_json() == finished
        assert ws.receive_json()["payload"] == {"status": "completed"}


@pytest.mark.parametrize("tail", [")", " 😊", "。？！\n", " \u200d\ufe0f"], ids=["closing-parenthesis", "emoji", "punctuation", "decorative-marks"])
def test_finished_allows_only_final_decorative_tail_after_real_speech(tail):
    speech = FixtureSpeech()
    prefix = "안녕하세요, 저는 키리안이에요! (제 목소리가 느껴지시나요?"
    with audio_client(speech, provider=FixtureProvider(text=prefix + tail)) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        request = speech_request(scope, text=prefix)
        ws.send_json(request)
        assert ws.receive_json() == request
        receive_audio(ws)
        playback(ws, scope)
        finished = message(scope, "speech.finished", {"sentence_count": 1}, 50)
        ws.send_json(finished)
        assert ws.receive_json() == finished
        assert ws.receive_json()["payload"] == {"status": "completed"}
    assert [call[1] for call in speech.calls] == [prefix]


@pytest.mark.parametrize("tail", [" 다음 말", "3kg", "①", "Ⅳ", "㎏", "ⓐ", "Ⓐ", "1️⃣"],
                         ids=["korean", "unit-number", "circled-number", "roman-number", "compatibility-unit", "circled-letter", "enclosed-letter", "keycap"])
def test_finished_cannot_omit_letters_numbers_or_compatibility_characters(tail):
    assert contains_letters_or_numbers(tail)
    with audio_client(provider=FixtureProvider(text=tail)) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        ws.send_json(message(scope, "speech.finished", {"sentence_count": 0}, 50))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_middle_decorations_cannot_be_omitted_from_exact_response_prefix():
    with audio_client(provider=FixtureProvider(text="first 😊 second")) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        first = speech_request(scope, text="first")
        ws.send_json(first)
        assert ws.receive_json() == first
        receive_audio(ws)
        ws.send_json(speech_request(scope, index=1, text="second", number=11))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_entire_decorative_response_closes_without_inventing_synthesis_or_playback():
    speech = FixtureSpeech()
    with audio_client(speech, provider=FixtureProvider(text="😊")) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        finished = message(scope, "speech.finished", {"sentence_count": 0}, 50)
        ws.send_json(finished)
        assert ws.receive_json() == finished
        assert ws.receive_json()["payload"] == {"status": "completed"}
    assert speech.calls == []


def test_tts_revalidates_direct_and_inherited_context_boundary_before_http():
    speech = FixtureSpeech()
    catalog = {"note-1": source()}
    lan_voice = replace(VOICE, boundary="private_lan")
    app = create_app(config(speech=lan_voice), FixtureProvider(), catalog, speech_provider=speech)
    with TestClient(app, client=("127.0.0.1", 50100)) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope, [{"source_id": "note-1", "revision": 1, "text": catalog["note-1"].text}])
        response_done(ws)
        ws.send_json(speech_request(scope))
        assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "context_blocked"}
    assert not speech.calls


def test_deleted_source_after_llm_completion_blocks_speech():
    speech = FixtureSpeech()
    catalog = {"note-1": source()}
    with audio_client(speech, catalog=catalog) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope, [{"source_id": "note-1", "revision": 1, "text": catalog["note-1"].text}])
        response_done(ws)
        catalog["note-1"].record["deleted"] = True
        ws.send_json(speech_request(scope))
        assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "context_blocked"}
    assert not speech.calls


@pytest.mark.parametrize("code", ["speech_unavailable", "speech_error"])
def test_speech_failure_preserves_visible_text_and_never_completes_turn(code):
    speech = FixtureSpeech(error=code)
    with audio_client(speech) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        assert response_done(ws)[0]["payload"]["text"] == "fixture answer"
        request = speech_request(scope)
        ws.send_json(request)
        assert ws.receive_json() == request
        assert ws.receive_json()["payload"] == {"status": "failed", "error_code": code}


@pytest.mark.parametrize("operation", ["cancel", "reconnect"])
def test_cancel_and_reconnect_close_pending_synthesis_without_late_audio(operation):
    speech = FixtureSpeech(block=True)
    with audio_client(speech) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        request = speech_request(scope)
        ws.send_json(request)
        assert ws.receive_json() == request
        time.sleep(0.02)
        assert len(speech.calls) == 1
        if operation == "cancel":
            cancel = message(scope, "turn.cancel", {"reason": "user"}, 90)
            ws.send_json(cancel)
            assert ws.receive_json() == cancel
            assert ws.receive_json()["payload"] == {"status": "cancelled"}
        else:
            with http.websocket_connect("/v1/chat?session_id=" + scope["session_id"], headers=HEADERS) as replacement:
                assert replacement.receive_json()["payload"]["resume"] == "turns_cancelled"
                with pytest.raises(WebSocketDisconnect):
                    ws.receive_json()
        time.sleep(0.01)
        assert speech.closed


def test_missing_renderer_completion_times_out_and_cleans_tasks():
    with audio_client(speech_turn_timeout_seconds=0.02) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        assert ws.receive_json()["payload"] == {"status": "failed", "error_code": "playback_failed"}


def test_playback_cannot_reuse_speech_request_family():
    with audio_client() as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        request = speech_request(scope)
        ws.send_json(request)
        assert ws.receive_json() == request
        receive_audio(ws)
        ws.send_json(message(scope, "playback.state", {"sentence_id": "sentence-0", "state": "queued"}, 30, request_id=request["request_id"]))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_later_sentence_cannot_play_before_earlier_sentence_completes():
    with audio_client(provider=FixtureProvider(text="first second")) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        for index, text in enumerate(("first ", "second")):
            request = speech_request(scope, index, text, 10 + index)
            ws.send_json(request)
            assert ws.receive_json() == request
            receive_audio(ws)
        queued = message(scope, "playback.state", {"sentence_id": "sentence-1", "state": "queued"}, 30, request_id="playback-1")
        ws.send_json(queued)
        assert ws.receive_json() == queued
        ws.send_json(message(scope, "playback.state", {"sentence_id": "sentence-1", "state": "playing"}, 31, request_id="playback-1", sequence=1))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_more_than_four_outstanding_synthesis_requests_is_rejected_and_cancelled():
    speech = FixtureSpeech(block=True)
    with audio_client(speech, provider=FixtureProvider(text="a b c d e")) as http, http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        for index, text in enumerate(("a ", "b ", "c ", "d ")):
            request = speech_request(scope, index, text, 10 + index)
            ws.send_json(request)
            assert ws.receive_json() == request
        time.sleep(0.02)
        assert len(speech.calls) == 2
        ws.send_json(speech_request(scope, 4, "e", 14))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert speech.closed


def test_speech_failure_terminal_write_exhaustion_requires_fresh_session():
    # ready + input receive/echo + start receive/echo + delta/completed + request receive/echo = 9.
    with audio_client(FixtureSpeech(error="speech_error"), max_events=9) as http:
        with http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
            scope = ws.receive_json()["scope"]
            start_voice(ws, scope)
            response_done(ws)
            request = speech_request(scope)
            ws.send_json(request)
            assert ws.receive_json() == request
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.reason == "fresh_session_required"
        with http.websocket_connect("/v1/chat?session_id=" + scope["session_id"], headers=HEADERS) as resumed:
            with pytest.raises(WebSocketDisconnect) as closed:
                resumed.receive_json()
            assert closed.value.reason == "fresh_session_required"


def test_streamed_audio_does_not_consume_the_session_budget():
    # Three 80 KiB sentences stream ~320 KiB of base64 chunks through a 200 KiB session budget: the
    # session stays open and the turn completes, while ordinary envelopes still count toward the budget.
    speech = FixtureSpeech()
    with audio_client(speech, provider=FixtureProvider(text="one two three"), max_bytes=200 * 1024) as http,             http.websocket_connect("/v1/chat", headers=HEADERS) as ws:
        scope = ws.receive_json()["scope"]
        start_voice(ws, scope)
        response_done(ws)
        session = http.app.state.v1_service.sessions[scope["session_id"]]
        charged = session.bytes
        for index, text in enumerate(("one ", "two ", "three")):
            request = speech_request(scope, index, text, 10 + index)
            ws.send_json(request)
            assert ws.receive_json() == request
            chunks = receive_audio(ws)
            assert b"".join(base64.b64decode(row["payload"]["audio_base64"]) for row in chunks) == wav_bytes()
            assert all(row["message_id"] not in session.fingerprints for row in chunks)
        assert len(speech.calls) == 3
        assert session.bytes - charged < 8 * 1024 and not session.exhausted
        finished = message(scope, "speech.finished", {"sentence_count": 3}, 20)
        ws.send_json(finished)
        assert ws.receive_json() == finished
        for index in range(3):
            playback(ws, scope, index, 30 + index * 3)
        assert ws.receive_json()["payload"] == {"status": "completed"}
        assert session.turns["turn-1"].status == "completed"


def audio_http(handler):
    return HTTPAudioProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


@pytest.mark.asyncio
async def test_async_adapter_sends_the_qwen3_custom_voice_contract_and_validates_actual_wav():
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=wav_bytes())
    result = await audio_http(handler).synthesize(VOICE, "hello 😊")
    assert result.sample_rate_hz == 32000
    body = json.loads(seen[0].content)
    assert body == {"text": "hello", "language": "Korean", "speaker": "Sohee", "instruct": "synthetic instruct", "seed": 12345}
    assert seen[0].url == httpx.URL(VOICE.url)


@pytest.mark.parametrize("field, value, code", [
    ("language", "", "invalid_voice_selection"), ("language", "ko", "invalid_voice_selection"), ("language", 3, "invalid_voice_selection"),
    ("speaker", "", "invalid_voice_selection"), ("speaker", "sohee", "invalid_voice_selection"), ("speaker", "So hee", "invalid_voice_selection"),
    ("speaker", "x" * 65, "invalid_voice_selection"), ("instruct", "y" * 513, "invalid_voice_selection"), ("instruct", None, "invalid_voice_selection"),
    ("seed", -1, "invalid_voice_options"), ("seed", True, "invalid_voice_options"), ("timeout_seconds", 91, "invalid_voice_timeout"),
])
def test_speech_binding_rejects_invalid_voice_selection(field, value, code):
    data = {"model": VOICE_MODEL, "label": VOICE.label, "url": VOICE.url, "boundary": VOICE.boundary, "language": "Korean", "speaker": "Sohee", field: value}
    with pytest.raises(ConfigError, match=code):
        SpeechBinding(**data)


def test_speech_binding_has_no_reference_audio_fields():
    """The Qwen3-TTS preset voice is selected by name; recorded reference audio or prompt text is not accepted anywhere."""
    for legacy in ("reference_audio_path", "prompt_text", "rate"):
        with pytest.raises(TypeError):
            SpeechBinding(VOICE_MODEL, VOICE.label, VOICE.url, VOICE.boundary, "Korean", "Sohee", **{legacy: "/srv/ref.wav" if legacy != "rate" else 1.0})
    assert VOICE.instruct == "synthetic instruct" and SpeechBinding(VOICE_MODEL, VOICE.label, VOICE.url, VOICE.boundary, "Korean", "Sohee").instruct == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [b"", b'{"Exception":"private reference details"}', b"not wav", wav_bytes()[:-2], wav_bytes().replace(b"\x01\x00", b"\x00\x00")],
                         ids=["empty", "engine-error", "wrong-format", "truncated-frames", "silence"])
async def test_engine_failure_bodies_and_invalid_or_silent_pcm_are_not_success(body):
    with pytest.raises(AudioError, match="speech_error") as error:
        await audio_http(lambda request: httpx.Response(200, content=body)).synthesize(VOICE, "hello")
    assert "private reference" not in str(error.value)


class BlockingAudioBody(httpx.AsyncByteStream):
    def __init__(self):
        self.waiting = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        yield b"RIFF"
        self.waiting.set()
        await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["speech", "transcription"])
async def test_cancel_closes_actual_audio_http_response(kind):
    body = BlockingAudioBody()
    provider = audio_http(lambda request: httpx.Response(200, stream=body))
    coroutine = provider.synthesize(VOICE, "hello") if kind == "speech" else provider.transcribe(STT, b"fixture", "audio/webm")
    task = asyncio.create_task(coroutine)
    await body.waiting.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert body.closed


@pytest.mark.asyncio
async def test_stt_adapter_forwards_raw_audio_with_fixed_language_and_normalizes_text():
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"text": "  synthetic transcript \n"})
    text = await audio_http(handler).transcribe(STT, b"synthetic webm", "audio/webm;codecs=opus")
    assert text == "synthetic transcript"
    assert seen[0].content == b"synthetic webm"
    assert seen[0].headers["content-type"] == "audio/webm;codecs=opus"
    assert seen[0].url.params["language"] == "ko"


class FixtureTranscription:
    def __init__(self, text="fixture transcript"):
        self.text, self.calls = text, []

    async def transcribe(self, binding, data, content_type):
        self.calls.append((data, content_type))
        return self.text


def test_transcription_route_auth_media_and_bounded_stream_before_inference():
    provider = FixtureTranscription()
    app = create_app(config(speech=VOICE, transcription=STT), FixtureProvider(), transcription_provider=provider)
    with TestClient(app, client=("127.0.0.1", 50100)) as http:
        data = http.get("/v1/config", headers=HEADERS).json()
        assert data["speech"] == {"model": VOICE_MODEL, "label": VOICE.label}
        assert data["transcription"] == {"label": STT.model_label}
        assert "prompt" not in json.dumps(data) and "url" not in json.dumps(data)
        assert http.post("/v1/transcriptions", content=b"a").status_code == 401
        assert http.post("/v1/transcriptions", headers=HEADERS | {"Origin": "null"}, content=b"a").status_code == 401
        assert http.post("/v1/transcriptions", headers=HEADERS | {"Content-Type": "text/plain"}, content=b"a").status_code == 415
        assert http.post("/v1/transcriptions", headers=HEADERS | {"Content-Type": "audio/webm"}, content=b"").status_code == 400
        assert http.post("/v1/transcriptions", headers=HEADERS | {"Content-Type": "audio/webm", "Content-Length": "-1"}, content=b"a").status_code == 400
        assert http.post("/v1/transcriptions", headers=HEADERS | {"Content-Type": "audio/webm"}, content=iter([b"x" * (4 * 1024 * 1024), b"x"])).status_code == 413
        assert not provider.calls
        result = http.post("/v1/transcriptions", headers=HEADERS | {"Content-Type": "audio/webm"}, content=b"fixture")
        assert result.json() == {"text": "fixture transcript"}
        assert provider.calls == [(b"fixture", "audio/webm")]


@pytest.mark.parametrize("text", ["", " ", "x" * 8193, None], ids=["empty", "blank", "oversized", "wrong-type"])
def test_transcription_route_rejects_empty_or_unbounded_provider_text(text):
    app = create_app(config(transcription=STT), FixtureProvider(), transcription_provider=FixtureTranscription(text))
    with TestClient(app, client=("127.0.0.1", 50100)) as http:
        result = http.post("/v1/transcriptions", headers=HEADERS | {"Content-Type": "audio/wav"}, content=b"fixture")
        assert result.status_code == 422
        assert result.json() == {"detail": "transcription_error"}


@pytest.mark.asyncio
@pytest.mark.parametrize("simultaneous_completion", [False, True])
async def test_asgi_client_disconnect_cancels_upstream_transcription(simultaneous_completion):
    class BlockingTranscription:
        def __init__(self):
            self.started, self.closed = asyncio.Event(), False

        async def transcribe(self, binding, data, content_type):
            self.started.set()
            try:
                if simultaneous_completion:
                    return "late synthetic transcript"
                await asyncio.Event().wait()
            finally:
                self.closed = True

    provider = BlockingTranscription()
    app = create_app(config(transcription=STT), FixtureProvider(), transcription_provider=provider)
    queue = asyncio.Queue()
    await queue.put({"type": "http.request", "body": b"synthetic audio", "more_body": False})
    if simultaneous_completion:
        await queue.put({"type": "http.disconnect"})
    sent = []
    async def send(event):
        sent.append(event)
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
             "scheme": "http", "path": "/v1/transcriptions", "raw_path": b"/v1/transcriptions", "query_string": b"",
             "root_path": "", "server": ("127.0.0.1", 8099), "client": ("127.0.0.1", 50001),
             "headers": [(b"authorization", ("Bearer " + TOKEN).encode()), (b"content-type", b"audio/webm")]}
    task = asyncio.create_task(app(scope, queue.get, send))
    await asyncio.wait_for(provider.started.wait(), 1)
    if not simultaneous_completion:
        await queue.put({"type": "http.disconnect"})
    await asyncio.wait_for(task, 1)
    assert provider.closed
    assert next(event for event in sent if event["type"] == "http.response.start")["status"] == 499


def test_host_audio_config_roundtrip_and_boundary_validation(tmp_path, monkeypatch):
    data = {"identity": IDENTITY, "bindings": [{"model": MODEL, "label": "fixture", "kind": "ollama", "url": "http://127.0.0.1:11434", "boundary": "local"}],
            "speech": {"model": VOICE_MODEL, "label": VOICE.label, "url": VOICE.url, "boundary": VOICE.boundary, "language": VOICE.language, "speaker": VOICE.speaker, "instruct": VOICE.instruct},
            "transcription": {"url": STT.url, "boundary": STT.boundary, "model_label": STT.model_label}}
    path = tmp_path / "host.json"
    path.write_text(json.dumps(data))
    monkeypatch.setenv("KIRIAN_V1_CONFIG_FILE", str(path))
    monkeypatch.setenv("KIRIAN_V1_TOKEN", TOKEN)
    loaded = V1Config.from_env()
    assert loaded.speech == VOICE and loaded.transcription == STT
    assert "synthetic instruct" not in repr(loaded)
    with pytest.raises(ConfigError):
        replace(VOICE, url="https://external.invalid/tts")
    with pytest.raises(ConfigError):
        replace(VOICE, seed=float("nan"))
    with pytest.raises(ConfigError):
        replace(STT, url="http://192.168.1.2/stt/transcriptions")


def test_trim_silence_drops_engine_padding_but_keeps_a_margin_and_quiet_fixtures():
    import array, io, math, wave
    from rearchitecture.audio import SpeechAudio, trim_silence, validate_wav
    rate = 16000
    def clip(lead_ms, tone_ms, trail_ms, amplitude=12000):
        samples = array.array("h")
        samples.extend(0 for _ in range(rate * lead_ms // 1000))
        samples.extend(int(amplitude * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate * tone_ms // 1000))
        samples.extend(0 for _ in range(rate * trail_ms // 1000))
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as target:
            target.setnchannels(1); target.setsampwidth(2); target.setframerate(rate); target.writeframes(samples.tobytes())
        return validate_wav(buffer.getvalue())
    padded = clip(850, 1000, 600)
    trimmed = trim_silence(padded)
    with wave.open(io.BytesIO(trimmed.data), "rb") as audio:
        assert audio.getframerate() == rate and audio.getnchannels() == 1
        seconds = audio.getnframes() / rate
    # 1.0 s of tone plus at most 120 ms of margin on each side (sample-level rounding aside).
    assert 1.15 <= seconds <= 1.26
    assert trim_silence(trimmed).data == trimmed.data
    # A quiet fixture (below the threshold everywhere) is left exactly as it was.
    quiet = clip(0, 500, 0, amplitude=50)
    assert trim_silence(quiet) is quiet
    assert validate_wav(trimmed.data).sample_rate_hz == rate
