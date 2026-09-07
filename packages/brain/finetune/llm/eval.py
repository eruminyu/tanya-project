"""Phase 7: 파인튜닝 전후 응답 품질 비교.

파인튜닝 전 모델과 후 모델에 동일한 프롬프트를 전송해
응답 길이, 타냐 페르소나 특성 등을 비교하는 간단한 평가 도구.

외부 API 없이 Ollama generate 엔드포인트만 사용한다.

사용 예:
    python -m finetune.llm.eval \\
        --before qwen2.5:7b \\
        --after tanya-v2 \\
        --output eval_report.json
"""
from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error
from dataclasses import asdict, dataclass, field

logger = logging.getLogger(__name__)


# 타냐 페르소나 평가용 기본 프롬프트 5개
DEFAULT_EVAL_PROMPTS: list[str] = [
    "안녕! 오늘 기분이 어때?",
    "나 요즘 너무 힘든데, 타냐가 위로해줘.",
    "파이썬에서 딕셔너리 사용법 간단히 설명해줘.",
    "오늘 밥 뭐 먹었어?",
    "자기야, 나 오늘 발표 잘 할 수 있을까?",
]


@dataclass
class EvalResult:
    """평가 결과 데이터."""

    before_model: str
    after_model: str
    prompts: list[str]
    before_responses: list[str]
    after_responses: list[str]
    score: dict = field(default_factory=dict)


class FineTuneEvaluator:
    """파인튜닝 전후 모델 응답을 비교 평가한다."""

    def __init__(
        self,
        ollama_url: str = "http://localhost:11434",
        before_model: str = "qwen2.5:7b",
        after_model: str = "tanya-v1",
    ) -> None:
        self._url = ollama_url.rstrip("/")
        self._before = before_model
        self._after = after_model

    def _generate(self, model: str, prompt: str) -> str:
        """Ollama generate 엔드포인트를 호출해 응답을 받는다."""
        payload = json.dumps({
            "model": model,
            "prompt": prompt,
            "stream": False,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self._url}/api/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                return data.get("response", "")
        except Exception as e:
            logger.warning(f"Ollama 호출 실패 ({model}): {e}")
            return ""

    def run_prompts(self, prompts: list[str] | None = None) -> EvalResult:
        """두 모델에 프롬프트를 실행하고 EvalResult를 반환한다.

        Args:
            prompts: 평가 프롬프트 목록. None이면 DEFAULT_EVAL_PROMPTS 사용.

        Returns:
            EvalResult (before/after 응답 + 점수 포함)
        """
        if prompts is None:
            prompts = DEFAULT_EVAL_PROMPTS

        before_responses = []
        after_responses = []

        for prompt in prompts:
            logger.info(f"평가 중: {prompt[:30]}...")
            before_responses.append(self._generate(self._before, prompt))
            after_responses.append(self._generate(self._after, prompt))

        score = self.score_responses(before_responses, after_responses)

        return EvalResult(
            before_model=self._before,
            after_model=self._after,
            prompts=prompts,
            before_responses=before_responses,
            after_responses=after_responses,
            score=score,
        )

    def score_responses(
        self,
        before_responses: list[str],
        after_responses: list[str],
    ) -> dict:
        """응답 품질을 간단한 지표로 채점한다.

        지표:
        - before/after 평균 응답 길이
        - 타냐 페르소나 키워드 포함 횟수 (자기야, 사용자, ❤️, ~야 등)

        Returns:
            {
                "before_avg_length": float,
                "after_avg_length": float,
                "before_persona_hits": int,
                "after_persona_hits": int,
            }
        """
        _PERSONA_KEYWORDS = ["자기야", "사용자", "❤️", "데모 사용자", "~야", "야~", "타냐"]

        def avg_length(responses: list[str]) -> float:
            if not responses:
                return 0.0
            return sum(len(r) for r in responses) / len(responses)

        def persona_hits(responses: list[str]) -> int:
            count = 0
            for r in responses:
                for kw in _PERSONA_KEYWORDS:
                    if kw in r:
                        count += 1
            return count

        return {
            "before_avg_length": avg_length(before_responses),
            "after_avg_length": avg_length(after_responses),
            "before_persona_hits": persona_hits(before_responses),
            "after_persona_hits": persona_hits(after_responses),
        }

    def save_report(self, result: EvalResult, output_path: str) -> None:
        """평가 결과를 JSON 파일로 저장한다."""
        import os
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(asdict(result), f, ensure_ascii=False, indent=2)
        logger.info(f"평가 리포트 저장: {output_path}")


# ── CLI 진입점 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="파인튜닝 전후 품질 비교")
    parser.add_argument("--before", required=True, help="파인튜닝 전 모델 이름")
    parser.add_argument("--after", required=True, help="파인튜닝 후 모델 이름")
    parser.add_argument("--output", default="eval_report.json", help="리포트 저장 경로")
    parser.add_argument("--ollama_url", default="http://localhost:11434")
    args = parser.parse_args()

    ev = FineTuneEvaluator(
        ollama_url=args.ollama_url,
        before_model=args.before,
        after_model=args.after,
    )

    print(f"평가 시작: {args.before} vs {args.after}")
    result = ev.run_prompts()
    ev.save_report(result, args.output)

    print(f"\n=== 평가 결과 ===")
    print(f"평균 응답 길이: {args.before} = {result.score['before_avg_length']:.1f}자")
    print(f"평균 응답 길이: {args.after} = {result.score['after_avg_length']:.1f}자")
    print(f"페르소나 키워드: {args.before} = {result.score['before_persona_hits']}회")
    print(f"페르소나 키워드: {args.after} = {result.score['after_persona_hits']}회")
    print(f"\n리포트 저장: {args.output}")
