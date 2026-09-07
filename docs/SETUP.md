# Setup and Verification

이 문서는 검토용 스냅샷을 로컬에서 실행하는 안내입니다. 운영 배포 설정과 자동 배포 workflow는 포함하지 않습니다.

## 1. 준비 환경

- Python **3.12**와 가상 환경.
- Node.js **24 이상**, npm. 기준은 루트 `.nvmrc`와 Client `package.json`.
- 선택적 Windows 데스크톱 실행: Rust, MSVC C++ 빌드 도구, WebView2가 필요합니다.
- 실제 대화: 사용 권한이 있는 모델을 준비한 로컬 Ollama.
- STT·embedding 사용 또는 해당 smoke test: 필요한 모델 다운로드나 로컬 캐시.
- 선택적 음성 합성: 별도 TTS 서비스 및 사용 가능한 참조 음성·가중치.

웹 Client의 설치·단위 테스트·production 빌드에는 Live2D 모델 원본이나 Core 런타임이 필요하지 않습니다. 미설정 Live2D는 비활성화되며 나머지 UI가 유지됩니다. 실제 LLM·STT·TTS·Google 실행까지 자산과 계정 없이 제공되는 것은 아닙니다.

## 2. Brain 설치와 실행

저장소 루트에서 실행합니다.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r packages/brain/requirements.txt
Copy-Item .env.example .env
```

이미 `.env`가 있다면 덮어쓰지 말고 필요한 항목만 비교해 추가하세요. `.env`에는 로컬 서비스 주소와 직접 준비한 값만 넣고 Git에 추가하지 않습니다.

일반 대화의 Ollama endpoint·모델과 task provider를 자신의 환경에 맞게 설정합니다. 인터넷 provider를 선택하면 별도 키가 필요합니다. 연결되지 않은 기능은 설정을 완료하기 전까지 실행할 수 없습니다.

```powershell
python -m uvicorn main:app --app-dir packages/brain --host 127.0.0.1 --port 8098
```

STT·embedding 모델은 처음 사용할 때 다운로드가 필요할 수 있습니다. 네트워크가 없는 환경은 캐시를 미리 준비해야 합니다. 환경 준비 실패나 모델 다운로드 실패를 기능 테스트 통과로 간주하지 않습니다.

## 3. Client 설치와 실행

새 터미널에서 `packages/client`로 이동하여 실행합니다.

```powershell
cd packages/client
npm ci
```

`packages/client/.env.local`에 다음 값을 둡니다. Vite 환경 변수는 브라우저 코드에 포함될 수 있으므로 비밀값을 넣지 않습니다.

```dotenv
VITE_BRAIN_URL=http://127.0.0.1:8098
VITE_LIVE2D_MODEL_URL=
VITE_LIVE2D_CORE_URL=
```

```powershell
npm run dev -- --host 127.0.0.1
```

브라우저에서 [로컬 Client](http://127.0.0.1:1420)를 엽니다. Brain 연결 및 활성 기능에 따라 가능한 UI 동작이 달라집니다. 외부 기능을 설정하지 않은 상태에서 성공 결과를 만들어 표시하지 않습니다.

Tauri 데스크톱의 기본 CSP는 localhost/127.0.0.1 Brain만 허용합니다. 다른 Brain 주소를 사용하려면 연결 설정과 함께 [tauri.conf.json](../packages/client/src-tauri/tauri.conf.json)의 `connect-src`에도 필요한 endpoint를 명시적으로 추가해야 합니다.

## 4. 선택적 Live2D

모델 URL을 비워 두는 것이 기본입니다. 모델 미설치 또는 Core 로드 실패 시 Live2D 영역에 안내를 표시하고 나머지 화면은 유지합니다.

Live2D를 사용하려면 다음을 직접 준비합니다.

1. 의도한 사용과 호스팅을 허용하는 호환 모델.
2. [공식 Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/)의 호환 Core. 적용되는 SDK 계약에 동의해야 합니다.
3. 모델 파일이 참조하는 texture·motion·expression 등이 로컬 서비스에서 읽히는 배치.

Core를 로컬 `packages/client/public/live2d/core/live2dcubismcore.min.js`에 두면 기본 경로로 사용할 수 있습니다. 다른 위치를 쓸 때는 `VITE_LIVE2D_CORE_URL`을 지정합니다. 모델이 활성화된 경우에만 Core를 로드합니다.

```dotenv
VITE_LIVE2D_MODEL_URL=/live2d/models/example/model.model3.json
VITE_LIVE2D_CORE_URL=/live2d/core/live2dcubismcore.min.js
```

위 모델 경로는 배치 방법을 설명하는 예시이며 해당 자산은 제공하지 않습니다. 설정 후 개발 서버를 다시 시작합니다. 원본 모델과 Core를 공개 커밋에 추가하지 않습니다. 빈 기본 manifest는 특정 제3자 표정 자산에 의존하지 않으며, 새 모델의 표현은 직접 조정해야 합니다.

라이선스 구분과 타입 선언 보존 범위는 [제3자 고지](THIRD_PARTY_NOTICES.md)를 참고하세요.

## 5. 선택적 Google·튜토리얼

공개 튜토리얼과 Google demo 실행은 기본적으로 꺼져 있습니다. 직접 테스트할 때는 개인 데이터와 분리한 데모 계정을 준비하고 해당 계정의 Calendar·Tasks API 권한을 설정합니다.

Brain의 비추적 `.env`에서 `ENABLE_GOOGLE_DEMO`, `ENABLE_HACKATHON_TUTORIAL`, `GOOGLE_DEMO_CLIENT_ID`, `GOOGLE_DEMO_CLIENT_SECRET`, `GOOGLE_DEMO_REFRESH_TOKEN`과 튜토리얼 전용 설정을 채웁니다. `TUTORIAL_HMAC_SECRET`은 무작위 값으로 준비하며 최소 UTF-8 32바이트가 필요합니다. `TUTORIAL_OLLAMA_BASE_URL`과 `TUTORIAL_OLLAMA_MODEL`은 명시적인 로컬 모델을 가리켜야 합니다. 서버 비밀값을 Vite 변수에 복사하지 않습니다.

승인하면 지정한 데모 계정에 **실제 항목이 생성**됩니다. 성공한 데모 항목은 30분 후 자동 삭제 대상으로 기록되며, 실제 삭제에는 Brain이 실행 중이고 provider에 연결되어 있어야 합니다. `uncertain` 결과는 생성·삭제가 확인됐다는 뜻이 아닙니다.

성공 영수증에서 개인 캘린더로 복사한 항목은 별개입니다. 사용자가 자신의 캘린더 앱에서 최종 저장하며, Tanya의 데모 cleanup이 그 복사본을 삭제하지 않습니다.

데스크톱의 개인 Google 연결은 Rust/Windows 권한 경로입니다. 별도 Desktop OAuth 설정과 사용자 로그인이 필요하고, 자격 증명은 Windows 저장소에 보관합니다.

## 6. 자동 검증

가상 환경을 활성화한 뒤 루트에서 실행합니다.

```powershell
python -m pytest packages/brain/tests -q
```

Client 검증:

```powershell
cd packages/client
npm ci
npm test
npm run build
```

원본 테스트 중 제외한 운영 배포 파일을 검사하던 Brain 테스트 **12건**은 이 스냅샷에서 제외했습니다. 따라서 공개 스냅샷 테스트 수는 원본 개발 저장소와 직접 같지 않습니다. 나머지 소스 테스트를 유지하고 공개용 설정·모델 미설치 경로를 검증합니다.

**실제 실행 결과: Brain 883 passed · Client 501 passed (49 files) · Client build 성공 (모델·Core 없음)**

이 결과는 명시된 스냅샷의 자동 검증입니다. 별도 기재가 없는 Tauri 설치 파일 빌드, GPU 벤치마크, Google 실계정 호출, 모바일·NVDA 판정을 포함하지 않습니다.

## 7. 남은 사람 판정

실제 휴대폰 STT와 네트워크 복귀, iOS/Android 캘린더 파일 저장, Windows NVDA·창 동작·립싱크와 음성 품질을 확인해야 합니다. Live2D 모델의 공개·웹·포트폴리오 사용 조건도 별도 확인 대상입니다.
