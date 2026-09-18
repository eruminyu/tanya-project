"""Entry point: loads the pinned Qwen3-TTS CustomVoice model once and serves qwen3_tts_service on loopback.

Environment (see kirian-qwen3-tts.service and README.md):
  KIRIAN_QWEN3_TTS_MODEL     HF id or local snapshot path (default Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
  KIRIAN_QWEN3_TTS_DEVICE    cuda:0 | cpu
  KIRIAN_QWEN3_TTS_DTYPE     bfloat16 | float32
  KIRIAN_QWEN3_TTS_SPEAKERS  comma-separated preset speakers allowed (default Sohee)
  KIRIAN_QWEN3_TTS_HOST/PORT default 127.0.0.1:19882
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import torch  # noqa: E402
from qwen_tts import Qwen3TTSModel  # noqa: E402

from qwen3_tts_service import SpeechRequest, SpeechService, serve, settings_from_env  # noqa: E402


def load(settings: dict):
    dtype = {"bfloat16": torch.bfloat16, "float32": torch.float32}[settings["dtype"]]
    model = Qwen3TTSModel.from_pretrained(settings["model"], device_map=settings["device"], dtype=dtype)
    release_cache = settings["device"].startswith("cuda") and torch.cuda.is_available()

    def synthesize(request: SpeechRequest):
        torch.manual_seed(request.seed)
        with torch.inference_mode():
            wavs, sample_rate = model.generate_custom_voice(
                text=request.text, speaker=request.speaker, language=request.language, instruct=request.instruct,
            )
        # The GPU is shared with Ollama (8 GB): PyTorch's caching allocator otherwise keeps ~1 GB of freed
        # activations reserved (measured 2.4 GB after load → 3.2 GB in service), which pushes half of the
        # Gemma weights to the CPU. Releasing it after every clip costs milliseconds.
        if release_cache:
            torch.cuda.empty_cache()
        return wavs[0], int(sample_rate)

    return synthesize


def main() -> None:
    settings = settings_from_env()
    service = SpeechService(load(settings), settings["speakers"], model=settings["model"], device=settings["device"])
    server = serve(service, settings["host"], settings["port"])
    print(f"kirian-qwen3-tts ready on http://{settings['host']}:{settings['port']} model={settings['model']} device={settings['device']} speakers={','.join(settings['speakers'])}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
