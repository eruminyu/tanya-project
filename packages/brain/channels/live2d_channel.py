"""Phase 6-B: Live2DChannel — Open-LLM-VTuber 호환 WebSocket 채널.

Open-LLM-VTuber 웹 클라이언트가 타냐 서버에 직접 연결할 수 있도록
프로토콜 변환 레이어를 제공한다.

Open-LLM-VTuber 프로토콜:
    수신: {"type": "text-input", "text": "...", "history_uid": "..."}
          {"type": "interrupt-signal"}   ← 무시
          {"type": "mic-audio-end", ...}  ← STT 미구현, error 응답

    송신: {"type": "control", "text": "conversation-chain-start"}
          {"type": "full-text", "text": "응답 텍스트"}
          {"type": "audio", "audio": "<base64>", "display_text": {...}, "actions": {...}, ...}
          {"type": "backend-synth-complete"}
          {"type": "control", "text": "conversation-chain-end"}
          {"type": "error", "message": "..."}
"""
from __future__ import annotations

import json

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from channels.base import Channel
from core.orchestrator import Orchestrator


class Live2DChannel(Channel):
    """Open-LLM-VTuber 클라이언트 전용 호환 채널.

    타냐 Orchestrator 응답을 Open-LLM-VTuber 프로토콜 메시지 시퀀스로 변환한다.
    """

    def __init__(self, orchestrator: Orchestrator, session_key: str = "") -> None:
        self._orch = orchestrator
        self._session_key = session_key

    async def handle(self, websocket: WebSocket) -> None:
        await websocket.accept()

        try:
            while True:
                raw_text = await websocket.receive_text()
                data = json.loads(raw_text)
                msg_type = data.get("type", "")

                if msg_type == "text-input":
                    await self._handle_text_input(websocket, data)
                elif msg_type == "interrupt-signal":
                    pass  # 현재는 처리 중 중단 불가 — 무시
                elif msg_type == "mic-audio-end":
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "mic-audio-end: STT is not yet supported on this server.",
                    }, ensure_ascii=False))
                else:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Unsupported message type: {msg_type}",
                    }, ensure_ascii=False))

        except WebSocketDisconnect:
            pass

    async def _handle_text_input(self, websocket: WebSocket, data: dict) -> None:
        """text-input 메시지를 처리하고 Open-LLM-VTuber 형식으로 응답한다."""
        text = data.get("text", "")

        # conversation-chain-start 신호
        await websocket.send_text(json.dumps({
            "type": "control",
            "text": "conversation-chain-start",
        }))

        # Orchestrator 호출 — 레거시 포맷으로 전달
        tanya_response = await self._orch.handle_message({"message": text})

        if tanya_response is None:
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": "No response from Tanya.",
            }, ensure_ascii=False))
            await websocket.send_text(json.dumps({
                "type": "control",
                "text": "conversation-chain-end",
            }))
            return

        # full-text 전송
        await websocket.send_text(json.dumps({
            "type": "full-text",
            "text": tanya_response.content,
        }, ensure_ascii=False))

        # audio 전송 (있을 경우 — 빈 문자열이면 생략)
        if tanya_response.audio:
            emotion_name = tanya_response.emotion.type.value
            await websocket.send_text(json.dumps({
                "type": "audio",
                "audio": tanya_response.audio,
                "display_text": {
                    "text": tanya_response.content,
                    "name": "Tanya",
                },
                "actions": {
                    "expressions": [emotion_name],
                },
                "volumes": [],
                "slice_length": 20,
            }, ensure_ascii=False))

        # backend-synth-complete 신호
        await websocket.send_text(json.dumps({"type": "backend-synth-complete"}))

        # conversation-chain-end 신호
        await websocket.send_text(json.dumps({
            "type": "control",
            "text": "conversation-chain-end",
        }))
