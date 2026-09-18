"""Qwen3-TTS CustomVoice HTTP service used by Brain's SpeechBinding (deploy/qwen3-tts).

Contract (loopback only):
  POST /tts   JSON {"text", "language", "speaker", "instruct"?, "seed"?} -> 200 audio/wav (16-bit PCM mono)
  GET  /health -> 200 JSON {"status": "ready", "model", "speakers", "device"}
Only the preset speakers listed in KIRIAN_QWEN3_TTS_SPEAKERS are accepted; no reference audio or voice
cloning path exists in this service. One synthesis runs at a time; a client disconnect cannot stop a
generation already running, so callers keep their own timeout (Brain: SpeechBinding.timeout_seconds).
"""
from __future__ import annotations

import io
import json
import os
import re
import threading
import wave
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Sequence

import numpy as np

DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
DEFAULT_SPEAKERS = ("Sohee",)
DEFAULT_LANGUAGE = "Korean"
MAX_TEXT_CHARACTERS = 500
MAX_INSTRUCT_CHARACTERS = 512
MAX_BODY_BYTES = 16 * 1024
MAX_SECONDS = 90


class RequestError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SpeechRequest:
    text: str
    language: str
    speaker: str
    instruct: str | None
    seed: int


def parse_request(body: bytes, speakers: Sequence[str]) -> SpeechRequest:
    """Strict JSON contract; every failure maps to a stable code and never echoes the input."""
    if len(body) > MAX_BODY_BYTES:
        raise RequestError("request_too_large")
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise RequestError("invalid_json") from None
    if not isinstance(data, dict) or set(data) - {"text", "language", "speaker", "instruct", "seed"}:
        raise RequestError("invalid_fields")
    text = data.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS or "\x00" in text:
        raise RequestError("invalid_text")
    language = data.get("language", DEFAULT_LANGUAGE)
    if not isinstance(language, str) or not re.fullmatch(r"[A-Z][A-Za-z]{1,31}", language):
        raise RequestError("invalid_language")
    speaker = data.get("speaker")
    if not isinstance(speaker, str) or speaker not in speakers:
        raise RequestError("unknown_speaker")
    instruct = data.get("instruct", "")
    if instruct is None:
        instruct = ""
    if not isinstance(instruct, str) or len(instruct) > MAX_INSTRUCT_CHARACTERS or "\x00" in instruct:
        raise RequestError("invalid_instruct")
    seed = data.get("seed", 12345)
    if type(seed) is not int or not 0 <= seed <= 2147483647:
        raise RequestError("invalid_seed")
    return SpeechRequest(text.strip(), language, speaker, instruct.strip() or None, seed)


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Float waveform -> 16-bit PCM mono WAV, bounded like Brain's validate_wav expects."""
    if not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 192000:
        raise RequestError("invalid_audio")
    array = np.asarray(samples)
    if array.ndim == 2:
        array = array.mean(axis=0 if array.shape[0] < array.shape[1] else 1)
    if array.ndim != 1 or array.size < 1 or array.size > sample_rate * MAX_SECONDS or not np.all(np.isfinite(array)):
        raise RequestError("invalid_audio")
    pcm = np.clip(array.astype(np.float32), -1.0, 1.0)
    if not np.any(pcm):
        raise RequestError("silent_audio")
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes((pcm * 32767.0).astype("<i2").tobytes())
    return output.getvalue()


Synthesizer = Callable[[SpeechRequest], tuple[np.ndarray, int]]


class SpeechService:
    """Serializes synthesis; the model object is created by the caller (see server.py)."""

    def __init__(self, synthesize: Synthesizer, speakers: Sequence[str] = DEFAULT_SPEAKERS, *, model: str = DEFAULT_MODEL, device: str = "unknown"):
        self.synthesize, self.speakers, self.model, self.device = synthesize, tuple(speakers), model, device
        self.lock = threading.Lock()

    def health(self) -> dict:
        return {"status": "ready", "model": self.model, "speakers": list(self.speakers), "device": self.device}

    def handle(self, body: bytes) -> bytes:
        request = parse_request(body, self.speakers)
        with self.lock:
            samples, sample_rate = self.synthesize(request)
        return encode_wav(samples, sample_rate)


def make_handler(service: SpeechService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "KirianQwen3TTS/1"

        def log_message(self, format, *args):  # noqa: A002 - stdlib signature; keep request text out of logs
            pass

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload: dict) -> None:
            self._send(status, json.dumps(payload).encode(), "application/json")

        def do_GET(self):  # noqa: N802 - stdlib naming
            if self.path == "/health":
                self._json(200, service.health())
            else:
                self._json(404, {"error": "not_found"})

        def do_POST(self):  # noqa: N802 - stdlib naming
            if self.path != "/tts":
                self._json(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                self._json(413, {"error": "request_too_large"})
                return
            try:
                wav = service.handle(self.rfile.read(length))
            except RequestError as error:
                self._json(400, {"error": error.code})
                return
            except Exception:  # noqa: BLE001 - engine failures must not leak details to the caller
                self._json(500, {"error": "synthesis_failed"})
                return
            self._send(200, wav, "audio/wav")

    return Handler


def serve(service: SpeechService, host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(service))
    server.daemon_threads = True
    return server


def settings_from_env(env=os.environ) -> dict:
    speakers = tuple(item.strip() for item in env.get("KIRIAN_QWEN3_TTS_SPEAKERS", ",".join(DEFAULT_SPEAKERS)).split(",") if item.strip())
    if not speakers or any(not re.fullmatch(r"[A-Z][A-Za-z0-9_]{1,63}", item) for item in speakers):
        raise RequestError("invalid_speakers")
    return {
        "model": env.get("KIRIAN_QWEN3_TTS_MODEL", DEFAULT_MODEL),
        "device": env.get("KIRIAN_QWEN3_TTS_DEVICE", "cuda:0"),
        "dtype": env.get("KIRIAN_QWEN3_TTS_DTYPE", "bfloat16"),
        "host": env.get("KIRIAN_QWEN3_TTS_HOST", "127.0.0.1"),
        "port": int(env.get("KIRIAN_QWEN3_TTS_PORT", "19882")),
        "speakers": speakers,
    }
