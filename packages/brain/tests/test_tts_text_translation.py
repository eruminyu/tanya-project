"""TTS용 한국어-일본어 문장 번역 테스트."""

from unittest.mock import AsyncMock

import pytest

from core.tts_text_translation import TtsTextTranslationError, TtsTextTranslator


class TestTtsTextTranslator:
    @pytest.mark.asyncio
    async def test_disabled_target_returns_original_text(self):
        llm = AsyncMock()
        translator = TtsTextTranslator(llm, target_language="")

        assert await translator.translate("안녕.") == "안녕."
        llm.chat.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_translates_korean_sentence_to_japanese(self):
        llm = AsyncMock()
        llm.chat.return_value = "  今日もお疲れ様。  "
        translator = TtsTextTranslator(llm, target_language="ja")

        result = await translator.translate("오늘도 수고했어.")

        assert result == "今日もお疲れ様。"
        assert llm.chat.await_args.kwargs["history"] == []

    @pytest.mark.asyncio
    async def test_retries_once_when_translation_contains_korean(self):
        llm = AsyncMock()
        llm.chat.side_effect = ["今日도 수고했어.", "今日もお疲れ様。"]
        translator = TtsTextTranslator(llm, target_language="ja")

        result = await translator.translate("오늘도 수고했어.")

        assert result == "今日もお疲れ様。"
        assert llm.chat.await_count == 2

    @pytest.mark.asyncio
    async def test_rejects_invalid_translation_after_retry(self):
        llm = AsyncMock()
        llm.chat.side_effect = ["오늘도 수고했어.", "still korean 안녕"]
        translator = TtsTextTranslator(llm, target_language="ja")

        with pytest.raises(TtsTextTranslationError, match="일본어 번역"):
            await translator.translate("오늘도 수고했어.")
