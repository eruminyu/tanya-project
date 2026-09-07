"""Phase 7: LLM QLoRA 학습 스크립트.

RTX 3070 Ti 8GB 서버에서 자동 실행되는 학습 파이프라인.
AutoFineTuneScheduler가 JSONL을 저장한 뒤 이 스크립트를 subprocess로 호출한다.

의존성 (requirements-finetune.txt):
    unsloth, trl, transformers, datasets, peft, bitsandbytes

사용 예:
    python -m finetune.llm.train \\
        --jsonl finetune_data/tanya_20260319.jsonl \\
        --output_dir finetune_data/adapters/tanya_20260319
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class TrainConfig:
    """QLoRA 학습 설정."""

    model_name: str
    output_dir: str
    max_seq_length: int = 2048
    r: int = 16                    # LoRA rank
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: list[str] = field(
        default_factory=lambda: ["q_proj", "k_proj", "v_proj", "o_proj",
                                  "gate_proj", "up_proj", "down_proj"]
    )
    epochs: int = 3
    batch_size: int = 2
    gradient_accumulation_steps: int = 4
    learning_rate: float = 2e-4
    warmup_steps: int = 10
    load_in_4bit: bool = True


class LLMFineTuner:
    """QLoRA 방식으로 LLM을 파인튜닝한다.

    unsloth가 설치되어 있어야 실제 학습이 가능하다.
    미설치 환경에서는 load_model() 또는 run() 호출 시 ImportError를 raise한다.
    """

    def __init__(self, config: TrainConfig) -> None:
        self._config = config
        self._model = None
        self._tokenizer = None

    def load_model(self):
        """unsloth로 모델을 4-bit 로드한다."""
        try:
            from unsloth import FastLanguageModel  # type: ignore
        except (ImportError, TypeError):
            raise ImportError(
                "unsloth가 설치되지 않았습니다. "
                "'pip install -r requirements-finetune.txt' 로 설치 후 재시도하세요."
            )

        self._model, self._tokenizer = FastLanguageModel.from_pretrained(
            model_name=self._config.model_name,
            max_seq_length=self._config.max_seq_length,
            dtype=None,
            load_in_4bit=self._config.load_in_4bit,
        )
        self._model = FastLanguageModel.get_peft_model(
            self._model,
            r=self._config.r,
            target_modules=self._config.target_modules,
            lora_alpha=self._config.lora_alpha,
            lora_dropout=self._config.lora_dropout,
            bias="none",
            use_gradient_checkpointing="unsloth",
        )
        return self._model, self._tokenizer

    def prepare_dataset(self, jsonl_path: str) -> list[dict]:
        """JSONL 파일에서 학습 데이터를 로드한다.

        Args:
            jsonl_path: instruction-response 페어 JSONL 경로

        Returns:
            dict 리스트 (각 항목: {"instruction": ..., "response": ...})

        Raises:
            FileNotFoundError: 파일이 존재하지 않을 때
        """
        import os
        if not os.path.exists(jsonl_path):
            raise FileNotFoundError(f"JSONL 파일을 찾을 수 없습니다: {jsonl_path}")

        data = []
        with open(jsonl_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    data.append(json.loads(line))
        return data

    def train(self, dataset: list[dict]) -> None:
        """SFTTrainer로 학습을 실행한다.

        load_model()이 먼저 호출되어야 한다.
        """
        if self._model is None or self._tokenizer is None:
            raise RuntimeError("load_model()을 먼저 호출해야 합니다.")

        try:
            from trl import SFTTrainer  # type: ignore
            from transformers import TrainingArguments  # type: ignore
            from datasets import Dataset  # type: ignore
        except ImportError as e:
            raise ImportError(f"학습 의존성 미설치: {e}. requirements-finetune.txt를 확인하세요.")

        hf_dataset = Dataset.from_list(dataset)

        trainer = SFTTrainer(
            model=self._model,
            tokenizer=self._tokenizer,
            train_dataset=hf_dataset,
            dataset_text_field="instruction",
            max_seq_length=self._config.max_seq_length,
            args=TrainingArguments(
                per_device_train_batch_size=self._config.batch_size,
                gradient_accumulation_steps=self._config.gradient_accumulation_steps,
                warmup_steps=self._config.warmup_steps,
                num_train_epochs=self._config.epochs,
                learning_rate=self._config.learning_rate,
                fp16=True,
                logging_steps=10,
                output_dir=self._config.output_dir,
                save_strategy="epoch",
            ),
        )
        trainer.train()

    def save_adapter(self) -> str:
        """학습된 LoRA 어댑터를 저장하고 경로를 반환한다."""
        if self._model is None:
            raise RuntimeError("load_model()을 먼저 호출해야 합니다.")
        self._model.save_pretrained(self._config.output_dir)
        if self._tokenizer is not None:
            self._tokenizer.save_pretrained(self._config.output_dir)
        logger.info(f"어댑터 저장 완료: {self._config.output_dir}")
        return self._config.output_dir

    def run(self, jsonl_path: str) -> str:
        """전체 파이프라인을 실행한다: 로드 → 데이터 준비 → 학습 → 저장.

        Returns:
            저장된 어댑터 디렉토리 경로
        """
        logger.info(f"QLoRA 학습 시작: {jsonl_path}")
        self.load_model()
        dataset = self.prepare_dataset(jsonl_path)
        if not dataset:
            raise ValueError("학습 데이터가 비어 있습니다.")
        logger.info(f"학습 데이터 {len(dataset)}개 로드 완료")
        self.train(dataset)
        return self.save_adapter()


# ── CLI 진입점 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="타냐 LLM QLoRA 파인튜닝")
    parser.add_argument("--jsonl", required=True, help="학습 데이터 JSONL 경로")
    parser.add_argument("--output_dir", required=True, help="어댑터 출력 디렉토리")
    parser.add_argument("--model", default="qwen2.5:7b", help="베이스 모델")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--r", type=int, default=16, help="LoRA rank")
    args = parser.parse_args()

    cfg = TrainConfig(
        model_name=args.model,
        output_dir=args.output_dir,
        epochs=args.epochs,
        r=args.r,
    )
    tuner = LLMFineTuner(cfg)
    adapter_dir = tuner.run(args.jsonl)
    print(f"학습 완료. 어댑터: {adapter_dir}")
