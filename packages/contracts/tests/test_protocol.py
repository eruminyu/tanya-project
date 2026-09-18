"""Python runs the same wire fixtures as TypeScript, plus Python JSON edge cases."""

from __future__ import annotations

import copy
import json
from decimal import Decimal
from pathlib import Path

import pytest

from kirian_contracts import ContractValidationError, assert_definition, parse_message


FIXTURES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "wire.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", FIXTURES, ids=lambda case: case["name"])
def test_shared_wire_fixture(case: dict) -> None:
    if case["valid"]:
        assert parse_message(case["message"]) == case["message"]
    else:
        with pytest.raises(ContractValidationError):
            parse_message(case["message"])


def _scope() -> dict:
    return {
        "instance_id": "instance-1",
        "mode": "personal",
        "principal_id": "owner-1",
        "session_id": "session-1",
        "connection_id": "connection-1",
        "connection_epoch": 0,
    }


@pytest.mark.parametrize("epoch", [0, 1, 1.0, 9007199254740991])
def test_json_integer_boundaries_accept(epoch: int | float) -> None:
    scope = _scope()
    scope["connection_epoch"] = epoch
    assert_definition("Scope", scope)


@pytest.mark.parametrize("epoch", [True, False, -1, 0.5, 9007199254740992, "1"])
def test_json_integer_boundaries_reject(epoch: object) -> None:
    scope = _scope()
    scope["connection_epoch"] = epoch
    with pytest.raises(ContractValidationError):
        assert_definition("Scope", scope)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf"), Decimal("1"), (1,), {1}])
def test_non_json_values_reject(value: object) -> None:
    scope = _scope()
    scope["connection_epoch"] = value
    with pytest.raises(ContractValidationError):
        assert_definition("Scope", scope)


def test_non_string_keys_reject() -> None:
    scope = _scope()
    scope[1] = "invalid key"
    with pytest.raises(ContractValidationError, match="keys must be strings"):
        assert_definition("Scope", scope)


def test_cyclic_values_reject() -> None:
    scope = _scope()
    scope["self"] = scope
    with pytest.raises(ContractValidationError, match="Cyclic"):
        assert_definition("Scope", scope)


def test_unknown_definition_rejects() -> None:
    with pytest.raises(ContractValidationError, match="Unknown contract definition"):
        assert_definition("MissingDefinition", {})


def test_validation_does_not_coerce_or_remove_fields() -> None:
    scope = _scope()
    scope["connection_epoch"] = "1"
    scope["unexpected"] = True
    original = copy.deepcopy(scope)
    with pytest.raises(ContractValidationError):
        assert_definition("Scope", scope)
    assert scope == original


def test_errors_do_not_echo_rejected_content() -> None:
    scope = _scope()
    scope["principal_id"] = "sensitive rejected content"
    with pytest.raises(ContractValidationError) as error:
        assert_definition("Scope", scope)
    assert "sensitive rejected content" not in str(error.value)

def test_parser_returns_an_independent_validated_message():
    message = copy.deepcopy(FIXTURES[0]["message"])
    parsed = parse_message(message)
    message["scope"]["session_id"] = "changed"
    assert parsed["scope"]["session_id"] != message["scope"]["session_id"]
