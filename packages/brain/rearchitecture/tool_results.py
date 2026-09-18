"""Host-only tool result provenance validation. Model text never authorizes a write."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re

from kirian_contracts import assert_definition

from .storage import StorageError


PROVENANCE_FIELDS = {
    "identity", "scope", "turnId", "intentId", "proposalId", "offerId", "draftId", "draftRevision",
    "payloadSha256", "executionId", "providerOperationId", "connectionId", "connectionGeneration", "accountId",
    "toolName", "toolFingerprint", "boundary", "parents", "offeredMetadata", "rawResultSha256", "canonicalResultSha256",
}
METADATA_FIELDS = {"offerId", "connectionId", "connectionGeneration", "accountId", "toolName", "toolFingerprint", "boundary"}
BOUNDARIES = {"local": 0, "private_lan": 1, "cloud": 2}
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
SHA = re.compile(r"[a-f0-9]{64}")


def _require(condition, code="invalid_request"):
    if not condition:
        raise StorageError(code)


def _shape(value, fields):
    _require(isinstance(value, dict) and set(value) == fields)


def _identifier(value):
    _require(isinstance(value, str) and ID.fullmatch(value) is not None)


def _sha(value):
    _require(isinstance(value, str) and SHA.fullmatch(value) is not None)


def _text(value, byte_limit, character_limit=None):
    _require(isinstance(value, str) and bool(value.strip()) and "\0" not in value)
    try:
        data = value.encode("utf-8")
    except UnicodeError:
        raise StorageError("invalid_request") from None
    _require(len(data) <= byte_limit and (character_limit is None or len(value) <= character_limit))
    return data


def _json(value):
    def reject(_value):
        raise ValueError()
    result = json.loads(value, parse_constant=reject)
    def finite(item, depth=0):
        _require(depth <= 24)
        if isinstance(item, float):
            _require(math.isfinite(item))
        elif isinstance(item, dict):
            _require(len(item) <= 1024 and not {"__proto__", "constructor", "prototype"}.intersection(item))
            for key, child in item.items():
                _require("\0" not in key)
                key.encode("utf-8")
                finite(child, depth + 1)
        elif isinstance(item, list):
            _require(len(item) <= 4096)
            for child in item:
                finite(child, depth + 1)
        elif isinstance(item, str):
            _require("\0" not in item)
            item.encode("utf-8")
    finite(result)
    return result


def _same_json(left, right):
    # Python bool is an int subclass. JSON true must not equal JSON 1.
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_json(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def validate_registration(value, identity):
    """Validate the exact host bodies, preserving the submitted canonical text.

    JSON equivalence is structural. Re-serializing with Python would change JS
    number spellings and Unicode key ordering and destroy the host's exact hash.
    """
    try:
        _shape(value, {"provenance", "rawResultJson", "canonicalResultJson", "receipt"})
        p, receipt = value["provenance"], value["receipt"]
        _shape(p, PROVENANCE_FIELDS | ({"providerKind"} if isinstance(p, dict) and "providerKind" in p else set()))
        provider = p.get("providerKind", "mcp")
        _require(provider in ("mcp", "google_calendar"))
        assert_definition("Identity", p["identity"])
        assert_definition("Scope", p["scope"])
        _require(p["identity"] == identity and identity["mode"] in ("personal", "public_demo")
                 and {key: p["scope"][key] for key in identity} == identity)
        for key in ("turnId", "intentId", "proposalId", "offerId", "draftId", "executionId", "providerOperationId",
                    "connectionId", "connectionGeneration", "accountId"):
            _identifier(p[key])
        _require(type(p["draftRevision"]) is int and 1 <= p["draftRevision"] <= 9007199254740991)
        for key in ("payloadSha256", "toolFingerprint", "rawResultSha256", "canonicalResultSha256"):
            _sha(p[key])
        _text(p["toolName"], 512)
        _require(isinstance(p["boundary"], str) and p["boundary"] in BOUNDARIES)
        _require(isinstance(p["parents"], list) and len(p["parents"]) <= 128)
        parent_ids = set()
        for ref in p["parents"]:
            assert_definition("SourceRef", ref)
            _require(ref["source_id"] not in parent_ids)
            parent_ids.add(ref["source_id"])
        metadata = p["offeredMetadata"]
        _require(isinstance(metadata, list) and 1 <= len(metadata) <= 16)
        offers, candidates = set(), set()
        chosen = None
        for item in metadata:
            _shape(item, METADATA_FIELDS | ({"providerKind"} if isinstance(item, dict) and "providerKind" in item else set()))
            _require(item.get("providerKind", "mcp") in ("mcp", "google_calendar"))
            for key in ("offerId", "connectionId", "connectionGeneration", "accountId"):
                _identifier(item[key])
            _sha(item["toolFingerprint"])
            _text(item["toolName"], 512)
            _require(isinstance(item["boundary"], str) and item["boundary"] in BOUNDARIES)
            _require(BOUNDARIES[p["boundary"]] <= BOUNDARIES[item["boundary"]], "context_blocked")
            candidate = (item["connectionId"], item["toolName"])
            _require(item["offerId"] not in offers and candidate not in candidates)
            offers.add(item["offerId"])
            candidates.add(candidate)
            if item["offerId"] == p["offerId"]:
                chosen = item
        _require(chosen is not None and all(chosen[key] == p[key] for key in METADATA_FIELDS - {"boundary"}))
        _require(chosen.get("providerKind", "mcp") == provider)
        assert_definition("ExecutionReceipt", receipt)
        _require(receipt["status"] == "succeeded" and receipt["provider_id"] == provider
                 and receipt["executor_id"] == "kirian-external-v1")
        for receipt_key, provenance_key in (("identity", "identity"), ("draft_id", "draftId"), ("draft_revision", "draftRevision"),
                                            ("execution_id", "executionId"), ("payload_sha256", "payloadSha256"),
                                            ("provider_operation_id", "providerOperationId")):
            _require(receipt[receipt_key] == p[provenance_key])
        raw = _text(value["rawResultJson"], 65536)
        canonical = _text(value["canonicalResultJson"], 32768, 8192)
        _require(hashlib.sha256(raw).hexdigest() == p["rawResultSha256"])
        _require(hashlib.sha256(canonical).hexdigest() == p["canonicalResultSha256"])
        _require(_same_json(_json(value["rawResultJson"]), _json(value["canonicalResultJson"])))
        return copy.deepcopy(value)
    except StorageError:
        raise
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise StorageError("invalid_request") from None


def registered_result(source, provenance):
    record = source["record"]
    return {"kind": "tool_result", "sourceRef": {"source_id": record["source_id"], "revision": record["revision"]},
            "identity": copy.deepcopy(record["identity"]), "boundary": record["boundary"],
            "parents": copy.deepcopy(record["parents"]), "text": source["text"],
            "rawResultSha256": provenance["rawResultSha256"], "canonicalResultSha256": provenance["canonicalResultSha256"]}
