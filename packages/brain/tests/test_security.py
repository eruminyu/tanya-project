"""Phase 4-B: 보안 모델 테스트"""
import time
import pytest
from unittest.mock import AsyncMock, MagicMock

from security.policy import ToolPolicy, PolicyResult, SecurityManager
from security.token import TokenValidator
from core.protocol import RequestEnvelope


# ---------------------------------------------------------------------------
# ToolPolicy enum
# ---------------------------------------------------------------------------

class TestToolPolicy:
    def test_values_exist(self):
        assert ToolPolicy.ALLOW is not None
        assert ToolPolicy.DENY is not None
        assert ToolPolicy.REQUIRE_APPROVAL is not None

    def test_values(self):
        assert ToolPolicy.ALLOW.value == "allow"
        assert ToolPolicy.DENY.value == "deny"
        assert ToolPolicy.REQUIRE_APPROVAL.value == "require_approval"


# ---------------------------------------------------------------------------
# PolicyResult
# ---------------------------------------------------------------------------

class TestPolicyResult:
    def test_create_with_policy(self):
        result = PolicyResult(policy=ToolPolicy.ALLOW)
        assert result.policy == ToolPolicy.ALLOW
        assert result.reason == ""

    def test_create_with_reason(self):
        result = PolicyResult(policy=ToolPolicy.DENY, reason="위험 스킬")
        assert result.reason == "위험 스킬"

    def test_is_allowed(self):
        assert PolicyResult(policy=ToolPolicy.ALLOW).is_allowed is True
        assert PolicyResult(policy=ToolPolicy.DENY).is_allowed is False
        assert PolicyResult(policy=ToolPolicy.REQUIRE_APPROVAL).is_allowed is False

    def test_requires_approval(self):
        assert PolicyResult(policy=ToolPolicy.REQUIRE_APPROVAL).requires_approval is True
        assert PolicyResult(policy=ToolPolicy.ALLOW).requires_approval is False


# ---------------------------------------------------------------------------
# SecurityManager — 기본 정책
# ---------------------------------------------------------------------------

class TestSecurityManagerDefault:
    def setup_method(self):
        self.sm = SecurityManager()

    def test_unknown_skill_default_allow(self):
        result = self.sm.get_policy("unknown_skill")
        assert result.policy == ToolPolicy.ALLOW

    def test_dangerous_skill_default_require_approval(self):
        """위험 스킬은 기본적으로 REQUIRE_APPROVAL"""
        result = self.sm.get_policy("shell")
        assert result.policy == ToolPolicy.REQUIRE_APPROVAL

    def test_dangerous_skills_list(self):
        for skill in ["shell", "file_write", "file_delete", "process_kill"]:
            result = self.sm.get_policy(skill)
            assert result.policy == ToolPolicy.REQUIRE_APPROVAL, f"{skill} should be REQUIRE_APPROVAL"

    def test_set_policy_override(self):
        self.sm.set_policy("my_skill", ToolPolicy.DENY)
        result = self.sm.get_policy("my_skill")
        assert result.policy == ToolPolicy.DENY

    def test_set_policy_allow_dangerous(self):
        """위험 스킬도 명시적으로 ALLOW 설정 가능"""
        self.sm.set_policy("shell", ToolPolicy.ALLOW)
        result = self.sm.get_policy("shell")
        assert result.policy == ToolPolicy.ALLOW


# ---------------------------------------------------------------------------
# SecurityManager — 채널 권한
# ---------------------------------------------------------------------------

class TestSecurityManagerChannel:
    def setup_method(self):
        self.sm = SecurityManager()

    def test_no_allowlist_allows_all(self):
        """채널 허용 목록 없으면 모든 스킬 허용"""
        result = self.sm.check_channel("any_skill", "tauri")
        assert result.policy == ToolPolicy.ALLOW

    def test_channel_allowlist_permits_listed(self):
        self.sm.set_channel_allowlist("tauri", ["weather", "timer"])
        result = self.sm.check_channel("weather", "tauri")
        assert result.policy == ToolPolicy.ALLOW

    def test_channel_allowlist_denies_unlisted(self):
        self.sm.set_channel_allowlist("tauri", ["weather"])
        result = self.sm.check_channel("shell", "tauri")
        assert result.policy == ToolPolicy.DENY

    def test_channel_extracted_from_session_key(self):
        """session_key에서 채널 prefix 추출"""
        assert SecurityManager.extract_channel("live2d:main") == "live2d"
        assert SecurityManager.extract_channel("discord:dm:123") == "discord"
        assert SecurityManager.extract_channel("webchat:browser-1") == "webchat"

    def test_extract_channel_no_colon(self):
        """콜론 없는 session_key → 그대로 반환"""
        assert SecurityManager.extract_channel("unknown") == "unknown"


