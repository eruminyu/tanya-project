"""T-027 strict Ollama와 상태 없는 Google API client 경계 테스트."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from action.google_api import (
    GoogleApiClient,
    GoogleApiError,
    GoogleApiUncertainError,
)
from tutorial.ollama import StrictOllamaClient, StrictOllamaError


class FakeResponse:
    def __init__(self, status_code: int, payload: object):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if isinstance(self._payload, BaseException):
            raise self._payload
        return self._payload


class FakeGoogleTransport:
    def __init__(self, responses: list[object]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def post(self, url: str, **kwargs):
        self.calls.append({"method": "POST", "url": url, **kwargs})
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    def delete(self, url: str, **kwargs):
        self.calls.append({"method": "DELETE", "url": url, **kwargs})
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def google_client(transport: FakeGoogleTransport) -> GoogleApiClient:
    return GoogleApiClient(
        client_id="demo-client",
        client_secret="demo-secret",
        refresh_token="demo-refresh",
        calendar_id="primary",
        task_list_id="@default",
        timeout_seconds=7,
        transport=transport,
    )


def test_google_client_creates_calendar_without_persisting_credentials():
    transport = FakeGoogleTransport([
        FakeResponse(200, {"access_token": "short-access"}),
        FakeResponse(200, {"id": "calendar-1"}),
    ])
    client = google_client(transport)
    fields = {
        "title": "해커톤 준비",
        "startAt": "2026-09-03T15:00:00+09:00",
        "endAt": "2026-09-03T15:30:00+09:00",
        "timeZone": "Asia/Seoul",
    }

    assert client.create("calendar", fields) == "calendar-1"
    assert transport.calls[1]["json"] == {
        "summary": "해커톤 준비",
        "start": {
            "dateTime": "2026-09-03T15:00:00+09:00",
            "timeZone": "Asia/Seoul",
        },
        "end": {
            "dateTime": "2026-09-03T15:30:00+09:00",
            "timeZone": "Asia/Seoul",
        },
    }


def test_google_create_transport_loss_is_uncertain_and_hides_raw_details():
    transport = FakeGoogleTransport([
        FakeResponse(200, {"access_token": "short-access"}),
        TimeoutError("demo-refresh sensitive provider body"),
    ])

    with pytest.raises(GoogleApiUncertainError) as caught:
        google_client(transport).create(
            "task", {"title": "발표 점검", "due": "2026-09-04"}
        )

    assert "demo-refresh" not in str(caught.value)
    assert caught.value.__cause__ is None


@pytest.mark.parametrize("status", [204, 404])
def test_google_delete_treats_success_and_not_found_as_cleaned(status):
    transport = FakeGoogleTransport([
        FakeResponse(200, {"access_token": "short-access"}),
        FakeResponse(status, {}),
    ])

    assert google_client(transport).delete("task", "task-1") is True
    assert transport.calls[1]["method"] == "DELETE"


def test_google_auth_failure_is_definite_and_safe():
    transport = FakeGoogleTransport([
        FakeResponse(400, {"refresh_token": "demo-refresh"}),
    ])

    with pytest.raises(GoogleApiError) as caught:
        google_client(transport).create("task", {"title": "점검", "due": None})

    assert not isinstance(caught.value, GoogleApiUncertainError)
    assert "demo-refresh" not in str(caught.value)


@pytest.mark.asyncio
async def test_strict_ollama_requires_actual_model_and_non_empty_content():
    response = FakeResponse(200, {
        "model": "qwen2.5:7b",
        "message": {"content": "근거가 있는 로컬 답변"},
    })
    transport = MagicMock()
    transport.post.return_value = response
    client = StrictOllamaClient(
        base_url="http://127.0.0.1:11434",
        model="qwen2.5:7b",
        transport=transport,
    )

    result = await client.generate("질문", "시스템")

    assert result.content == "근거가 있는 로컬 답변"
    assert result.model == "qwen2.5:7b"
    payload = transport.post.call_args.kwargs["json"]
    assert payload["stream"] is False
    assert payload["model"] == "qwen2.5:7b"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"model": "qwen2.5:7b", "message": {"content": "   "}},
        {"message": {"content": "답변"}},
        ["malformed"],
    ],
)
async def test_strict_ollama_fails_closed_on_unverifiable_response(payload):
    transport = MagicMock()
    transport.post.return_value = FakeResponse(200, payload)
    client = StrictOllamaClient(
        base_url="http://127.0.0.1:11434",
        model="qwen2.5:7b",
        transport=transport,
    )

    with pytest.raises(StrictOllamaError):
        await client.generate("질문")


@pytest.mark.asyncio
async def test_strict_ollama_hides_transport_details():
    transport = MagicMock()
    transport.post.side_effect = RuntimeError("internal-url sensitive-body")
    client = StrictOllamaClient(
        base_url="http://127.0.0.1:11434",
        model="qwen2.5:7b",
        transport=transport,
    )

    with pytest.raises(StrictOllamaError) as caught:
        await client.generate("질문")

    assert "internal-url" not in str(caught.value)
    assert caught.value.__cause__ is None


@pytest.mark.asyncio
async def test_strict_ollama_forwards_think_and_num_ctx():
    """T-042: 공개 튜토리얼 경로도 사고·컨텍스트 설정을 따른다."""
    response = FakeResponse(200, {
        "model": "m",
        "message": {"content": "로컬 답변", "thinking": "사고 과정"},
    })
    transport = MagicMock()
    transport.post.return_value = response
    client = StrictOllamaClient(
        base_url="http://127.0.0.1:11434",
        model="m",
        think=False,
        num_ctx=65536,
        transport=transport,
    )

    result = await client.generate("질문")

    # 사고 필드가 있어도 사용자에게 가는 값은 content뿐이다.
    assert result.content == "로컬 답변"
    payload = transport.post.call_args.kwargs["json"]
    assert payload["think"] is False
    assert payload["options"] == {"num_ctx": 65536}


@pytest.mark.asyncio
async def test_strict_ollama_omits_options_when_num_ctx_unset():
    response = FakeResponse(200, {"model": "m", "message": {"content": "답변"}})
    transport = MagicMock()
    transport.post.return_value = response
    client = StrictOllamaClient(
        base_url="http://127.0.0.1:11434",
        model="m",
        transport=transport,
    )

    await client.generate("질문")

    payload = transport.post.call_args.kwargs["json"]
    assert "options" not in payload
    assert payload["think"] is False
