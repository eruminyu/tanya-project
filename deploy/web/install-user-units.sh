#!/usr/bin/env bash
# Registers the three public-demo services as *user* systemd units for the kirian account (no root needed):
# kirian-qwen3-tts, kirian-public-brain, kirian-web-gateway. Requires `loginctl enable-linger kirian` so the
# units survive logout and start at boot. The system-unit files under deploy/ stay the reference for a root
# installation; these derive from them without User=/Group= and without the mount-namespace hardening that
# unprivileged user managers cannot apply. Re-run after each release to refresh and restart.
set -euo pipefail

HOME_DIR="${HOME:?}"
UNITS="$HOME_DIR/.config/systemd/user"
mkdir -p "$UNITS"
umask 077

cat > "$UNITS/kirian-qwen3-tts.service" <<EOF
[Unit]
Description=Kirian Qwen3-TTS preset voice (Sohee, loopback only) [user unit]
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$HOME_DIR/tts/qwen3-tts
EnvironmentFile=$HOME_DIR/tts/qwen3-tts/qwen3-tts.env
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=HF_HOME=$HOME_DIR/tts/qwen3-tts/hf
Environment=HF_HUB_OFFLINE=1
Environment=TRANSFORMERS_OFFLINE=1
ExecStart=$HOME_DIR/.venvs/kirian-qwen3-tts/bin/python -X utf8 $HOME_DIR/tts/qwen3-tts/server.py
ExecStartPost=/bin/sh -c 'for attempt in \$(seq 1 180); do /usr/bin/kill -0 "\$MAINPID" || exit 1; /usr/bin/curl --fail --silent http://127.0.0.1:19882/health >/dev/null && exit 0; /bin/sleep 1; done; exit 1'
TimeoutStartSec=240
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGINT
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

cat > "$UNITS/kirian-public-brain.service" <<EOF
[Unit]
Description=Kirian public demo Brain (stateless, loopback only) [user unit]
After=network.target kirian-qwen3-tts.service
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$HOME_DIR/kirian-web/current/brain
EnvironmentFile=$HOME_DIR/kirian-web/brain.env
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONPATH=$HOME_DIR/kirian-web/current/brain
# Visitor conversations live only under the user runtime dir (tmpfs), recreated on every start.
RuntimeDirectory=kirian-public-brain
RuntimeDirectoryMode=0700
Environment=KIRIAN_V1_DATA_DIR=%t/kirian-public-brain
ExecStart=$HOME_DIR/.venvs/kirian-public-brain/bin/python -X utf8 -m uvicorn rearchitecture.app:create_app --factory --host 127.0.0.1 --port 8099 --workers 1 --no-access-log --log-level warning --timeout-graceful-shutdown 20
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGINT
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

cat > "$UNITS/kirian-web-gateway.service" <<EOF
[Unit]
Description=Kirian public web gateway (static web + visitor sessions) [user unit]
After=network.target kirian-public-brain.service
Wants=kirian-public-brain.service
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$HOME_DIR/kirian-web/current
EnvironmentFile=$HOME_DIR/kirian-web/gateway.env
ExecStart=$HOME_DIR/.local/node/bin/node $HOME_DIR/kirian-web/current/gateway/gateway.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillSignal=SIGTERM
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable kirian-qwen3-tts.service kirian-public-brain.service kirian-web-gateway.service >/dev/null
systemctl --user restart kirian-qwen3-tts.service
systemctl --user restart kirian-public-brain.service
systemctl --user restart kirian-web-gateway.service
sleep 3
systemctl --user --no-pager --no-legend list-units 'kirian-*'
echo "linger: $(loginctl show-user "$(id -un)" -p Linger --value)"
curl -s http://127.0.0.1:8090/demo/health; echo
