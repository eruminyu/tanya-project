"""설치된 Brain의 비밀 입력·준비 통지·부모 종료 계약을 검사한다."""
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import urllib.error
import urllib.request

import pytest

from rearchitecture.config import V1Config
from rearchitecture.desktop_entry import main, read_token


TOKEN = "a1" * 32


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for name in tuple(os.environ):
        if name.startswith("KIRIAN_V1_"):
            monkeypatch.delenv(name)


@pytest.mark.parametrize("payload", [
    b"", b"{}\n", b"[]\n", b"{\"token\":null}\n", b"not-json\n", b"\xff\n",
    json.dumps({"token": "a" * 63}).encode() + b"\n",
    json.dumps({"token": "z" * 64}).encode() + b"\n",
    json.dumps({"token": TOKEN, "path": "private"}).encode() + b"\n",
    json.dumps({"token": TOKEN}).encode(),
    b'{"token":"' + TOKEN.encode() + b'","token":"' + TOKEN.encode() + b'"}\n',
    b" " * 1024 + b"\n",
])
def test_rejects_malformed_or_unbounded_handshake(payload):
    with pytest.raises(ValueError):
        read_token(io.BytesIO(payload))


def test_handshake_reads_one_line_and_accepts_exactly_bounded_frame():
    frame = json.dumps({"token": TOKEN}).encode()
    stream = io.BytesIO(frame + b" " * (1023 - len(frame)) + b"\nremaining")
    assert read_token(stream) == TOKEN
    assert stream.read() == b"remaining"


def test_explicit_token_never_enters_environment(monkeypatch):
    monkeypatch.setenv("KIRIAN_V1_TOKEN", "legacy-secret-" * 4)
    config = V1Config.from_env(token=TOKEN)
    assert config.token == TOKEN
    assert os.environ["KIRIAN_V1_TOKEN"] == "legacy-secret-" * 4
    assert V1Config.from_env().token == "legacy-secret-" * 4


def test_validate_config_has_no_server_import_or_storage_side_effects(tmp_path, monkeypatch):
    directory = tmp_path / "not-created"
    monkeypatch.setenv("KIRIAN_V1_DATA_DIR", str(directory))
    monkeypatch.setitem(sys.modules, "rearchitecture.app", None)
    stdout, stderr = io.StringIO(), io.StringIO()
    assert main(["--validate-config"], stdin=io.BytesIO(json.dumps({"token": TOKEN}).encode() + b"\n"),
                stdout=stdout, stderr=stderr) == 0
    assert not directory.exists()
    assert "KIRIAN_V1_TOKEN" not in os.environ
    assert stdout.getvalue() == stderr.getvalue() == ""


def test_invalid_config_emits_only_generic_code(tmp_path, monkeypatch):
    config_path = tmp_path / "private-path-with-secret.json"
    config_path.write_text('{"secret":"do-not-log"}', encoding="utf-8")
    monkeypatch.setenv("KIRIAN_V1_CONFIG_FILE", str(config_path))
    stdout, stderr = io.StringIO(), io.StringIO()
    assert main(["--validate-config"], stdin=io.BytesIO(json.dumps({"token": TOKEN}).encode() + b"\n"),
                stdout=stdout, stderr=stderr) == 1
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == "brain_start_failed\n"


def test_unknown_arguments_never_echo_private_values():
    stdout, stderr = io.StringIO(), io.StringIO()
    assert main(["--secret", TOKEN], stdin=io.BytesIO(), stdout=stdout, stderr=stderr) == 1
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == "brain_start_failed\n"


def test_real_server_is_authenticated_before_ready_and_exits_on_parent_eof(tmp_path):
    brain_root = Path(__file__).resolve().parents[1]
    env = dict(os.environ, KIRIAN_V1_DATA_DIR=str(tmp_path / "data"),
               PYTHONPATH=os.pathsep.join((str(brain_root), str(brain_root.parent / "contracts" / "python"))))
    child = subprocess.Popen([sys.executable, "-m", "rearchitecture.desktop_entry"], cwd=tmp_path,
                             env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
    try:
        child.stdin.write(json.dumps({"token": TOKEN}).encode() + b"\n")
        child.stdin.flush()
        ready = json.loads(lines.get(timeout=20))
        assert set(ready) == {"type", "port"}
        assert ready["type"] == "ready" and type(ready["port"]) is int and 0 < ready["port"] < 65536
        url = f'http://127.0.0.1:{ready["port"]}/v1/config'
        with pytest.raises(urllib.error.HTTPError) as unauthorized:
            urllib.request.urlopen(url, timeout=5)
        assert unauthorized.value.code == 401
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOKEN})
        with urllib.request.urlopen(request, timeout=5) as response:
            data = json.load(response)
        assert data["identity"]["mode"] == "personal"
        assert list((tmp_path / "data").iterdir())
        child.stdin.close()
        assert child.wait(timeout=12) == 0
        assert child.stdout.read() == child.stderr.read() == b""
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()

@pytest.mark.skipif(os.name != "nt", reason="Windows 프로세스 핸들 경계")
def test_parent_handle_detects_forced_exit_without_stdin_eof(tmp_path):
    brain_root = Path(__file__).resolve().parents[1]
    watcher = """import json, os, time
from rearchitecture.desktop_parent import ParentProcess
with ParentProcess() as parent:
    print(json.dumps({'ready': os.getpid()}), flush=True)
    while not parent.exited(): time.sleep(0.01)
    print('parent-exited', flush=True)
"""
    launcher = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{watcher!r}],stdin=subprocess.PIPE); time.sleep(60)"
    env = dict(os.environ, PYTHONPATH=str(brain_root))
    # venv redirector 대신 실제 Python 프로세스를 종료한다.
    parent = subprocess.Popen([sys._base_executable, "-c", launcher], env=env, cwd=tmp_path,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in parent.stdout], daemon=True).start()
    try:
        first = lines.get(timeout=10)
        assert "ready" in json.loads(first)
        parent.kill()
        parent.wait(timeout=5)
        assert lines.get(timeout=5) == b"parent-exited\r\n"
    finally:
        if parent.poll() is None: parent.kill()
        parent.wait(timeout=5)


@pytest.mark.skipif(os.name != "nt", reason="Windows 부모 종료 결합")
def test_parent_exit_without_eof_does_not_crash_python_finalization(tmp_path):
    brain_root = Path(__file__).resolve().parents[1]
    script = """from rearchitecture import desktop_parent, desktop_entry
class ClosedParent:
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def exited(self): return True
desktop_parent.ParentProcess = ClosedParent
raise SystemExit(desktop_entry.main())
"""
    env = dict(os.environ, KIRIAN_V1_DATA_DIR=str(tmp_path / "data"),
               PYTHONPATH=os.pathsep.join((str(brain_root), str(brain_root.parent / "contracts" / "python"))))
    child = subprocess.Popen([sys.executable, "-c", script], env=env, cwd=tmp_path,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        child.stdin.write(json.dumps({"token": TOKEN}).encode() + b"\n")
        child.stdin.flush()
        assert child.wait(timeout=12) == 0
        assert child.stderr.read() == b""
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()
