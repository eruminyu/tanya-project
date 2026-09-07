"""Phase 8: DiscordChannel — Discord 봇 채널.

discord.py 라이브러리 기반.
- on_message 이벤트로 사용자 메시지 수신
- ChannelManager를 통해 Orchestrator 세션 관리
- ProactiveTriggerScheduler 연동 지원
- 허용 채널 ID 필터링 (빈 리스트 = 모든 채널)
"""
import asyncio
import logging

from channels.bot_base import BotChannel
from channels.manager import ChannelManager

logger = logging.getLogger(__name__)

try:
    import discord
    _DISCORD_AVAILABLE = True
except ImportError:
    _DISCORD_AVAILABLE = False
    discord = None  # type: ignore[assignment]


class DiscordChannel(BotChannel):
    """Discord 봇 채널.

    Args:
        channel_manager: Orchestrator 풀 관리자
        token: Discord 봇 토큰
        allowed_channel_ids: 허용할 채널 ID 목록 (빈 리스트 = 모든 채널)
        proactive_scheduler: ProactiveTriggerScheduler 인스턴스 (선택)
    """

    def __init__(
        self,
        channel_manager: ChannelManager,
        token: str,
        allowed_channel_ids: list[int] | None = None,
        proactive_scheduler=None,
    ) -> None:
        if not _DISCORD_AVAILABLE:
            raise ImportError("discord.py가 설치되지 않았습니다: pip install discord.py")

        self._manager = channel_manager
        self._token = token
        self._allowed_channel_ids = set(allowed_channel_ids or [])
        self._proactive_scheduler = proactive_scheduler
        self._client: discord.Client | None = None
        self._task: asyncio.Task | None = None

    def _make_session_key(self, message) -> str:
        guild_id = message.guild.id if message.guild else "dm"
        return f"discord:{guild_id}:{message.channel.id}"

    def _is_allowed(self, message) -> bool:
        """봇 자신의 메시지 및 허용되지 않은 채널은 무시."""
        if self._client and message.author == self._client.user:
            return False
        if self._allowed_channel_ids and message.channel.id not in self._allowed_channel_ids:
            return False
        return True

    async def _handle_message(self, message) -> None:
        session_key = self._make_session_key(message)
        orchestrator = self._manager.get_or_create(session_key)

        raw_data = {"type": "text", "content": message.content}
        response = await orchestrator.handle_message(raw_data)

        if self._proactive_scheduler is not None:
            self._proactive_scheduler.update_last_conversation()

        if response is not None:
            await message.channel.send(response.content)

    async def start(self) -> None:
        """Discord 클라이언트를 시작한다."""
        intents = discord.Intents.default()
        intents.message_content = True
        self._client = discord.Client(intents=intents)

        @self._client.event
        async def on_message(message):
            if not self._is_allowed(message):
                return
            await self._handle_message(message)

        # ProactiveTriggerScheduler 연동 — DM 채널 대상
        if self._proactive_scheduler is not None:
            async def _send_proactive(text: str, meta: dict | None = None):
                # 봇이 준비된 이후 DM 전송은 별도 구현이 필요하므로
                # 현재는 로깅만 (향후 특정 채널로 전송 가능)
                logger.info("[Discord Proactive] %s", text)

            self._proactive_scheduler.set_connection(_send_proactive, "discord:proactive")

        self._task = asyncio.create_task(self._client.start(self._token))
        logger.info("DiscordChannel 시작됨")

    async def stop(self) -> None:
        """Discord 클라이언트를 종료한다."""
        if self._proactive_scheduler is not None:
            self._proactive_scheduler.clear_connection("discord:proactive")

        if self._client is not None:
            await self._client.close()
            self._client = None

        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

        logger.info("DiscordChannel 종료됨")

    async def send_message(self, chat_id: str | int, text: str) -> None:
        """특정 채널 ID로 메시지를 전송한다."""
        if self._client is None:
            raise RuntimeError("DiscordChannel이 시작되지 않았습니다")
        channel = self._client.get_channel(int(chat_id))
        if channel is None:
            raise ValueError(f"채널을 찾을 수 없습니다: {chat_id}")
        await channel.send(text)
