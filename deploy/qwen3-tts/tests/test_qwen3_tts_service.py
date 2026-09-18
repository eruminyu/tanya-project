"""Contract tests for deploy/qwen3-tts without loading a model: strict request parsing, WAV encoding, serialization, HTTP."""
import io
import json
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qwen3_tts_service import (MAX_TEXT_CHARACTERS, RequestError, SpeechService, encode_wav, parse_request,  # noqa: E402
                               serve, settings_from_env)


def tone(seconds=0.5, rate=24000):
    return np.sin(np.linspace(0, 440 * 2 * np.pi * seconds, int(rate * seconds))).astype(np.float32) * 0.5, rate


def test_parse_request_accepts_only_the_preset_voice_contract():
    request = parse_request(json.dumps({"text": " 안녕, 나는 키리안이야. ", "language": "Korean", "speaker": "Sohee", "instruct": "", "seed": 7}).encode(), ("Sohee",))
    assert (request.text, request.language, request.speaker, request.instruct, request.seed) == ("안녕, 나는 키리안이야.", "Korean", "Sohee", None, 7)
    assert parse_request(json.dumps({"text": "a", "speaker": "Sohee"}).encode(), ("Sohee",)).language == "Korean"


@pytest.mark.parametrize("body, code", [
    (b"{", "invalid_json"), (b"[]", "invalid_fields"),
    (json.dumps({"text": "a", "speaker": "Sohee", "ref_audio_path": "/x.wav"}).encode(), "invalid_fields"),
    (json.dumps({"text": "a", "speaker": "Sohee", "prompt_text": "x"}).encode(), "invalid_fields"),
    (json.dumps({"text": "", "speaker": "Sohee"}).encode(), "invalid_text"),
    (json.dumps({"text": "x" * (MAX_TEXT_CHARACTERS + 1), "speaker": "Sohee"}).encode(), "invalid_text"),
    (json.dumps({"text": "a", "speaker": "Vivian"}).encode(), "unknown_speaker"),
    (json.dumps({"text": "a", "speaker": "sohee"}).encode(), "unknown_speaker"),
    (json.dumps({"text": "a", "speaker": "Sohee", "language": "ko"}).encode(), "invalid_language"),
    (json.dumps({"text": "a", "speaker": "Sohee", "instruct": "i" * 513}).encode(), "invalid_instruct"),
    (json.dumps({"text": "a", "speaker": "Sohee", "seed": -1}).encode(), "invalid_seed"),
    (json.dumps({"text": "a", "speaker": "Sohee", "seed": True}).encode(), "invalid_seed"),
    (b"x" * (16 * 1024 + 1), "request_too_large"),
])
def test_parse_request_rejects_reference_audio_fields_unknown_speakers_and_bad_values(body, code):
    with pytest.raises(RequestError, match=code):
        parse_request(body, ("Sohee",))


def test_encode_wav_produces_bounded_16bit_mono_pcm_that_brain_accepts():
    samples, rate = tone()
    data = encode_wav(samples, rate)
    with wave.open(io.BytesIO(data), "rb") as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()) == (1, 2, rate, len(samples))
    stereo = np.stack([samples, samples])
    assert len(encode_wav(stereo, rate)) == len(data)
    for bad, code in [(np.zeros(100, dtype=np.float32), "silent_audio"), (np.array([np.nan], dtype=np.float32), "invalid_audio"),
                      (np.zeros(rate * 91, dtype=np.float32), "invalid_audio")]:
        with pytest.raises(RequestError, match=code):
            encode_wav(bad, rate)
    with pytest.raises(RequestError, match="invalid_audio"):
        encode_wav(samples, 4000)


def test_service_serializes_synthesis_and_serves_http_contract():
    active, peak, seen = [0], [0], []
    lock = threading.Lock()

    def synthesize(request):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        seen.append(request)
        time.sleep(0.05)
        with lock:
            active[0] -= 1
        return tone()

    service = SpeechService(synthesize, ("Sohee",), model="fixture-model", device="cpu")
    server = serve(service, "127.0.0.1", 0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{port}"
        health = json.loads(urllib.request.urlopen(base + "/health", timeout=5).read())
        assert health == {"status": "ready", "model": "fixture-model", "speakers": ["Sohee"], "device": "cpu"}
        payload = json.dumps({"text": "짧은 한국어 문장입니다.", "language": "Korean", "speaker": "Sohee", "instruct": "", "seed": 12345}).encode()

        def call(results):
            request = urllib.request.Request(base + "/tts", data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                results.append((response.status, response.headers["Content-Type"], response.read()))

        results = []
        workers = [threading.Thread(target=call, args=(results,)) for _ in range(3)]
        for worker in workers: worker.start()
        for worker in workers: worker.join()
        assert len(results) == 3 and all(status == 200 and kind == "audio/wav" and body[:4] == b"RIFF" for status, kind, body in results)
        assert peak[0] == 1, "synthesis must run one at a time"
        assert all(request.speaker == "Sohee" and request.seed == 12345 for request in seen)

        for body, status, code in [(json.dumps({"text": "x", "speaker": "Vivian"}).encode(), 400, "unknown_speaker"),
                                   (b"{", 400, "invalid_json")]:
            with pytest.raises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(base + "/tts", data=body, headers={"Content-Type": "application/json"}), timeout=5)
            assert error.value.code == status and json.loads(error.value.read())["error"] == code
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(base + "/other", timeout=5)
        assert error.value.code == 404
    finally:
        server.shutdown()
        server.server_close()


def test_engine_failures_are_reported_without_details():
    def synthesize(request):
        raise RuntimeError("CUDA out of memory at /private/path")
    service = SpeechService(synthesize, ("Sohee",))
    server = serve(service, "127.0.0.1", 0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        body = json.dumps({"text": "x", "speaker": "Sohee"}).encode()
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/tts", data=body, headers={"Content-Type": "application/json"}), timeout=5)
        text = error.value.read().decode()
        assert error.value.code == 500 and json.loads(text) == {"error": "synthesis_failed"} and "private" not in text
    finally:
        server.shutdown()
        server.server_close()


def test_settings_from_env_defaults_to_sohee_only_and_rejects_bad_speaker_lists():
    settings = settings_from_env({})
    assert settings["speakers"] == ("Sohee",) and settings["port"] == 19882 and settings["host"] == "127.0.0.1"
    assert settings["model"] == "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
    assert settings_from_env({"KIRIAN_QWEN3_TTS_SPEAKERS": "Sohee, Ono_Anna"})["speakers"] == ("Sohee", "Ono_Anna")
    for bad in ("", "sohee", "So hee", "../x"):
        with pytest.raises(RequestError, match="invalid_speakers"):
            settings_from_env({"KIRIAN_QWEN3_TTS_SPEAKERS": bad})
