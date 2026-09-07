"""화면 출력은 유지하면서 TTS에 적합한 문장과 감정 톤을 만든다."""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class PreparedTtsText:
    text: str
    tone: str = ""


_TONE_EMOJI = {
    "affection": frozenset("❤♥💕💖💗💓💞💘💝🥰😍😘"),
    "strict": frozenset("😠😡🤬😤🙄"),
    "reaction": frozenset("😮😲🤯😱😂🤣😆🔥"),
    "cheer": frozenset("😀😃😄😁😊🙂🎉👏💪👍✨⭐🌟"),
}

# 이모지 블록, variation selector, skin tone, ZWJ와 keycap 결합 문자를 제거한다.
_EMOJI_PATTERN = re.compile(
    "["
    "\U0001F1E6-\U0001F1FF"
    "\U0001F300-\U0001FAFF"
    "\u2600-\u27BF"
    "\u2300-\u23FF"
    "]"
)
_EMOJI_MODIFIER_PATTERN = re.compile(r"[\u200d\ufe0e\ufe0f\u20e3\U0001F3FB-\U0001F3FF]")
TTS_SENTENCE_END_PATTERN = re.compile(
    r"(?:[.?!]+(?:\s*[\U0001F1E6-\U0001FAFF\u2300-\u27BF"
    r"\u200d\ufe0e\ufe0f\u20e3]*)?|\n)\s*"
)


def prepare_tts_text(text: str) -> PreparedTtsText:
    """이모지를 발음 대상에서 제거하고 가장 적합한 참조 음성 톤을 반환한다."""
    tone = ""
    for candidate, emojis in _TONE_EMOJI.items():
        if any(emoji in text for emoji in emojis):
            tone = candidate
            break

    cleaned = _EMOJI_PATTERN.sub("", text)
    cleaned = _EMOJI_MODIFIER_PATTERN.sub("", cleaned)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\s+([,.?!])", r"\1", cleaned).strip()
    return PreparedTtsText(text=cleaned, tone=tone)
