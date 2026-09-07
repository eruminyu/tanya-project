# Engineering Cases

아래 세 사례는 포함된 production code와 테스트에서 확인할 수 있습니다. 외부 서비스·GPU의 과거 성능 측정을 이 스냅샷에서 재현한 벤치마크로 제시하지 않습니다.

## 1. 제안 수락을 외부 실행 승인과 분리하기

### 문제

“좋아”라는 응답은 제안에 대한 호응일 수 있습니다. 이를 곧바로 외부 변경 권한으로 취급하면 사용자가 보지 못한 일정이나 할 일이 생성될 수 있습니다. 승인 화면을 본 뒤 실행 필드가 바뀌거나, 같은 승인이 반복 소비되는 문제도 막아야 합니다.

### 해결

공개 튜토리얼은 실행할 수 없는 미리보기를 먼저 만들고 서버에 초안을 저장합니다. 사용자는 정확한 변경 필드와 실행 주체를 확인한 뒤 별도로 승인합니다.

[TutorialStore](../packages/brain/tutorial/store.py)의 `consume_approval`은 세션 소유자·flow·purpose·request ID·token을 검증하고 트랜잭션에서 일회성 승인을 소비합니다. [TutorialService](../packages/brain/tutorial/service.py)는 승인 요청에 붙은 임의의 새 필드 대신 **서버에 저장한 draft**를 provider로 보냅니다. 성공은 실제 provider ID가 있을 때 기록하고 전송 필드를 영수증에 남깁니다.

STT 오인식은 실행 권한을 넓히는 방식으로 보정하지 않았습니다. [입력 제안 계층](../packages/client/src/tutorial-suggestion.ts)은 유일하게 가까운 후보만 보여주고, 명시적으로 수락한 canonical 문장을 기존 parser에 다시 넣습니다. 모호한 후보·승인과 거절의 충돌은 자동으로 실행하지 않습니다.

### 검증과 한계

[Store 테스트](../packages/brain/tests/test_tutorial_store.py)는 일회성 결속을, [Service 테스트](../packages/brain/tests/test_tutorial_service.py)는 다른 세션·잘못된 단계·거절·동시 승인 경계를 검사합니다. [입력 테스트](../packages/client/src/tutorial-suggestion.test.ts)와 [App 테스트](../packages/client/src/App.tutorial.test.tsx)는 후보 제안만으로 실행되지 않는 경로를 고정합니다.

이 강한 서버 계약은 공개 튜토리얼의 구현입니다. 데스크톱은 별도 승인 UI와 개인 자격 증명, 성공 영수증 캐시를 사용하지만 같은 영속 복구 보장까지 갖지는 않습니다.

## 2. 연결 복구와 외부 작업 재실행을 분리하기

### 문제

모바일 브라우저는 백그라운드에 있는 동안 연결이 끊길 수 있습니다. 복귀 후 긴 백오프를 기다리면 앱이 멈춘 듯 보입니다. 반대로 실행 중 연결이 끊겼다고 Google 생성 요청을 자동 재시도하면 이미 생성된 항목이 중복될 수 있습니다.

### 해결

[연결 hook](../packages/client/src/hooks/useBrainConnection.ts)은 화면이 다시 보이거나 네트워크가 돌아오면 대기 타이머를 취소하고 즉시 재연결합니다. 이미 열려 있거나 연결 중인 소켓은 중복 생성하지 않습니다. 교체된 이전 소켓의 늦은 close 이벤트도 현재 연결 상태를 바꾸지 못하게 합니다.

서버는 재연결 후 자신의 저장 상태를 돌려줍니다. [Store](../packages/brain/tutorial/store.py)의 `_recover_interrupted_actions`는 재시작 당시 executing 작업을 `uncertain`으로 남기고 다음 안정 단계로 이동합니다. 결과를 알 수 없다는 사실을 보존하며 새 항목을 자동 생성하지 않습니다. 만료된 미실행 승인은 같은 초안·request를 유지한 채 새 token을 발급할 수 있습니다.

### 검증과 한계

[연결 테스트](../packages/client/src/hooks/useBrainConnection.test.ts)는 visible/online 복귀, 중복 소켓 방지, 백오프 초기화와 listener 정리를 검사합니다. [Store 테스트](../packages/brain/tests/test_tutorial_store.py)와 [Service 테스트](../packages/brain/tests/test_tutorial_service.py)는 중단 복구·만료 승인 재발급 시 provider 재호출이 없음을 확인합니다.

이는 모든 네트워크 장애에서 외부 시스템의 결과를 알아낼 수 있다는 뜻이 아닙니다. 확인 불가능한 결과는 끝까지 불확실하게 표시합니다. 실제 휴대폰의 화면 잠금·앱 전환 타이밍은 별도 실기기 판정입니다.

## 3. HTTP 200인데 소리가 없는 문제와 음성 자원 조정

### 문제

개발 중 GPT-SoVITS가 HTTP 200 응답으로 JSON 오류 또는 모든 PCM 샘플이 0인 WAV를 반환하는 사례가 있었습니다. 본문이 비어 있지 않은지만 검사하면 실패가 성공처럼 처리됩니다. 주 provider의 tone을 다른 provider의 voice 이름으로 넘겨 fallback까지 실패하는 경로도 있었습니다.

### 해결

[GPT-SoVITS provider](../packages/brain/core/providers/gpt_sovits_provider.py)의 `ensure_audible_wav`가 JSON 오류·WAV 형식·data 유무·완전한 디지털 무음을 검사합니다. 조용한 정상 음성을 과도하게 버리지 않도록 음량 임계값으로 실패를 결정하지 않습니다.

[Audio manager](../packages/brain/core/audio.py)는 fallback에 주 provider의 tone을 전달하지 않고 fallback의 기본 voice를 사용합니다. [음성 입력 hook](../packages/client/src/hooks/useVoiceInput.ts)은 발화 감시가 말소리를 듣지 못한 취소를 전사 서버로 보내지 않습니다. 감시할 수 없는 PTT·Web Audio 부재 경로는 구분합니다.

[faster-whisper 설정](../packages/brain/core/providers/faster_whisper_provider.py)은 모델·device·compute type·VAD·어휘 힌트를 주입할 수 있습니다. [Ollama](../packages/brain/tutorial/ollama.py)도 thinking과 context 설정을 받습니다. 개발 과정에서는 STT·TTS·LLM의 개별 지연과 동시 VRAM 사용을 나누어 측정하여 설정을 선택했습니다. 모델 크기만 올리는 방식으로 품질·지연·메모리를 한꺼번에 해결됐다고 판단하지 않았습니다.

### 검증과 한계

[TTS 테스트](../packages/brain/tests/test_tts_providers.py)는 정상·짧은 음성, JSON 오류, 무음, 잘못된 WAV, provider fallback의 tone 제거를 검사합니다. [음성 입력 테스트](../packages/client/src/hooks/useVoiceInput.test.ts)는 무발화 취소와 실제 발화 종료를 구분합니다.

개발 중 STT 비교에는 합성음이 사용됐습니다. 이를 사람 목소리 정확도로 일반화하지 않으며, 실제 마이크 품질과 GPU 장기 안정성은 별도 확인이 필요합니다. 모델 가중치·참조 음성·GPU 환경을 포함하지 않으므로 이 저장소는 과거의 성능 수치를 보장하지 않습니다.
