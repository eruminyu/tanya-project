from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import stt as stt_router


def _client(provider=None) -> TestClient:
    app = FastAPI()
    app.state.stt_provider = provider
    app.include_router(stt_router.router)
    return TestClient(app)


def test_transcription_returns_recognized_text():
    provider = AsyncMock()
    provider.transcribe.return_value = "내일 오후 세 시에 회의"

    response = _client(provider).post(
        "/stt/transcriptions?language=ko",
        content=b"webm-audio",
        headers={"content-type": "audio/webm;codecs=opus"},
    )

    assert response.status_code == 200
    assert response.json() == {"text": "내일 오후 세 시에 회의"}
    provider.transcribe.assert_awaited_once_with(b"webm-audio", language="ko")


def test_transcription_is_unavailable_when_stt_is_disabled():
    response = _client().post(
        "/stt/transcriptions",
        content=b"audio",
        headers={"content-type": "audio/webm"},
    )

    assert response.status_code == 503


def test_transcription_rejects_non_audio_content():
    response = _client(AsyncMock()).post(
        "/stt/transcriptions",
        content=b"not-audio",
        headers={"content-type": "text/plain"},
    )

    assert response.status_code == 415


def test_transcription_rejects_empty_audio():
    response = _client(AsyncMock()).post(
        "/stt/transcriptions",
        content=b"",
        headers={"content-type": "audio/webm"},
    )

    assert response.status_code == 400


def test_transcription_rejects_audio_over_limit(monkeypatch):
    monkeypatch.setattr(stt_router, "MAX_AUDIO_BYTES", 4)

    response = _client(AsyncMock()).post(
        "/stt/transcriptions",
        content=b"12345",
        headers={"content-type": "audio/webm"},
    )

    assert response.status_code == 413
