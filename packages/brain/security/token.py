"""Phase 4-B: 토큰 검증 모듈.

HMAC-SHA256 기반 간단한 서명 토큰.
JWT 라이브러리 없이 표준 라이브러리만 사용.

토큰 형식: base64url(json_payload).expire_ts.hmac_signature
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s)


class TokenValidator:
    """HMAC-SHA256 기반 토큰 생성 및 검증."""

    def __init__(self, secret_key: str) -> None:
        self._secret = secret_key.encode()

    def generate(self, payload: dict, expires_in: int = 3600) -> str:
        """토큰을 생성한다.

        Parameters
        ----------
        payload : dict
            토큰에 담을 데이터.
        expires_in : int
            만료 시간 (초). 음수면 이미 만료된 토큰 생성 (테스트용).

        Returns
        -------
        str
            서명된 토큰 문자열.
        """
        expire_ts = int(time.time()) + expires_in
        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        payload_b64 = _b64encode(payload_json.encode())
        message = f"{payload_b64}.{expire_ts}".encode()
        sig = hmac.new(self._secret, message, hashlib.sha256).digest()
        sig_b64 = _b64encode(sig)
        return f"{payload_b64}.{expire_ts}.{sig_b64}"

    def validate(self, token: str) -> dict | None:
        """토큰을 검증하고 payload를 반환한다.

        Returns
        -------
        dict
            검증 성공 시 payload.
        None
            형식 불일치, 서명 위조, 만료된 토큰.
        """
        try:
            parts = token.split(".")
            if len(parts) != 3:
                return None
            payload_b64, expire_ts_str, sig_b64 = parts

            # 서명 검증
            message = f"{payload_b64}.{expire_ts_str}".encode()
            expected_sig = hmac.new(self._secret, message, hashlib.sha256).digest()
            expected_sig_b64 = _b64encode(expected_sig)
            if not hmac.compare_digest(sig_b64, expected_sig_b64):
                return None

            # 만료 시간 검증
            expire_ts = int(expire_ts_str)
            if time.time() > expire_ts:
                return None

            # payload 디코딩
            payload_json = _b64decode(payload_b64).decode()
            return json.loads(payload_json)
        except Exception:
            return None
