"""첫 실행 및 관리자용 LLM 프로필 설정 API."""

import secrets

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from config.llm_profiles import LLMProfile, LLMProfiles, LLMProfileStore


router = APIRouter(prefix="/settings/llm", tags=["settings"])


class LLMProfileResponse(BaseModel):
    provider: str
    model: str
    base_url: str
    has_api_key: bool


class LLMProfilesResponse(BaseModel):
    casual: LLMProfileResponse
    task: LLMProfileResponse


def _authorize(request: Request, supplied_token: str) -> None:
    configured_token = getattr(request.app.state, "settings_api_token", "")
    if not configured_token:
        raise HTTPException(
            status_code=503,
            detail="settings API token is not configured",
        )
    if not supplied_token or not secrets.compare_digest(
        supplied_token, configured_token
    ):
        raise HTTPException(status_code=401, detail="invalid admin token")


def _store(request: Request) -> LLMProfileStore:
    store = getattr(request.app.state, "llm_profile_store", None)
    if store is None:
        raise HTTPException(
            status_code=503,
            detail="LLM profile store is not available",
        )
    return store


def _response(profiles: LLMProfiles) -> LLMProfilesResponse:
    def mask(profile: LLMProfile) -> LLMProfileResponse:
        return LLMProfileResponse(
            provider=profile.provider,
            model=profile.model,
            base_url=profile.base_url,
            has_api_key=bool(profile.api_key),
        )

    return LLMProfilesResponse(
        casual=mask(profiles.casual),
        task=mask(profiles.task),
    )


@router.get("", response_model=LLMProfilesResponse)
async def get_llm_profiles(
    request: Request,
    x_tanya_admin_token: str = Header(default=""),
):
    _authorize(request, x_tanya_admin_token)
    profiles = _store(request).load()
    if profiles is None:
        raise HTTPException(status_code=404, detail="LLM profiles not configured")
    return _response(profiles)


@router.put("", response_model=LLMProfilesResponse)
async def put_llm_profiles(
    request: Request,
    body: LLMProfiles,
    x_tanya_admin_token: str = Header(default=""),
):
    _authorize(request, x_tanya_admin_token)
    store = _store(request)
    saved = store.load()
    if saved is not None:
        if not body.casual.api_key:
            body.casual.api_key = saved.casual.api_key
        if not body.task.api_key:
            body.task.api_key = saved.task.api_key
    store.save(body)
    return _response(body)
