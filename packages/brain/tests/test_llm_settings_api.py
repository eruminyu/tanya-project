"""첫 실행 LLM 프로필 저장소와 관리 API 테스트."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from config.llm_profiles import LLMProfile, LLMProfiles, LLMProfileStore
from routers.llm_settings import router


def _profiles() -> LLMProfiles:
    return LLMProfiles(
        casual=LLMProfile(
            provider="ollama",
            model="qwen2.5:7b",
            base_url="http://ollama:11434",
        ),
        task=LLMProfile(
            provider="openai-compatible",
            model="custom-task-model",
            base_url="http://task-model:8000/v1",
            api_key="secret-key",
        ),
    )


def _client(store: LLMProfileStore, token: str = "admin-token") -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.state.llm_profile_store = store
    app.state.settings_api_token = token
    return TestClient(app)


class TestLLMProfileStore:
    def test_save_and_load_round_trip(self, tmp_path):
        store = LLMProfileStore(tmp_path / "llm_profiles.json")

        store.save(_profiles())

        assert store.load() == _profiles()

    def test_load_missing_file_returns_none(self, tmp_path):
        store = LLMProfileStore(tmp_path / "missing.json")

        assert store.load() is None

    def test_rejects_unknown_provider(self):
        try:
            LLMProfile(provider="unknown", model="model")
        except ValueError:
            return
        raise AssertionError("알 수 없는 provider를 허용하면 안 됩니다.")


class TestLLMSettingsAPI:
    def test_put_requires_admin_token(self, tmp_path):
        client = _client(LLMProfileStore(tmp_path / "profiles.json"))

        response = client.put("/settings/llm", json=_profiles().model_dump())

        assert response.status_code == 401

    def test_put_rejects_when_server_token_is_not_configured(self, tmp_path):
        client = _client(LLMProfileStore(tmp_path / "profiles.json"), token="")

        response = client.put(
            "/settings/llm",
            headers={"X-Tanya-Admin-Token": "anything"},
            json=_profiles().model_dump(),
        )

        assert response.status_code == 503

    def test_put_persists_profiles(self, tmp_path):
        store = LLMProfileStore(tmp_path / "profiles.json")
        client = _client(store)

        response = client.put(
            "/settings/llm",
            headers={"X-Tanya-Admin-Token": "admin-token"},
            json=_profiles().model_dump(),
        )

        assert response.status_code == 200
        assert store.load() == _profiles()

    def test_response_masks_api_key(self, tmp_path):
        store = LLMProfileStore(tmp_path / "profiles.json")
        client = _client(store)

        response = client.put(
            "/settings/llm",
            headers={"X-Tanya-Admin-Token": "admin-token"},
            json=_profiles().model_dump(),
        )

        body = response.json()
        assert "api_key" not in body["task"]
        assert body["task"]["has_api_key"] is True
        assert "secret-key" not in response.text

    def test_get_returns_saved_profiles_without_secret(self, tmp_path):
        store = LLMProfileStore(tmp_path / "profiles.json")
        store.save(_profiles())
        client = _client(store)

        response = client.get(
            "/settings/llm",
            headers={"X-Tanya-Admin-Token": "admin-token"},
        )

        assert response.status_code == 200
        assert response.json()["casual"]["provider"] == "ollama"
        assert response.json()["task"]["has_api_key"] is True
        assert "secret-key" not in response.text

    def test_put_with_blank_api_key_preserves_saved_secret(self, tmp_path):
        store = LLMProfileStore(tmp_path / "profiles.json")
        store.save(_profiles())
        client = _client(store)
        updated = _profiles().model_copy(deep=True)
        updated.task.model = "updated-model"
        updated.task.api_key = ""

        response = client.put(
            "/settings/llm",
            headers={"X-Tanya-Admin-Token": "admin-token"},
            json=updated.model_dump(),
        )

        assert response.status_code == 200
        saved = store.load()
        assert saved is not None
        assert saved.task.model == "updated-model"
        assert saved.task.api_key == "secret-key"
