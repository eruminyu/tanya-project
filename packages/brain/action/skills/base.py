"""Phase 3.5: Skill ABC + SkillRegistry."""
from __future__ import annotations

from abc import ABC, abstractmethod


class Skill(ABC):
    """스킬 추상 기반 클래스.

    Attributes
    ----------
    name:        고유 식별자 (소문자, kebab-case 권장)
    description: 사람이 읽는 한 줄 설명 (system prompt 주입용)
    enabled:     Feature Flag — False면 SkillRegistry에서 제외
    """
    name: str
    description: str
    enabled: bool = True

    @abstractmethod
    async def execute(self, payload: dict) -> dict:
        """스킬을 실행하고 결과 dict를 반환한다."""
        ...


class SkillRegistry:
    """등록된 스킬을 관리하는 레지스트리."""

    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}

    def register(self, skill: Skill) -> None:
        self._skills[skill.name] = skill

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def list_enabled(self) -> list[Skill]:
        return [s for s in self._skills.values() if s.enabled]

    def get_prompt_context(self) -> str:
        """활성 스킬 목록을 system prompt에 삽입할 문자열로 반환."""
        enabled = self.list_enabled()
        if not enabled:
            return ""
        lines = ["## 사용 가능한 스킬"]
        for skill in enabled:
            lines.append(f"- **{skill.name}**: {skill.description}")
        return "\n".join(lines)
