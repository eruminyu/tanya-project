#!/usr/bin/env bash
# Prepares the Qwen3-TTS voice service under the kirian account without touching the existing GPT-SoVITS
# folders, venvs or units: isolated venv, offline model snapshot, service folder. Root is only needed for the
# systemd registration printed at the end. Run from a checkout or release that contains deploy/qwen3-tts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:?}"
BASE="$HOME_DIR/tts/qwen3-tts"
VENV="$HOME_DIR/.venvs/kirian-qwen3-tts"
PYTHON="${KIRIAN_PYTHON:-python3.12}"
MODEL="${KIRIAN_QWEN3_TTS_MODEL:-Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice}"

umask 077
mkdir -p "$BASE"
if [ ! -x "$VENV/bin/python" ]; then "$PYTHON" -m venv "$VENV"; fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet --index-url https://download.pytorch.org/whl/cu128 "torch==2.11.0" "torchaudio==2.11.0"
"$VENV/bin/python" -m pip install --quiet -r "$HERE/requirements.txt"
"$VENV/bin/python" -c "import torch, qwen_tts, transformers; print('qwen3-tts deps ok torch', torch.__version__, 'cuda', torch.cuda.is_available())"

# Model snapshot into the service's own HF cache. The unit runs offline afterwards, and qwen-tts still asks the
# Hub when given a repo id, so the env file points KIRIAN_QWEN3_TTS_MODEL at the resolved local snapshot path.
SNAPSHOT="$(HF_HOME="$BASE/hf" "$VENV/bin/python" - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
# The CustomVoice snapshot already contains the speech_tokenizer/ (Qwen3-TTS-Tokenizer-12Hz) weights.
print(snapshot_download(sys.argv[1]))
PY
)"
echo "$MODEL -> $SNAPSHOT"

install -m 0600 "$HERE/server.py" "$BASE/server.py"
install -m 0600 "$HERE/qwen3_tts_service.py" "$BASE/qwen3_tts_service.py"
install -m 0600 "$HERE/measure.py" "$BASE/measure.py"
[ -f "$BASE/qwen3-tts.env" ] || install -m 0600 "$HERE/qwen3-tts.env.example" "$BASE/qwen3-tts.env"
sed -i "s#^KIRIAN_QWEN3_TTS_MODEL=.*#KIRIAN_QWEN3_TTS_MODEL=$SNAPSHOT#" "$BASE/qwen3-tts.env"
chmod -R u+rX,go-rwx "$BASE"

cat <<MSG
prepared: $BASE (venv $VENV, model $MODEL)
administrator, once:
  sudo cp $HERE/kirian-qwen3-tts.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now kirian-qwen3-tts.service
  curl -s http://127.0.0.1:19882/health
then measure on this machine: $VENV/bin/python $BASE/measure.py --runs 2 --out $BASE/measure.json
MSG
