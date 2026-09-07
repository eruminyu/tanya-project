"""Phase 9-B: 채널 ↔ ProactiveTriggerScheduler 연동 테스트."""

import json
import sqlite3
import tempfile
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.proactive import ProactiveTriggerScheduler, TriggerContext, TriggerRule
from core.proactive_rules import LongSessionRule, NightCheckRule, WorkReminderRule


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

class AlwaysFireRule(TriggerRule):
    rule_name = "always_fire"
    cooldown_hours = 1

    def should_fire(self, ctx: TriggerContext) -> bool:
        return True

    def get_prompt(self, ctx: TriggerContext) -> str:
        return "테스트"


def _make_scheduler(rules=None, db_path=":memory:"):
    mock_llm = AsyncMock()
    mock_llm.chat_casual = AsyncMock(return_value="안녕!")
    return ProactiveTriggerScheduler(
        rules=rules or [AlwaysFireRule()],
        llm=mock_llm,
        persona_prompt="페르소나",
        db_path=db_path,
        check_interval_seconds=0.05,
    )


# ── 채널 연동: WebChatChannel ─────────────────────────────────────────────────

class TestWebChatChannelSchedulerIntegration:
    @pytest.mark.asyncio
    async def test_registers_scheduler_on_connect(self):
        """WebChatChannel 연결 시 스케줄러에 set_connection 호출."""
        from channels.webchat import WebChatChannel
        from core.orchestrator import Orchestrator
        from starlette.websockets import WebSocketDisconnect

        scheduler = _make_scheduler()
        set_calls = []
        original_set = scheduler.set_connection
        scheduler.set_connection = lambda fn, key: (set_calls.append(key), original_set(fn, key))

        mock_orch = MagicMock(spec=Orchestrator)
        mock_orch.handle_message = AsyncMock(return_value=None)

        ws = AsyncMock()
        ws.app = MagicMock()
        ws.app.state = MagicMock()
        ws.app.state.proactive_scheduler = scheduler
        ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

        channel = WebChatChannel(orchestrator=mock_orch, session_key="webchat:test")
        await channel.handle(ws)

        assert "webchat:test" in set_calls

    @pytest.mark.asyncio
    async def test_clears_scheduler_on_disconnect(self):
        """WebChatChannel 해제 시 clear_connection 호출."""
        from channels.webchat import WebChatChannel
        from core.orchestrator import Orchestrator
        from starlette.websockets import WebSocketDisconnect

        scheduler = _make_scheduler()
        mock_orch = MagicMock(spec=Orchestrator)
        mock_orch.handle_message = AsyncMock(return_value=None)

        ws = AsyncMock()
        ws.app = MagicMock()
        ws.app.state = MagicMock()
        ws.app.state.proactive_scheduler = scheduler
        ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

        channel = WebChatChannel(orchestrator=mock_orch, session_key="webchat:test")
        await channel.handle(ws)

        assert not scheduler.is_connected

    @pytest.mark.asyncio
    async def test_disabled_connection_does_not_register_scheduler(self):
        """사용자가 선제 제안을 끄면 Brain 연결과 쿨다운을 소비하지 않는다."""
        from channels.webchat import WebChatChannel
        from core.orchestrator import Orchestrator
        from starlette.websockets import WebSocketDisconnect

        scheduler = _make_scheduler()
        scheduler.set_connection = MagicMock()
        mock_orch = MagicMock(spec=Orchestrator)
        ws = AsyncMock()
        ws.app = MagicMock()
        ws.app.state = MagicMock()
        ws.app.state.proactive_scheduler = scheduler
        ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

        channel = WebChatChannel(
            orchestrator=mock_orch,
            session_key="webchat:test",
            enable_proactive=False,
        )
        await channel.handle(ws)

        scheduler.set_connection.assert_not_called()

    @pytest.mark.asyncio
    async def test_proactive_text_is_wrapped_as_json_event(self):
        """선제 제안은 데스크톱이 구분 가능한 JSON 이벤트로 전달한다."""
        from channels.webchat import WebChatChannel
        from core.orchestrator import Orchestrator
        from starlette.websockets import WebSocketDisconnect

        scheduler = _make_scheduler()
        captured = {}
        scheduler.set_connection = lambda send_fn, key: captured.update(send_fn=send_fn, key=key)
        scheduler.clear_connection = MagicMock()
        mock_orch = MagicMock(spec=Orchestrator)
        ws = AsyncMock()
        ws.app = MagicMock()
        ws.app.state = MagicMock()
        ws.app.state.proactive_scheduler = scheduler
        ws.receive_text = AsyncMock(side_effect=WebSocketDisconnect())

        channel = WebChatChannel(mock_orch, session_key="webchat:test")
        await channel.handle(ws)
        scheduler.clear_connection.assert_called_once_with(
            "webchat:test", captured["send_fn"]
        )
        await captured["send_fn"]("잠깐 쉬는 게 어때?")

        payload = json.loads(ws.send_text.await_args.args[0])
        assert payload == {
            "type": "event",
            "event": "proactive_suggestion",
            "payload": {"text": "잠깐 쉬는 게 어때?"},
        }


