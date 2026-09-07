"""웹 체험판 전용 Google 데모 계정 쓰기 공급자.

개인 계정 OAuth를 브라우저에 노출하지 않는다. 서버의 환경 변수에 저장된 데모 계정
refresh token으로만 Calendar/Tasks를 호출하고, requestId 영수증을 파일에 남겨 재전송
시 중복 생성을 막는다.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

from action.google_api import GoogleApiClient, GoogleApiError


_DUE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class GoogleDemoError(RuntimeError):
    """사용자에게 노출해도 비밀 값이 새지 않는 Google 데모 실행 오류."""


class GoogleDemoService:
    """서버 전용 데모 계정으로 승인된 Google 쓰기 요청을 실행한다."""

    def __init__(
        self,
        *,
        enabled: bool,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        calendar_id: str = "primary",
        task_list_id: str = "@default",
        receipts_path: str = "google_demo_receipts.json",
        timeout_seconds: float = 10.0,
        transport: Any = requests,
    ) -> None:
        self._enabled = enabled
        self._client_id = client_id.strip()
        self._client_secret = client_secret.strip()
        self._refresh_token = refresh_token.strip()
        self._calendar_id = calendar_id.strip() or "primary"
        self._task_list_id = task_list_id.strip() or "@default"
        self._receipts_path = Path(receipts_path)
        self._timeout_seconds = max(1.0, timeout_seconds)
        self._transport = transport
        self._api = GoogleApiClient(
            client_id=self._client_id,
            client_secret=self._client_secret,
            refresh_token=self._refresh_token,
            calendar_id=self._calendar_id,
            task_list_id=self._task_list_id,
            timeout_seconds=self._timeout_seconds,
            transport=transport,
        )
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls, settings: Any) -> "GoogleDemoService":
        def string_value(name: str, default: str = "") -> str:
            value = getattr(settings, name, default)
            return value if isinstance(value, str) else default

        timeout = getattr(settings, "google_demo_timeout_seconds", 10.0)
        return cls(
            # 테스트의 MagicMock 설정이나 오래된 설정 객체가 실수로 활성화되지 않게 한다.
            enabled=getattr(settings, "enable_google_demo", False) is True,
            client_id=string_value("google_demo_client_id"),
            client_secret=string_value("google_demo_client_secret"),
            refresh_token=string_value("google_demo_refresh_token"),
            calendar_id=string_value("google_demo_calendar_id", "primary"),
            task_list_id=string_value("google_demo_task_list_id", "@default"),
            receipts_path=string_value(
                "google_demo_receipts_path", "google_demo_receipts.json"
            ),
            timeout_seconds=timeout if isinstance(timeout, (int, float)) else 10.0,
        )

    @property
    def configured(self) -> bool:
        return bool(
            self._enabled
            and self._api.configured
        )

    def create(self, request_id: str, draft: dict[str, Any]) -> dict[str, Any]:
        """검증된 초안을 생성하고 멱등 영수증을 반환한다."""
        if not self.configured:
            raise GoogleDemoError("Google 데모 계정이 설정되지 않았습니다.")
        normalized_request_id = request_id.strip() if isinstance(request_id, str) else ""
        if not normalized_request_id:
            raise GoogleDemoError("Google 쓰기 요청 ID가 필요합니다.")
        normalized = self._validate_draft(draft)

        # 한 프로세스 안에서는 조회부터 Google 호출, 저장까지 직렬화한다. 같은 requestId가
        # 동시에 승인되어도 네트워크 호출이 두 번 나가지 않는다.
        with self._lock:
            receipts = self._load_receipts()
            if existing := receipts.get(normalized_request_id):
                return {**existing, "duplicate": True}

            try:
                provider_id = self._api.create(normalized["kind"], normalized)
            except GoogleApiError as error:
                raise GoogleDemoError(str(error)) from None
            receipt = {
                "requestId": normalized_request_id,
                "providerId": provider_id,
                "title": normalized["title"],
                "duplicate": False,
            }
            receipts[normalized_request_id] = receipt
            self._save_receipts(receipts)
            return receipt

    @staticmethod
    def _validate_draft(draft: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(draft, dict):
            raise GoogleDemoError("Google 쓰기 초안 형식이 올바르지 않습니다.")
        title = draft.get("title")
        if not isinstance(title, str) or not title.strip():
            raise GoogleDemoError("Google 쓰기 제목이 필요합니다.")
        normalized_title = title.strip()
        if len(normalized_title) > 300:
            raise GoogleDemoError("Google 쓰기 제목이 너무 깁니다.")

        if draft.get("kind") == "calendar":
            start_at = draft.get("startAt")
            end_at = draft.get("endAt")
            start = GoogleDemoService._parse_datetime(start_at)
            end = GoogleDemoService._parse_datetime(end_at)
            if start is None or end is None or end <= start:
                raise GoogleDemoError("일정 시작·종료 시간을 확인해 주세요.")
            return {
                "kind": "calendar",
                "title": normalized_title,
                "startAt": start_at,
                "endAt": end_at,
            }

        if draft.get("kind") == "task":
            due = draft.get("due")
            if due is not None and (not isinstance(due, str) or not _DUE_DATE.fullmatch(due)):
                raise GoogleDemoError("할 일 기한은 YYYY-MM-DD 형식이어야 합니다.")
            if due is not None:
                try:
                    datetime.strptime(due, "%Y-%m-%d")
                except ValueError as exc:
                    raise GoogleDemoError("할 일 기한이 유효한 날짜가 아닙니다.") from exc
            return {"kind": "task", "title": normalized_title, "due": due}

        raise GoogleDemoError("지원하지 않는 Google 쓰기 종류입니다.")

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        if not isinstance(value, str) or len(value) > 80:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo is not None else None

    def _load_receipts(self) -> dict[str, dict[str, Any]]:
        if not self._receipts_path.exists():
            return {}
        try:
            payload = json.loads(self._receipts_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise GoogleDemoError("Google 데모 영수증을 읽지 못했습니다.") from exc
        return payload if isinstance(payload, dict) else {}

    def _save_receipts(self, receipts: dict[str, dict[str, Any]]) -> None:
        try:
            self._receipts_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._receipts_path.with_name(f"{self._receipts_path.name}.tmp")
            temporary.write_text(
                json.dumps(receipts, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(temporary, self._receipts_path)
        except OSError as exc:
            raise GoogleDemoError("Google 데모 영수증을 저장하지 못했습니다.") from exc
