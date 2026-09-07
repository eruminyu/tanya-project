"""Phase 7-A: 파인튜닝 데이터 포맷터.

대화 데이터를 instruction-response 페어 또는 ChatML 형식의 JSONL로 변환한다.
"""
from __future__ import annotations

import json
import os


class FineTuneFormatter:
    """학습 데이터를 다양한 포맷으로 변환하고 JSONL 파일로 저장한다."""

    def to_instruction_response(self, conversations: list[dict]) -> list[dict]:
        """Alpaca 스타일 instruction-response 페어 생성.

        Returns:
            [{"instruction": user_msg, "response": assistant_msg}, ...]
        """
        return [
            {
                "instruction": conv["user_msg"],
                "response": conv["assistant_msg"],
            }
            for conv in conversations
        ]

    def to_chatml(self, conversations: list[dict]) -> list[dict]:
        """ChatML 형식으로 변환.

        Returns:
            [{"messages": [{"role": "user", "content": ...}, {"role": "assistant", "content": ...}]}, ...]
        """
        return [
            {
                "messages": [
                    {"role": "user", "content": conv["user_msg"]},
                    {"role": "assistant", "content": conv["assistant_msg"]},
                ]
            }
            for conv in conversations
        ]

    def save_jsonl(self, data: list[dict], output_path: str) -> int:
        """데이터를 JSONL 파일로 저장한다.

        Args:
            data: 저장할 dict 리스트
            output_path: 출력 파일 경로 (중간 디렉토리 자동 생성)

        Returns:
            저장된 라인 수
        """
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            for item in data:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
        return len(data)