# ── 추가 규칙: NightCheckRule ─────────────────────────────────────────────────

class TestNightCheckRule:
    def _ctx(self, hour):
        now = datetime(2026, 3, 17, hour % 24, 30, 0)
        return TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now - timedelta(hours=1),
            daily_fire_count=0,
            hour_of_day=hour % 24,
        )

    def test_fires_at_23(self):
        rule = NightCheckRule()
        assert rule.should_fire(self._ctx(23)) is True

    def test_fires_at_0(self):
        rule = NightCheckRule()
        assert rule.should_fire(self._ctx(0)) is True

    def test_does_not_fire_at_noon(self):
        rule = NightCheckRule()
        assert rule.should_fire(self._ctx(12)) is False

    def test_prompt_is_string(self):
        rule = NightCheckRule()
        ctx = self._ctx(23)
        assert isinstance(rule.get_prompt(ctx), str)

    def test_rule_name(self):
        assert NightCheckRule.rule_name == "night_check"

    def test_cooldown_hours(self):
        assert NightCheckRule.cooldown_hours == 8


# ── 추가 규칙: LongSessionRule ────────────────────────────────────────────────

class TestLongSessionRule:
    def _ctx(self, session_hours):
        now = datetime(2026, 3, 17, 15, 0, 0)
        return TriggerContext(
            now=now,
            last_conversation_at=now - timedelta(minutes=10),
            session_start_at=now - timedelta(hours=session_hours),
            daily_fire_count=0,
            hour_of_day=15,
        )

    def test_fires_when_session_exceeds_threshold(self):
        rule = LongSessionRule()
        assert rule.should_fire(self._ctx(3)) is True

    def test_fires_exactly_at_threshold(self):
        rule = LongSessionRule()
        assert rule.should_fire(self._ctx(2)) is True

    def test_does_not_fire_short_session(self):
        rule = LongSessionRule()
        assert rule.should_fire(self._ctx(1)) is False

    def test_prompt_is_string(self):
        rule = LongSessionRule()
        ctx = self._ctx(3)
        assert isinstance(rule.get_prompt(ctx), str)

    def test_rule_name(self):
        assert LongSessionRule.rule_name == "long_session"

    def test_cooldown_hours(self):
        assert LongSessionRule.cooldown_hours == 2


# ── 추가 규칙: WorkReminderRule ───────────────────────────────────────────────

class TestWorkReminderRule:
    def _ctx(self, hour, weekday=1):  # 1=Tuesday
        now = datetime(2026, 3, 17, hour, 0, 0)  # 2026-03-17은 화요일
        return TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=hour,
        )

    def test_fires_on_weekday_at_target_hour(self):
        rule = WorkReminderRule(target_hour=10)
        assert rule.should_fire(self._ctx(hour=10)) is True

    def test_does_not_fire_wrong_hour(self):
        rule = WorkReminderRule(target_hour=10)
        assert rule.should_fire(self._ctx(hour=11)) is False

    def test_does_not_fire_on_weekend(self):
        rule = WorkReminderRule(target_hour=10)
        # 2026-03-21은 토요일
        now = datetime(2026, 3, 21, 10, 0, 0)
        ctx = TriggerContext(
            now=now,
            last_conversation_at=None,
            session_start_at=now,
            daily_fire_count=0,
            hour_of_day=10,
        )
        assert rule.should_fire(ctx) is False

    def test_prompt_is_string(self):
        rule = WorkReminderRule(target_hour=10)
        ctx = self._ctx(hour=10)
        assert isinstance(rule.get_prompt(ctx), str)

    def test_rule_name(self):
        assert WorkReminderRule.rule_name == "work_reminder"

    def test_cooldown_hours(self):
        assert WorkReminderRule.cooldown_hours == 12


