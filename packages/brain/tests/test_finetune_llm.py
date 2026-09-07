"""Phase 7: finetune/llm/ 파이프라인 테스트.

- LLMFineTuner: unsloth 미설치 시 ImportError, TrainConfig 유효성
- GGUFExporter: is_available() 경로 체크, convert 파라미터
- OllamaRegistrar: HTTP mock으로 list_models / is_available / register
- FineTuneEvaluator: mock 응답으로 score_responses, save_report
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ─── LLMFineTuner ─────────────────────────────────────────────────────────────

class TestTrainConfig:
    def test_default_config_values(self):
        from finetune.llm.train import TrainConfig
        cfg = TrainConfig(model_name="qwen2.5:7b", output_dir="/tmp/out")
        assert cfg.r == 16
        assert cfg.lora_alpha == 32
        assert cfg.max_seq_length == 2048
        assert cfg.epochs == 3
        assert cfg.batch_size == 2

    def test_custom_config_values(self):
        from finetune.llm.train import TrainConfig
        cfg = TrainConfig(
            model_name="llama3:8b",
            output_dir="/tmp/out",
            r=8,
            lora_alpha=16,
            epochs=5,
        )
        assert cfg.r == 8
        assert cfg.lora_alpha == 16
        assert cfg.epochs == 5

    def test_output_dir_stored(self):
        from finetune.llm.train import TrainConfig
        cfg = TrainConfig(model_name="test", output_dir="/custom/path")
        assert cfg.output_dir == "/custom/path"


class TestLLMFineTuner:
    def test_import_error_when_unsloth_missing(self):
        """unsloth 미설치 시 load_model()에서 ImportError 발생."""
        from finetune.llm.train import LLMFineTuner, TrainConfig
        cfg = TrainConfig(model_name="qwen2.5:7b", output_dir="/tmp/out")
        tuner = LLMFineTuner(cfg)
        with patch.dict("sys.modules", {"unsloth": None}):
            with pytest.raises((ImportError, RuntimeError)):
                tuner.load_model()

    def test_prepare_dataset_from_jsonl(self, tmp_path):
        """JSONL 파일에서 데이터셋 로드 성공."""
        from finetune.llm.train import LLMFineTuner, TrainConfig
        jsonl = tmp_path / "data.jsonl"
        lines = [
            {"instruction": "안녕?", "response": "안녕!"},
            {"instruction": "뭐해?", "response": "대화 중이지!"},
        ]
        with open(jsonl, "w", encoding="utf-8") as f:
            for line in lines:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")

        cfg = TrainConfig(model_name="test", output_dir=str(tmp_path))
        tuner = LLMFineTuner(cfg)
        dataset = tuner.prepare_dataset(str(jsonl))
        assert len(dataset) == 2

    def test_prepare_dataset_empty_file(self, tmp_path):
        """빈 JSONL → 빈 리스트 반환."""
        from finetune.llm.train import LLMFineTuner, TrainConfig
        jsonl = tmp_path / "empty.jsonl"
        jsonl.write_text("", encoding="utf-8")

        cfg = TrainConfig(model_name="test", output_dir=str(tmp_path))
        tuner = LLMFineTuner(cfg)
        dataset = tuner.prepare_dataset(str(jsonl))
        assert len(dataset) == 0

    def test_prepare_dataset_file_not_found(self, tmp_path):
        from finetune.llm.train import LLMFineTuner, TrainConfig
        cfg = TrainConfig(model_name="test", output_dir=str(tmp_path))
        tuner = LLMFineTuner(cfg)
        with pytest.raises(FileNotFoundError):
            tuner.prepare_dataset("/nonexistent/path.jsonl")

    def test_run_raises_without_gpu_when_unsloth_missing(self, tmp_path):
        """unsloth 없으면 run()도 ImportError/RuntimeError."""
        from finetune.llm.train import LLMFineTuner, TrainConfig
        jsonl = tmp_path / "data.jsonl"
        jsonl.write_text('{"instruction": "test", "response": "ok"}\n')
        cfg = TrainConfig(model_name="test", output_dir=str(tmp_path))
        tuner = LLMFineTuner(cfg)
        with patch.dict("sys.modules", {"unsloth": None}):
            with pytest.raises((ImportError, RuntimeError)):
                tuner.run(str(jsonl))


# ─── GGUFExporter ─────────────────────────────────────────────────────────────

class TestGGUFExporter:
    def test_is_available_false_when_dir_missing(self, tmp_path):
        from finetune.llm.export import GGUFExporter
        exporter = GGUFExporter(llama_cpp_dir=str(tmp_path / "nonexistent"))
        assert exporter.is_available() is False

    def test_is_available_false_when_script_missing(self, tmp_path):
        """디렉토리는 있지만 convert 스크립트 없을 때."""
        from finetune.llm.export import GGUFExporter
        exporter = GGUFExporter(llama_cpp_dir=str(tmp_path))
        assert exporter.is_available() is False

    def test_is_available_true_when_script_exists(self, tmp_path):
        """convert_lora_to_gguf.py 또는 convert.py가 있을 때."""
        from finetune.llm.export import GGUFExporter
        (tmp_path / "convert_lora_to_gguf.py").write_text("# mock")
        exporter = GGUFExporter(llama_cpp_dir=str(tmp_path))
        assert exporter.is_available() is True

    def test_convert_raises_when_not_available(self, tmp_path):
        from finetune.llm.export import GGUFExporter
        exporter = GGUFExporter(llama_cpp_dir=str(tmp_path / "missing"))
        with pytest.raises(RuntimeError, match="llama.cpp"):
            exporter.convert(
                adapter_dir=str(tmp_path),
                base_model="qwen2.5:7b",
                output_path=str(tmp_path / "out.gguf"),
            )

    def test_convert_calls_subprocess(self, tmp_path):
        """is_available() True 상태에서 subprocess 호출 확인."""
        from finetune.llm.export import GGUFExporter
        (tmp_path / "convert_lora_to_gguf.py").write_text("# mock")
        exporter = GGUFExporter(llama_cpp_dir=str(tmp_path))
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            exporter.convert(
                adapter_dir=str(tmp_path / "adapter"),
                base_model="qwen2.5:7b",
                output_path=str(tmp_path / "out.gguf"),
            )
            assert mock_run.called

    def test_quant_options(self, tmp_path):
        """quant 파라미터가 subprocess 명령에 포함되는지 확인."""
        from finetune.llm.export import GGUFExporter
        (tmp_path / "convert_lora_to_gguf.py").write_text("# mock")
        exporter = GGUFExporter(llama_cpp_dir=str(tmp_path))
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            exporter.convert(
                adapter_dir=str(tmp_path / "adapter"),
                base_model="qwen2.5:7b",
                output_path=str(tmp_path / "out.gguf"),
                quant="q8_0",
            )
            cmd = mock_run.call_args[0][0]
            assert "q8_0" in " ".join(str(c) for c in cmd)


# ─── OllamaRegistrar ──────────────────────────────────────────────────────────

class TestOllamaRegistrar:
    def test_is_available_true_on_200(self):
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar(ollama_url="http://localhost:11434")
        with patch("urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_resp.read.return_value = b'{"version": "0.3.0"}'
            mock_open.return_value = mock_resp
            assert reg.is_available() is True

    def test_is_available_false_on_error(self):
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar(ollama_url="http://localhost:11434")
        with patch("urllib.request.urlopen", side_effect=Exception("connection refused")):
            assert reg.is_available() is False

    def test_list_models_returns_names(self):
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar(ollama_url="http://localhost:11434")
        payload = json.dumps({"models": [{"name": "qwen2.5:7b"}, {"name": "tanya-v1"}]}).encode()
        with patch("urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_resp.read.return_value = payload
            mock_open.return_value = mock_resp
            models = reg.list_models()
            assert "qwen2.5:7b" in models
            assert "tanya-v1" in models

    def test_list_models_returns_empty_on_error(self):
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar()
        with patch("urllib.request.urlopen", side_effect=Exception("timeout")):
            assert reg.list_models() == []

    def test_create_modelfile_content(self, tmp_path):
        """Modelfile에 FROM, SYSTEM 지시어 포함 여부."""
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar()
        gguf_path = str(tmp_path / "tanya.gguf")
        modelfile_path = reg.create_modelfile(
            gguf_path=gguf_path,
            system_prompt="너는 타냐야.",
            model_name="tanya-v1",
            output_dir=str(tmp_path),
        )
        content = Path(modelfile_path).read_text(encoding="utf-8")
        assert "FROM" in content
        assert "SYSTEM" in content
        assert "타냐" in content

    def test_register_calls_ollama_create(self, tmp_path):
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar()
        modelfile = tmp_path / "Modelfile"
        modelfile.write_text("FROM ./test.gguf\n")
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = reg.register(str(modelfile), model_name="tanya-v1")
            assert result is True
            assert mock_run.called

    def test_register_returns_false_on_failure(self, tmp_path):
        from finetune.llm.register import OllamaRegistrar
        reg = OllamaRegistrar()
        modelfile = tmp_path / "Modelfile"
        modelfile.write_text("FROM ./test.gguf\n")
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr=b"error")
            result = reg.register(str(modelfile), model_name="tanya-v1")
            assert result is False


# ─── FineTuneEvaluator ────────────────────────────────────────────────────────

class TestFineTuneEvaluator:
    def test_score_responses_longer_after_wins(self):
        """파인튜닝 후 응답이 길면 score가 높아야 한다 (기본 지표)."""
        from finetune.llm.eval import FineTuneEvaluator
        ev = FineTuneEvaluator(
            ollama_url="http://localhost:11434",
            before_model="qwen2.5:7b",
            after_model="tanya-v1",
        )
        before_resp = ["짧아."] * 3
        after_resp = ["이것은 훨씬 더 길고 상세한 응답이야. 타냐 페르소나로 잘 대답하고 있어!"] * 3
        score = ev.score_responses(before_resp, after_resp)
        assert score["after_avg_length"] > score["before_avg_length"]

    def test_score_responses_equal_length(self):
        from finetune.llm.eval import FineTuneEvaluator
        ev = FineTuneEvaluator(
            ollama_url="http://localhost:11434",
            before_model="qwen2.5:7b",
            after_model="tanya-v1",
        )
        before_resp = ["동일한 길이의 응답."] * 3
        after_resp = ["동일한 길이의 응답."] * 3
        score = ev.score_responses(before_resp, after_resp)
        assert score["before_avg_length"] == score["after_avg_length"]

    def test_save_report_creates_json(self, tmp_path):
        from finetune.llm.eval import FineTuneEvaluator, EvalResult
        ev = FineTuneEvaluator(
            ollama_url="http://localhost:11434",
            before_model="qwen2.5:7b",
            after_model="tanya-v1",
        )
        result = EvalResult(
            before_model="qwen2.5:7b",
            after_model="tanya-v1",
            prompts=["안녕?"],
            before_responses=["안녕하세요."],
            after_responses=["안녕! 자기야~"],
            score={"before_avg_length": 6.0, "after_avg_length": 8.0},
        )
        output_path = str(tmp_path / "eval_report.json")
        ev.save_report(result, output_path)
        assert Path(output_path).exists()
        data = json.loads(Path(output_path).read_text(encoding="utf-8"))
        assert data["before_model"] == "qwen2.5:7b"
        assert data["after_model"] == "tanya-v1"

    def test_run_prompts_uses_ollama(self):
        """Ollama HTTP 호출 mock — 두 모델 응답 수집."""
        from finetune.llm.eval import FineTuneEvaluator
        ev = FineTuneEvaluator(
            ollama_url="http://localhost:11434",
            before_model="qwen2.5:7b",
            after_model="tanya-v1",
        )
        prompts = ["안녕?", "뭐해?"]

        def fake_generate(model, prompt):
            return f"{model}: {prompt}에 대한 응답"

        with patch.object(ev, "_generate", side_effect=fake_generate):
            result = ev.run_prompts(prompts)
            assert len(result.before_responses) == 2
            assert len(result.after_responses) == 2

    def test_default_prompts_exist(self):
        from finetune.llm.eval import FineTuneEvaluator, DEFAULT_EVAL_PROMPTS
        assert len(DEFAULT_EVAL_PROMPTS) >= 5
        assert any("타냐" in p or "안녕" in p for p in DEFAULT_EVAL_PROMPTS)
