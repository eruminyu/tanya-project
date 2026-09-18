"""실제 HTTP 임베딩과 교체 가능한 SQLite cosine 색인."""
from __future__ import annotations

import json
import math
from typing import Protocol

import httpx
from kirian_contracts import assert_definition

from .storage import StorageError, encoded


class EmbeddingError(RuntimeError):
    def __init__(self, code="embedding_error"):
        self.code = code
        super().__init__(code)


def normalized(vector):
    if (not isinstance(vector, list) or not 1 <= len(vector) <= 8192
            or any(type(value) not in (float, int) or not math.isfinite(value) for value in vector)):
        raise EmbeddingError()
    magnitude = math.hypot(*vector)
    if not math.isfinite(magnitude) or magnitude <= 0:
        raise EmbeddingError()
    return [value / magnitude for value in vector]


class EmbeddingProvider(Protocol):
    async def embed(self, binding, text: str) -> list[float]: ...


class VectorIndex(Protocol):
    def put(self, source, model, vector): ...
    def search(self, model, vector, limit=8, allowed_ids=None): ...


class HTTPEmbeddingProvider:
    def __init__(self, client_factory=None):
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(
            timeout=httpx.Timeout(60, connect=5), follow_redirects=False, trust_env=False))

    async def embed(self, binding, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 8192:
            raise EmbeddingError("invalid_request")
        body = {"model": binding.model["model_id"], "input": text}
        if binding.kind == "ollama":
            path, body["truncate"] = "/api/embed", False
        else:
            path, body["encoding_format"] = "/embeddings", "float"
        headers = {"Accept-Encoding": "identity"}
        if binding.api_key:
            headers["Authorization"] = "Bearer " + binding.api_key
        try:
            async with self.client_factory() as client:
                async with client.stream("POST", binding.url.rstrip("/") + path, json=body, headers=headers) as response:
                    if response.status_code != 200:
                        raise EmbeddingError("embedding_unavailable")
                    raw = bytearray()
                    async for part in response.aiter_bytes():
                        if len(raw) + len(part) > 512 * 1024:
                            raise EmbeddingError()
                        raw.extend(part)
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get("model") != binding.model["model_id"]:
                raise EmbeddingError("model_mismatch")
            if binding.kind == "ollama":
                vectors = data.get("embeddings")
                if not isinstance(vectors, list) or len(vectors) != 1:
                    raise EmbeddingError()
                vector = vectors[0]
            else:
                rows = data.get("data")
                if (data.get("object") != "list" or not isinstance(rows, list) or len(rows) != 1
                        or not isinstance(rows[0], dict) or type(rows[0].get("index")) is not int
                        or rows[0]["index"] != 0 or rows[0].get("object") != "embedding"):
                    raise EmbeddingError()
                vector = rows[0].get("embedding")
            normalized(vector)
            return vector
        except EmbeddingError:
            raise
        except httpx.RequestError:
            raise EmbeddingError("embedding_unavailable") from None
        except (ValueError, TypeError, KeyError, OverflowError):
            raise EmbeddingError() from None


class SQLiteVectorIndex:
    def __init__(self, store):
        self.store = store

    def put(self, source, model, vector):
        assert_definition("ModelRef", model)
        vector = normalized(vector)
        record = source["record"]
        with self.store.transaction() as db:
            self.store._validate_parents(db, [{"source_id": record["source_id"], "revision": record["revision"]}], record["boundary"])
            if self.store._source(db, record["source_id"]) != source:
                raise StorageError("source_changed")
            count = db.execute("SELECT count(*) FROM source_vectors").fetchone()[0]
            if count >= 10000 and not db.execute("SELECT 1 FROM source_vectors WHERE source_id=? AND model=?", (record["source_id"], encoded(model))).fetchone():
                raise EmbeddingError("index_limit")
            db.execute("""INSERT INTO source_vectors VALUES(?,?,?,?,?) ON CONFLICT(source_id,model)
                DO UPDATE SET revision=excluded.revision,dimensions=excluded.dimensions,vector=excluded.vector""",
                       (record["source_id"], record["revision"], encoded(model), len(vector), encoded(vector)))

    def search(self, model, vector, limit=8, allowed_ids=None):
        assert_definition("ModelRef", model)
        vector = normalized(vector)
        if type(limit) is not int or not 1 <= limit <= 50:
            raise EmbeddingError("invalid_request")
        scored = []
        with self.store.transaction() as db:
            for row in db.execute("""SELECT v.* FROM source_vectors v JOIN sources s ON s.id=v.source_id
                    WHERE v.model=? AND v.dimensions=? AND v.revision=s.revision AND s.deleted=0
                    AND NOT EXISTS(SELECT 1 FROM unavailable_sources u WHERE u.source_id=s.id)""", (encoded(model), len(vector))):
                if allowed_ids is not None and row["source_id"] not in allowed_ids:
                    continue
                source = self.store._source(db, row["source_id"])
                self.store._validate_parents(db, source["record"]["parents"], source["record"]["boundary"])
                stored = normalized(json.loads(row["vector"]))
                score = max(-1.0, min(1.0, math.fsum(a * b for a, b in zip(vector, stored, strict=True))))
                scored.append((source, score))
        scored.sort(key=lambda pair: (-pair[1], pair[0]["record"]["source_id"]))
        return scored[:limit]
