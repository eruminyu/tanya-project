# Third-Party Notices

Tanya 원본 코드와 제3자 구성 요소의 권리는 구분됩니다. 이 저장소는 전체 구성 요소에 공통 MIT 라이선스를 부여하지 않습니다. 원본 코드의 이용허락 범위는 [NOTICE](../NOTICE.md)를 참고하세요.

## Live2D model — original assets excluded

과거 개발 화면에 사용한 모델은 제3자 무료 배포 모델입니다. **원본 모델 파일은 이 저장소에 포함하거나 재배포하지 않습니다.** 재배포, 공개 웹 호스팅, 포트폴리오·홍보 사용 허용 여부가 확정되지 않았기 때문입니다.

보존된 [원본 안내문](../packages/client/model-licenses/shiroko-source-license.txt)에는 배포 채널이 Bilibili 계정 **神宫凉子**, UID **13737731**로 기재되어 있습니다. 이는 안내문에 기록된 배포자 정보이며, 모델 제작자 신원과 실제 원본 배포 페이지를 독립적으로 확정한 것은 아닙니다. 확인되지 않은 배포 URL은 싣지 않습니다.

방송 수익·2차 창작 등의 안내를 GitHub 재배포나 웹·포트폴리오 사용 허가로 확장 해석하지 않습니다. 향후 모델이 등장하는 영상·스크린샷을 추가한다면 확인된 제작자·배포처와 적용 조건을 함께 표시해야 합니다. 출처 표기만으로 사용 허가가 확정되는 것은 아닙니다.

사용자는 자신의 의도한 용도를 허용하는 조건의 호환 모델을 별도로 준비해야 합니다.

## Cubism Core — runtime excluded

Live2D Cubism Core는 독점 소프트웨어입니다. JavaScript 런타임 `live2dcubismcore.min.js`는 이 저장소에 포함하지 않습니다.

Live2D 렌더링이 필요하면 [공식 Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/)에서 호환 SDK를 받고 적용되는 계약에 동의한 뒤 Core를 로컬에 준비하세요. 설치 위치와 설정은 [SETUP](SETUP.md)에 있습니다.

[Core 라이선스 안내](../packages/client/model-licenses/live2d-cubism-core-license.md)는 그대로 보존했습니다. [타입 선언 파일](../packages/client/vendor/cubism-framework/live2dcubismcore.d.ts)은 빌드 시 타입 확인용으로 남아 있으며, 런타임과 별개의 파일입니다. 해당 선언에도 Live2D 독점 소프트웨어 라이선스 헤더가 있으므로 원본 고지를 유지합니다. 타입 파일의 존재는 Core 사용 권한을 대신하지 않습니다.

## Cubism Framework — original notices retained

[vendor/cubism-framework](../packages/client/vendor/cubism-framework/)와 관련 shader에는 제3자 소스가 포함되어 있습니다. 기존 저작권 헤더와 [Framework 라이선스 안내](../packages/client/model-licenses/live2d-cubism-framework-license.md)를 유지했습니다.

[공식 Cubism Web Framework](https://github.com/Live2D/CubismWebFramework)의 라이선스와 사용·배포 조건을 확인해야 합니다. 이 문서는 Framework, Core, 모델을 하나의 동일한 라이선스 자산으로 취급하지 않습니다.

## 음성·모델·의존성

GPT-SoVITS와 faster-whisper는 연동 대상입니다. 개인 참조 음성, 음성 원본과 학습·추론 가중치는 포함하지 않습니다. Ollama 모델 및 embedding 모델도 별도로 준비하며 모델별 조건이 적용됩니다.

JavaScript·Python·Rust 의존성은 [package.json](../packages/client/package.json), [requirements.txt](../packages/brain/requirements.txt), [Cargo.toml](../packages/client/src-tauri/Cargo.toml)에 기재되어 있습니다. 설치되는 각 구성 요소의 라이선스·고지는 해당 배포물에 따릅니다.
