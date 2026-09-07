"""T-015: 선제 제안을 수락하면 초안이 만들어진다."""

from datetime import datetime, timedelta

import pytest

from core.pending_offer import (
    ACCEPT_WORDS,
    PendingOffer,
    build_preparation_draft,
    is_acceptance,
)


class TestAcceptanceDetection:
    def test_plain_agreement_counts(self):
        for word in ["그래", "응", "좋아", "부탁해", "ㅇㅇ", "그래 부탁해"]:
            assert is_acceptance(word) is True, word

    def test_whitespace_and_punctuation_are_normalized(self):
        assert is_acceptance("  그래!  ") is True
        assert is_acceptance("응.") is True

    def test_unrelated_message_is_not_acceptance(self):
        for text in ["아니", "나중에", "오늘 날씨 어때?", "그래서 그게 뭔데", ""]:
            assert is_acceptance(text) is False, text

    def test_whitelist_is_exact_match_not_substring(self):
        """'그래서'가 '그래'로 잡히면 일반 대화가 초안을 만든다."""
        assert is_acceptance("그래서") is False
        assert is_acceptance("응답해줘") is False


class TestPendingOfferLifetime:
    def test_offer_is_alive_within_ttl(self):
        now = datetime(2026, 9, 15, 14, 20)
        offer = PendingOffer(event_id="e1", title="프로젝트 회의",
                             starts_at=now + timedelta(minutes=30), created_at=now)

        assert offer.is_alive(now + timedelta(minutes=14)) is True

    def test_offer_expires(self):
        now = datetime(2026, 9, 15, 14, 20)
        offer = PendingOffer(event_id="e1", title="프로젝트 회의",
                             starts_at=now + timedelta(minutes=30), created_at=now)

        assert offer.is_alive(now + timedelta(minutes=16)) is False


class TestPreparationDraft:
    def test_draft_ends_when_the_event_starts(self):
        now = datetime(2026, 9, 15, 14, 20)
        offer = PendingOffer("e1", "프로젝트 회의", now + timedelta(minutes=30), now)

        draft = build_preparation_draft(offer, now)

        assert draft["kind"] == "calendar"
        assert draft["title"] == "프로젝트 회의 준비"
        assert draft["endAt"].startswith("2026-09-15T14:50")
        assert draft["startAt"].startswith("2026-09-15T14:20")

    def test_draft_never_starts_in_the_past(self):
        """일정이 30분 안쪽이면 시작이 과거가 된다. 클라이언트는 그런 초안을 조용히 버린다."""
        now = datetime(2026, 9, 15, 14, 50)
        offer = PendingOffer("e1", "회의", now + timedelta(minutes=10), now)

        draft = build_preparation_draft(offer, now)

        start = datetime.fromisoformat(draft["startAt"]).replace(tzinfo=None)
        end = datetime.fromisoformat(draft["endAt"]).replace(tzinfo=None)
        assert start >= now, "시작이 과거면 안 된다"
        assert end > start, "end > start 불변식 — 깨지면 클라이언트가 에러 없이 버린다"

    def test_draft_always_satisfies_end_after_start(self):
        now = datetime(2026, 9, 15, 14, 50)
        for minutes in (-10, 0, 1, 5, 30, 40):
            offer = PendingOffer("e", "회의", now + timedelta(minutes=minutes), now)
            draft = build_preparation_draft(offer, now)
            start = datetime.fromisoformat(draft["startAt"])
            end = datetime.fromisoformat(draft["endAt"])
            assert end > start, f"{minutes}분 뒤 일정에서 불변식이 깨졌다"

    def test_offset_is_included(self):
        """RFC3339 오프셋이 없으면 클라이언트의 Date 파싱이 시간대를 잘못 읽는다."""
        now = datetime(2026, 9, 15, 14, 20)
        offer = PendingOffer("e1", "회의", now + timedelta(minutes=30), now)

        draft = build_preparation_draft(offer, now)

        assert "+" in draft["startAt"][10:] or draft["startAt"].endswith("Z")
