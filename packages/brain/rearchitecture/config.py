"""Host-owned configuration. Wire messages never supply URLs or credentials."""
from __future__ import annotations

import copy
import ipaddress
import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from kirian_contracts import assert_definition


class ConfigError(ValueError):
    pass


def local_boundary(url: str) -> str:
    host = urlsplit(url).hostname
    if host == "localhost":
        return "local"
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        raise ConfigError("unapproved_endpoint_address") from None
    if address.is_loopback:
        return "local"
    networks = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
    if any(address in ipaddress.ip_network(network) for network in networks):
        return "private_lan"
    raise ConfigError("unapproved_endpoint_address")


@dataclass(frozen=True)
class ModelBinding:
    model: dict
    label: str
    kind: str
    url: str
    boundary: str
    api_key: str = field(default="", repr=False)
    think: bool = False
    num_ctx: int = 0
    supports_images: bool = False
    supports_text: bool = True
    supports_embeddings: bool = False
    automatic_allowed: bool = False
    budget_units: int | None = None
    supports_tools: bool = False
    # Official input formats of embedding models (e.g. Qwen3-Embedding's instruct/query prefix for queries).
    # The host declares them once; the Brain prepends them at query/document time and never twice.
    query_prefix: str = ""
    document_prefix: str = ""
    # Minimum cosine similarity for a memory to be offered; measured per embedding model by the host.
    min_score: float = 0.25

    def __post_init__(self):
        assert_definition("ModelRef", self.model)
        object.__setattr__(self, "model", copy.deepcopy(self.model))
        parsed = urlsplit(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ConfigError("invalid_endpoint_url")
        if self.kind not in ("ollama", "openai-compatible") or self.boundary not in ("local", "private_lan", "cloud"):
            raise ConfigError("invalid_endpoint_binding")
        if self.boundary == "cloud":
            if parsed.scheme != "https":
                raise ConfigError("cloud_endpoint_requires_tls")
        elif self.boundary == "local" and local_boundary(self.url) != "local":
            raise ConfigError("local_endpoint_requires_loopback")
        elif self.boundary == "private_lan":
            local_boundary(self.url)
        if not isinstance(self.label, str) or not self.label.strip() or len(self.label) > 160:
            raise ConfigError("invalid_model_label")
        if type(self.think) is not bool or type(self.supports_images) is not bool or type(self.num_ctx) is not int or not 0 <= self.num_ctx <= 131072:
            raise ConfigError("invalid_inference_options")
        if any(type(value) is not bool for value in (self.supports_text, self.supports_embeddings, self.automatic_allowed, self.supports_tools)):
            raise ConfigError("invalid_inference_options")
        if self.budget_units is not None and (type(self.budget_units) is not int or not 0 <= self.budget_units <= 1000000000):
            raise ConfigError("invalid_budget_units")
        if any(type(value) is not str or len(value) > 512 for value in (self.query_prefix, self.document_prefix)):
            raise ConfigError("invalid_embedding_prefix")
        if (self.query_prefix or self.document_prefix) and not self.supports_embeddings:
            raise ConfigError("invalid_embedding_prefix")
        if type(self.min_score) not in (float, int) or isinstance(self.min_score, bool) or not 0 <= self.min_score <= 1:
            raise ConfigError("invalid_embedding_score")


@dataclass(frozen=True)
class SpeechBinding:
    """Host-selected Qwen3-TTS preset voice (language + speaker name); no recorded reference audio is accepted."""
    model: dict
    label: str
    url: str
    boundary: str
    language: str
    speaker: str
    instruct: str = field(default="", repr=False)
    seed: int = 12345
    timeout_seconds: float = 90

    def __post_init__(self):
        checked = ModelBinding(self.model, self.label, "ollama", self.url, self.boundary)
        object.__setattr__(self, "model", checked.model)
        if not isinstance(self.language, str) or not re.fullmatch(r"[A-Z][A-Za-z]{1,31}", self.language):
            raise ConfigError("invalid_voice_selection")
        if not isinstance(self.speaker, str) or not re.fullmatch(r"[A-Z][A-Za-z0-9_]{1,63}", self.speaker):
            raise ConfigError("invalid_voice_selection")
        if not isinstance(self.instruct, str) or len(self.instruct) > 512 or "\x00" in self.instruct:
            raise ConfigError("invalid_voice_selection")
        if type(self.seed) is not int or not 0 <= self.seed <= 2147483647:
            raise ConfigError("invalid_voice_options")
        if type(self.timeout_seconds) not in (int, float) or not 0 < self.timeout_seconds <= 90:
            raise ConfigError("invalid_voice_timeout")


@dataclass(frozen=True)
class TranscriptionBinding:
    url: str
    boundary: str
    model_label: str
    timeout_seconds: float = 60

    def __post_init__(self):
        ModelBinding({"provider_id": "stt", "model_id": "host-selected", "endpoint_id": "host-stt"}, self.model_label, "ollama", self.url, self.boundary)
        if type(self.timeout_seconds) not in (int, float) or not 0 < self.timeout_seconds <= 90:
            raise ConfigError("invalid_transcription_timeout")


@dataclass(frozen=True)
class V1Config:
    token: str = field(repr=False)
    identity: dict
    bindings: tuple[ModelBinding, ...]
    default_selection: dict
    max_sessions: int = 16
    session_ttl_seconds: float = 1800
    max_events: int = 5000
    max_bytes: int = 16 * 1024 * 1024
    max_message_bytes: int = 256 * 1024
    max_response_characters: int = 32768
    max_history_messages: int = 20
    max_history_characters: int = 32768
    turn_timeout_seconds: float = 90
    system_prompt: str = "너는 키리안(Kirian), 사용자의 개인 AI 동반자야. 한국어로 자연스럽고 정확하게 답해."
    speech: SpeechBinding | None = None
    transcription: TranscriptionBinding | None = None
    speech_turn_timeout_seconds: float = 180
    data_dir: str | None = None
    embedding: ModelBinding | None = None

    def __post_init__(self):
        if not isinstance(self.token, str) or len(self.token) < 32:
            raise ConfigError("v1_token_required_minimum_32_characters")
        assert_definition("Identity", self.identity)
        assert_definition("ModelSelection", self.default_selection)
        if self.identity["mode"] not in ("personal", "public_demo"):
            raise ConfigError("personal_service_only")
        if not self.bindings or len(self.bindings) > 32:
            raise ConfigError("invalid_model_catalog")
        keys = [model_key(binding.model) for binding in self.bindings]
        if len(set(keys)) != len(keys) or model_key(self.default_selection["model"]) not in keys:
            raise ConfigError("invalid_default_model")
        if self.default_selection["source"] not in ("saved_default", "initial_local"):
            raise ConfigError("invalid_default_selection_source")
        selected = next(binding for binding in self.bindings if binding.model == self.default_selection["model"])
        if self.default_selection["source"] == "initial_local" and selected.boundary == "cloud":
            raise ConfigError("initial_default_requires_local_model")
        for name in ("max_sessions", "max_events", "max_bytes", "max_message_bytes", "max_response_characters", "max_history_messages", "max_history_characters"):
            if type(getattr(self, name)) is not int or getattr(self, name) < 1:
                raise ConfigError("invalid_resource_limit")
        if not 0 < self.session_ttl_seconds <= 86400 or not 0 < self.turn_timeout_seconds <= 600:
            raise ConfigError("invalid_timeout")
        if type(self.speech_turn_timeout_seconds) not in (int, float) or not 0 < self.speech_turn_timeout_seconds <= 180:
            raise ConfigError("invalid_voice_timeout")
        if self.speech is not None and not isinstance(self.speech, SpeechBinding):
            raise ConfigError("invalid_voice_binding")
        if self.transcription is not None and not isinstance(self.transcription, TranscriptionBinding):
            raise ConfigError("invalid_transcription_binding")
        if self.embedding is not None and (not isinstance(self.embedding, ModelBinding) or not self.embedding.supports_embeddings):
            raise ConfigError("invalid_embedding_binding")
        if self.data_dir is not None and (not isinstance(self.data_dir, str) or not self.data_dir.strip() or len(self.data_dir) > 4096):
            raise ConfigError("invalid_data_directory")
        if not isinstance(self.system_prompt, str) or not self.system_prompt.strip() or len(self.system_prompt) > 4000:
            raise ConfigError("invalid_system_prompt")
        if self.identity["mode"] == "public_demo":
            # A public demo instance uses local models only, no automatic routing, no embedding; its store (when
            # configured) is meant to be ephemeral and holds per-visitor conversations and tool results only.
            if any(binding.boundary == "cloud" for binding in self.bindings):
                raise ConfigError("public_demo_requires_local_models")
            if any(binding.automatic_allowed for binding in self.bindings):
                raise ConfigError("public_demo_forbids_automatic_routing")
            if self.embedding is not None or self.transcription is not None:
                raise ConfigError("public_demo_forbids_embedding_and_transcription")
        object.__setattr__(self, "identity", copy.deepcopy(self.identity))
        object.__setattr__(self, "default_selection", copy.deepcopy(self.default_selection))

    @classmethod
    def from_env(cls, *, token: str | None = None) -> "V1Config":
        token = os.environ.get("KIRIAN_V1_TOKEN", "") if token is None else token
        config_path = os.environ.get("KIRIAN_V1_CONFIG_FILE")
        if config_path:
            try:
                data = json.loads(Path(config_path).read_text(encoding="utf-8"))
                if not isinstance(data, dict) or set(data) - {"identity", "bindings", "saved_default", "speech", "transcription", "data_dir", "embedding", "system_prompt"}:
                    raise ConfigError("invalid_host_config")
                def parse_binding(raw):
                    item = dict(raw)
                    key_name = item.pop("api_key_env", None)
                    if "api_key" in item:
                        raise ConfigError("credentials_must_use_environment")
                    if key_name is not None:
                        if not isinstance(key_name, str) or not key_name or key_name not in os.environ:
                            raise ConfigError("provider_credential_unavailable")
                        item["api_key"] = os.environ[key_name]
                    return ModelBinding(**item)
                bindings = [parse_binding(raw) for raw in data["bindings"]]
                default = data.get("saved_default")
                if default is None:
                    default = next(binding.model for binding in bindings if binding.boundary != "cloud")
                selection = {"model": default, "source": "saved_default" if "saved_default" in data else "initial_local"}
                return cls(token, data["identity"], tuple(bindings), selection,
                           speech=SpeechBinding(**data["speech"]) if data.get("speech") is not None else None,
                           transcription=TranscriptionBinding(**data["transcription"]) if data.get("transcription") is not None else None,
                           embedding=parse_binding(data["embedding"]) if data.get("embedding") is not None else None,
                           data_dir=os.environ.get("KIRIAN_V1_DATA_DIR", data.get("data_dir")) or None,
                           **({"system_prompt": data["system_prompt"]} if "system_prompt" in data else {}))
            except ConfigError:
                raise
            except Exception:
                raise ConfigError("invalid_host_config") from None
        url = os.environ.get("KIRIAN_V1_OLLAMA_URL", "http://127.0.0.1:11434")
        model = {"provider_id": "ollama", "model_id": os.environ.get("KIRIAN_V1_OLLAMA_MODEL", "qwen2.5:7b"), "endpoint_id": "local-ollama"}
        binding = ModelBinding(model, "Local Ollama", "ollama", url, local_boundary(url))
        return cls(token, {"instance_id": "personal-v1", "mode": "personal", "principal_id": "owner"}, (binding,), {"model": model, "source": "initial_local"},
                   data_dir=os.environ.get("KIRIAN_V1_DATA_DIR") or None)


def model_key(model: dict) -> tuple[str, str, str]:
    return model["provider_id"], model["model_id"], model["endpoint_id"]
