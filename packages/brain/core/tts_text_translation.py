"""TTS용 문장을 대상 언어로 번역한다."""

import re
from typing import Any


class TtsTextTranslationError(RuntimeError):
    """TTS에 사용할 수 있는 번역을 얻지 못했다."""


class TtsTextTranslator:
    """한국어 화면 문장을 일본어 TTS 문장으로 변환한다."""

    _SYSTEM_PROMPT = (
        "너는 TTS용 한국어-일본어 번역기다. "
        "입력의 의미, 말투, 감정을 자연스러운 일본어 구어체로 유지해라. "
        "번역문만 출력하고 설명, 태그, 마크다운, 따옴표를 추가하지 마라."
    )
    _STRICT_RETRY_PROMPT = (
        _SYSTEM_PROMPT
        + " 이전 번역에 한국어가 섞였다. 한글을 하나도 사용하지 말고 일본어만 출력해라."
    )
    _HANGUL_PATTERN = re.compile(r"[\uac00-\ud7a3]")
    _JAPANESE_PATTERN = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")

    def __init__(self, llm: Any, target_language: str = ""):
        self._llm = llm
        self.target_language = (
            target_language.strip().lower()
            if isinstance(target_language, str)
            else ""
        )

    async def translate(self, text: str) -> str:
        if not self.target_language:
            return text
        if self.target_language != "ja":
            raise TtsTextTranslationError(
                f"지원하지 않는 TTS 대상 언어: {self.target_language}"
            )

        for prompt in (self._SYSTEM_PROMPT, self._STRICT_RETRY_PROMPT):
            translated = await self._llm.chat(
                user_input=text,
                system_prompt=prompt,
                history=[],
            )
            cleaned = self._clean(translated)
            if self._is_valid_japanese(cleaned):
                return cleaned

        raise TtsTextTranslationError("유효한 일본어 번역을 얻지 못했습니다.")

    @staticmethod
    def _clean(text: str) -> str:
        cleaned = re.sub(r"</?(?:ko|ja)>", "", text).strip()
        return cleaned.strip("`\"'").strip()

    @classmethod
    def _is_valid_japanese(cls, text: str) -> bool:
        return bool(
            text
            and cls._JAPANESE_PATTERN.search(text)
            and not cls._HANGUL_PATTERN.search(text)
        )
