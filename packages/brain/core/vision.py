"""Local-only vision result and safe error contracts."""

from dataclasses import dataclass


_PUBLIC_UNAVAILABLE_MESSAGE = (
    "로컬 화면 분석을 사용할 수 없어 요청을 중단했습니다."
)


class VisionProviderError(RuntimeError):
    """A local vision provider failed without exposing raw provider details."""


class VisionUnavailableError(RuntimeError):
    """Vision cannot run inside the configured local trust boundary."""

    code = "local_vision_unavailable"
    public_message = _PUBLIC_UNAVAILABLE_MESSAGE

    def __init__(self) -> None:
        super().__init__(self.public_message)


class VisionTransportUntrustedError(RuntimeError):
    """The caller is not an explicitly trusted local image transport."""

    code = "vision_transport_untrusted"
    public_message = (
        "신뢰된 로컬 화면 연결이 아니어서 이미지 요청을 중단했습니다."
    )

    def __init__(self) -> None:
        super().__init__(self.public_message)


@dataclass(frozen=True)
class VisionRoute:
    provider: str
    execution: str
    fallback: bool
    model: str

    def to_dict(self) -> dict[str, str | bool]:
        return {
            "provider": self.provider,
            "execution": self.execution,
            "fallback": self.fallback,
            "model": self.model,
        }


@dataclass(frozen=True)
class VisionAnalysis:
    content: str
    route: VisionRoute

    @classmethod
    def local_ollama(cls, content: str, model: str) -> "VisionAnalysis":
        return cls(
            content=content,
            route=VisionRoute(
                provider="ollama",
                execution="local",
                fallback=False,
                model=model,
            ),
        )