# ---------------------------------------------------------------------------
# TokenValidator
# ---------------------------------------------------------------------------

class TestTokenValidator:
    def setup_method(self):
        self.validator = TokenValidator(secret_key="test-secret-key")

    def test_generate_returns_string(self):
        token = self.validator.generate({"user": "tanya"})
        assert isinstance(token, str)
        assert len(token) > 0

    def test_validate_valid_token(self):
        payload = {"user": "tanya", "channel": "tauri"}
        token = self.validator.generate(payload)
        result = self.validator.validate(token)
        assert result is not None
        assert result["user"] == "tanya"
        assert result["channel"] == "tauri"

    def test_validate_expired_token(self):
        token = self.validator.generate({"user": "tanya"}, expires_in=-1)
        result = self.validator.validate(token)
        assert result is None

    def test_validate_tampered_token(self):
        token = self.validator.generate({"user": "tanya"})
        # 서명 변조
        parts = token.split(".")
        tampered = parts[0] + "." + parts[1] + ".invalidsignature"
        result = self.validator.validate(tampered)
        assert result is None

    def test_validate_invalid_format(self):
        result = self.validator.validate("not-a-valid-token")
        assert result is None

    def test_different_secret_fails(self):
        token = self.validator.generate({"user": "tanya"})
        other_validator = TokenValidator(secret_key="different-secret")
        result = other_validator.validate(token)
        assert result is None


# ---------------------------------------------------------------------------
# RequestEnvelope — auth_token 필드
# ---------------------------------------------------------------------------

class TestRequestEnvelopeAuth:
    def test_request_without_auth_token(self):
        req = RequestEnvelope(id="1", action="chat", payload={"text": "hi"})
        assert req.auth_token is None

    def test_request_with_auth_token(self):
        req = RequestEnvelope(id="1", action="chat", payload={}, auth_token="mytoken")
        assert req.auth_token == "mytoken"


# ---------------------------------------------------------------------------
# ActionRouter + SecurityManager 통합
# ---------------------------------------------------------------------------

class TestActionRouterSecurity:
    @pytest.mark.asyncio
    async def test_denied_skill_returns_none(self):
        from action.router import ActionRouter
        from action.intent import Intent
        from action.skills.base import SkillRegistry, Skill

        class DummySkill(Skill):
            name = "dangerous"
            description = "위험 스킬"
            async def execute(self, payload):
                return {"done": True}

        registry = SkillRegistry()
        registry.register(DummySkill())

        sm = SecurityManager()
        sm.set_policy("dangerous", ToolPolicy.DENY)

        router = ActionRouter(registry, security_manager=sm)
        result = await router.route(Intent(name="dangerous"))
        assert result is None

    @pytest.mark.asyncio
    async def test_require_approval_skill_returns_approval_needed(self):
        from action.router import ActionRouter
        from action.intent import Intent
        from action.skills.base import SkillRegistry, Skill

        class ShellSkill(Skill):
            name = "shell"
            description = "쉘 실행"
            async def execute(self, payload):
                return {"output": "done"}

        registry = SkillRegistry()
        registry.register(ShellSkill())

        sm = SecurityManager()  # shell은 기본적으로 REQUIRE_APPROVAL

        router = ActionRouter(registry, security_manager=sm)
        result = await router.route(Intent(name="shell"))
        # REQUIRE_APPROVAL 시 특수 응답 반환
        assert result is not None
        assert result.get("approval_required") is True

    @pytest.mark.asyncio
    async def test_allowed_skill_executes_normally(self):
        from action.router import ActionRouter
        from action.intent import Intent
        from action.skills.base import SkillRegistry, Skill

        class WeatherSkill(Skill):
            name = "weather"
            description = "날씨"
            async def execute(self, payload):
                return {"weather": "sunny"}

        registry = SkillRegistry()
        registry.register(WeatherSkill())

        sm = SecurityManager()  # weather는 기본 ALLOW
        router = ActionRouter(registry, security_manager=sm)
        result = await router.route(Intent(name="weather"))
        assert result == {"weather": "sunny"}

    @pytest.mark.asyncio
    async def test_no_security_manager_works_as_before(self):
        """security_manager 없으면 기존 동작 유지"""
        from action.router import ActionRouter
        from action.intent import Intent
        from action.skills.base import SkillRegistry, Skill

        class SimpleSkill(Skill):
            name = "simple"
            description = "심플"
            async def execute(self, payload):
                return {"ok": True}

        registry = SkillRegistry()
        registry.register(SimpleSkill())

        router = ActionRouter(registry)  # security_manager 없음
        result = await router.route(Intent(name="simple"))
        assert result == {"ok": True}
