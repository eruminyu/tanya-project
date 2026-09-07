"""공개 튜토리얼 전용 strict local Ollama client."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import requests


class StrictOllamaError(RuntimeError):
    """로컬 응답을 성공으로 검증할 수 없을 때 사용하는 안전 오류."""


@dataclass(frozen=True)
class StrictOllamaResult:
    content: str
    model: str


class StrictOllamaClient:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        timeout_seconds: float = 60.0,
        think: bool = False,
        num_ctx: int = 0,
        transport: Any = requests,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model.strip()
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._think = bool(think)
        self._num_ctx = int(num_ctx) if isinstance(num_ctx, int) and num_ctx > 0 else 0
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self._base_url and self._model)

    async def generate(
        self, prompt: str, system_prompt: str = ""
    ) -> StrictOllamaResult:
        if (
            not self.configured
            or not isinstance(prompt, str)
            or not prompt.strip()
        ):
            raise StrictOllamaError("로컬 답변 모델을 사용할 수 없습니다.")
        messages: list[dict[str, str]] = []
        if isinstance(system_prompt, str) and system_prompt.strip():
            messages.append({"role": "system", "content": system_prompt.strip()})
        messages.append({"role": "user", "content": prompt.strip()})
        try:
            response = await asyncio.to_thread(
                self._transport.post,
                f"{self._base_url}/api/chat",
                json={
                    "model": self._model,
                    "messages": messages,
                    "stream": False,
                    # 사고를 지원하지 않는 모델에도 안전하게 무시된다.
                    "think": self._think,
                    **({"options": {"num_ctx": self._num_ctx}} if self._num_ctx else {}),
                },
                timeout=self._timeout_seconds,
            )
            status = getattr(response, "status_code", 0)
            if not isinstance(status, int) or not 200 <= status < 300:
                raise StrictOllamaError("로컬 답변 모델 요청이 실패했습니다.")
            payload = response.json()
            if not isinstance(payload, dict):
                raise StrictOllamaError("로컬 답변을 검증할 수 없습니다.")
            model = payload.get("model")
            message = payload.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if (
                not isinstance(model, str)
                or not model.strip()
                or not isinstance(content, str)
                or not content.strip()
            ):
                raise StrictOllamaError("로컬 답변을 검증할 수 없습니다.")
            return StrictOllamaResult(content.strip(), model.strip())
        except StrictOllamaError:
            raise
        except Exception:
            raise StrictOllamaError("로컬 답변 모델 요청이 실패했습니다.") from None
