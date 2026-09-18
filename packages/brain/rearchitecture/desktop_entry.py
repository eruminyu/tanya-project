"""데스크톱이 소유하는 stdin 인증·임의 loopback 포트 Brain 진입점."""
from __future__ import annotations

import asyncio
from contextlib import redirect_stderr, redirect_stdout
import json
import logging
import os
import re
import socket
import sys
import threading
import warnings


def read_token(stream) -> str:
    line = stream.readline(1025)
    if not isinstance(line, bytes) or not line.endswith(b"\n") or len(line) > 1024:
        raise ValueError("invalid_handshake")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("invalid_handshake")
            result[key] = value
        return result

    data = json.loads(line.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(data, dict) or set(data) != {"token"} or not isinstance(data["token"], str):
        raise ValueError("invalid_handshake")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", data["token"]):
        raise ValueError("invalid_handshake")
    return data["token"]


async def serve(config, stdin, stdout, parent=None) -> None:
    # 검증 전용 실행은 이 import와 저장소 생성에 도달하지 않는다.
    import uvicorn
    from rearchitecture.app import create_app

    loop = asyncio.get_running_loop()
    parent_closed = threading.Event()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        listener.setblocking(False)
        port = listener.getsockname()[1]

        class DesktopServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if self.started and not parent_closed.is_set():
                    stdout.write(json.dumps({"type": "ready", "port": port}, separators=(",", ":")) + "\n")
                    stdout.flush()

        server = DesktopServer(uvicorn.Config(
            create_app(config), host="127.0.0.1", port=port,
            loop="asyncio", http="h11", ws="websockets", lifespan="on",
            log_config=None, log_level=None, access_log=False,
            timeout_graceful_shutdown=5, timeout_keep_alive=2,
        ))

        def stop_on_parent_close():
            try:
                # 첫 프레임 이후에는 입력이 없다. EOF 또는 잘못된 추가 입력은 종료다.
                stdin.read(1)
            except (OSError, ValueError):
                pass
            parent_closed.set()
            try:
                loop.call_soon_threadsafe(setattr, server, "should_exit", True)
            except RuntimeError:
                pass

        threading.Thread(target=stop_on_parent_close, daemon=True, name="desktop-parent").start()
        async def watch_parent():
            while True:
                if parent.exited():
                    parent_closed.set()
                    server.should_exit = True
                    return
                await asyncio.sleep(0.1)

        watcher = asyncio.create_task(watch_parent()) if parent is not None else None
        try:
            await server.serve(sockets=[listener])
        finally:
            if watcher is not None:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
        if not server.started and not parent_closed.is_set():
            raise RuntimeError("startup_failed")


def main(argv=None, *, stdin=None, stdout=None, stderr=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    # daemon 감시가 EOF를 기다리는 중에도 interpreter가 buffered lock 없이 종료된다.
    # 첫 인증 프레임부터 같은 raw stream을 사용해 prefetch로 제어 입력을 잃지 않는다.
    control_in = sys.stdin.buffer.raw if stdin is None else stdin
    control_out = sys.stdout if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    previous_logging_disable = logging.root.manager.disable
    try:
        # 라이브러리 경고·traceback에는 host 경로나 provider 자료가 섞일 수 있다.
        # 부모에 노출하는 채널은 ready 한 줄과 고정 실패 코드로 제한한다.
        with open(os.devnull, "w", encoding="utf-8") as silent, redirect_stdout(silent), redirect_stderr(silent), warnings.catch_warnings():
            logging.disable(sys.maxsize)
            warnings.simplefilter("ignore")
            if args not in ([], ["--validate-config"]):
                raise ValueError("invalid_arguments")
            from rearchitecture.config import V1Config
            config = V1Config.from_env(token=read_token(control_in))
            if args == ["--validate-config"]:
                return 0
            if os.name == "nt":
                from rearchitecture.desktop_parent import ParentProcess
                with ParentProcess() as parent:
                    asyncio.run(serve(config, control_in, control_out, parent))
            else:
                asyncio.run(serve(config, control_in, control_out))
            return 0
    except (Exception, KeyboardInterrupt, SystemExit):
        errors.write("brain_start_failed\n")
        errors.flush()
        return 1
    finally:
        logging.disable(previous_logging_disable)


if __name__ == "__main__":
    raise SystemExit(main())
