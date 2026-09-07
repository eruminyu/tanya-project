"""OpenAI GPT LLM Provider."""

import logging
import typing

from core.providers.llm_base import LLMProvider

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    """OpenAI API 기반 LLM Provider (GPT-4o 등)."""

    def __init__(self, api_key: str, model_name: str = "gpt-4o", base_url: str | None = None):
        self._api_key = api_key
        self._model_name = model_name
        self._client: typing.Any = None

        if self._api_key or base_url:
            try:
                from openai import AsyncOpenAI

                self._client = AsyncOpenAI(
                    api_key=self._api_key if self._api_key else "dummy_api_key",
                    base_url=base_url
                )
            except Exception as e:
                logger.error("OpenAI 초기화 실패: %s", e)

    @property
    def provider_name(self) -> str:
        return "openai"

    def is_available(self) -> bool:
        return self._client is not None

    async def chat(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> str:
        messages = self._build_messages(user_input, system_prompt, history)
        try:
            response = await self._client.chat.completions.create(
                model=self._model_name,
                messages=messages,
            )
            return response.choices[0].message.content or ""
        except Exception as e:
            raise RuntimeError(f"OpenAI chat 오류: {e}") from e

    async def chat_stream(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> typing.AsyncGenerator[str, None]:
        messages = self._build_messages(user_input, system_prompt, history)
        try:
            response = await self._client.chat.completions.create(
                model=self._model_name,
                messages=messages,
                stream=True,
            )
            async for chunk in response:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            raise RuntimeError(f"OpenAI chat_stream 오류: {e}") from e

    async def analyze_image(
        self, base64_image: str, system_prompt: str = ""
    ) -> str:
        if not self._client:
            return "OpenAI not configured."

        messages: list[typing.Any] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": self._VISION_PROMPT,
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}"
                        },
                    },
                ],
            }
        )

        try:
            response = await self._client.chat.completions.create(
                model=self._model_name,
                messages=messages,
            )
            return response.choices[0].message.content or "화면을 볼 수 없어요."
        except Exception as e:
            logger.error("OpenAI Vision 오류: %s", e)
            return "화면을 볼 수 없어요."

    @staticmethod
    def _build_messages(
        user_input: str,
        system_prompt: str,
        history: list[dict] | None,
    ) -> list[dict]:
        """OpenAI API 형식의 메시지 리스트를 구성한다."""
        messages: list[typing.Any] = []

        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if history:
            for turn in history:
                messages.append(
                    {"role": turn["role"], "content": turn["content"]}
                )

        messages.append({"role": "user", "content": user_input})
        return messages
