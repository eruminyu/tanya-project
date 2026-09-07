"""Phase 7: LoRA 어댑터 → GGUF 변환.

llama.cpp의 convert_lora_to_gguf.py 스크립트를 사용해
학습된 LoRA 어댑터를 GGUF 포맷으로 변환한다.

전제조건:
    - llama.cpp 레포가 로컬에 클론되어 있어야 함
    - llama-quantize 바이너리 빌드 완료

사용 예:
    python -m finetune.llm.export \\
        --adapter_dir finetune_data/adapters/tanya_20260319 \\
        --base_model qwen2.5:7b \\
        --output_path finetune_data/gguf/tanya_20260319.gguf \\
        --llama_cpp_dir /opt/llama.cpp
"""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

# llama.cpp의 변환 스크립트 후보 (버전별 파일명 다름)
_CONVERT_SCRIPT_CANDIDATES = [
    "convert_lora_to_gguf.py",
    "convert.py",
]


class GGUFExporter:
    """LoRA 어댑터를 GGUF 포맷으로 변환한다.

    llama.cpp 디렉토리 내 convert 스크립트를 subprocess로 호출한다.
    """

    def __init__(self, llama_cpp_dir: str = "/opt/llama.cpp") -> None:
        self._llama_cpp_dir = llama_cpp_dir

    def is_available(self) -> bool:
        """변환 가능 여부 확인 (llama.cpp 디렉토리 + 스크립트 존재)."""
        if not os.path.isdir(self._llama_cpp_dir):
            return False
        for script in _CONVERT_SCRIPT_CANDIDATES:
            if (Path(self._llama_cpp_dir) / script).exists():
                return True
        return False

    def _find_script(self) -> Path:
        """사용 가능한 변환 스크립트 경로를 반환한다."""
        for script in _CONVERT_SCRIPT_CANDIDATES:
            p = Path(self._llama_cpp_dir) / script
            if p.exists():
                return p
        raise RuntimeError(
            f"llama.cpp 변환 스크립트를 찾을 수 없습니다: {self._llama_cpp_dir}\n"
            "llama.cpp 레포를 클론하고 --llama_cpp_dir 경로를 지정해주세요."
        )

    def convert(
        self,
        adapter_dir: str,
        base_model: str,
        output_path: str,
        quant: str = "q4_k_m",
    ) -> str:
        """LoRA 어댑터를 GGUF로 변환한다.

        Args:
            adapter_dir: 학습된 LoRA 어댑터 디렉토리
            base_model: 베이스 모델 이름 또는 경로 (Ollama 모델명 또는 HF 경로)
            output_path: 출력 GGUF 파일 경로
            quant: 양자화 방식 (q4_k_m | q8_0 | f16)

        Returns:
            생성된 GGUF 파일 경로

        Raises:
            RuntimeError: llama.cpp 스크립트 없거나 변환 실패 시
        """
        if not self.is_available():
            raise RuntimeError(
                f"llama.cpp 변환 환경이 준비되지 않았습니다: {self._llama_cpp_dir}\n"
                "is_available()을 확인하거나 llama_cpp_dir 경로를 수정해주세요."
            )

        script = self._find_script()
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

        cmd = [
            "python",
            str(script),
            adapter_dir,
            "--base-model-id", base_model,
            "--outfile", output_path,
            "--outtype", quant,
        ]

        logger.info(f"GGUF 변환 시작: {adapter_dir} → {output_path} (quant={quant})")
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise RuntimeError(
                f"GGUF 변환 실패 (returncode={result.returncode})\n"
                f"stderr: {result.stderr}"
            )

        logger.info(f"GGUF 변환 완료: {output_path}")
        return output_path


# ── CLI 진입점 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="LoRA 어댑터 → GGUF 변환")
    parser.add_argument("--adapter_dir", required=True, help="LoRA 어댑터 디렉토리")
    parser.add_argument("--base_model", required=True, help="베이스 모델 이름/경로")
    parser.add_argument("--output_path", required=True, help="출력 GGUF 파일 경로")
    parser.add_argument("--llama_cpp_dir", default="/opt/llama.cpp", help="llama.cpp 디렉토리")
    parser.add_argument("--quant", default="q4_k_m", choices=["q4_k_m", "q8_0", "f16"])
    args = parser.parse_args()

    exporter = GGUFExporter(llama_cpp_dir=args.llama_cpp_dir)
    if not exporter.is_available():
        print(f"오류: llama.cpp를 찾을 수 없습니다: {args.llama_cpp_dir}")
        raise SystemExit(1)

    out = exporter.convert(
        adapter_dir=args.adapter_dir,
        base_model=args.base_model,
        output_path=args.output_path,
        quant=args.quant,
    )
    print(f"변환 완료: {out}")
