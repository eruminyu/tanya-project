"""Cancellable HTTP text streams. Model errors never become answer text."""
from __future__ import annotations

import json
from contextlib import aclosing
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Protocol

import httpx

from .config import ModelBinding
from .external_tools import NativeToolCall, calendar_example_messages, parse_native_call, prepare_offers, strict_json


class ProviderError(RuntimeError):
    def __init__(self, code: str = "provider_error"):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ProviderChunk:
    text: str
    reported_model: str
    done: bool = False
    tool_call: NativeToolCall | None = None


class TextProvider(Protocol):
    def stream(self, binding: ModelBinding, user_input: str, system_prompt: str, history: list[dict]) -> AsyncIterator[ProviderChunk]: ...


class ImageProvider(Protocol):
    def stream_image(self, binding: ModelBinding, prompt: str, system_prompt: str, image_base64: str) -> AsyncIterator[ProviderChunk]: ...


async def bounded_lines(response: httpx.Response) -> AsyncIterator[str]:
    """Keep incomplete NDJSON/SSE lines bounded without delaying small token chunks."""
    pending = bytearray()
    async for part in response.aiter_bytes():
        offset = 0
        while offset < len(part):
            end = part.find(b"\n", offset)
            stop = len(part) if end == -1 else end
            if len(pending) + stop - offset > 262144:
                raise ProviderError()
            pending.extend(part[offset:stop])
            if end == -1:
                break
            yield pending.rstrip(b"\r").decode("utf-8")
            pending.clear()
            offset = end + 1
    if pending:
        yield pending.rstrip(b"\r").decode("utf-8")


