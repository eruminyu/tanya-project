"""Phase 3.6: Action Router.

Intent → Skill 실행 라우팅.
- chat intent: None 반환 (Orchestrator가 LLM으로 처리)
- 등록된 스킬 이름과 일치 + enabled=True: 스킬 execute() 호출
- 미등록/비활성/예외: None 반환 (crash 방지)

Phase 4-B: SecurityManager 연동
- DENY → None 반환
- REQUIRE_APPROVAL → {"approval_required": True, "skill": name, "reason": ...} 반환
"""
from __future__ import annotations

from action.intent import Intent
from action.skills.base import SkillRegistry


class ActionRouter:
    """Intent를 받아 적절한 Skill을 실행한다."""

    def __init__(self, registry: SkillRegistry, security_manager=None) -> None:
        self._registry = registry
        self._security = security_manager

    async def route(self, intent: Intent, session_key: str = "") -> dict | None:
        """Intent에 맞는 스킬을 실행한다.

        Returns
        -------
        dict
            스킬 실행 결과. REQUIRE_APPROVAL 시 {"approval_required": True, ...}.
        None
            chat intent이거나, 스킬 없음/비활성/DENY/오류인 경우.
        """
        if intent.name == "chat":
            return None

        skill = self._registry.get(intent.name)
        if skill is None or not skill.enabled:
            return None

        # Phase 4-B: 보안 정책 검사
        if self._security is not None:
            from security.policy import ToolPolicy

            # 스킬 정책 검사
            policy_result = self._security.get_policy(intent.name)
            if policy_result.policy == ToolPolicy.DENY:
                return None
            if policy_result.policy == ToolPolicy.REQUIRE_APPROVAL:
                return {
                    "approval_required": True,
                    "skill": intent.name,
                    "reason": policy_result.reason,
                }

            # 채널 권한 검사
            if session_key:
                channel = self._security.extract_channel(session_key)
                channel_result = self._security.check_channel(intent.name, channel)
                if channel_result.policy == ToolPolicy.DENY:
                    return None

        try:
            return await skill.execute(intent.payload)
        except Exception:
            return None
