from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from web_client import install_web_client, is_public_web_request


def _status_payload():
    return {"status": "Tanya Brain is running"}


def test_root_falls_back_to_status_when_build_is_missing(tmp_path: Path):
    app = FastAPI()
    install_web_client(app, dist_dir=tmp_path / "missing", status_payload=_status_payload)

    response = TestClient(app).get("/")

    assert response.status_code == 200
    assert response.json() == _status_payload()


def test_built_client_and_status_api_are_served(tmp_path: Path):
    dist = tmp_path / "dist"
    assets = dist / "assets"
    live2d = dist / "live2d"
    assets.mkdir(parents=True)
    live2d.mkdir()
    (dist / "index.html").write_text("<html>tanya web</html>", encoding="utf-8")
    (assets / "app.js").write_text("console.log('tanya')", encoding="utf-8")
    (live2d / "model.json").write_text("{}", encoding="utf-8")

    app = FastAPI()
    install_web_client(app, dist_dir=dist, status_payload=_status_payload)
    client = TestClient(app)

    root = client.get("/")
    assert root.status_code == 200
    assert root.headers["content-type"].startswith("text/html")
    assert root.headers["cache-control"] == "no-cache"
    assert "tanya web" in root.text
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/live2d/model.json").json() == {}
    assert client.get("/api/status").json() == _status_payload()


def test_static_browser_requests_do_not_consume_ai_rate_limit():
    for path in ("/", "/api/status", "/assets/app.js", "/live2d/model.json", "/static/webchat.html"):
        assert is_public_web_request(path, "GET")

    assert not is_public_web_request("/stt/transcriptions", "POST")
    assert not is_public_web_request("/feedback", "POST")
    assert not is_public_web_request("/assets/app.js", "POST")
