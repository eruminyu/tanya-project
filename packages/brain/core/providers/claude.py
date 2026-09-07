"""Anthropic Claude LLM Provider."""

import logging
import typing

from core.providers.llm_base import LLMProvider

logger = logging.getLogger(__name__)


class ClaudeProvider(LLMProvider):
    """Anthropic Claude API 기반 LLM Provider."""

    def __init__(self, api_key: str, model_name: str = "claude-sonnet-4-20250514"):
        self._api_key = api_key
        self._model_name = model_name
        self._client: typing.Any = None

        if self._api_key:
            try:
                from anthropic import AsyncAnthropic

                self._client = AsyncAnthropic(api_key=self._api_key)
            except Exception as e:
                logger.error("Claude 초기화 실패: %s", e)

    @property
    def provider_name(self) -> str:
        return "claude"

    def is_available(self) -> bool:
        return self._client is not None

    async def chat(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> str:
        messages = self._build_messages(user_input, history)
        try:
            response = await self._client.messages.create(
                model=self._model_name,
                max_tokens=4096,
                system=system_prompt if system_prompt else "",
                messages=messages,
            )
            # Claude는 content가 list[ContentBlock]
            return response.content[0].text if response.content else ""
        except Exception as e:
            raise RuntimeError(f"Claude chat 오류: {e}") from e

    async def chat_stream(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> typing.AsyncGenerator[str, None]:
        """Claude 스트리밍 응답 (현재 구조상 단일 덩어리 전송)."""
        messages = self._build_messages(user_input, history)
        try:
            response = await self._client.messages.create(
                model=self._model_name,
                max_tokens=4096,
                system=system_prompt if system_prompt else "",
                messages=messages,
            )
            text = response.content[0].text if response.content else ""
            yield text
        except Exception as e:
            yield f"Claude stream 오류: {e}"

    async def analyze_image(
        self, base64_image: str, system_prompt: str = ""
    ) -> str:
        if not self._client:
            return "Claude not configured."

        try:
            response = await self._client.messages.create(
                model=self._model_name,
                max_tokens=1024,
                system=system_prompt if system_prompt else "",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/jpeg",
                                    "data": base64_image,
                                },
                            },
                            {
                                "type": "text",
                                "text": self._VISION_PROMPT,
                            },
                        ],
                    }
                ],
            )
            return response.content[0].text if response.content else "화면을 볼 수 없어요."
        except Exception as e:
            logger.error("Claude Vision 오류: %s", e)
            return "화면을 볼 수 없어요."

    @staticmethod
    def _build_messages(
        user_input: str,
        history: list[dict] | None,
    ) -> list[dict]:
        """Claude API 형식의 메시지 리스트를 구성한다.

        Note: Claude는 system을 별도 파라미터로 받으므로 여기에 포함하지 않는다.
        """
        messages = []

        if history:
            for turn in history:
                messages.append(
                    {"role": turn["role"], "content": turn["content"]}
                )

        messages.append({"role": "user", "content": user_input})
        return messages
