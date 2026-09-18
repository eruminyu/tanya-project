"""운영 배포 자산의 필수 보안·경로 계약 테스트."""

from pathlib import Path


SERVICE_PATH = (
    Path(__file__).parents[3] / "deploy" / "systemd" / "kirian-brain.service"
)
AIVIS_SERVICE_PATH = (
    Path(__file__).parents[3]
    / "deploy"
    / "systemd"
    / "kirian-aivis-speech.service"
)
GPT_SOVITS_SERVICE_PATH = (
    Path(__file__).parents[3]
    / "deploy"
    / "systemd"
    / "kirian-gpt-sovits-cpufast.service"
)


def test_systemd_service_uses_dedicated_user():
    service = SERVICE_PATH.read_text(encoding="utf-8")

    assert "User=kirian" in service
    assert "Group=kirian" in service
    assert "User=root" not in service


def test_systemd_service_uses_operational_paths():
    service = SERVICE_PATH.read_text(encoding="utf-8")

    assert "WorkingDirectory=/home/kirian/brain" in service
    assert "EnvironmentFile=/home/kirian/brain/.env" in service
    assert "ReadWritePaths=/home/kirian/data/brain" in service


def test_systemd_service_has_minimum_hardening():
    service = SERVICE_PATH.read_text(encoding="utf-8")

    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "ProtectHome=read-only" in service
    assert "UMask=0077" in service


def test_systemd_service_restarts_after_failure():
    service = SERVICE_PATH.read_text(encoding="utf-8")

    assert "Restart=on-failure" in service
    assert "WantedBy=multi-user.target" in service


def test_aivis_service_runs_as_kirian_on_localhost_cpu():
    service = AIVIS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "User=kirian" in service
    assert "Group=kirian" in service
    assert "--host 127.0.0.1" in service
    assert "--port 10101" in service
    assert "--no-use_gpu" in service


def test_aivis_service_uses_installed_runtime_and_data_paths():
    service = AIVIS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "WorkingDirectory=/home/kirian/tts/aivis/runtime/Linux-x64" in service
    assert "Environment=XDG_DATA_HOME=/home/kirian/tts/aivis/data" in service
    assert "ReadWritePaths=/home/kirian/tts/aivis/data" in service


def test_aivis_service_has_minimum_hardening_and_restart_policy():
    service = AIVIS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "ProtectHome=read-only" in service
    assert "Restart=on-failure" in service
    assert "WantedBy=multi-user.target" in service


def test_brain_starts_after_aivis_service():
    service = SERVICE_PATH.read_text(encoding="utf-8")

    assert "Wants=network-online.target kirian-gpt-sovits-cpufast.service" in service
    assert "After=network-online.target kirian-gpt-sovits-cpufast.service" in service


def test_gpt_sovits_service_runs_as_kirian_on_localhost_cpu():
    service = GPT_SOVITS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "User=kirian" in service
    assert "Group=kirian" in service
    assert "Environment=CUDA_VISIBLE_DEVICES=-1" in service
    assert "-a 127.0.0.1" in service
    assert "-p 9881" in service


def test_gpt_sovits_service_uses_isolated_runtime_and_config():
    service = GPT_SOVITS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "WorkingDirectory=/home/kirian/tts/gpt-sovits-cpufast" in service
    assert "/home/kirian/miniforge3/envs/gpt-sovits-cpu/bin/python" in service
    assert "tts-infer-kirian-v2pro-cpu.yaml" in service


def test_gpt_sovits_service_waits_until_api_is_ready():
    service = GPT_SOVITS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "ExecStartPost=" in service
    assert "http://127.0.0.1:9881/openapi.json" in service
    assert 'kill -0 "$MAINPID"' in service


def test_gpt_sovits_service_has_minimum_hardening_and_restart_policy():
    service = GPT_SOVITS_SERVICE_PATH.read_text(encoding="utf-8")

    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "ProtectHome=read-only" in service
    assert (
        "ReadWritePaths=/home/kirian/tts/gpt-sovits-cpufast/"
        "tts-infer-kirian-v2pro-cpu.yaml"
    ) in service
    assert "Restart=on-failure" in service
    assert "WantedBy=multi-user.target" in service
