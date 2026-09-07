"""Phase 3.1: EmbeddingProvider 테스트"""
import math
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from memory.embeddings import (
    EmbeddingProvider,
    LocalEmbeddingProvider,
    OpenAIEmbeddingProvider,
    get_embedding_provider,
)


class TestEmbeddingProviderInterface:
    def test_is_abstract(self):
        with pytest.raises(TypeError):
            EmbeddingProvider()  # type: ignore


class TestLocalEmbeddingProvider:
    @pytest.fixture
    def provider(self):
        return LocalEmbeddingProvider(
            model_name="paraphrase-multilingual-MiniLM-L12-v2"
        )

    def test_dimension(self, provider):
        assert provider.dimension == 384

    def test_model_not_loaded_initially(self, provider):
        """lazy loading — 생성 시 모델 로드 안 함."""
        assert provider._model is None

    @pytest.mark.asyncio
    async def test_embed_returns_correct_dimension(self, provider):
        vec = await provider.embed("안녕하세요")
        assert len(vec) == 384

    @pytest.mark.asyncio
    async def test_embed_returns_floats(self, provider):
        vec = await provider.embed("hello")
        assert all(isinstance(v, float) for v in vec)

    @pytest.mark.asyncio
    async def test_embed_batch(self, provider):
        texts = ["안녕", "반가워", "잘 지냈어?"]
        vecs = await provider.embed_batch(texts)
        assert len(vecs) == 3
        assert all(len(v) == 384 for v in vecs)

    @pytest.mark.asyncio
    async def test_embed_normalized(self, provider):
        vec = await provider.embed("테스트")
        norm = math.sqrt(sum(v * v for v in vec))
        # sentence-transformers 기본 출력은 정규화됨 (노름 ≈ 1.0)
        assert 0.9 < norm < 1.1

    @pytest.mark.asyncio
    async def test_korean_similar_sentences(self, provider):
        v1 = await provider.embed("나는 게임을 좋아한다")
        v2 = await provider.embed("나는 게임을 즐긴다")
        v3 = await provider.embed("오늘 날씨가 맑다")

        def cosine(a, b):
            dot = sum(x * y for x, y in zip(a, b))
            na = math.sqrt(sum(x * x for x in a))
            nb = math.sqrt(sum(x * x for x in b))
            return dot / (na * nb)

        sim_similar = cosine(v1, v2)
        sim_diff = cosine(v1, v3)
        assert sim_similar > sim_diff


class TestOpenAIEmbeddingProvider:
    def test_dimension(self):
        provider = OpenAIEmbeddingProvider(api_key="test-key")
        assert provider.dimension == 1536

    @pytest.mark.asyncio
    async def test_embed_calls_api(self):
        provider = OpenAIEmbeddingProvider(api_key="test-key")
        fake_vec = [0.1] * 1536
        mock_resp = MagicMock()
        mock_resp.data = [MagicMock(embedding=fake_vec)]

        with patch.object(
            provider._client.embeddings, "create", new_callable=MagicMock
        ) as mock_create:
            mock_create.return_value = mock_resp
            result = await provider.embed("hello")

        assert len(result) == 1536
        mock_create.assert_called_once()


class TestGetEmbeddingProvider:
    def test_local_provider(self):
        p = get_embedding_provider("local")
        assert isinstance(p, LocalEmbeddingProvider)

    def test_openai_provider(self):
        p = get_embedding_provider("openai", api_key="fake")
        assert isinstance(p, OpenAIEmbeddingProvider)

    def test_unknown_falls_back_to_local(self):
        p = get_embedding_provider("unknown_provider")
        assert isinstance(p, LocalEmbeddingProvider)
