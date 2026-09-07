"""Phase 3.5: SkillLoader — SKILL.md 파서.

각 스킬 폴더 안의 SKILL.md를 읽어서 Skill 인스턴스를 생성한다.

SKILL.md 형식:
```
---
name: skill-name
description: 한 줄 설명
enabled: true
---

마크다운 지시문 (선택)
```
"""
from __future__ import annotations

import os
from pathlib import Path

import yaml

from action.skills.base import Skill


class _MarkdownSkill(Skill):
    """SKILL.md에서 로드된 선언적 스킬 (execute는 no-op placeholder)."""

    def __init__(self, name: str, description: str, enabled: bool, instructions: str = "") -> None:
        self.name = name
        self.description = description
        self.enabled = enabled
        self.instructions = instructions

    async def execute(self, payload: dict) -> dict:
        """선언적 스킬은 LLM이 처리 — 직접 실행 불필요."""
        return {"skill": self.name, "status": "declarative"}


class SkillLoader:
    """지정 디렉토리 하위의 SKILL.md 파일을 스캔해서 스킬 목록을 반환."""

    def __init__(self, skills_dir: str) -> None:
        self._dir = Path(skills_dir)

    def load(self) -> list[Skill]:
        skills: list[Skill] = []
        if not self._dir.exists():
            return skills

        for entry in self._dir.iterdir():
            if not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.exists():
                continue
            skill = self._parse(skill_md)
            if skill:
                skills.append(skill)

        return skills

    def _parse(self, path: Path) -> _MarkdownSkill | None:
        text = path.read_text(encoding="utf-8")

        # YAML frontmatter 추출
        if not text.startswith("---"):
            return None

        end = text.find("---", 3)
        if end == -1:
            return None

        frontmatter_str = text[3:end].strip()
        instructions = text[end + 3:].strip()

        try:
            meta = yaml.safe_load(frontmatter_str)
        except yaml.YAMLError:
            return None

        name = meta.get("name", "")
        description = meta.get("description", "")
        enabled = bool(meta.get("enabled", True))

        if not name:
            return None

        return _MarkdownSkill(
            name=name,
            description=description,
            enabled=enabled,
            instructions=instructions,
        )
