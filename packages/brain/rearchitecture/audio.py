"""Bounded single-job audio adapters; queues and actual playback belong to the client."""
from __future__ import annotations

import array
import asyncio
import io
import json
import wave
from dataclasses import dataclass
from typing import Callable, Protocol

import httpx

from core.tts_text_preprocessor import prepare_tts_text

from .config import SpeechBinding, TranscriptionBinding

MAX_AUDIO_BYTES = 4 * 1024 * 1024
MAX_TRANSCRIPT_CHARACTERS = 8192


class AudioError(RuntimeError):
    def __init__(self, code: str = "speech_error"):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SpeechAudio:
    data: bytes
    sample_rate_hz: int


def validate_wav(data: bytes) -> SpeechAudio:
    """Validate actual PCM frames, never expose engine error bodies."""
    if not data or len(data) > MAX_AUDIO_BYTES or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise AudioError()
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            rate, channels, width, count = audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getnframes()
            if not 8000 <= rate <= 192000 or channels not in (1, 2) or width != 2 or count < 1 or count > rate * 90:
                raise AudioError()
            pcm = audio.readframes(count)
            if len(pcm) != count * channels * width or not pcm.strip(b"\x00"):
                raise AudioError()
    except (wave.Error, EOFError, ValueError):
        raise AudioError() from None
    return SpeechAudio(data, rate)


# Engines pad each clip with silence (Qwen3-TTS: about 0.85 s leading and 0.4-0.7 s trailing per sentence,
# measured 2026-09-18); between sentences that padding is heard as a pause, so it is trimmed here for every
# provider. The clip keeps a short margin on both sides so consonants are not clipped.
TRIM_THRESHOLD = 300  # 16-bit sample magnitude, about -41 dBFS
TRIM_KEEP_MS = 120


def trim_silence(audio: SpeechAudio, threshold: int = TRIM_THRESHOLD, keep_ms: int = TRIM_KEEP_MS) -> SpeechAudio:
    """Drops leading and trailing near-silence of a validated 16-bit WAV; returns the input when nothing is trimmed."""
    try:
        with wave.open(io.BytesIO(audio.data), "rb") as source:
            rate, channels, width, count = source.getframerate(), source.getnchannels(), source.getsampwidth(), source.getnframes()
            if width != 2 or channels not in (1, 2) or count < 1:
                return audio
            pcm = source.readframes(count)
        samples = array.array("h")
        samples.frombytes(pcm)
        loud = [index // channels for index, value in enumerate(samples) if value > threshold or value < -threshold]
        if not loud:
            return audio
        keep = rate * keep_ms // 1000
        start, end = max(0, loud[0] - keep), min(count, loud[-1] + 1 + keep)
        if start == 0 and end == count:
            return audio
        frame = channels * width
        trimmed = pcm[start * frame:end * frame]
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as target:
            target.setnchannels(channels)
            target.setsampwidth(width)
            target.setframerate(rate)
            target.writeframes(trimmed)
        return validate_wav(buffer.getvalue())
    except (wave.Error, EOFError, ValueError, AudioError):
        return audio


class SpeechProvider(Protocol):
    async def synthesize(self, binding: SpeechBinding, text: str) -> SpeechAudio: ...


class TranscriptionProvider(Protocol):
    async def transcribe(self, binding: TranscriptionBinding, data: bytes, content_type: str) -> str: ...


async def bounded_body(response: httpx.Response, limit: int) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        if len(body) + len(chunk) > limit:
            raise AudioError()
        body.extend(chunk)
    return bytes(body)


class HTTPAudioProvider:
    def __init__(self, client_factory: Callable[[], httpx.AsyncClient] | None = None):
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(
            timeout=httpx.Timeout(90, connect=5), follow_redirects=False, trust_env=False,
        ))

    async def synthesize(self, binding: SpeechBinding, text: str) -> SpeechAudio:
        prepared = prepare_tts_text(text).text
        if not prepared:
            raise AudioError()
        # Qwen3-TTS CustomVoice contract of deploy/qwen3-tts/server.py: a preset speaker, never reference audio.
        payload = {"text": prepared, "language": binding.language, "speaker": binding.speaker, "instruct": binding.instruct, "seed": binding.seed}
        try:
            async with asyncio.timeout(binding.timeout_seconds):
                async with self.client_factory() as client:
                    async with client.stream("POST", binding.url, json=payload, headers={"Accept-Encoding": "identity"}) as response:
                        if response.status_code != 200:
                            raise AudioError("speech_unavailable")
                        data = await bounded_body(response, MAX_AUDIO_BYTES)
                        return validate_wav(data)
        except (httpx.HTTPError, TimeoutError):
            raise AudioError("speech_unavailable") from None

    async def transcribe(self, binding: TranscriptionBinding, data: bytes, content_type: str) -> str:
        try:
            async with asyncio.timeout(binding.timeout_seconds):
                async with self.client_factory() as client:
                    # The existing Brain STT route consumes raw audio, not multipart.
                    async with client.stream("POST", binding.url, params={"language": "ko"}, content=data,
                                             headers={"Content-Type": content_type, "Accept-Encoding": "identity"}) as response:
                        if response.status_code != 200:
                            raise AudioError("transcription_unavailable")
                        body = await bounded_body(response, 64 * 1024)
                        result = json.loads(body)
                        return normalize_transcript(result.get("text") if isinstance(result, dict) else None)
        except (httpx.HTTPError, TimeoutError):
            raise AudioError("transcription_unavailable") from None
        except (ValueError, UnicodeError):
            raise AudioError("transcription_error") from None


def normalize_transcript(value) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TRANSCRIPT_CHARACTERS:
        raise AudioError("transcription_error")
    return value.strip()
