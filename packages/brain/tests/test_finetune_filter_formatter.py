"""Phase 7-A: FineTuneFilter + FineTuneFormatter TDD 테스트."""
import json
import os
import tempfile
import pytest

from finetune.filter import FineTuneFilter
from finetune.formatter import FineTuneFormatter


# ──────────────────────────────────────────────
# 헬퍼
# ──────────────────────────────────────────────

def make_conv(user_msg="안녕하세요 타냐, 오늘 날씨 어때?", assistant_msg="안녕 데모 사용자, 오늘도 잘 부탁해요!",
              quality_score=0.7):
    return {
        "id": 1,
        "session_key": "test:main",
        "user_msg": user_msg,
        "assistant_msg": assistant_msg,
        "quality_score": quality_score,
    }


# ──────────────────────────────────────────────
# TestFineTuneFilter
# ──────────────────────────────────────────────

class TestFineTuneFilterApply:
    def test_passes_valid_conversation(self):
        f = FineTuneFilter()
        convs = [make_conv()]
        result = f.apply(convs)
        assert len(result) == 1

    def test_excludes_short_user_msg(self):
        """user_msg < 10자 제외."""
        f = FineTuneFilter()
        convs = [make_conv(user_msg="hi")]
        result = f.apply(convs)
        assert len(result) == 0

    def test_excludes_short_assistant_msg(self):
        """assistant_msg < 10자 제외."""
        f = FineTuneFilter()
        convs = [make_conv(assistant_msg="네.")]
        result = f.apply(convs)
        assert len(result) == 0

    def test_excludes_fallback_message(self):
        """fallback 메시지 포함 제외."""
        f = FineTuneFilter()
        convs = [make_conv(assistant_msg="잠깐, 생각을 정리 중이야... 조금만 기다려줘.")]
        result = f.apply(convs)
        assert len(result) == 0

    def test_excludes_null_quality(self):
        """quality_score=None 제외."""
        f = FineTuneFilter()
        convs = [make_conv(quality_score=None)]
        result = f.apply(convs)
        assert len(result) == 0

    def test_excludes_low_quality(self):
        """quality_score < 0.3 제외."""
        f = FineTuneFilter()
        convs = [make_conv(quality_score=0.2)]
        result = f.apply(convs)
        assert len(result) == 0

    def test_passes_exact_threshold(self):
        """quality_score = 0.3은 포함."""
        f = FineTuneFilter()
        convs = [make_conv(quality_score=0.3)]
        result = f.apply(convs)
        assert len(result) == 1

    def test_empty_list(self):
        f = FineTuneFilter()
        result = f.apply([])
        assert result == []

    def test_filters_multiple(self):
        f = FineTuneFilter()
        convs = [
            make_conv(user_msg="안녕하세요 타냐야!", quality_score=0.8),   # 통과
            make_conv(user_msg="ok", quality_score=0.8),                  # 제외 (짧음)
            make_conv(quality_score=0.1),                                  # 제외 (낮은 품질)
            make_conv(assistant_msg="잠깐, 생각을 정리 중이야 ❤️"),         # 제외 (fallback)
        ]
        result = f.apply(convs)
        assert len(result) == 1


class TestFineTuneFilterStats:
    def test_filter_stats_returns_dict(self):
        f = FineTuneFilter()
        stats = f.filter_stats(before=100, after=75)
        assert isinstance(stats, dict)

    def test_filter_stats_removal_rate(self):
        f = FineTuneFilter()
        stats = f.filter_stats(before=100, after=75)
        assert abs(stats["removal_rate"] - 0.25) < 0.001

    def test_filter_stats_zero_before(self):
        """before=0이면 removal_rate=0.0."""
        f = FineTuneFilter()
        stats = f.filter_stats(before=0, after=0)
        assert stats["removal_rate"] == 0.0

    def test_filter_stats_keys(self):
        f = FineTuneFilter()
        stats = f.filter_stats(before=50, after=30)
        assert "before" in stats
        assert "after" in stats
        assert "removed" in stats
        assert "removal_rate" in stats


# ──────────────────────────────────────────────
# TestFineTuneFormatter
# ──────────────────────────────────────────────

class TestFineTuneFormatterInstructionResponse:
    def test_produces_instruction_response_pairs(self):
        fmt = FineTuneFormatter()
        convs = [make_conv()]
        result = fmt.to_instruction_response(convs)
        assert len(result) == 1
        assert result[0]["instruction"] == convs[0]["user_msg"]
        assert result[0]["response"] == convs[0]["assistant_msg"]

    def test_empty_list(self):
        fmt = FineTuneFormatter()
        result = fmt.to_instruction_response([])
        assert result == []

    def test_multiple_rows(self):
        fmt = FineTuneFormatter()
        convs = [
            make_conv(user_msg="msg1", assistant_msg="resp1"),
            make_conv(user_msg="msg2", assistant_msg="resp2"),
        ]
        result = fmt.to_instruction_response(convs)
        assert len(result) == 2
        assert result[1]["instruction"] == "msg2"


class TestFineTuneFormatterChatML:
    def test_produces_chatml_format(self):
        fmt = FineTuneFormatter()
        convs = [make_conv()]
        result = fmt.to_chatml(convs)
        assert len(result) == 1
        messages = result[0]["messages"]
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == convs[0]["user_msg"]
        assert messages[1]["role"] == "assistant"
        assert messages[1]["content"] == convs[0]["assistant_msg"]

    def test_chatml_message_count(self):
        """각 대화당 2개 메시지 (user + assistant)."""
        fmt = FineTuneFormatter()
        convs = [make_conv(), make_conv()]
        result = fmt.to_chatml(convs)
        for item in result:
            assert len(item["messages"]) == 2

    def test_empty_list(self):
        fmt = FineTuneFormatter()
        result = fmt.to_chatml([])
        assert result == []


class TestFineTuneFormatterSaveJsonl:
    def test_saves_jsonl_file(self):
        fmt = FineTuneFormatter()
        data = [{"instruction": "hi", "response": "hello"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "output.jsonl")
            count = fmt.save_jsonl(data, path)
            assert count == 1
            assert os.path.exists(path)

    def test_jsonl_content_valid(self):
        fmt = FineTuneFormatter()
        data = [
            {"instruction": "msg1", "response": "resp1"},
            {"instruction": "msg2", "response": "resp2"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "output.jsonl")
            fmt.save_jsonl(data, path)
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            assert len(lines) == 2
            parsed = json.loads(lines[0])
            assert parsed["instruction"] == "msg1"

    def test_save_returns_line_count(self):
        fmt = FineTuneFormatter()
        data = [{"a": "b"}, {"c": "d"}, {"e": "f"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.jsonl")
            count = fmt.save_jsonl(data, path)
            assert count == 3

    def test_save_empty_list(self):
        fmt = FineTuneFormatter()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "empty.jsonl")
            count = fmt.save_jsonl([], path)
            assert count == 0

    def test_creates_parent_dirs(self):
        """중간 디렉토리가 없어도 생성."""
        fmt = FineTuneFormatter()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "subdir", "deep", "out.jsonl")
            fmt.save_jsonl([{"x": 1}], path)
            assert os.path.exists(path)
