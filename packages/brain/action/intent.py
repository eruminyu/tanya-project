"""Phase 3.6: Intent 해석기.

규칙 기반 Intent 분류기.
커스텀 규칙을 리스트로 주입하거나 기본 규칙(chat fallback)만 사용.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Intent:
    """분류된 인텐트."""
    name: str
    payload: dict = field(default_factory=dict)
    confidence: float = 1.0


# 규칙 타입: text → Intent | None
RuleFn = Callable[[str], Intent | None]


class IntentClassifier:
    """규칙 기반 Intent 분류기.

    Parameters
    ----------
    rules:
        `(text: str) -> Intent | None` 시그니처의 규칙 함수 리스트.
        첫 번째 non-None 반환값이 사용된다.
        규칙이 없거나 모두 None이면 `chat` fallback.
    """

    def __init__(self, rules: list[RuleFn] | None = None) -> None:
        self._rules: list[RuleFn] = rules or []

    def classify(self, text: str) -> Intent:
        for rule in self._rules:
            result = rule(text)
            if result is not None:
                return result
        return Intent(name="chat", payload={"text": text})
