"""Google Gemini LLM Provider."""

import logging
import typing

from core.providers.llm_base import LLMProvider

logger = logging.getLogger(__name__)


class GeminiProvider(LLMProvider):
    """Google Gemini (langchain-google-genai) 기반 LLM Provider."""

    def __init__(self, api_key: str, model_name: str = "gemini-2.5-flash-preview-05-20"):
        self._api_key = api_key
        self._model_name = model_name
        self._client: typing.Any = None

        if self._api_key:
            try:
                from langchain_google_genai import ChatGoogleGenerativeAI

                self._client = ChatGoogleGenerativeAI(
                    model=self._model_name,
                    google_api_key=self._api_key,
                )
            except Exception as e:
                logger.error("Gemini 초기화 실패: %s", e)

    @property
    def provider_name(self) -> str:
        return "gemini"

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
            response = await self._client.ainvoke(messages)
            return response.content
        except Exception as e:
            raise RuntimeError(f"Gemini chat 오류: {e}") from e

    async def chat_stream(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> typing.AsyncGenerator[str, None]:
        """Gemini 스트리밍 응답 제너레이터."""
        messages = self._build_messages(user_input, system_prompt, history)
        try:
            async for chunk in self._client.astream(messages):
                if chunk.content:
                    yield chunk.content
        except Exception as e:
            yield f"Gemini stream 오류: {e}"

    async def analyze_image(
        self, base64_image: str, system_prompt: str = ""
    ) -> str:
        from langchain_core.messages import HumanMessage, SystemMessage

        if not self._client:
            return "Gemini not configured."

        try:
            messages = []
            if system_prompt:
                messages.append(SystemMessage(content=system_prompt))

            messages.append(
                HumanMessage(
                    content=[
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
                    ]
                )
            )
            response = await self._client.ainvoke(messages)
            return response.content
        except Exception as e:
            logger.error("Gemini Vision 오류: %s", e)
            return "화면을 볼 수 없어요."

    @staticmethod
    def _build_messages(
        user_input: str,
        system_prompt: str,
        history: list[dict] | None,
    ) -> list:
        """LangChain Message 리스트를 구성한다."""
        from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

        messages = []

        if system_prompt:
            messages.append(SystemMessage(content=system_prompt))

        if history:
            for turn in history:
                if turn["role"] == "user":
                    messages.append(HumanMessage(content=turn["content"]))
                elif turn["role"] == "assistant":
                    messages.append(AIMessage(content=turn["content"]))

        messages.append(HumanMessage(content=user_input))
        return messages
