"""Phase 4-B: 보안 정책 모듈.

ToolPolicy:
- ALLOW            — 자동 실행
- DENY             — 차단
- REQUIRE_APPROVAL — 사용자 승인 후 실행

SecurityManager:
- 스킬명 → ToolPolicy 매핑
- 채널별 허용 스킬 목록 관리
- 기본 위험 스킬: shell, file_write, file_delete, process_kill → REQUIRE_APPROVAL
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ToolPolicy(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


@dataclass
class PolicyResult:
    policy: ToolPolicy
    reason: str = ""

    @property
    def is_allowed(self) -> bool:
        return self.policy == ToolPolicy.ALLOW

    @property
    def requires_approval(self) -> bool:
        return self.policy == ToolPolicy.REQUIRE_APPROVAL


class SecurityManager:
    """스킬 실행 정책 + 채널 권한 관리자."""

    _DANGEROUS_SKILLS: frozenset[str] = frozenset(
        {"shell", "file_write", "file_delete", "process_kill"}
    )

    def __init__(self, rules: dict[str, ToolPolicy] | None = None) -> None:
        # 명시적 정책 오버라이드 (dangerous 기본 포함)
        self._rules: dict[str, ToolPolicy] = {}
        # 채널별 허용 스킬 목록 (None = 제한 없음)
        self._channel_allowlists: dict[str, set[str]] = {}

        if rules:
            self._rules.update(rules)

    def set_policy(self, skill_name: str, policy: ToolPolicy) -> None:
        """스킬에 대한 정책을 설정한다."""
        self._rules[skill_name] = policy

    def get_policy(self, skill_name: str) -> PolicyResult:
        """스킬 이름에 대한 정책을 반환한다.

        우선순위:
        1. 명시적 규칙
        2. 위험 스킬 기본값 → REQUIRE_APPROVAL
        3. 기본값 → ALLOW
        """
        if skill_name in self._rules:
            return PolicyResult(policy=self._rules[skill_name])
        if skill_name in self._DANGEROUS_SKILLS:
            return PolicyResult(
                policy=ToolPolicy.REQUIRE_APPROVAL,
                reason=f"'{skill_name}'은 위험 스킬로 사용자 승인이 필요합니다.",
            )
        return PolicyResult(policy=ToolPolicy.ALLOW)

    def set_channel_allowlist(self, channel: str, skills: list[str]) -> None:
        """채널에서 허용할 스킬 목록을 설정한다.

        이 목록에 없는 스킬은 해당 채널에서 DENY 처리된다.
        """
        self._channel_allowlists[channel] = set(skills)

    def check_channel(self, skill_name: str, channel: str) -> PolicyResult:
        """채널 권한 검사.

        채널 허용 목록이 없으면 모두 허용.
        목록이 있으면 목록 내 스킬만 허용.
        """
        if channel not in self._channel_allowlists:
            return PolicyResult(policy=ToolPolicy.ALLOW)
        if skill_name in self._channel_allowlists[channel]:
            return PolicyResult(policy=ToolPolicy.ALLOW)
        return PolicyResult(
            policy=ToolPolicy.DENY,
            reason=f"채널 '{channel}'에서는 '{skill_name}' 스킬이 허용되지 않습니다.",
        )

    @staticmethod
    def extract_channel(session_key: str) -> str:
        """session_key에서 채널 prefix를 추출한다.

        예: "live2d:main" → "live2d"
            "discord:dm:123" → "discord"
            "unknown" → "unknown"
        """
        return session_key.split(":")[0]
