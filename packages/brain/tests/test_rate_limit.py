"""T-017: 공개 배포용 요청 제한."""

import pytest

from core.rate_limit import (
    Decision,
    RateLimiter,
    client_key,
)


class TestClientKey:
    def test_cloudflare_header_wins(self):
        """프록시 뒤에서는 모든 요청의 출발지가 Cloudflare로 보인다.
        실제 방문자를 구분하지 못하면 한 명이 전체 한도를 소진한다."""
        key = client_key({"cf-connecting-ip": "203.0.113.7",
                          "x-forwarded-for": "198.51.100.1"}, "172.68.1.1")
        assert key == "203.0.113.7"

    def test_forwarded_for_is_next(self):
        key = client_key({"x-forwarded-for": "198.51.100.1, 172.68.1.1"}, "172.68.1.1")
        assert key == "198.51.100.1"

    def test_falls_back_to_socket(self):
        assert client_key({}, "192.0.2.5") == "192.0.2.5"

    def test_header_names_are_case_insensitive(self):
        assert client_key({"CF-Connecting-IP": "203.0.113.7"}, "1.1.1.1") == "203.0.113.7"

    def test_missing_everything_is_still_a_key(self):
        """키가 없다고 무제한이 되면 안 된다."""
        assert client_key({}, None) == "unknown"


class TestRateLimiter:
    def test_allows_within_limit(self):
        limiter = RateLimiter(per_minute=3, daily_total=100)
        for _ in range(3):
            assert limiter.check("ip-a", now=0.0).allowed is True

    def test_blocks_over_limit(self):
        limiter = RateLimiter(per_minute=3, daily_total=100)
        for _ in range(3):
            limiter.check("ip-a", now=0.0)

        decision = limiter.check("ip-a", now=0.0)
        assert decision.allowed is False
        assert decision.retry_after > 0
        assert "잠시" in decision.message or "요청" in decision.message

    def test_window_slides(self):
        limiter = RateLimiter(per_minute=2, daily_total=100)
        limiter.check("ip-a", now=0.0)
        limiter.check("ip-a", now=0.0)
        assert limiter.check("ip-a", now=30.0).allowed is False
        assert limiter.check("ip-a", now=61.0).allowed is True

    def test_clients_are_independent(self):
        limiter = RateLimiter(per_minute=1, daily_total=100)
        assert limiter.check("ip-a", now=0.0).allowed is True
        assert limiter.check("ip-a", now=0.0).allowed is False
        assert limiter.check("ip-b", now=0.0).allowed is True

    def test_daily_total_caps_everyone(self):
        """비용 상한. 분산 공격으로 IP를 바꿔도 총량은 못 넘는다."""
        limiter = RateLimiter(per_minute=100, daily_total=3)
        for i in range(3):
            assert limiter.check(f"ip-{i}", now=0.0).allowed is True

        decision = limiter.check("ip-new", now=0.0)
        assert decision.allowed is False
        assert "한도" in decision.message

    def test_daily_total_resets_next_day(self):
        limiter = RateLimiter(per_minute=100, daily_total=2)
        limiter.check("ip-a", now=0.0)
        limiter.check("ip-a", now=0.0)
        assert limiter.check("ip-a", now=0.0).allowed is False
        assert limiter.check("ip-a", now=86401.0).allowed is True

    def test_memory_does_not_grow_without_bound(self):
        """공개 서비스는 IP가 무한히 들어온다. 오래된 항목은 버려야 한다."""
        limiter = RateLimiter(per_minute=5, daily_total=100000)
        for i in range(500):
            limiter.check(f"ip-{i}", now=0.0)
        limiter.check("late", now=3600.0)

        assert limiter.tracked_clients() < 500


class TestConcurrentConnections:
    def test_limits_simultaneous_websockets(self):
        limiter = RateLimiter(per_minute=100, daily_total=1000, max_connections_per_client=2)

        assert limiter.acquire_connection("ip-a") is True
        assert limiter.acquire_connection("ip-a") is True
        assert limiter.acquire_connection("ip-a") is False

    def test_release_frees_a_slot(self):
        limiter = RateLimiter(per_minute=100, daily_total=1000, max_connections_per_client=1)
        limiter.acquire_connection("ip-a")
        limiter.release_connection("ip-a")

        assert limiter.acquire_connection("ip-a") is True

    def test_release_below_zero_is_safe(self):
        limiter = RateLimiter(per_minute=100, daily_total=1000, max_connections_per_client=1)
        limiter.release_connection("never-acquired")

        assert limiter.acquire_connection("never-acquired") is True


class TestDisabled:
    def test_disabled_limiter_allows_everything(self):
        """내부망·데스크톱 사용에는 제한이 필요 없다. 기본은 꺼짐이다."""
        limiter = RateLimiter(per_minute=1, daily_total=1, enabled=False)
        for _ in range(50):
            assert limiter.check("ip-a", now=0.0).allowed is True
        assert limiter.acquire_connection("ip-a") is True
