"""Runtime validation of JSON values against the packaged, shared schema source."""

from __future__ import annotations

import copy
import json
import math
from functools import lru_cache
from importlib.resources import files
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft7Validator


class ContractValidationError(ValueError):
    """A value is not JSON or does not satisfy the requested contract shape."""


@lru_cache(maxsize=1)
def _schema() -> dict[str, Any]:
    source = files("kirian_contracts").joinpath("schema", "protocol.v1.json")
    if not source.is_file():
        # Editable installs use the same canonical file outside the Python source
        # directory; wheels contain it via setuptools' package-dir/data mapping.
        source_root = Path(__file__).resolve().parents[2]
        if source_root.joinpath("pyproject.toml").is_file():
            source = source_root.joinpath("schema", "protocol.v1.json")
    schema = json.loads(source.read_text(encoding="utf-8"))
    Draft7Validator.check_schema(schema)
    return schema


@lru_cache(maxsize=None)
def _validator(definition: str | None) -> Draft7Validator:
    schema = _schema()
    if definition is None:
        return Draft7Validator(schema)
    if definition not in schema["definitions"]:
        raise ContractValidationError("Unknown contract definition")
    pointer = definition.replace("~", "~0").replace("/", "~1")
    return Draft7Validator({
        "$schema": schema["$schema"],
        "$ref": f"#/definitions/{pointer}",
        "definitions": schema["definitions"],
    })


def _assert_json(value: object, ancestors: set[int]) -> None:
    value_type = type(value)
    if value is None or value_type in (str, bool, int):
        return
    if value_type is float:
        if not math.isfinite(value):
            raise ContractValidationError("Non-finite numbers are not JSON")
        return
    if value_type not in (dict, list):
        raise ContractValidationError("Only JSON objects, arrays, and scalar values are accepted")
    identity = id(value)
    if identity in ancestors:
        raise ContractValidationError("Cyclic values are not JSON")
    ancestors.add(identity)
    try:
        if value_type is dict:
            for key, child in cast(dict[object, object], value).items():
                if type(key) is not str:
                    raise ContractValidationError("JSON object keys must be strings")
                _assert_json(child, ancestors)
        else:
            for child in cast(list[object], value):
                _assert_json(child, ancestors)
    finally:
        ancestors.remove(identity)


def _validate(value: object, definition: str | None) -> None:
    try:
        _assert_json(value, set())
        error = next(_validator(definition).iter_errors(value), None)
    except RecursionError:
        raise ContractValidationError("JSON value exceeds validation nesting limits") from None
    if error is not None:
        # Do not echo rejected payload content into callers' logs or error responses.
        raise ContractValidationError(f"Contract validation failed ({error.validator})")


def parse_message(value: object) -> dict[str, Any]:
    """Validate an already decoded JSON message without coercion or field removal."""
    _validate(value, None)
    return copy.deepcopy(cast(dict[str, Any], value))


def assert_definition(name: str, value: object) -> None:
    """Validate a named shared definition, independently of its message envelope."""
    if type(name) is not str:
        raise ContractValidationError("Contract definition name must be a string")
    _validate(value, name)
