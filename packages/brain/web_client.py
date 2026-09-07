"""웹 체험판 정적 파일 서빙과 관련된 작은 FastAPI 어댑터."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


_PUBLIC_WEB_PATHS = frozenset({"/", "/api/status", "/webchat"})
_PUBLIC_WEB_PREFIXES = ("/assets/", "/live2d/", "/static/")


def default_web_client_dir() -> Path:
    """저장소 안의 Vite production 산출물 위치를 반환한다."""
    return Path(__file__).resolve().parents[1] / "client" / "dist"


def is_public_web_request(path: str, method: str) -> bool:
    """LLM/STT 비용과 무관한 브라우저 정적 요청인지 판별한다."""
    if method.upper() not in {"GET", "HEAD"}:
        return False
    return path in _PUBLIC_WEB_PATHS or path.startswith(_PUBLIC_WEB_PREFIXES)


def install_web_client(
    app: FastAPI,
    *,
    dist_dir: Path,
    status_payload: Callable[[], dict[str, Any]],
) -> None:
    """Vite 산출물이 있으면 루트에, 없으면 기존 상태 JSON을 제공한다."""
    index_file = dist_dir / "index.html"

    for route, directory in (
        ("/assets", dist_dir / "assets"),
        ("/live2d", dist_dir / "live2d"),
    ):
        if directory.is_dir():
            app.mount(route, StaticFiles(directory=str(directory)), name=f"web-{directory.name}")

    @app.get("/api/status", include_in_schema=False)
    def brain_status() -> dict[str, Any]:
        return status_payload()

    @app.get("/", include_in_schema=False)
    def web_client_or_status():
        if index_file.is_file():
            return FileResponse(
                str(index_file),
                media_type="text/html",
                headers={"Cache-Control": "no-cache"},
            )
        return status_payload()
