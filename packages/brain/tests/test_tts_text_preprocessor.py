"""화면 텍스트와 TTS 입력을 분리하는 전처리 테스트."""

from core.tts_text_preprocessor import prepare_tts_text


def test_removes_emoji_but_preserves_visible_text():
    result = prepare_tts_text("오늘도 수고했어! 🥰✨")

    assert result.text == "오늘도 수고했어!"
    assert result.tone == "affection"


def test_emoji_only_text_is_skipped():
    result = prepare_tts_text("✨ 💕")

    assert result.text == ""
    assert result.tone == "affection"


def test_selects_reaction_tone_from_reaction_emoji():
    result = prepare_tts_text("진짜 성공했어? 🤯")

    assert result.text == "진짜 성공했어?"
    assert result.tone == "reaction"


def test_selects_strict_tone_from_angry_emoji():
    result = prepare_tts_text("이건 다시 확인해야 해. 😠")

    assert result.text == "이건 다시 확인해야 해."
    assert result.tone == "strict"


def test_selects_cheer_tone_from_celebration_emoji():
    result = prepare_tts_text("잘했어! 🎉")

    assert result.text == "잘했어!"
    assert result.tone == "cheer"


def test_without_emoji_uses_no_explicit_tone():
    result = prepare_tts_text("차근차근 설명해 줄게.")

    assert result.text == "차근차근 설명해 줄게."
    assert result.tone == ""


def test_removes_zwj_and_skin_tone_emoji_as_one_unit():
    result = prepare_tts_text("정말 잘했어 👩🏻‍💻👍🏽")

    assert result.text == "정말 잘했어"
    assert result.tone == "cheer"
