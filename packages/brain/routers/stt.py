"""데스크톱 클라이언트용 음성 인식 API."""

from fastapi import APIRouter, HTTPException, Request


router = APIRouter(prefix="/stt", tags=["stt"])
MAX_AUDIO_BYTES = 10 * 1024 * 1024


@router.post("/transcriptions")
async def transcribe_audio(request: Request, language: str = "ko") -> dict[str, str]:
    provider = getattr(request.app.state, "stt_provider", None)
    if provider is None:
        raise HTTPException(status_code=503, detail="음성 인식이 비활성화되어 있습니다.")

    content_type = request.headers.get("content-type", "").lower()
    if not content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="오디오 형식만 받을 수 있습니다.")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_AUDIO_BYTES:
                raise HTTPException(status_code=413, detail="오디오는 10MB 이하여야 합니다.")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="잘못된 Content-Length입니다.") from error

    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="녹음된 오디오가 없습니다.")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="오디오는 10MB 이하여야 합니다.")

    try:
        text = await provider.transcribe(audio, language=language)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if not text:
        raise HTTPException(status_code=422, detail="음성을 인식하지 못했습니다.")
    return {"text": text}
