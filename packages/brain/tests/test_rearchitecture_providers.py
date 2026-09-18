"""Synthetic HTTP fixtures exercise the production adapter; no inference is claimed."""
import asyncio
import json
from contextlib import aclosing

import httpx
import pytest

from rearchitecture.config import ModelBinding
from rearchitecture.providers import HTTPTextProvider, ProviderError


MODEL = {"provider_id": "ollama", "model_id": "fixture-model", "endpoint_id": "local"}


def binding(**kwargs):
    return ModelBinding(MODEL, "Fixture", "ollama", "http://127.0.0.1:11434", "local", **kwargs)


def provider_for(body, seen=None):
    def respond(request):
        if seen is not None:
            seen.append(request)
        return httpx.Response(200, content=body)
    return HTTPTextProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))


@pytest.mark.asyncio
async def test_ollama_ndjson_options_and_only_visible_text():
    seen = []
    body = b'{"model":"fixture-model","message":{"thinking":"hidden"},"done":false}\n{"model":"fixture-model","message":{"content":"hello"},"done":false}\n{"model":"fixture-model","message":{"content":"!"},"done":true}\n'
    provider = provider_for(body, seen)
    chunks = [item async for item in provider.stream(binding(think=True, num_ctx=8192), "question", "persona", [{"role": "assistant", "content": "earlier"}])]
    assert "".join(item.text for item in chunks) == "hello!"
    assert chunks[-1].done
    payload = json.loads(seen[0].content)
    assert payload["think"] is True and payload["options"] == {"num_ctx": 8192}
    assert [row["content"] for row in payload["messages"]] == ["persona", "earlier", "question"]
    assert seen[0].url.path == "/api/chat"


@pytest.mark.asyncio
@pytest.mark.parametrize("body,code", [
    (b'{"model":"fixture-model","message":{"content":"partial"}}\n', "incomplete_response"),
    (b'{"message":{"content":"no model"},"done":true}\n', "model_mismatch"),
    (b'{"error":"private provider details"}\n', "provider_error"),
    (b'not json\n', "provider_error"),
])
async def test_http_provider_does_not_turn_errors_or_missing_finish_into_answers(body, code):
    with pytest.raises(ProviderError) as error:
        _ = [item async for item in provider_for(body).stream(binding(), "q", "", [])]
    assert error.value.code == code
    assert "private provider details" not in str(error.value)


class BlockingBody(httpx.AsyncByteStream):
    def __init__(self):
        self.waiting = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        yield b'{"model":"fixture-model","message":{"content":"first"},"done":false}\n'
        self.waiting.set()
        await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_cancelling_http_iteration_closes_async_response():
    body = BlockingBody()
    provider = HTTPTextProvider(lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=body))))
    async with aclosing(provider.stream(binding(), "q", "", [])) as stream:
        assert (await anext(stream)).text == "first"
        pending = asyncio.create_task(anext(stream))
        await body.waiting.wait()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    assert body.closed


@pytest.mark.asyncio
async def test_openai_compatible_sse_requires_stop_and_preserves_server_model():
    api = ModelBinding({"provider_id": "custom", "model_id": "fixture-model", "endpoint_id": "api"}, "API", "openai-compatible", "https://provider.invalid/v1", "cloud", api_key="test-only-key")
    seen = []
    body = b'data: {"model":"fixture-model","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"model":"fixture-model","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    chunks = [item async for item in provider_for(body, seen).stream(api, "q", "", [])]
    assert chunks[-1].done and chunks[0].reported_model == "fixture-model"
    assert seen[0].headers["authorization"] == "Bearer test-only-key"
    assert seen[0].url.path == "/v1/chat/completions"
    with pytest.raises(ProviderError, match="incomplete_response"):
        _ = [item async for item in provider_for(b"data: [DONE]\n\n").stream(api, "q", "", [])]


@pytest.mark.asyncio
async def test_oversized_unterminated_provider_line_is_bounded():
    with pytest.raises(ProviderError, match="provider_error"):
        _ = [item async for item in provider_for(b"x" * 262145).stream(binding(), "q", "", [])]
