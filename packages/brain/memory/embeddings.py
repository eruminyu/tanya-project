"""Phase 3.1: 임베딩 모듈.

EmbeddingProvider ABC + 구현체 2종:
- LocalEmbeddingProvider : sentence-transformers, 384차원, lazy loading
- OpenAIEmbeddingProvider: text-embedding-3-small, 1536차원, 폴백용
"""
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openai import OpenAI


class EmbeddingProvider(ABC):
    @abstractmethod
    async def embed(self, text: str) -> list[float]: ...

    @abstractmethod
    async def embed_batch(self, texts: list[str]) -> list[list[float]]: ...

    @property
    @abstractmethod
    def dimension(self) -> int: ...


# ---------------------------------------------------------------------------
# Local — sentence-transformers
# ---------------------------------------------------------------------------

class LocalEmbeddingProvider(EmbeddingProvider):
    """paraphrase-multilingual-MiniLM-L12-v2 기반 로컬 임베딩 (384차원).

    최초 embed() 호출 시 모델을 로드(lazy loading).
    """

    def __init__(
        self,
        model_name: str = "paraphrase-multilingual-MiniLM-L12-v2",
        cache_dir: str | None = None,
    ):
        self._model_name = model_name
        self._cache_dir = cache_dir or None
        self._model = None  # lazy

    @property
    def dimension(self) -> int:
        return 384

    def _load_model(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(
                self._model_name, cache_folder=self._cache_dir
            )

    async def embed(self, text: str) -> list[float]:
        return (await self.embed_batch([text]))[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._encode_sync, texts)

    def _encode_sync(self, texts: list[str]) -> list[list[float]]:
        self._load_model()
        vecs = self._model.encode(texts, normalize_embeddings=True)
        return [v.tolist() for v in vecs]


# ---------------------------------------------------------------------------
# OpenAI — text-embedding-3-small
# ---------------------------------------------------------------------------

class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI text-embedding-3-small (1536차원). 로컬 불가 시 폴백."""

    def __init__(self, api_key: str, model: str = "text-embedding-3-small"):
        from openai import OpenAI
        self._model = model
        self._client = OpenAI(api_key=api_key)

    @property
    def dimension(self) -> int:
        return 1536

    async def embed(self, text: str) -> list[float]:
        return (await self.embed_batch([text]))[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._encode_sync, texts)

    def _encode_sync(self, texts: list[str]) -> list[list[float]]:
        resp = self._client.embeddings.create(input=texts, model=self._model)
        return [item.embedding for item in resp.data]


# ---------------------------------------------------------------------------
# 팩토리
# ---------------------------------------------------------------------------

def get_embedding_provider(
    provider: str = "local",
    *,
    model_name: str = "paraphrase-multilingual-MiniLM-L12-v2",
    cache_dir: str | None = None,
    api_key: str = "",
) -> EmbeddingProvider:
    if provider == "openai":
        return OpenAIEmbeddingProvider(api_key=api_key)
    # 알 수 없는 값은 local로 폴백
    return LocalEmbeddingProvider(model_name=model_name, cache_dir=cache_dir or None)
