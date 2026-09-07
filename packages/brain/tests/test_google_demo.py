import json

import pytest

from action.google_demo import GoogleDemoError, GoogleDemoService
from config.settings import Settings


class FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class FakeTransport:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def post(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.responses.pop(0)


def make_service(tmp_path, transport: FakeTransport, **overrides) -> GoogleDemoService:
    options = {
        "enabled": True,
        "client_id": "demo-client-id",
        "client_secret": "demo-client-secret",
        "refresh_token": "demo-refresh-token",
        "calendar_id": "primary",
        "task_list_id": "@default",
        "receipts_path": str(tmp_path / "google-demo-receipts.json"),
        "timeout_seconds": 7.0,
        "transport": transport,
    }
    options.update(overrides)
    return GoogleDemoService(**options)


def test_incomplete_demo_credentials_keep_provider_disabled(tmp_path):
    service = make_service(
        tmp_path,
        FakeTransport([]),
        refresh_token="",
    )

    assert service.configured is False
    with pytest.raises(GoogleDemoError, match="설정되지 않았습니다"):
        service.create(
            "request-1",
            {"kind": "task", "title": "자료 정리", "due": None},
        )


def test_settings_report_demo_as_configured_only_with_all_server_credentials():
    incomplete = Settings(
        enable_google_demo=True,
        google_demo_client_id="client-id",
        google_demo_client_secret="client-secret",
        google_demo_refresh_token="",
    )
    complete = Settings(
        enable_google_demo=True,
        google_demo_client_id="client-id",
        google_demo_client_secret="client-secret",
        google_demo_refresh_token="refresh-token",
    )

    assert incomplete.google_demo_configured is False
    assert complete.google_demo_configured is True


def test_calendar_create_refreshes_token_and_persists_receipt(tmp_path):
    transport = FakeTransport([
        FakeResponse(200, {"access_token": "short-lived-access-token"}),
        FakeResponse(200, {"id": "calendar-event-1"}),
    ])
    service = make_service(tmp_path, transport)

    receipt = service.create("request-1", {
        "kind": "calendar",
        "title": "해커톤 데모 회의",
        "startAt": "2026-08-31T15:00:00+09:00",
        "endAt": "2026-08-31T16:00:00+09:00",
    })

    assert receipt == {
        "requestId": "request-1",
        "providerId": "calendar-event-1",
        "title": "해커톤 데모 회의",
        "duplicate": False,
    }
    assert transport.calls[0] == {
        "url": "https://oauth2.googleapis.com/token",
        "data": {
            "client_id": "demo-client-id",
            "client_secret": "demo-client-secret",
            "refresh_token": "demo-refresh-token",
            "grant_type": "refresh_token",
        },
        "timeout": 7.0,
    }
    assert transport.calls[1]["url"].endswith("/calendars/primary/events")
    assert transport.calls[1]["headers"] == {
        "Authorization": "Bearer short-lived-access-token",
        "Content-Type": "application/json",
    }
    assert transport.calls[1]["json"] == {
        "summary": "해커톤 데모 회의",
        "start": {"dateTime": "2026-08-31T15:00:00+09:00"},
        "end": {"dateTime": "2026-08-31T16:00:00+09:00"},
    }
    persisted = json.loads((tmp_path / "google-demo-receipts.json").read_text(encoding="utf-8"))
    assert persisted["request-1"]["providerId"] == "calendar-event-1"
    assert "demo-refresh-token" not in json.dumps(persisted)


def test_same_request_id_returns_existing_receipt_without_second_google_call(tmp_path):
    transport = FakeTransport([
        FakeResponse(200, {"access_token": "access-token"}),
        FakeResponse(200, {"id": "task-1"}),
    ])
    service = make_service(tmp_path, transport)
    draft = {"kind": "task", "title": "발표 자료 정리", "due": "2026-09-01"}

    first = service.create("request-2", draft)
    second = service.create("request-2", draft)

    assert first["duplicate"] is False
    assert second == {**first, "duplicate": True}
    assert len(transport.calls) == 2


def test_task_due_is_sent_in_google_tasks_rfc3339_shape(tmp_path):
    transport = FakeTransport([
        FakeResponse(200, {"access_token": "access-token"}),
        FakeResponse(200, {"id": "task-2"}),
    ])
    service = make_service(tmp_path, transport, task_list_id="demo list")

    service.create("request-3", {
        "kind": "task",
        "title": "발표 연습",
        "due": "2026-09-02",
    })

    assert transport.calls[1]["url"].endswith("/lists/demo%20list/tasks")
    assert transport.calls[1]["json"] == {
        "title": "발표 연습",
        "due": "2026-09-02T00:00:00.000Z",
    }


def test_invalid_task_due_date_is_rejected_before_network_call(tmp_path):
    transport = FakeTransport([])
    service = make_service(tmp_path, transport)

    with pytest.raises(GoogleDemoError, match="유효한 날짜"):
        service.create("request-invalid-date", {
            "kind": "task",
            "title": "발표 연습",
            "due": "2026-02-31",
        })

    assert transport.calls == []


def test_google_error_does_not_expose_credentials_or_response_body(tmp_path):
    transport = FakeTransport([
        FakeResponse(400, {
            "error": "invalid_grant",
            "refresh_token": "demo-refresh-token",
        }),
    ])
    service = make_service(tmp_path, transport)

    with pytest.raises(GoogleDemoError) as caught:
        service.create(
            "request-4",
            {"kind": "task", "title": "발표 연습", "due": None},
        )

    message = str(caught.value)
    assert "Google 데모 계정 인증에 실패했습니다" in message
    assert "demo-refresh-token" not in message
    assert "invalid_grant" not in message


@pytest.mark.parametrize("request_id", ["", "   "])
def test_request_id_is_required_before_any_network_call(tmp_path, request_id):
    transport = FakeTransport([])
    service = make_service(tmp_path, transport)

    with pytest.raises(GoogleDemoError, match="요청 ID"):
        service.create(
            request_id,
            {"kind": "task", "title": "발표 연습", "due": None},
        )

    assert transport.calls == []
