"""상태를 저장하지 않는 공개 데모 Google create/delete client."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import requests


_TOKEN_URL = "https://oauth2.googleapis.com/token"
_CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
_TASKS_URL = "https://tasks.googleapis.com/tasks/v1/lists/{task_list_id}/tasks"


class GoogleApiError(RuntimeError):
    """확정된 실패를 raw provider detail 없이 나타낸다."""


class GoogleApiUncertainError(GoogleApiError):
    """create 요청이 도착했는지 확정할 수 없어 재시도하면 안 되는 실패."""


class GoogleApiClient:
    """OAuth 갱신과 Calendar/Tasks HTTP만 담당하는 무상태 client."""

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        calendar_id: str = "primary",
        task_list_id: str = "@default",
        timeout_seconds: float = 10.0,
        transport: Any = requests,
    ) -> None:
        self._client_id = client_id.strip()
        self._client_secret = client_secret.strip()
        self._refresh_token = refresh_token.strip()
        self._calendar_id = calendar_id.strip() or "primary"
        self._task_list_id = task_list_id.strip() or "@default"
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self._client_id and self._client_secret and self._refresh_token)

    @property
    def timeout_seconds(self) -> float:
        return self._timeout_seconds

    def create(self, kind: str, fields: dict[str, Any]) -> str:
        if not self.configured:
            raise GoogleApiError("Google 데모 계정이 설정되지 않았습니다.")
        access_token = self._refresh_access_token()
        url, body = self._create_request(kind, fields)
        try:
            response = self._transport.post(
                url,
                headers=self._headers(access_token),
                json=body,
                timeout=self._timeout_seconds,
            )
        except Exception:
            raise GoogleApiUncertainError(
                "Google 생성 결과를 확인할 수 없습니다. 자동 재시도하지 않습니다."
            ) from None

        payload = self._response_json(response)
        provider_id = payload.get("id")
        if 200 <= self._status(response) < 300:
            if isinstance(provider_id, str) and provider_id.strip():
                return provider_id.strip()
            raise GoogleApiUncertainError(
                "Google 생성 결과를 확인할 수 없습니다. 자동 재시도하지 않습니다."
            )
        raise GoogleApiError("Google 데모 항목을 생성하지 못했습니다.")

    def delete(self, kind: str, provider_id: str) -> bool:
        if not self.configured:
            raise GoogleApiError("Google 데모 계정이 설정되지 않았습니다.")
        if not isinstance(provider_id, str) or not provider_id.strip():
            raise GoogleApiError("Google 삭제 대상이 올바르지 않습니다.")
        access_token = self._refresh_access_token()
        url = self._delete_url(kind, provider_id.strip())
        try:
            response = self._transport.delete(
                url,
                headers=self._headers(access_token),
                timeout=self._timeout_seconds,
            )
        except Exception:
            raise GoogleApiError("Google 자동 삭제를 완료하지 못했습니다.") from None
        status = self._status(response)
        if status == 404 or 200 <= status < 300:
            return True
        raise GoogleApiError("Google 자동 삭제를 완료하지 못했습니다.")

    def _refresh_access_token(self) -> str:
        try:
            response = self._transport.post(
                _TOKEN_URL,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "refresh_token": self._refresh_token,
                    "grant_type": "refresh_token",
                },
                timeout=self._timeout_seconds,
            )
        except Exception:
            raise GoogleApiError(
                "Google 데모 계정 인증 서버에 연결하지 못했습니다."
            ) from None
        payload = self._response_json(response)
        token = payload.get("access_token")
        if (
            not 200 <= self._status(response) < 300
            or not isinstance(token, str)
            or not token.strip()
        ):
            raise GoogleApiError("Google 데모 계정 인증에 실패했습니다.")
        return token.strip()

    def _create_request(
        self, kind: str, fields: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        if not isinstance(fields, dict):
            raise GoogleApiError("Google 생성 필드가 올바르지 않습니다.")
        title = fields.get("title")
        if not isinstance(title, str) or not title.strip():
            raise GoogleApiError("Google 생성 제목이 필요합니다.")
        if kind == "calendar":
            start_at = fields.get("startAt")
            end_at = fields.get("endAt")
            if not isinstance(start_at, str) or not isinstance(end_at, str):
                raise GoogleApiError("Google 일정 시간이 올바르지 않습니다.")
            start: dict[str, Any] = {"dateTime": start_at}
            end: dict[str, Any] = {"dateTime": end_at}
            timezone = fields.get("timeZone")
            if isinstance(timezone, str) and timezone:
                start["timeZone"] = timezone
                end["timeZone"] = timezone
            return (
                _CALENDAR_URL.format(
                    calendar_id=quote(self._calendar_id, safe="")
                ),
                {"summary": title.strip(), "start": start, "end": end},
            )
        if kind == "task":
            body: dict[str, Any] = {"title": title.strip()}
            due = fields.get("due")
            if isinstance(due, str) and due:
                body["due"] = f"{due}T00:00:00.000Z"
            elif due is not None:
                raise GoogleApiError("Google 할 일 기한이 올바르지 않습니다.")
            return (
                _TASKS_URL.format(
                    task_list_id=quote(self._task_list_id, safe="")
                ),
                body,
            )
        raise GoogleApiError("지원하지 않는 Google 종류입니다.")

    def _delete_url(self, kind: str, provider_id: str) -> str:
        encoded_id = quote(provider_id, safe="")
        if kind == "calendar":
            return (
                _CALENDAR_URL.format(
                    calendar_id=quote(self._calendar_id, safe="")
                )
                + f"/{encoded_id}"
            )
        if kind == "task":
            return (
                _TASKS_URL.format(
                    task_list_id=quote(self._task_list_id, safe="")
                )
                + f"/{encoded_id}"
            )
        raise GoogleApiError("지원하지 않는 Google 종류입니다.")

    @staticmethod
    def _headers(access_token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _response_json(response: Any) -> dict[str, Any]:
        try:
            payload = response.json()
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _status(response: Any) -> int:
        status = getattr(response, "status_code", 0)
        return status if isinstance(status, int) else 0
