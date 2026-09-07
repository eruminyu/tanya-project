"""Google 일정·할 일 자연어 요청을 실행 불가능한 구조화 초안으로 변환한다."""

from __future__ import annotations

from datetime import datetime
import asyncio
import json
import re


_WRITE_HINT = re.compile(r"(추가|등록|생성|만들|잡아|기억해|잊지).*(일정|캘린더|약속|회의|미팅|할\s*일|태스크|작업)|(일정|캘린더|약속|회의|미팅|할\s*일|태스크).*(추가|등록|생성|만들|잡아)")
_FALLBACK_QUESTION = "일정이나 할 일 정보를 정확히 이해하지 못했어. 날짜와 시간을 조금 더 구체적으로 말해줄래?"


class GoogleWriteDraftExtractor:
    def __init__(self, llm):
        self._llm = llm

    @staticmethod
    def _build_prompt(text: str, now: str, timezone: str) -> str:
        """초안 생성 프롬프트.

        이 프롬프트는 길이(400자 이상)와 "설명" 키워드 때문에 ModeClassifier가
        TASK로 판정한다. 그래서 chat()이 아니라 chat_casual()로 보내야 한다 (T-016).
        """
        return f"""사용자의 Google Calendar 일정 생성 또는 Google Tasks 할 일 생성 요청을 JSON 하나로만 변환해.
현재 시각: {now}
사용자 시간대: {timezone}

규칙:
- 일정은 kind=calendar, title, startAt, endAt을 RFC3339 오프셋 포함 문자열로 반환한다.
- 할 일은 kind=task, title, due를 YYYY-MM-DD 또는 null로 반환한다.
- 일정의 날짜, 시작 시각, 종료 시각이 불명확하면 절대 추측하지 말고 status=clarify와 짧은 한국어 question을 반환한다.
- 사용자가 종료 시각을 말하지 않았다면 정확히 확인 질문을 한다.
- 생성 요청이 아니면 status=none을 반환한다.
- 설명이나 Markdown 없이 JSON 객체만 반환한다.

사용자 요청: {text}"""

    async def extract(self, text: str, now: str, timezone: str) -> dict | None:
        if not _WRITE_HINT.search(text):
            return None
        prompt = self._build_prompt(text, now, timezone)
        try:
            # ADR-0007: 분류를 거치지 않고 일상 모드(로컬)로 고정한다.
            # 이 프롬프트에는 사용자의 일정 제목이 그대로 들어가므로
            # chat()으로 보내면 TASK로 분류되어 클라우드 provider로 나간다.
            raw = await asyncio.wait_for(
                self._llm.chat_casual(prompt, system_prompt="너는 실행하지 않고 초안만 만드는 엄격한 일정·할 일 파서다.", history=[]),
                timeout=30,
            )
        except Exception:
            return {"clarification": "일정 초안을 만드는 데 시간이 너무 오래 걸렸어. 날짜와 시간을 다시 한 번 말해줄래?"}
        return self._parse(raw)

    @staticmethod
    def _parse(raw: str) -> dict:
        if not isinstance(raw, str):
            return {"clarification": _FALLBACK_QUESTION}
        candidate = raw.strip()
        if match := re.search(r"\{[\s\S]*\}", candidate):
            candidate = match.group(0)
        try:
            value = json.loads(candidate)
        except (json.JSONDecodeError, AttributeError):
            return {"clarification": _FALLBACK_QUESTION}
        if not isinstance(value, dict):
            return {"clarification": _FALLBACK_QUESTION}
        if value.get("status") == "none":
            return None
        if value.get("status") == "clarify":
            question = value.get("question")
            return {"clarification": question.strip() if isinstance(question, str) and question.strip() else _FALLBACK_QUESTION}
        if value.get("status") not in (None, "draft") or not isinstance(value.get("title"), str) or not value["title"].strip():
            return {"clarification": _FALLBACK_QUESTION}
        if value.get("kind") == "calendar":
            try:
                start = datetime.fromisoformat(value["startAt"])
                end = datetime.fromisoformat(value["endAt"])
            except (KeyError, TypeError, ValueError):
                return {"clarification": _FALLBACK_QUESTION}
            if start.tzinfo is None or end.tzinfo is None or end <= start:
                return {"clarification": _FALLBACK_QUESTION}
            return {"kind": "calendar", "title": value["title"].strip(), "startAt": value["startAt"], "endAt": value["endAt"]}
        if value.get("kind") == "task":
            due = value.get("due")
            if due is not None:
                try:
                    datetime.strptime(due, "%Y-%m-%d")
                except (TypeError, ValueError):
                    return {"clarification": _FALLBACK_QUESTION}
            return {"kind": "task", "title": value["title"].strip(), "due": due}
        return {"clarification": _FALLBACK_QUESTION}
