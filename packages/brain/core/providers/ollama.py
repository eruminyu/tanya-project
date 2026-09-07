"""Ollama 로컬 LLM Provider."""

import json
import requests
import typing

from core.providers.llm_base import LLMProvider
from core.vision import VisionProviderError


class OllamaProvider(LLMProvider):
    """Ollama API 기반 로컬 LLM Provider.

    외부 API 키가 필요 없으며, 로컬에서 실행 중인 Ollama 서버에 연결한다.
    네트워크 장애 시에도 로컬로 작동하는 폴백 역할.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model_name: str = "qwen2.5:7b",
        think: bool = False,
        num_ctx: int = 0,
    ):
        self._base_url = base_url
        self._model_name = model_name
        self._think = bool(think)
        self._num_ctx = int(num_ctx) if isinstance(num_ctx, int) and num_ctx > 0 else 0

    def _request_options(self) -> dict[str, object]:
        """모델 호출 공통 옵션.

        `think`는 사고를 지원하지 않는 모델에서도 오류 없이 무시된다.
        `num_ctx`는 0이면 보내지 않아 Ollama 기본값을 그대로 쓴다.
        """
        payload: dict[str, object] = {"think": self._think}
        if self._num_ctx:
            payload["options"] = {"num_ctx": self._num_ctx}
        return payload

    @property
    def provider_name(self) -> str:
        return "ollama"

    @property
    def model_name(self) -> str:
        return self._model_name

    def is_available(self) -> bool:
        """Ollama 서버가 응답하는지 확인."""
        try:
            response = requests.get(f"{self._base_url}/api/tags", timeout=2)
            return response.status_code == 200
        except Exception:
            return False

    async def chat(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> str:
        import asyncio
        url = f"{self._base_url}/api/chat"

        messages = self._build_messages(user_input, system_prompt, history)

        payload = {
            "model": self._model_name,
            "messages": messages,
            "stream": False,
            **self._request_options(),
        }

        try:
            response = await asyncio.to_thread(
                requests.post, url, json=payload, timeout=60
            )
            response.raise_for_status()
            result = response.json()
            return result.get("message", {}).get("content", "")
        except Exception as e:
            return f"Ollama 오류: {e}"

    async def chat_stream(
        self,
        user_input: str,
        system_prompt: str = "",
        history: list[dict] | None = None,
    ) -> typing.AsyncGenerator[str, None]:
        """Ollama NDJSON 응답을 토큰 청크로 전달한다."""
        import asyncio
        url = f"{self._base_url}/api/chat"
        messages = self._build_messages(user_input, system_prompt, history)

        payload = {
            "model": self._model_name,
            "messages": messages,
            "stream": True,
            **self._request_options(),
        }
        queue: asyncio.Queue[str | Exception | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def read_stream() -> None:
            try:
                with requests.post(
                    url,
                    json=payload,
                    timeout=60,
                    stream=True,
                ) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if not line:
                            continue
                        data = json.loads(line)
                        content = data.get("message", {}).get("content", "")
                        if content:
                            loop.call_soon_threadsafe(queue.put_nowait, content)
                        if data.get("done"):
                            break
            except Exception as error:
                loop.call_soon_threadsafe(queue.put_nowait, error)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        reader = asyncio.create_task(asyncio.to_thread(read_stream))
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                yield f"Ollama stream 오류: {item}"
                continue
            yield item
        await reader

    async def analyze_image(
        self, base64_image: str, system_prompt: str = ""
    ) -> str:
        """Ollama Vision — 이미지 분석 (llava 등 멀티모달 모델 필요)."""
        import asyncio

        if not isinstance(base64_image, str) or not base64_image.strip():
            raise VisionProviderError("로컬 vision 이미지가 비어 있습니다.")

        url = f"{self._base_url}/api/chat"

        messages: list[typing.Any] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        messages.append(
            {
                "role": "user",
                "content": self._VISION_PROMPT,
                "images": [base64_image],
            }
        )

        payload = {
            "model": self._model_name,
            "messages": messages,
            "stream": False,
            **self._request_options(),
        }

        try:
            response = await asyncio.to_thread(
                requests.post, url, json=payload, timeout=60
            )
            response.raise_for_status()
            result = response.json()
            content = result.get("message", {}).get("content", "")
            if not isinstance(content, str) or not content.strip():
                raise VisionProviderError(
                    "로컬 vision provider가 빈 응답을 반환했습니다."
                )
            return content.strip()
        except VisionProviderError:
            raise
        except Exception:
            raise VisionProviderError(
                "로컬 vision provider 요청을 완료하지 못했습니다."
            ) from None

    @staticmethod
    def _build_messages(
        user_input: str,
        system_prompt: str,
        history: list[dict] | None,
    ) -> list[dict]:
        """Ollama chat API 형식의 메시지 리스트를 구성한다."""
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
