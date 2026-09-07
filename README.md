# Tanya

> **먼저 챙기되, 허락 없이 행동하지 않는 AI.**

Tanya는 사용자의 상황을 근거로 행동을 먼저 제안하되, 정확한 변경 내용을 보여주고 명시적 승인을 받은 뒤에만 실행하는 **consent-first ambient AI companion**입니다.

[아키텍처](docs/ARCHITECTURE.md) · [기술적 문제 해결](docs/ENGINEERING_CASES.md) · [실행 안내](docs/SETUP.md)

| 항목 | 내용 |
| --- | --- |
| 개발 형태 | 개인 프로젝트 |
| 현재 상태 | Working Prototype · Portfolio Snapshot |
| Client | Tauri v2, Rust, React 19, TypeScript, Vite |
| Brain | Python, FastAPI, WebSocket, Ollama |
| 음성 | faster-whisper, GPT-SoVITS 연동 |
| 외부 연동 | Google Calendar, Google Tasks |
| 검증 | Brain 883 passed · Client 501 passed (49 files) · Client build 성공 (모델·Core 없음) |

[검증 범위와 원본 대비 차이](docs/VERIFICATION.md)를 공개합니다.

이 저장소는 검토를 위해 정리한 소스 스냅샷입니다. 운영 배포 소스가 아니며 자동 배포에 연결하지 않습니다.

## 1. 해결하려는 문제

AI가 먼저 도와주려 할수록 “왜 지금 제안했는지”, “무엇을 바꾸는지”, “정말 실행됐는지”를 알기 어려워집니다. Tanya는 조용한 상주 화면에서 근거·미리보기·승인·영수증을 이어 사용자가 개입 시점과 실행 권한을 통제하게 합니다.

## 2. 범용 에이전트와의 차이

OpenClaw 같은 범용 에이전트 플랫폼의 대체가 목표는 아닙니다. 도구 수보다 **Presence, Grounding, Consent-first Action, Local Authority, Execution Receipt**라는 다섯 계약과 이를 이해할 수 있는 인터페이스에 집중합니다.

## 3. 핵심 사용자 흐름

```text
일정·사용자 상태 → 근거가 있는 제안 → 실행 불가능한 초안
→ 정확한 변경 미리보기 → 별도 승인 → 승인에 결속된 내용 확인
→ 외부 실행 → 실제 provider 결과 영수증
```

제안 수락과 실행 승인은 별개입니다. 공개 튜토리얼은 서버에 보관한 초안을 일회성 승인과 연결하며, 결과를 확정할 수 없으면 `uncertain`으로 기록하고 자동 재실행하지 않습니다.

## 4. 구현된 범위

- 데스크톱 5개 모드, 창 제어, 일정 기반 선제 제안, Google 초안·승인·생성·영수증.
- 공개 튜토리얼의 선호 저장·Calendar/Tasks 실행·기억 사용 전후 비교·잊기·삭제 확인.
- 단계별 텍스트·음성 입력, 모호한 전사의 확인 제안, 재연결과 중단 상태 복구.
- 성공한 일정 영수증에서 ICS 또는 Google Calendar 링크로 개인 캘린더에 복사.

실제 Google 생성·조회·재시작·삭제와 브라우저 검증의 개발 기록이 있습니다. 이 스냅샷의 자동 검증 결과와 실환경 판정은 구분합니다.

## 5. 남은 검증과 범위

실제 휴대폰 STT·재연결·승인 화면, iOS/Android 캘린더 저장, Windows NVDA·창 동작·립싱크, Live2D 사용 조건은 최종 사람 판정이 남아 있습니다.

범용 데스크톱 자동 조작, 사용자 임의 모델 import, 개인 Obsidian 전체 RAG, 완성된 화면 캡처 경험은 완료 기능이 아닙니다. 데스크톱의 성공 영수증 캐시는 공개 튜토리얼의 영속적인 `uncertain` 복구와 같은 보장을 제공하지 않습니다.

## 6. 아키텍처

React UI는 WebSocket으로 Brain과 연결됩니다. Brain은 판단·초안을 만들고, 데스크톱의 개인 Google 권한은 Windows Client가 보유합니다. 공개 튜토리얼은 별도 데모 계정을 사용하는 서버 실행 경로입니다. [권한 경계와 모듈](docs/ARCHITECTURE.md)을 참고하세요.

## 7. 기술적 문제 해결

[세 가지 사례](docs/ENGINEERING_CASES.md): 일회성 승인과 실행 영수증, 재연결·재시작에서 중복 실행 방지, 무음 응답·전사 오류와 STT/TTS 자원 조정.

## 8. 역할과 AI 활용

제품 방향·우선순위·완료 기준·외부 서비스 설정·실환경 판정을 담당했습니다. Claude와 Codex를 요구사항 구체화·구현·테스트·리뷰·문서화에 활용하고, Task와 실제 diff·검증 결과로 변경을 관리했습니다. [판단과 AI 기여의 구분](docs/AI_ASSISTED_DEVELOPMENT.md)을 명시했습니다.

## 9. 실행과 테스트

Node.js 24 이상, Python 3.12를 사용합니다. Live2D 모델과 Core가 없는 기본 설정은 렌더링을 비활성화하고 채팅·튜토리얼·승인 화면을 유지합니다. 실제 대화·외부 실행에는 별도 서비스 설정이 필요합니다.

```powershell
python -m pytest packages/brain/tests -q
cd packages/client
npm ci
npm test
npm run build
```

환경 준비, 선택 기능, 검증 범위는 [SETUP](docs/SETUP.md)에 있습니다.

## 10. 제3자 자산과 라이선스

Live2D 모델 원본, Cubism Core 런타임, 음성 원본·모델 가중치·개인 설정은 포함하지 않습니다. Framework와 Core 타입 선언의 기존 고지는 유지했습니다. 모델의 재배포·웹·포트폴리오 사용 허가는 확정되지 않았습니다. 저장소 전체에 MIT를 부여하지 않으며 [NOTICE](NOTICE.md)와 [제3자 고지](docs/THIRD_PARTY_NOTICES.md)를 확인해야 합니다.

```text
SOURCE_COMMIT=7723116655c8ca7e3c93c0b5b7a8d00e46a71e90
SOURCE_DATE=2026-09-07
```

원본 Git 이력을 가져오지 않고 위 커밋의 추적 파일을 선별한 뒤, 공개용 설정·문서·모델 없는 경로를 조정했습니다.
