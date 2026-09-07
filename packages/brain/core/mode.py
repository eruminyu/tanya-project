"""Phase 3.7: 일상/작업 모드 정의 + 규칙 기반 분류기.

TanyaMode:
- CASUAL: 일상 대화 → 로컬 LLM (Ollama) 우선
- TASK:   복잡한 작업 → API LLM (Gemini/Claude/OpenAI) 우선

ModeClassifier:
- 키워드/길이 기반 규칙으로 모드 결정 (1단계)
- 2단계(임베딩 기반)는 Phase 7 이후 교체 예정
"""
from __future__ import annotations

from enum import Enum

# 작업 모드로 분류할 키워드 (한국어 + 영어)
_TASK_KEYWORDS = [
    "코드", "code", "구현", "implement",
    "분석", "analyze", "analysis",
    "설명", "explain", "description",
    "에러", "error", "버그", "bug", "오류",
    "리팩토링", "refactor",
    "디버그", "debug",
    "작성", "write",
    "개발", "develop",
    "알고리즘", "algorithm",
    "함수", "function", "class", "클래스",
    "데이터베이스", "database", "sql",
    "api", "서버", "server",
    "테스트", "test",
]

# 길이 기준: 이 이상이면 task 모드
_TASK_LENGTH_THRESHOLD = 100


class TanyaMode(str, Enum):
    CASUAL = "casual"
    TASK = "task"


class ModeClassifier:
    """규칙 기반 모드 분류기.

    1. 키워드 매칭 → TASK
    2. 텍스트 길이 > threshold → TASK
    3. 그 외 → CASUAL
    """

    def classify(self, text: str) -> TanyaMode:
        lower = text.lower()
        for kw in _TASK_KEYWORDS:
            if kw in lower:
                return TanyaMode.TASK
        if len(text) > _TASK_LENGTH_THRESHOLD:
            return TanyaMode.TASK
        return TanyaMode.CASUAL
