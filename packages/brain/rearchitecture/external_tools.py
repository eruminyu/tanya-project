"""Bounded native tool-call data. Nothing in this module executes a tool."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

# What the assistant "says" when a draft is shown: used in the few-shot example and as the assistant turn
# preceding the post-approval summary, so both places agree.
DRAFT_SHOWN_TEXT = "초안을 준비했어요. 화면에서 확인하고 승인해 주세요."


class ToolDataError(ValueError):
    pass


@dataclass(frozen=True)
class NativeToolCall:
    offer_id: str
    arguments_json: str


def bounded_json(value, depth=0):
    if depth > 24:
        raise ToolDataError()
    if value is None or type(value) is bool:
        return
    if type(value) in (float, int):
        if not math.isfinite(value) or type(value) is int and abs(value) > 9007199254740991:
            raise ToolDataError()
        return
    if type(value) is str:
        if "\0" in value:
            raise ToolDataError()
        value.encode("utf-8")
        return
    if type(value) is list and len(value) <= 4096:
        for child in value:
            bounded_json(child, depth + 1)
        return
    if type(value) is dict and len(value) <= 1024:
        for key, child in value.items():
            if type(key) is not str or key in ("__proto__", "constructor", "prototype"):
                raise ToolDataError()
            bounded_json(key, depth + 1)
            bounded_json(child, depth + 1)
        return
    raise ToolDataError()


def strict_json(raw, limit):
    if not isinstance(raw, (str, bytes)) or len(raw.encode("utf-8") if isinstance(raw, str) else raw) > limit:
        raise ToolDataError()
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ToolDataError()
            result[key] = value
        return result
    def reject(_):
        raise ToolDataError()
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=reject)
    bounded_json(value)
    return value


def encoded(value):
    bounded_json(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def prepare_offers(offers):
    if type(offers) is not list or not 1 <= len(offers) <= 16:
        raise ToolDataError()
    if len(encoded(offers).encode("utf-8")) > 32768:
        raise ToolDataError()
    names, tools, seen = {}, [], set()
    for index, offer in enumerate(offers):
        if type(offer) is not dict or set(offer) not in ({"offer_id", "display_name", "description", "input_schema_json"}, {"offer_id", "display_name", "description", "input_schema_json", "provider_kind"}):
            raise ToolDataError()
        if offer.get("provider_kind", "mcp") not in ("mcp", "google_calendar"):
            raise ToolDataError()
        offer_id = offer["offer_id"]
        if type(offer_id) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", offer_id) or offer_id in seen:
            raise ToolDataError()
        seen.add(offer_id)
        for field, limit in (("display_name", 640), ("description", 2048)):
            value = offer[field]
            if type(value) is not str or len(value.encode("utf-8")) > limit or field == "display_name" and (not value.strip() or len(value) > 160):
                raise ToolDataError()
        schema = strict_json(offer["input_schema_json"], 8192)
        if type(schema) is not dict:
            raise ToolDataError()
        # Schemas are provider metadata only. No schema execution or remote $ref lookup.
        name = "kirian_tool_" + str(index)
        names[name] = offer_id
        tools.append({"type": "function", "function": {"name": name,
            "description": offer["display_name"] + "\n" + offer["description"], "parameters": schema}})
    return tools, names


def parse_native_call(raw, names, kind):
    if type(raw) is not list or len(raw) != 1 or type(raw[0]) is not dict:
        raise ToolDataError()
    call = raw[0]
    if set(call) - {"type", "function", "id"} or call.get("type", "function") != "function":
        raise ToolDataError()
    function = call.get("function")
    if type(function) is not dict or set(function) - {"name", "arguments", "index"}:
        raise ToolDataError()
    if "index" in function and (type(function["index"]) is not int or function["index"] != 0):
        raise ToolDataError()
    name = function.get("name")
    if type(name) is not str or name not in names:
        raise ToolDataError()
    if kind == "openai-compatible":
        if call.get("type") != "function" or type(call.get("id")) is not str or not 1 <= len(call["id"]) <= 128:
            raise ToolDataError()
        arguments = strict_json(function.get("arguments"), 16384)
    else:
        arguments = function.get("arguments")
    if type(arguments) is not dict:
        raise ToolDataError()
    arguments_json = encoded(arguments)
    if len(arguments_json.encode("utf-8")) > 16384:
        raise ToolDataError()
    return NativeToolCall(names[name], arguments_json)


def calendar_example_messages(offers, tools, kind, now: datetime | None = None) -> list[dict]:
    """A one-shot demonstration for the first calendar *create* offer, placed before the real history.

    Instruction-tuned models read "prepare a draft" as "ask first"; the offer description alone moved the official
    Gemma 4 E4B to 0-4 calls out of 10 on plain requests, one worked example to 10/10 without spurious calls on
    ordinary turns (2026-09-18 probe). The example uses tomorrow so it can never be mistaken for the user's turn.
    """
    for offer, tool in zip(offers, tools):
        if offer.get("provider_kind") != "google_calendar":
            continue
        required = tool["function"]["parameters"].get("required")
        if type(required) is not list or "eventId" in required or "start" not in required:
            continue
        moment = (now or datetime.now().astimezone()).replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=1)
        offset = moment.strftime("%z")
        offset = offset[:3] + ":" + offset[3:] if offset else "+00:00"
        arguments = {"summary": "미용실 예약", "start": {"dateTime": moment.strftime("%Y-%m-%dT%H:%M:%S") + offset},
                     "end": {"dateTime": (moment + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S") + offset},
                     "description": "", "location": ""}
        name = tool["function"]["name"]
        if kind == "openai-compatible":
            call = {"id": "example-call-1", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}
            result = {"role": "tool", "tool_call_id": "example-call-1", "content": "{\"status\":\"draft_shown_to_user\"}"}
        else:
            call = {"function": {"name": name, "arguments": arguments}}
            result = {"role": "tool", "content": "{\"status\":\"draft_shown_to_user\"}"}
        return [{"role": "user", "content": "내일 오전 9시에 미용실 예약 잡아 줘."},
                {"role": "assistant", "content": "", "tool_calls": [call]},
                result,
                {"role": "assistant", "content": DRAFT_SHOWN_TEXT}]
    return []
