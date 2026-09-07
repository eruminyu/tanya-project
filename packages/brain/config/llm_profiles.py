"""사용자가 선택한 일상/작업 LLM 프로필의 로컬 저장소."""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel


LLMProviderName = Literal[
    "ollama",
    "gemini",
    "claude",
    "openai",
    "openai-compatible",
    "vllm",
]


class LLMProfile(BaseModel):
    provider: LLMProviderName
    model: str = ""
    base_url: str = ""
    api_key: str = ""


class LLMProfiles(BaseModel):
    casual: LLMProfile
    task: LLMProfile


class LLMProfileStore:
    """LLM 프로필을 JSON 파일 하나에 원자적으로 저장한다."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    def load(self) -> LLMProfiles | None:
        if not self._path.exists():
            return None
        return LLMProfiles.model_validate_json(
            self._path.read_text(encoding="utf-8")
        )

    def save(self, profiles: LLMProfiles) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary_path.write_text(
            profiles.model_dump_json(indent=2),
            encoding="utf-8",
        )
        temporary_path.replace(self._path)
