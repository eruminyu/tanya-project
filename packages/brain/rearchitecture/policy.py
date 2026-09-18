"""Policy uses only host-owned model bindings and source records."""
from __future__ import annotations

from dataclasses import dataclass

from kirian_contracts import assert_definition

from .config import ModelBinding, V1Config, model_key


class PolicyError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ContextSource:
    record: dict
    text: str


def select_model(config: V1Config, selection: dict, conversation_model: dict | None, effective_default: dict | None = None) -> ModelBinding:
    binding = next((item for item in config.bindings if model_key(item.model) == model_key(selection["model"])), None)
    if binding is None:
        raise PolicyError("model_not_allowed")
    if selection["source"] in ("saved_default", "initial_local"):
        # The exact host default represents an explicit reset of conversation choice.
        if selection != (effective_default or config.default_selection):
            raise PolicyError("model_not_allowed")
    return binding


def resolve_context(config: V1Config, binding: ModelBinding, items: list[dict], catalog: dict[str, ContextSource], history: list[dict]) -> tuple[str, list[dict]]:
    visited: dict[str, int] = {}
    visiting: set[str] = set()

    def visit(reference: dict):
        source_id, revision = reference["source_id"], reference["revision"]
        if source_id in visiting or len(visiting) >= 64 or len(visited) + len(visiting) >= 512:
            raise PolicyError("context_blocked")
        if source_id in visited:
            if visited[source_id] != revision:
                raise PolicyError("context_blocked")
            return
        source = catalog.get(source_id)
        if source is None:
            raise PolicyError("context_blocked")
        record = source.record
        try:
            assert_definition("SourceRecord", record)
        except ValueError:
            raise PolicyError("context_blocked") from None
        if record["identity"] != config.identity or record["source_id"] != source_id or record["revision"] != revision or record["deleted"]:
            raise PolicyError("context_blocked")
        boundary = "private_lan" if record["kind"] == "screen" and record["boundary"] == "cloud" else record["boundary"]
        if (boundary == "local" and binding.boundary != "local") or (boundary == "private_lan" and binding.boundary == "cloud"):
            raise PolicyError("context_blocked")
        visiting.add(source_id)
        for parent in record["parents"]:
            visit(parent)
        visiting.remove(source_id)
        visited[source_id] = revision

    for row in history:
        for reference in row.get("sources", []):
            visit(reference)
    text = []
    for item in items:
        visit(item)
        source = catalog[item["source_id"]]
        if item["text"] != source.text:
            raise PolicyError("context_blocked")
        text.append(source.text)
    if sum(map(len, text)) > 32768:
        raise PolicyError("context_blocked")
    return "\n\n".join(text), [{"source_id": key, "revision": value} for key, value in visited.items()]
