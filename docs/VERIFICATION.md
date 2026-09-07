# Snapshot verification

2026-09-07에 SOURCE_COMMIT `7723116655c8ca7e3c93c0b5b7a8d00e46a71e90`을 고정하고 원본과 공개본을 별도 디렉터리에서 검증했습니다. 기존 개발 작업 파일이나 운영 서비스에서 테스트를 실행하지 않았습니다.

| 검사 | 원본 스냅샷 | 공개 스냅샷 |
| --- | --- | --- |
| Brain pytest | 895 passed | 883 passed |
| Client Vitest | 489 passed / 47 files | 501 passed / 49 files |
| Client production build | 이번 작업에서는 생략 | 통과 / 134 modules |

Brain 차이 12건은 제외한 운영 systemd 파일의 경로·서비스 설정만 검사하는 테스트입니다. 공개본은 나머지를 유지했습니다. Client는 모델 없는 경로와 Core 실패 처리 테스트를 추가하여 12건 늘었습니다.

Python 3.12.14의 기존 가상 환경과 embedding 모델 캐시를 사용했습니다. 전체 requirements를 새 환경에 재설치한 검증은 아닙니다. STT/TTS provider 계약 테스트는 mock을 사용하며 실제 마이크·GPU 추론 품질을 뜻하지 않습니다. Brain에 Starlette TestClient의 httpx 관련 deprecation warning 1건이 남았습니다. Node 24.19.0 / npm 11.17.0에서 잠금 파일 기준 `npm ci`를 실행했습니다.

## 모델과 Core 없는 실제 화면

로컬 브라우저에서 데스크톱과 390×844 모바일 화면을 확인했습니다. 모델 URL이 비어 있으면 모델 미설치 안내와 튜토리얼·입력 UI가 표시되고, Core·렌더러 요청은 모두 0건이었습니다. 모델 URL만 설정하고 Core 파일을 제공하지 않은 경우도 Live2D 영역에만 오류를 표시하며 입력 UI가 유지됐습니다. 두 경우 모두 처리되지 않은 page error는 없었습니다. 연결할 Brain을 실행하지 않은 화면에서 실제 외부 실행 성공을 주장하지 않습니다.

## 공개 파일·비밀정보 검사

공개할 파일과 새 Git 이력에서 모델 원본·Core 런타임·개인 설정·DB·음성·가중치를 제외합니다. `.gitignore`는 모델 디렉터리 전체를 제외하여 texture 등도 보호합니다. 제3자 고지와 타입 선언은 명시한 범위에서 유지합니다.

Gitleaks 8.30.1 기본 규칙과 별도 강한 비밀값·개인 인프라 패턴 검사를 사용합니다. 기본 규칙은 `packages/brain/memory/session.py`의 `session_key`와 `max_turns` 함수 인자 (`self._max_turns` 참조)를 generic-api-key 1건으로 탐지합니다. 해당 코드에는 문자열 비밀값이 없으므로 확인된 오탐으로 분류했습니다. 이 항목을 숨기기 위해 스캐너 규칙이나 소스 코드를 바꾸지 않았습니다. 실제 자격 증명으로 확인된 탐지는 0건입니다.

문서의 상대 링크가 존재하는지 확인했습니다. 영상·이미지·운영 웹 링크는 싣지 않았습니다. 자세한 자산 범위는 [제3자 고지](THIRD_PARTY_NOTICES.md)를 참고하세요.

## 이번 검증에 포함하지 않은 것

Tauri/Rust 빌드와 네이티브 창 제어, 실제 Google 계정 실행, 실기기 STT/TTS·GPU 측정, NVDA는 이번 스냅샷 작업에서 실행하지 않았습니다. 운영 배포·서비스 재시작·DNS 변경도 수행하지 않았습니다.
