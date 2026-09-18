# Kirian Client

전환 전 구현 안내(2026-09-07 T-053 기준)다. 개편 작업은 루트 CURRENT_PLAN.md를 기준으로 진행한다. Vite + React + TypeScript의 공통 UI를 Windows Tauri와 공개 웹에서 사용한다. [현재 상태](../../CURRENT_PLAN.md), [개발 환경](../../archive/pre-rearchitecture-2026-09-08/docs/DEVELOPMENT.md)을 함께 본다.

## 실행

Node 24를 사용한다. 저장소 루트에서 실행한다:

```powershell
Set-Location packages\client
npm ci
npm run dev
```

개발 서버는 `http://localhost:1420`이다. 저장 설정과 `VITE_BRAIN_URL`이 없으면 Brain 기본 주소는 `http://localhost:8098`이다. 원격 Brain은 설정에서 지정하거나 실행/빌드 전에 주입한다.

```powershell
$env:VITE_BRAIN_URL = "http://<lan-host>:8098"
npm run dev
```

이 주소는 내부 VM 연결 예시이며 현재 서비스 정상 여부를 보증하지 않는다. 공개 빌드는 방문자 localhost 대신 실제 배포 Brain 주소를 사용한다.

## Windows 네이티브

C++ Desktop Build Tools, Rust stable MSVC, WebView2를 준비한 뒤 `npm run tauri dev`로 시작한다. `npm run tauri build -- --debug`는 `src-tauri/target/debug/kirian-client.exe`를 만든다. [Windows 릴리스 체크](../../archive/pre-rearchitecture-2026-09-08/docs/release-check-windows.md)의 창 제어·단축키·실청취 판정은 별도다.

## 검증

```powershell
npm test
npm run build
```

build는 Cubism Framework 컴파일·앱 타입 검사·Vite build를 포함한다. 네이티브 변경에서는 `src-tauri`에서 `cargo test`도 수행한다. 마지막 Client 기록은 T-052의 489 passed/132 modules이며 이번 문서 정리에서 재실행하지 않았다.

## UI·음성 경계

- Presence / Whisper / Utility / Agent Dock / Settings와 공개 TutorialPanel
- 공개 STT는 검토 후 전송, 데스크톱 일반 음성은 연결 상태에 따라 자동 전송/입력 보존 경로 사용
- 자동 종료·취소는 말소리 감시 가능 여부에 따라 처리하며 PTT는 별도 종료 신호 사용
- TTS 문장별 청크를 조립·순서 재생, `tts_sentence`로 현재 문장 자막 동기화
- 실제 운영 TTS 기록은 GPT-SoVITS GPU와 edge-tts 폴백. 레거시 `/webchat` 텍스트 진단과 다름
- 승인 버튼은 설정·일정·할 일의 대상을 구분. 예시 칩은 실행 없이 입력만 채움

[훅 계약](../../archive/pre-rearchitecture-2026-09-08/specs/client-app-hooks.md), [튜토리얼 계약](../../archive/pre-rearchitecture-2026-09-08/specs/hackathon-tutorial.md), [자막 계약](../../archive/pre-rearchitecture-2026-09-08/specs/speech-caption.md)을 따른다.

## Live2D와 자산

개발용에서는 `public/live2d/core/live2dcubismcore.min.js`, `public/live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json`과 텍스처·물리·표정 등이 추적되어 있다. 공식 Framework 소스는 `vendor/cubism-framework`에 있으며 WebGL2 렌더러를 사용한다. `src/live2d-model.ts`에서 모델 manifest·감정 표현·파라미터를 관리한다.

라이선스 원문은 [Core](model-licenses/live2d-cubism-core-license.md), [Framework](model-licenses/live2d-cubism-framework-license.md)로 분리하고, Kirian 모델은 [출처·해시 기록](model-licenses/kirian-model-provenance.md)을 보관한다. 이 기록은 공개·홍보 사용이나 재배포 권리를 승인하지 않는다.

공개용 저장소는 별도다. 개발용 자산이나 코드 이력을 그대로 공개하는 절차는 제공하지 않는다. 공개 범위·생성 스크립트·동기화는 개발 마무리 때 결정한다. [저장소 정책](../../archive/pre-rearchitecture-2026-09-08/docs/repository-workflow.md)

Core/모델 로딩 실패는 Live2D 영역의 오류로 표시된다. 외형·표정·흉상 구도·립싱크·실제 모바일 터치는 사람 판정이 필요하다.
