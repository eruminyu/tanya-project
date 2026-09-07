import pytest
from core.schemas import (
    UserMessage,
    TanyaResponse,
    EmotionState,
    EmotionType,
    ConversationTurn,
)


class TestUserMessage:
    def test_default_type(self):
        msg = UserMessage(content="안녕!")
        assert msg.type == "text"
        assert msg.content == "안녕!"

    def test_vision_type(self):
        msg = UserMessage(type="vision", image="base64data")
        assert msg.type == "vision"
        assert msg.image == "base64data"


class TestEmotionState:
    def test_default(self):
        state = EmotionState()
        assert state.type == EmotionType.NEUTRAL
        assert state.intensity == 0.5

    def test_custom(self):
        state = EmotionState(type=EmotionType.HAPPY, intensity=0.9)
        assert state.type == EmotionType.HAPPY
        assert state.intensity == 0.9

    def test_intensity_bounds(self):
        with pytest.raises(Exception):
            EmotionState(intensity=1.5)
        with pytest.raises(Exception):
            EmotionState(intensity=-0.1)


class TestTanyaResponse:
    def test_serialization(self):
        resp = TanyaResponse(
            content="안녕 사용자!",
            audio="base64audio",
            emotion=EmotionState(type=EmotionType.AFFECTIONATE, intensity=0.8),
            animation_intent="smile",
        )
        data = resp.model_dump()

        assert data["type"] == "response"
        assert data["content"] == "안녕 사용자!"
        assert data["emotion"]["type"] == "affectionate"
        assert data["animation_intent"] == "smile"

    def test_json_serialization(self):
        resp = TanyaResponse(content="테스트", audio="")
        json_str = resp.model_dump_json()
        assert "테스트" in json_str
        assert "emotion" in json_str

    def test_backward_compatible_fields(self):
        """기존 Unity 클라이언트가 파싱하는 필드가 있는지 확인."""
        resp = TanyaResponse(content="응답", audio="audio_data")
        data = resp.model_dump()
        assert "type" in data
        assert "content" in data
        assert "audio" in data


class TestConversationTurn:
    def test_creation(self):
        turn = ConversationTurn(
            user_message="질문",
            assistant_message="답변",
        )
        assert turn.user_message == "질문"
        assert turn.assistant_message == "답변"
        assert turn.emotion.type == EmotionType.NEUTRAL
