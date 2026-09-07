"""Phase 7: LLM QLoRA 파인튜닝 파이프라인.

- train.py   — QLoRA 학습 (unsloth 기반, RTX 3070 Ti 8GB 서버용)
- export.py  — LoRA 어댑터 → GGUF 변환 (llama.cpp 필요)
- register.py — GGUF → Ollama 커스텀 모델 등록
- eval.py    — 파인튜닝 전후 응답 품질 비교
"""
