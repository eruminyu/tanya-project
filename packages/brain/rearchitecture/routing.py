"""Host-selected routing and durable, provider-adjacent reservation budgets."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .config import ModelBinding, V1Config, model_key
from .policy import PolicyError, resolve_context, select_model
from kirian_contracts import assert_definition


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class RouteDecision:
    binding: ModelBinding
    context: str
    sources: list[dict]
    reason: str
    purpose: str
    revision: int
    automatic: bool
    charged: bool


class ModelRouter:
    """Reservations are attempts, never estimates of a provider's actual invoice."""
    def __init__(self, config: V1Config, *, clock=time.time):
        self.config, self.clock = config, clock
        self.lock = threading.RLock()
        try:
            path = ":memory:"
            if config.data_dir:
                directory = Path(config.data_dir).expanduser().resolve() / hashlib.sha256(encode(config.identity).encode()).hexdigest()[:24]
                directory.mkdir(parents=True, exist_ok=True)
                path = str(directory / "routing.sqlite3")
            self.db = sqlite3.connect(path, timeout=1, check_same_thread=False, isolation_level=None)
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL,
                    revision INTEGER NOT NULL, daily_call_limit INTEGER NOT NULL, daily_budget_units INTEGER NOT NULL);
                INSERT OR IGNORE INTO settings VALUES(1,0,0,100,1000);
                CREATE TABLE IF NOT EXISTS usage(day INTEGER PRIMARY KEY, calls INTEGER NOT NULL, units INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, day INTEGER NOT NULL, model TEXT NOT NULL,
                    purpose TEXT NOT NULL, units INTEGER NOT NULL);
            """)
        except (sqlite3.Error, OSError):
            raise PolicyError("storage_unavailable") from None

    def close(self):
        with self.lock:
            self.db.close()

    def _day(self):
        # UTC fixed days, clamped to latest reservation to avoid a clock rollback resetting limits.
        latest = self.db.execute("SELECT MAX(day) FROM usage").fetchone()[0]
        return max(int(self.clock() // 86400), latest or 0)

    def _snapshot(self):
        row = dict(self.db.execute("SELECT * FROM settings WHERE id=1").fetchone())
        day = self._day()
        used = self.db.execute("SELECT calls,units FROM usage WHERE day=?", (day,)).fetchone()
        return {"enabled":bool(row["enabled"]), "revision":row["revision"],
                "daily_call_limit":row["daily_call_limit"], "daily_budget_units":row["daily_budget_units"],
                "calls_used":used[0] if used else 0, "budget_units_used":used[1] if used else 0,
                "resets_at":(day + 1) * 86400000, "persistent":bool(self.config.data_dir)}

    def snapshot(self):
        try:
            with self.lock:
                return self._snapshot()
        except sqlite3.Error:
            raise PolicyError("storage_unavailable") from None

    def configure(self, value):
        if (not isinstance(value, dict) or set(value) != {"enabled","expected_revision","daily_call_limit","daily_budget_units"}
                or type(value["enabled"]) is not bool
                or type(value["expected_revision"]) is not int or value["expected_revision"] < 0
                or type(value["daily_call_limit"]) is not int or not 1 <= value["daily_call_limit"] <= 100000
                or type(value["daily_budget_units"]) is not int or not 0 <= value["daily_budget_units"] <= 1000000000):
            raise PolicyError("invalid_request")
        if value["enabled"] and not self.config.data_dir:
            raise PolicyError("persistence_unavailable")
        try:
            with self.lock:
                self.db.execute("BEGIN IMMEDIATE")
                try:
                    state = self._snapshot()
                    if state["revision"] != value["expected_revision"]:
                        raise PolicyError("routing_changed")
                    self.db.execute("UPDATE settings SET enabled=?,revision=revision+1,daily_call_limit=?,daily_budget_units=? WHERE id=1",
                                    (int(value["enabled"]), value["daily_call_limit"], value["daily_budget_units"]))
                    self.db.execute("COMMIT")
                except BaseException:
                    self.db.execute("ROLLBACK")
                    raise
                return self._snapshot()
        except sqlite3.Error:
            raise PolicyError("storage_unavailable") from None

    @staticmethod
    def _capable(binding, capability):
        return {"text":binding.supports_text, "images":binding.supports_text and binding.supports_images,
                "embedding":binding.supports_embeddings}.get(capability, False)

    @staticmethod
    def _fits(binding, state):
        return (binding.budget_units is not None and state["calls_used"] < state["daily_call_limit"]
                and binding.budget_units <= state["daily_budget_units"] - state["budget_units_used"])

    def choose(self, *, catalog, selection=None, conversation_model=None, items=None, history=None,
               capability="text", purpose="chat", effective_default=None, candidates=None):
        if purpose not in ("chat", "screen", "screen_auto", "memory_extract", "embedding", "proactive"):
            raise PolicyError("invalid_request")
        selection = selection if selection is not None else (
            {"source": "conversation", "model": conversation_model} if conversation_model is not None
            else effective_default or self.config.default_selection)
        try:
            assert_definition("ModelSelection", selection)
        except ValueError:
            raise PolicyError("invalid_request") from None
        # Validate the claimed default before considering automatic alternatives.
        selected = select_model(self.config, selection, conversation_model, effective_default)
        items, history = items or [], history or []
        state = self.snapshot()
        fixed = selection["source"] in ("request", "conversation")
        automatic = state["enabled"] and not fixed
        if candidates is not None and (fixed or not state["enabled"]):
            raise PolicyError("routing_changed")
        # Background work is independently opt-in, but always consumes the same usage budget.
        charged = automatic or purpose in ("screen_auto", "memory_extract", "embedding", "proactive") or state["enabled"]
        if not automatic:
            binding = selected
            if purpose in ("screen_auto", "memory_extract", "embedding", "proactive") and not binding.automatic_allowed:
                raise PolicyError("model_not_allowed")
            if not self._capable(binding, capability):
                raise PolicyError("unsupported_model")
            context, sources = resolve_context(self.config, binding, items, catalog, history)
            if charged and not self._fits(binding, state):
                raise PolicyError("routing_limit")
            reason = {"request":"request_fixed", "conversation":"conversation_fixed"}.get(selection["source"], selection["source"])
            return RouteDecision(binding, context, sources, reason, purpose, state["revision"], False, charged)
        pool = (self.config.embedding,) if capability == "embedding" and self.config.embedding else self.config.bindings
        allowed = [binding for binding in pool if binding.automatic_allowed and self._capable(binding, capability)]
        if candidates is not None:
            if not isinstance(candidates, list) or not 1 <= len(candidates) <= 32:
                raise PolicyError("invalid_request")
            permitted = {model_key(binding.model) for binding in allowed}
            try:
                for model in candidates:
                    assert_definition("ModelRef", model)
            except ValueError:
                raise PolicyError("invalid_request") from None
            if any(model_key(model) not in permitted for model in candidates):
                raise PolicyError("model_not_allowed")
            allowed = [binding for binding in allowed if binding.model in candidates]
        allowed.sort(key=lambda binding: (binding.budget_units if binding.budget_units is not None else 10**12,
                                          {"local":0,"private_lan":1,"cloud":2}[binding.boundary]))
        for binding in allowed:
            if not self._fits(binding, state):
                continue
            try:
                context, sources = resolve_context(self.config, binding, items, catalog, history)
            except PolicyError as error:
                if error.code != "context_blocked":
                    raise
                continue
            return RouteDecision(binding, context, sources, "automatic_budget", purpose, state["revision"], True, True)
        raise PolicyError("routing_no_candidate")

    def reserve(self, decision, call_id, catalog):
        binding = decision.binding
        if (not isinstance(call_id, str) or not 1 <= len(call_id) <= 256
                or not any(binding is item for item in (*self.config.bindings, self.config.embedding))):
            raise PolicyError("model_not_allowed")
        # SourceCatalog resolves current originals/ancestors at dispatch time.
        resolve_context(self.config, binding, [], catalog, [{"sources":decision.sources}])
        if self.snapshot()["revision"] != decision.revision:
            raise PolicyError("routing_changed")
        if not decision.charged:
            return
        if not self.config.data_dir:
            raise PolicyError("persistence_unavailable")
        try:
            with self.lock:
                self.db.execute("BEGIN IMMEDIATE")
                try:
                    state = self._snapshot()
                    if state["revision"] != decision.revision or decision.automatic and (not state["enabled"] or not binding.automatic_allowed):
                        raise PolicyError("routing_changed")
                    if self.db.execute("SELECT 1 FROM attempts WHERE id=?", (call_id,)).fetchone():
                        raise PolicyError("routing_duplicate_call")
                    if not self._fits(binding, state):
                        raise PolicyError("routing_limit")
                    day = self._day()
                    self.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?)", (call_id,day,encode(binding.model),decision.purpose,binding.budget_units))
                    self.db.execute("INSERT INTO usage VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1, units=units+excluded.units", (day,binding.budget_units))
                    # Claims remain durable: an old job ID never becomes replay authority.
                    self.db.execute("COMMIT")
                except BaseException:
                    self.db.execute("ROLLBACK")
                    raise
        except sqlite3.Error:
            raise PolicyError("storage_unavailable") from None

    def reserve_binding(self, binding, *, purpose, call_id, items, catalog, history):
        if binding is not self.config.embedding or purpose != "embedding" or not binding.supports_embeddings or not binding.automatic_allowed:
            raise PolicyError("model_not_allowed")
        state = self.snapshot()
        context, sources = resolve_context(self.config, binding, items, catalog, history)
        decision = RouteDecision(binding, context, sources, "request_fixed", purpose, state["revision"], False, True)
        self.reserve(decision, call_id, catalog)
