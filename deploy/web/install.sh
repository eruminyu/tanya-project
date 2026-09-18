#!/usr/bin/env bash
# Installs one reviewed web-demo release under the kirian account. No root: it prepares a user-local Node
# runtime, a Python venv for the public Brain, the release folder and the secrets, then prints the two
# systemd commands an administrator runs once. Existing services and homes are not touched.
set -euo pipefail

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:?}"
BASE="$HOME_DIR/kirian-web"
NODE_VERSION="${KIRIAN_NODE_VERSION:-v24.21.0}"
NODE_DIR="$HOME_DIR/.local/node"
VENV="$HOME_DIR/.venvs/kirian-public-brain"
PYTHON="${KIRIAN_PYTHON:-python3.12}"

echo "release: $RELEASE_DIR"
[ -f "$RELEASE_DIR/SHA256SUMS" ] || { echo "SHA256SUMS missing; refusing an unreviewed release" >&2; exit 1; }
(cd "$RELEASE_DIR" && sha256sum --quiet -c SHA256SUMS)

# 1. Node runtime (user-local, official tarball, checksum verified against the published SHASUMS256.txt).
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" --version)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  echo "downloading Node $NODE_VERSION"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR.new" && mkdir -p "$NODE_DIR.new"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf "$tmp"
fi
echo "node: $("$NODE_DIR/bin/node" --version)"

# 2. Python venv for the public Brain (pinned requirements + the shared contracts package from the release).
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$RELEASE_DIR/brain/requirements-v1.txt"
"$VENV/bin/python" -m pip install --quiet "$RELEASE_DIR/contracts"
"$VENV/bin/python" -c "import fastapi, uvicorn, httpx, kirian_contracts; print('python deps ok')"

# 3. Release folder and the `current` link.
umask 077
mkdir -p "$BASE/releases"
name="$(basename "$RELEASE_DIR")"
target="$BASE/releases/$name"
if [ ! -d "$target" ]; then cp -r "$RELEASE_DIR" "$target"; fi
ln -sfn "$target" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
chmod -R u+rX,go-rwx "$target"

# 4. Secrets and settings: created once, never overwritten.
if [ ! -f "$BASE/brain-token" ]; then
  "$PYTHON" -c "import secrets; print(secrets.token_hex(32))" > "$BASE/brain-token"
fi
chmod 600 "$BASE/brain-token"
if [ ! -f "$BASE/brain.env" ]; then
  { cat "$RELEASE_DIR/deploy/brain.env.example"; echo "KIRIAN_V1_TOKEN=$(cat "$BASE/brain-token")"; } > "$BASE/brain.env"
fi
[ -f "$BASE/gateway.env" ] || cp "$RELEASE_DIR/deploy/gateway.env.example" "$BASE/gateway.env"
[ -f "$BASE/public-host.json" ] || cp "$RELEASE_DIR/deploy/public-host.json" "$BASE/public-host.json"
chmod 600 "$BASE/brain.env" "$BASE/gateway.env" "$BASE/public-host.json"
# 5. The Brain app and its config must import/load with this venv before any service is registered.
( cd "$target/brain" && PYTHONPATH="$target/brain" "$VENV/bin/python" -X utf8 -c "import rearchitecture.app; print('brain app import ok')" )
( cd "$target/brain" && KIRIAN_V1_TOKEN="$(cat "$BASE/brain-token")" KIRIAN_V1_CONFIG_FILE="$BASE/public-host.json" PYTHONPATH="$target/brain" \
  "$VENV/bin/python" -X utf8 -c "from rearchitecture.config import V1Config; c=V1Config.from_env(); print('brain config ok:', c.identity['mode'], [b.label for b in c.bindings], 'speech' if c.speech else 'no speech')" )

cat <<EOF

Release installed at $target (current -> $(readlink "$BASE/current")).
Administrator step (once; re-run daemon-reload + restart after later releases):

  sudo cp $target/deploy/kirian-public-brain.service $target/deploy/kirian-web-gateway.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now kirian-public-brain.service kirian-web-gateway.service
  curl -s http://127.0.0.1:8090/demo/health

Then route the public domain to port 8090 on this host.
EOF