# ── 쿨다운 SQLite 영속화 ──────────────────────────────────────────────────────

class TestCooldownPersistence:
    def test_cooldown_persisted_to_db(self):
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        scheduler = _make_scheduler(db_path=db_path)
        scheduler._record_fire("test_rule")

        # DB에 직접 조회
        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "SELECT last_fired_at FROM proactive_cooldowns WHERE rule_name = ?",
            ("test_rule",),
        ).fetchone()
        conn.close()

        assert row is not None
        assert row[0] is not None

    def test_cooldown_loaded_from_db(self):
        """재시작 시뮬레이션: DB에 쿨다운이 있으면 새 스케줄러도 인식."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        # 첫 번째 스케줄러 — 쿨다운 기록
        s1 = _make_scheduler(db_path=db_path)
        s1._record_fire("always_fire")

        # 두 번째 스케줄러 (재시작 시뮬레이션)
        s2 = _make_scheduler(db_path=db_path)
        # 방금 기록했으므로 쿨다운 중이어야 함
        assert not s2._is_cooled_down("always_fire")

    def test_in_memory_db_works(self):
        """기본값 :memory: 도 정상 동작 — 발동 후 쿨다운 중임을 확인."""
        scheduler = _make_scheduler(db_path=":memory:")
        # AlwaysFireRule(cooldown_hours=1)이 등록된 상태로 발동 기록
        scheduler._record_fire("always_fire")
        # 쿨다운 중이어야 함 (방금 발동했으므로 _is_cooled_down == False)
        assert not scheduler._is_cooled_down("always_fire")


# ── T-013: type "context" 수신 ─────────────────────────────────────────────────

def _context_websocket(messages):
    """지정한 메시지를 순서대로 준 뒤 연결을 끊는 가짜 WebSocket."""
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_text = AsyncMock()
    queue = [json.dumps(m, ensure_ascii=False) for m in messages]

    async def receive_text():
        if queue:
            return queue.pop(0)
        from fastapi import WebSocketDisconnect
        raise WebSocketDisconnect()

    ws.receive_text = AsyncMock(side_effect=receive_text)
    return ws


class TestScheduleContextMessage:
    @pytest.mark.asyncio
    async def test_context_message_updates_scheduler_without_replying(self):
        """일정 스냅샷은 대화가 아니다. 타냐가 대답하면 안 된다."""
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        orch = MagicMock()
        orch.handle_message_stream = MagicMock(
            side_effect=AssertionError("일정 스냅샷을 대화로 처리하면 안 된다")
        )
        ws = _context_websocket([{
            "type": "context",
            "context": {
                "now": "2026-09-15T14:20:00+09:00",
                "timeZone": "Asia/Seoul",
                "events": [{
                    "id": "abc123",
                    "title": "프로젝트 회의",
                    "startsAt": "2026-09-15T15:00:00+09:00",
                    "allDay": False,
                }],
            },
        }])

        channel = WebChatChannel(orchestrator=orch, enable_proactive=True)
        channel._session_key = "test"
        with patch.object(channel, "_get_scheduler", return_value=scheduler, create=True):
            await channel.handle(ws)

        assert ws.send_text.await_count == 0
        events = scheduler._build_context("test").events
        assert [e.id for e in events] == ["abc123"]
        assert events[0].title == "프로젝트 회의"
        assert events[0].all_day is False

    @pytest.mark.asyncio
    async def test_malformed_events_are_skipped_not_fatal(self):
        """일부 항목이 깨져도 연결이 끊기면 안 된다."""
        from core.schedule_context import parse_schedule_events

        events = parse_schedule_events([
            {"id": "ok", "title": "정상", "startsAt": "2026-09-15T15:00:00+09:00", "allDay": False},
            {"id": "no-time", "title": "시각 없음"},
            {"title": "id 없음", "startsAt": "2026-09-15T15:00:00+09:00"},
            "문자열",
        ])

        assert [e.id for e in events] == ["ok"]

    @pytest.mark.asyncio
    async def test_empty_events_clears_the_snapshot(self):
        """Google 연결이 끊기면 클라이언트가 빈 목록을 보낸다. 옛 일정이 남으면 안 된다."""
        from core.schedule_context import parse_schedule_events

        assert parse_schedule_events([]) == []


# ── T-014: 선제 발화에 음성을 붙인다 ──────────────────────────────────────────

async def _run_and_capture_send(channel, scheduler, ws):
    """handle()은 종료 시 clear_connection을 부르므로 등록 시점에 발화 함수를 잡는다."""
    captured = {}
    original = scheduler.set_connection

    def capture(send_fn, session_key):
        captured["fn"] = send_fn
        return original(send_fn, session_key)

    scheduler.set_connection = capture
    await channel.handle(ws)
    return captured["fn"]


def _proactive_ws(scheduler):
    ws = _context_websocket([])
    ws.app = MagicMock()
    ws.app.state.proactive_scheduler = scheduler
    return ws


def _sent_events(ws):
    return [json.loads(c.args[0]) for c in ws.send_text.call_args_list]


class TestProactiveSpeech:
    """선제 발화도 대화 응답과 같은 tts 이벤트 형식으로 소리가 나야 한다."""

    @pytest.mark.asyncio
    async def test_proactive_emits_tts_before_the_suggestion(self):
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        ws = _proactive_ws(scheduler)

        async def audio_stream(_text, **_kwargs):
            yield b"wav"

        with patch("channels.webchat.TTSManager") as MockTTS:
            MockTTS.return_value.generate_stream = audio_stream
            channel = WebChatChannel(orchestrator=MagicMock(), include_audio=True, enable_proactive=True)
            send = await _run_and_capture_send(channel, scheduler, ws)
            await send("3시에 회의 있어. 준비할 시간 잡아둘까?")

        names = [m.get("event") for m in _sent_events(ws)]
        assert "tts_sentence" in names, "합성 문장을 먼저 알려야 자막이 뜬다"
        assert "tts_chunk" in names, "오디오 청크가 없으면 무음이다"
        assert "proactive_suggestion" in names
        assert names.index("tts_sentence") < names.index("tts_chunk")
        assert names.index("tts_chunk") < names.index("proactive_suggestion")

    @pytest.mark.asyncio
    async def test_caption_text_keeps_emoji(self):
        """자막용 원문은 이모지를 유지한다 (spec v1.2 §4.1)."""
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        ws = _proactive_ws(scheduler)

        async def audio_stream(text, **_kwargs):
            assert "🎉" not in text, "합성 입력에서는 이모지를 뺀다"
            yield b"wav"

        with patch("channels.webchat.TTSManager") as MockTTS:
            MockTTS.return_value.generate_stream = audio_stream
            channel = WebChatChannel(orchestrator=MagicMock(), include_audio=True, enable_proactive=True)
            send = await _run_and_capture_send(channel, scheduler, ws)
            await send("회의 준비하자! 🎉")

        sentences = [m["payload"]["text"] for m in _sent_events(ws) if m.get("event") == "tts_sentence"]
        assert sentences == ["회의 준비하자! 🎉"]

    @pytest.mark.asyncio
    async def test_proactive_sends_end_sentinel(self):
        """종료 신호가 없으면 클라이언트의 speaking이 영원히 true로 남는다."""
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        ws = _proactive_ws(scheduler)

        async def audio_stream(_text, **_kwargs):
            yield b"wav"

        with patch("channels.webchat.TTSManager") as MockTTS:
            MockTTS.return_value.generate_stream = audio_stream
            channel = WebChatChannel(orchestrator=MagicMock(), include_audio=True, enable_proactive=True)
            send = await _run_and_capture_send(channel, scheduler, ws)
            await send("안녕!")

        chunks = [m["payload"] for m in _sent_events(ws) if m.get("event") == "tts_chunk"]
        assert chunks[-1]["is_last"] is True and chunks[-1]["data"] == ""

    @pytest.mark.asyncio
    async def test_text_only_channel_stays_silent(self):
        """오디오를 끈 채널(WebChat)은 TTS를 만들지 않는다."""
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        ws = _proactive_ws(scheduler)
        channel = WebChatChannel(orchestrator=MagicMock(), include_audio=False, enable_proactive=True)
        send = await _run_and_capture_send(channel, scheduler, ws)
        await send("안녕!")

        names = [m.get("event") for m in _sent_events(ws)]
        assert "tts_chunk" not in names
        assert "proactive_suggestion" in names

    @pytest.mark.asyncio
    async def test_tts_failure_still_delivers_the_suggestion(self):
        """음성 합성이 실패해도 제안 자체는 도착해야 한다."""
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        ws = _proactive_ws(scheduler)

        async def broken(_text, **_kwargs):
            raise RuntimeError("TTS 죽음")
            yield b""

        with patch("channels.webchat.TTSManager") as MockTTS:
            MockTTS.return_value.generate_stream = broken
            channel = WebChatChannel(orchestrator=MagicMock(), include_audio=True, enable_proactive=True)
            send = await _run_and_capture_send(channel, scheduler, ws)
            await send("안녕!")

        assert "proactive_suggestion" in [m.get("event") for m in _sent_events(ws)]


# ── T-015: 수락하면 초안이 만들어진다 ─────────────────────────────────────────

class TestOfferAcceptance:
    @pytest.mark.asyncio
    async def test_acceptance_after_offer_emits_a_draft(self):
        """"그래" 한마디로 초안이 나와야 한다. LLM을 거치지 않는다."""
        from channels.webchat import WebChatChannel
        from core.proactive import ScheduleEvent

        scheduler = _make_scheduler()
        ws = _context_websocket([{"type": "text", "content": "그래"}])
        ws.app = MagicMock()
        ws.app.state.proactive_scheduler = scheduler
        orch = MagicMock()
        orch.handle_message_stream = MagicMock(
            side_effect=AssertionError("수락은 LLM을 거치지 않는다")
        )
        orch.prepare_google_draft.side_effect = lambda draft: {
            **draft,
            "requestId": "request-1",
            "approvalToken": "approval-1",
            "executor": "brain",
        }

        channel = WebChatChannel(orchestrator=orch, include_audio=False, enable_proactive=True)
        # 제안이 먼저 나가 있어야 한다.
        channel._pending_offer = None
        captured = {}
        original = scheduler.set_connection

        def capture(send_fn, key):
            captured["fn"] = send_fn
            return original(send_fn, key)

        scheduler.set_connection = capture

        starts = datetime.now() + timedelta(minutes=30)
        meta = {"rule": "upcoming_event",
                "event": {"id": "evt-1", "title": "프로젝트 회의", "starts_at": starts}}

        # handle이 돌기 전에 제안을 심을 수 없으므로, 제안 → 수신을 순서대로 재현한다.
        async def scenario():
            await channel.handle(ws)

        # send_fn은 handle 안에서 등록되므로, 메시지 큐를 비우고 제안부터 보낸다.
        ws.receive_text = AsyncMock(side_effect=_scripted_receiver(
            channel, lambda: captured.get("fn"), meta, ["그래"]))
        await scenario()

        sent = [json.loads(c.args[0]) for c in ws.send_text.call_args_list]
        drafts = [m for m in sent if m.get("event") == "google_write_draft"]
        assert drafts, "수락했는데 초안이 나오지 않았다"
        responses = [m for m in sent if m.get("type") == "response"]
        assert responses[-1]["content"] == "초안을 만들었습니다. Agent Dock에서 확인하고 승인해 주세요."
        assert drafts[0]["payload"]["kind"] == "calendar"
        assert drafts[0]["payload"]["title"] == "프로젝트 회의 준비"
        assert drafts[0]["payload"]["approvalToken"] == "approval-1"
        orch.prepare_google_draft.assert_called_once()

    @pytest.mark.asyncio
    async def test_unrelated_message_falls_through_to_conversation(self):
        """수락이 아니면 평소대로 대화로 처리한다."""
        from channels.webchat import WebChatChannel

        scheduler = _make_scheduler()
        ws = _context_websocket([{"type": "text", "content": "오늘 날씨 어때?"}])
        ws.app = MagicMock()
        ws.app.state.proactive_scheduler = scheduler
        handled = []

        async def stream(raw, include_audio=False):
            handled.append(raw)
            yield ("text", "맑아!")

        orch = MagicMock()
        orch.handle_message_stream = stream

        channel = WebChatChannel(orchestrator=orch, include_audio=False, enable_proactive=True)
        await channel.handle(ws)

        assert handled, "수락이 아닌 메시지는 대화로 처리되어야 한다"


def _scripted_receiver(channel, get_send_fn, meta, messages):
    """제안을 먼저 보낸 뒤 지정한 메시지를 순서대로 준다."""
    state = {"offered": False, "queue": list(messages)}

    async def receive():
        if not state["offered"]:
            state["offered"] = True
            send = get_send_fn()
            await send("3시에 회의 있어. 준비할 시간 잡아둘까?", meta)
        if state["queue"]:
            return json.dumps({"type": "text", "content": state["queue"].pop(0)}, ensure_ascii=False)
        from fastapi import WebSocketDisconnect
        raise WebSocketDisconnect()

    return receive
