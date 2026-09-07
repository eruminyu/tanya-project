import pytest
import asyncio

from action.google_write_draft import GoogleWriteDraftExtractor


class FakeLlm:
    def __init__(self, response: str):
        self.response = response
        self.calls = []
        self.cloud_calls = []

    async def chat_casual(self, user_input, system_prompt="", history=None):
        """ADR-0007 경로 — 분류를 거치지 않고 일상 모드(로컬)로 고정."""
        self.calls.append((user_input, system_prompt))
        return self.response

    async def chat(self, user_input, system_prompt="", history=None):
        """분류 라우팅 경로. 초안 생성이 여기로 오면 일정 제목이 클라우드로 나간다."""
        self.cloud_calls.append((user_input, system_prompt))
        return self.response


@pytest.mark.asyncio
async def test_non_write_conversation_does_not_call_llm():
    llm = FakeLlm("should not be used")
    result = await GoogleWriteDraftExtractor(llm).extract("오늘 기분 어때?", "2026-08-16T09:00:00+09:00", "Asia/Seoul")
    assert result is None
    assert llm.calls == []


@pytest.mark.asyncio
async def test_calendar_request_returns_strict_draft():
    llm = FakeLlm('{"status":"draft","kind":"calendar","title":"회의","startAt":"2026-08-17T15:00:00+09:00","endAt":"2026-08-17T16:00:00+09:00"}')
    result = await GoogleWriteDraftExtractor(llm).extract("내일 3시에 회의 일정 잡아줘", "2026-08-16T09:00:00+09:00", "Asia/Seoul")
    assert result == {"kind": "calendar", "title": "회의", "startAt": "2026-08-17T15:00:00+09:00", "endAt": "2026-08-17T16:00:00+09:00"}


@pytest.mark.asyncio
async def test_ambiguous_request_returns_clarification_only():
    llm = FakeLlm('{"status":"clarify","question":"몇 시 일정으로 잡을까?"}')
    result = await GoogleWriteDraftExtractor(llm).extract("내일 회의 일정 잡아줘", "2026-08-16T09:00:00+09:00", "Asia/Seoul")
    assert result == {"clarification": "몇 시 일정으로 잡을까?"}


@pytest.mark.asyncio
async def test_invalid_llm_output_is_not_executable():
    llm = FakeLlm("물론이지! 바로 추가할게.")
    result = await GoogleWriteDraftExtractor(llm).extract("내일 회의 일정 잡아줘", "2026-08-16T09:00:00+09:00", "Asia/Seoul")
    assert result == {"clarification": "일정이나 할 일 정보를 정확히 이해하지 못했어. 날짜와 시간을 조금 더 구체적으로 말해줄래?"}


def test_markdown_explanation_around_json_is_safely_extracted():
    raw = '요청한 초안이야.\n```json\n{"status":"draft","kind":"task","title":"자료 정리","due":null}\n```'
    assert GoogleWriteDraftExtractor._parse(raw) == {"kind": "task", "title": "자료 정리", "due": None}


def test_strict_draft_without_optional_status_is_accepted():
    raw = '{"kind":"calendar","title":"회의","startAt":"2026-08-17T15:00+09:00","endAt":"2026-08-17T16:00+09:00"}'
    assert GoogleWriteDraftExtractor._parse(raw) == {"kind": "calendar", "title": "회의", "startAt": "2026-08-17T15:00+09:00", "endAt": "2026-08-17T16:00+09:00"}


@pytest.mark.asyncio
async def test_llm_timeout_returns_safe_clarification(monkeypatch):
    class SlowLlm:
        async def chat(self, *args, **kwargs):
            await asyncio.sleep(1)
    original = asyncio.wait_for
    async def short_wait(awaitable, timeout):
        return await original(awaitable, timeout=0.01)
    monkeypatch.setattr("action.google_write_draft.asyncio.wait_for", short_wait)
    result = await GoogleWriteDraftExtractor(SlowLlm()).extract("내일 회의 일정 잡아줘", "2026-08-16T09:00:00+09:00", "Asia/Seoul")
    assert "시간이 너무 오래" in result["clarification"]


# ── T-016: 초안 생성도 로컬로 고정한다 (ADR-0007) ─────────────────────────────

@pytest.mark.asyncio
async def test_draft_extraction_never_takes_the_classified_route():
    """초안 프롬프트에는 일정 제목이 들어간다. 분류 라우팅을 타면 클라우드로 나간다."""
    llm = FakeLlm('{"status":"draft","kind":"calendar","title":"회의","startAt":"2026-08-17T15:00:00+09:00","endAt":"2026-08-17T16:00:00+09:00"}')

    await GoogleWriteDraftExtractor(llm).extract(
        "내일 3시에 프로젝트 회의 일정 잡아줘", "2026-08-16T09:00:00+09:00", "Asia/Seoul"
    )

    assert llm.calls, "일상 모드 고정 경로로 호출되어야 한다"
    assert llm.cloud_calls == [], "분류 라우팅(chat)을 타면 안 된다"


def test_draft_prompt_would_be_classified_as_task():
    """왜 고정이 필요한지 — 이 프롬프트는 분류기가 TASK로 보낸다."""
    from core.mode import ModeClassifier, TanyaMode

    llm = FakeLlm("")
    extractor = GoogleWriteDraftExtractor(llm)
    prompt = extractor._build_prompt(
        "내일 3시에 프로젝트 회의 일정 잡아줘", "2026-08-16T09:00:00+09:00", "Asia/Seoul"
    )

    assert len(prompt) > 100, "길이만으로도 TASK 임계값을 넘는다"
    assert ModeClassifier().classify(prompt) is TanyaMode.TASK