class HTTPTextProvider:
    def __init__(self, client_factory: Callable[[], httpx.AsyncClient] | None = None):
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(
            timeout=httpx.Timeout(60, connect=5), follow_redirects=False, trust_env=False,
        ))

    async def stream(self, binding: ModelBinding, user_input: str, system_prompt: str, history: list[dict]) -> AsyncIterator[ProviderChunk]:
        # Preserve the old providers' system/history/current-message ordering.
        messages = ([{"role": "system", "content": system_prompt}] if system_prompt else [])
        messages += [{"role": row["role"], "content": row["content"]} for row in history]
        messages.append({"role": "user", "content": user_input})
        async with aclosing(self._stream_messages(binding, messages)) as stream:
            async for chunk in stream:
                yield chunk

    async def stream_image(self, binding: ModelBinding, prompt: str, system_prompt: str, image_base64: str) -> AsyncIterator[ProviderChunk]:
        if not binding.supports_images:
            raise ProviderError("unsupported_model")
        if binding.boundary == "cloud":
            raise ProviderError("context_blocked")
        messages = ([{"role": "system", "content": system_prompt}] if system_prompt else [])
        if binding.kind == "ollama":
            messages.append({"role": "user", "content": prompt, "images": [image_base64]})
        else:
            messages.append({"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_base64}},
            ]})
        async with aclosing(self._stream_messages(binding, messages)) as stream:
            async for chunk in stream:
                yield chunk

    async def stream_tools(self, binding: ModelBinding, user_input: str, system_prompt: str,
                           history: list[dict], offers: list[dict]) -> AsyncIterator[ProviderChunk]:
        """One bounded final native response; fragments and text JSON grant no tool authority."""
        if not binding.supports_tools:
            raise ProviderError("unsupported_model")
        try:
            tools, names = prepare_offers(offers)
            messages = ([{"role": "system", "content": system_prompt}] if system_prompt else [])
            messages += calendar_example_messages(offers, tools, binding.kind)
            messages += [{"role": row["role"], "content": row["content"]} for row in history]
            messages.append({"role": "user", "content": user_input})
            body = {"model": binding.model["model_id"], "messages": messages, "tools": tools, "stream": False}
            headers = {"Accept-Encoding": "identity"}
            if binding.api_key:
                headers["Authorization"] = "Bearer " + binding.api_key
            if binding.kind == "ollama":
                path = "/api/chat"
                body["think"] = binding.think
                if binding.num_ctx:
                    body["options"] = {"num_ctx": binding.num_ctx}
            else:
                path = "/chat/completions"
                body["parallel_tool_calls"] = False
            async with self.client_factory() as client:
                async with client.stream("POST", binding.url.rstrip("/") + path, json=body, headers=headers) as response:
                    if response.status_code != 200:
                        raise ProviderError("provider_unavailable")
                    raw = bytearray()
                    async for part in response.aiter_bytes():
                        if len(raw) + len(part) > 262144:
                            raise ProviderError("response_limit")
                        raw.extend(part)
                    data = strict_json(bytes(raw), 262144)
            if type(data) is not dict or data.get("error"):
                raise ProviderError()
            reported = data.get("model")
            if reported != binding.model["model_id"]:
                raise ProviderError("model_mismatch")
            if binding.kind == "ollama":
                # Older native responses may omit done_reason. An explicit stop is
                # the only accepted reason; length/unload never prove a complete call.
                if data.get("done") is not True or ("done_reason" in data and data["done_reason"] != "stop"):
                    raise ProviderError("incomplete_response")
                message, finish = data.get("message"), None
            else:
                choices = data.get("choices")
                if type(choices) is not list or len(choices) != 1 or type(choices[0]) is not dict:
                    raise ProviderError("incomplete_response")
                choice = choices[0]
                if type(choice.get("index", 0)) is not int or choice.get("index", 0) != 0:
                    raise ProviderError()
                message, finish = choice.get("message"), choice.get("finish_reason")
            if type(message) is not dict or message.get("role") != "assistant" or message.get("function_call") is not None:
                raise ProviderError()
            content = message.get("content")
            if content is None:
                content = ""
            if type(content) is not str:
                raise ProviderError()
            calls = message.get("tool_calls")
            if calls:
                if binding.kind == "openai-compatible" and finish != "tool_calls":
                    raise ProviderError("incomplete_response")
                call = parse_native_call(calls, names, binding.kind)
            else:
                if calls is not None and calls != [] or binding.kind == "openai-compatible" and finish != "stop":
                    raise ProviderError("incomplete_response")
                call = None
            yield ProviderChunk(content, reported, True, call)
        except ProviderError:
            raise
        except httpx.RequestError:
            raise ProviderError("provider_unavailable") from None
        except Exception:
            raise ProviderError() from None

    async def _stream_messages(self, binding: ModelBinding, messages: list[dict]) -> AsyncIterator[ProviderChunk]:
        body = {"model": binding.model["model_id"], "messages": messages, "stream": True}
        headers = {"Accept-Encoding": "identity"}
        if binding.api_key:
            headers["Authorization"] = "Bearer " + binding.api_key
        if binding.kind == "ollama":
            path = "/api/chat"
            body["think"] = binding.think
            if binding.num_ctx:
                body["options"] = {"num_ctx": binding.num_ctx}
        else:
            path = "/chat/completions"
        try:
            async with self.client_factory() as client:
                async with client.stream("POST", binding.url.rstrip("/") + path, json=body, headers=headers) as response:
                    if response.status_code != 200:
                        raise ProviderError("provider_unavailable")
                    async for line in bounded_lines(response):
                        if not line or (binding.kind == "openai-compatible" and line.startswith(":")):
                            continue
                        if binding.kind == "openai-compatible":
                            if not line.startswith("data:"):
                                continue
                            line = line[5:].strip()
                            if line == "[DONE]":
                                raise ProviderError("incomplete_response")
                        data = json.loads(line)
                        if not isinstance(data, dict) or data.get("error"):
                            raise ProviderError()
                        reported = data.get("model")
                        if not isinstance(reported, str) or not reported:
                            raise ProviderError("model_mismatch")
                        if binding.kind == "ollama":
                            if data.get("message", {}).get("tool_calls"):
                                raise ProviderError()
                            text = data.get("message", {}).get("content", "")
                            done = data.get("done") is True
                        else:
                            choices = data.get("choices")
                            if not isinstance(choices, list) or not choices:
                                continue
                            choice = choices[0]
                            text = choice.get("delta", {}).get("content") or ""
                            finish = choice.get("finish_reason")
                            if finish is not None and finish != "stop":
                                raise ProviderError("incomplete_response")
                            done = finish == "stop"
                        if not isinstance(text, str):
                            raise ProviderError()
                        yield ProviderChunk(text, reported, done)
                        if done:
                            return
        except ProviderError:
            raise
        except httpx.RequestError:
            raise ProviderError("provider_unavailable") from None
        except Exception:
            raise ProviderError() from None
        raise ProviderError("incomplete_response")
