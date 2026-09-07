"""Phase 7: GGUF 모델 → Ollama 커스텀 모델 등록.

Ollama의 Modelfile 생성 + `ollama create` subprocess 호출로
파인튜닝된 GGUF를 로컬 Ollama에 커스텀 모델로 등록한다.

등록 성공 시 settings의 local_llm_model을 새 모델명으로 업데이트하면
다음 대화부터 자동으로 파인튜닝된 모델이 사용된다.

사용 예:
    python -m finetune.llm.register \\
        --gguf_path finetune_data/gguf/tanya_20260319.gguf \\
        --model_name tanya-v2 \\
        --system_prompt "너는 타냐야..."
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)


class OllamaRegistrar:
    """GGUF 모델을 Ollama에 커스텀 모델로 등록한다."""

    def __init__(self, ollama_url: str = "http://localhost:11434") -> None:
        self._url = ollama_url.rstrip("/")

    def is_available(self) -> bool:
        """Ollama 서버가 실행 중인지 확인한다."""
        try:
            with urllib.request.urlopen(f"{self._url}/api/version", timeout=3) as resp:
                resp.read()
            return True
        except Exception:
            return False

    def list_models(self) -> list[str]:
        """현재 Ollama에 등록된 모델 이름 목록을 반환한다."""
        try:
            with urllib.request.urlopen(f"{self._url}/api/tags", timeout=5) as resp:
                data = json.loads(resp.read())
            return [m["name"] for m in data.get("models", [])]
        except Exception:
            return []

    def create_modelfile(
        self,
        gguf_path: str,
        system_prompt: str,
        model_name: str,
        output_dir: str = ".",
    ) -> str:
        """Ollama Modelfile을 생성하고 경로를 반환한다.

        Args:
            gguf_path: GGUF 모델 파일 경로
            system_prompt: 타냐 시스템 프롬프트
            model_name: 등록할 모델 이름
            output_dir: Modelfile 저장 디렉토리

        Returns:
            생성된 Modelfile 경로
        """
        os.makedirs(output_dir, exist_ok=True)
        modelfile_path = os.path.join(output_dir, f"Modelfile.{model_name}")

        content = f"""FROM {gguf_path}

SYSTEM \"\"\"{system_prompt}\"\"\"

PARAMETER temperature 0.8
PARAMETER top_p 0.9
PARAMETER num_ctx 4096
"""
        Path(modelfile_path).write_text(content, encoding="utf-8")
        logger.info(f"Modelfile 생성: {modelfile_path}")
        return modelfile_path

    def register(self, modelfile_path: str, model_name: str) -> bool:
        """Modelfile을 사용해 Ollama에 모델을 등록한다.

        Args:
            modelfile_path: Modelfile 경로
            model_name: 등록할 모델 이름 (예: tanya-v2)

        Returns:
            성공 여부
        """
        cmd = ["ollama", "create", model_name, "-f", modelfile_path]
        logger.info(f"Ollama 모델 등록: {model_name}")
        result = subprocess.run(cmd, capture_output=True)

        if result.returncode != 0:
            logger.error(f"Ollama 등록 실패: {result.stderr.decode(errors='replace')}")
            return False

        logger.info(f"Ollama 모델 등록 완료: {model_name}")
        return True


# ── CLI 진입점 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="GGUF → Ollama 모델 등록")
    parser.add_argument("--gguf_path", required=True, help="GGUF 파일 경로")
    parser.add_argument("--model_name", required=True, help="등록할 모델 이름 (예: tanya-v2)")
    parser.add_argument("--system_prompt", default="", help="시스템 프롬프트")
    parser.add_argument("--ollama_url", default="http://localhost:11434")
    parser.add_argument("--output_dir", default="finetune_data/modelfiles")
    args = parser.parse_args()

    reg = OllamaRegistrar(ollama_url=args.ollama_url)

    if not reg.is_available():
        print("오류: Ollama 서버가 실행 중이지 않습니다.")
        raise SystemExit(1)

    modelfile = reg.create_modelfile(
        gguf_path=args.gguf_path,
        system_prompt=args.system_prompt,
        model_name=args.model_name,
        output_dir=args.output_dir,
    )

    success = reg.register(modelfile, model_name=args.model_name)
    if success:
        print(f"등록 완료: {args.model_name}")
        print(f"→ .env에서 LOCAL_LLM_MODEL={args.model_name} 으로 변경 후 타냐 재시작")
    else:
        print("등록 실패. 로그를 확인해주세요.")
        raise SystemExit(1)
