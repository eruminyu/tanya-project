from pydantic import BaseModel, Field
from enum import Enum
from typing import Optional


class EmotionType(str, Enum):
    NEUTRAL = "neutral"
    HAPPY = "happy"
    SAD = "sad"
    EXCITED = "excited"
    WORRIED = "worried"
    ANNOYED = "annoyed"
    AFFECTIONATE = "affectionate"


class UserMessage(BaseModel):
    """클라이언트에서 수신하는 메시지"""
    type: str = Field(default="text", description="메시지 타입: text, vision")
    content: Optional[str] = Field(default=None, description="텍스트 내용")
    image: Optional[str] = Field(default=None, description="Base64 인코딩 이미지")
    session_id: Optional[str] = Field(default=None, description="세션 ID")


class EmotionState(BaseModel):
    """타냐의 현재 감정 상태"""
    type: EmotionType = Field(default=EmotionType.NEUTRAL)
    intensity: float = Field(default=0.5, ge=0.0, le=1.0)


class TanyaResponse(BaseModel):
    """서버에서 클라이언트로 보내는 응답"""
    type: str = Field(default="response")
    content: str = Field(description="텍스트 응답")
    audio: str = Field(default="", description="Base64 인코딩 오디오")
    emotion: EmotionState = Field(default_factory=EmotionState)
    animation_intent: str = Field(default="idle", description="Unity 애니메이션 인텐트")
    conv_id: Optional[int] = Field(default=None, description="DB 대화 row id (피드백용)")


class ConversationTurn(BaseModel):
    """대화 한 턴 (사용자 입력 + 타냐 응답)"""
    user_message: str
    assistant_message: str
    emotion: EmotionState = Field(default_factory=EmotionState)
    timestamp: Optional[str] = None


class MemoryRecord(BaseModel):
    """장기 기억 레코드 (LongTermMemory 검색 결과)"""
    id: int
    content: str
    category: str = Field(default="episodic")
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    created_at: str
    relevance_score: float = Field(default=0.0, ge=0.0, le=1.0)
