"""Discord 채널 테스트.

discord.py가 없는 환경에서도 실행 가능하도록 mock 사용.
핵심 검증: 세션 키 생성, 허용 채널 필터링, Orchestrator 호출, 스케줄러 연동.
"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ──────────────────────────────────────────────
# BotChannel ABC
# ──────────────────────────────────────────────

class TestBotChannelABC:
    def test_bot_channel_is_abstract(self):
        """BotChannel은 추상 클래스라 직접 인스턴스화 불가."""
        from channels.bot_base import BotChannel
        with pytest.raises(TypeError):
            BotChannel()

    def test_bot_channel_requires_start_stop_send(self):
        """start, stop, send_message 추상 메서드가 존재한다."""
        from channels.bot_base import BotChannel
        assert hasattr(BotChannel, "start")
        assert hasattr(BotChannel, "stop")
        assert hasattr(BotChannel, "send_message")


# ──────────────────────────────────────────────
# DiscordChannel 단위 테스트
# ──────────────────────────────────────────────

def _make_discord_channel(allowed_channel_ids=None, proactive_scheduler=None):
    """discord.py를 mock한 DiscordChannel 반환."""
    mock_discord = MagicMock()
    mock_discord.Intents.default.return_value = MagicMock()
    mock_client = MagicMock()
    mock_discord.Client.return_value = mock_client

    with patch.dict("sys.modules", {"discord": mock_discord}):
        # 모듈 재로드를 피하기 위해 패치 상태에서 import
        import importlib
        import channels.discord_channel as dc_mod
        importlib.reload(dc_mod)

        from channels.manager import ChannelManager
        manager = ChannelManager()
        channel = dc_mod.DiscordChannel(
            channel_manager=manager,
            token="fake-token",
            allowed_channel_ids=allowed_channel_ids,
            proactive_scheduler=proactive_scheduler,
        )
        return channel, mock_client, mock_discord


class TestDiscordChannelSessionKey:
    def test_session_key_with_guild(self):
        """guild가 있는 메시지의 세션 키: discord:{guild_id}:{channel_id}."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            from channels.discord_channel import DiscordChannel

            channel = DiscordChannel(
                channel_manager=ChannelManager(),
                token="tok",
            )
            msg = MagicMock()
            msg.guild.id = 111
            msg.channel.id = 222

            key = channel._make_session_key(msg)
            assert key == "discord:111:222"

    def test_session_key_dm(self):
        """DM(guild=None)의 세션 키: discord:dm:{channel_id}."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            from channels.discord_channel import DiscordChannel

            channel = DiscordChannel(
                channel_manager=ChannelManager(),
                token="tok",
            )
            msg = MagicMock()
            msg.guild = None
            msg.channel.id = 333

            key = channel._make_session_key(msg)
            assert key == "discord:dm:333"


class TestDiscordChannelFilter:
    def test_allows_all_when_no_restriction(self):
        """allowed_channel_ids가 빈 리스트면 모든 채널 허용."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            from channels.discord_channel import DiscordChannel

            channel = DiscordChannel(ChannelManager(), token="tok")
            channel._client = MagicMock()

            msg = MagicMock()
            msg.author = MagicMock()  # 봇과 다른 유저
            channel._client.user = MagicMock()
            msg.author.__eq__ = lambda self, other: False
            msg.channel.id = 999

            assert channel._is_allowed(msg) is True

    def test_blocks_bot_own_message(self):
        """봇 자신의 메시지는 차단한다."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            from channels.discord_channel import DiscordChannel

            channel = DiscordChannel(ChannelManager(), token="tok")
            client_mock = MagicMock()
            channel._client = client_mock

            msg = MagicMock()
            # 봇 자신
            msg.author = client_mock.user

            # __eq__가 True가 되도록 설정
            with patch.object(channel, "_client") as mock_client:
                mock_client.user = msg.author
                assert channel._is_allowed(msg) is False

    def test_blocks_non_allowed_channel(self):
        """allowed_channel_ids에 없는 채널은 차단한다."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            from channels.discord_channel import DiscordChannel

            channel = DiscordChannel(
                ChannelManager(),
                token="tok",
                allowed_channel_ids=[100, 200],
            )
            channel._client = MagicMock()

            msg = MagicMock()
            msg.author = MagicMock()
            channel._client.user = MagicMock()
            msg.channel.id = 999  # 허용 목록에 없음

            assert channel._is_allowed(msg) is False

    def test_allows_allowed_channel(self):
        """allowed_channel_ids에 있는 채널은 허용한다."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            from channels.discord_channel import DiscordChannel

            channel = DiscordChannel(
                ChannelManager(),
                token="tok",
                allowed_channel_ids=[100, 200],
            )
            channel._client = MagicMock()

            msg = MagicMock()
            msg.author = MagicMock()
            channel._client.user = object()  # 다른 객체
            msg.channel.id = 100  # 허용 목록에 있음

            assert channel._is_allowed(msg) is True


class TestDiscordChannelHandleMessage:
    @pytest.mark.asyncio
    async def test_handle_message_calls_orchestrator(self):
        """메시지 수신 시 Orchestrator.handle_message가 호출된다."""
        from channels.manager import ChannelManager
        from channels.discord_channel import DiscordChannel

        mock_response = MagicMock()
        mock_response.content = "안녕하세요!"

        mock_orchestrator = MagicMock()
        mock_orchestrator.handle_message = AsyncMock(return_value=mock_response)

        manager = MagicMock(spec=ChannelManager)
        manager.get_or_create.return_value = mock_orchestrator

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            channel = DiscordChannel(manager, token="tok")

            msg = MagicMock()
            msg.guild.id = 1
            msg.channel.id = 2
            msg.content = "안녕?"
            msg.channel.send = AsyncMock()

            await channel._handle_message(msg)

            mock_orchestrator.handle_message.assert_called_once_with(
                {"type": "text", "content": "안녕?"}
            )
            msg.channel.send.assert_called_once_with("안녕하세요!")

    @pytest.mark.asyncio
    async def test_handle_message_none_response_no_send(self):
        """Orchestrator가 None 반환 시 send를 호출하지 않는다."""
        from channels.manager import ChannelManager
        from channels.discord_channel import DiscordChannel

        mock_orchestrator = MagicMock()
        mock_orchestrator.handle_message = AsyncMock(return_value=None)

        manager = MagicMock(spec=ChannelManager)
        manager.get_or_create.return_value = mock_orchestrator

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            channel = DiscordChannel(manager, token="tok")

            msg = MagicMock()
            msg.guild.id = 1
            msg.channel.id = 2
            msg.content = "..."
            msg.channel.send = AsyncMock()

            await channel._handle_message(msg)

            msg.channel.send.assert_not_called()

    @pytest.mark.asyncio
    async def test_handle_message_updates_scheduler(self):
        """메시지 처리 시 ProactiveTriggerScheduler에 통보한다."""
        from channels.manager import ChannelManager
        from channels.discord_channel import DiscordChannel

        mock_response = MagicMock()
        mock_response.content = "응답"

        mock_orchestrator = MagicMock()
        mock_orchestrator.handle_message = AsyncMock(return_value=mock_response)

        manager = MagicMock(spec=ChannelManager)
        manager.get_or_create.return_value = mock_orchestrator

        mock_scheduler = MagicMock()
        mock_scheduler.update_last_conversation = MagicMock()

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            channel = DiscordChannel(manager, token="tok", proactive_scheduler=mock_scheduler)

            msg = MagicMock()
            msg.guild.id = 1
            msg.channel.id = 2
            msg.content = "테스트"
            msg.channel.send = AsyncMock()

            await channel._handle_message(msg)

            mock_scheduler.update_last_conversation.assert_called_once()


class TestDiscordChannelLifecycle:
    @pytest.mark.asyncio
    async def test_stop_cancels_task(self):
        """stop() 시 내부 태스크가 취소되고 _task가 None이 된다."""
        from channels.manager import ChannelManager
        from channels.discord_channel import DiscordChannel

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            channel = DiscordChannel(ChannelManager(), token="tok")

            # 취소 가능한 태스크 주입
            async def _never_end():
                await asyncio.sleep(9999)

            task = asyncio.create_task(_never_end())
            channel._task = task
            mock_client = AsyncMock()
            channel._client = mock_client

            await channel.stop()

            assert task.done()  # 원래 태스크 참조로 확인
            assert channel._task is None  # stop 후 None으로 초기화
            mock_client.close.assert_awaited_once()

    def test_import_error_when_discord_not_available(self):
        """discord.py 미설치 시 ImportError 발생."""
        from channels.manager import ChannelManager

        with patch("channels.discord_channel._DISCORD_AVAILABLE", False):
            from channels.discord_channel import DiscordChannel
            with pytest.raises(ImportError, match="discord.py"):
                DiscordChannel(ChannelManager(), token="tok")

    @pytest.mark.asyncio
    async def test_send_message_raises_when_not_started(self):
        """start() 전 send_message() 호출 시 RuntimeError."""
        from channels.manager import ChannelManager
        from channels.discord_channel import DiscordChannel

        with patch("channels.discord_channel._DISCORD_AVAILABLE", True), \
             patch("channels.discord_channel.discord", MagicMock()):
            channel = DiscordChannel(ChannelManager(), token="tok")
            # _client = None (미시작)

            with pytest.raises(RuntimeError, match="시작되지 않았습니다"):
                await channel.send_message(123, "테스트")
