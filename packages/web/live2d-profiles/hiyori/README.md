# Hiyori 샘플 캐릭터 프로파일 (타냐 웹데모 전용)

- 모델 파일(`Hiyori.moc3`, `Hiyori.model3.json`, `Hiyori.physics3.json`, `Hiyori.2048/*.png`, `motions/*`)은 **Live2D Inc.의 샘플 자료**로 Live2D Free Material License를 따른다. 자료 파일 자체의 재배포(소재로서 배포)가 금지되므로 **비공개 저장소에만** `packages/web/live2d-samples/Hiyori/`로 둔다(2026-09-18 사용자 결정; 공개 스냅샷 `tools/public-snapshot/export.mjs`의 제외 목록에 포함). 빌드는 그 폴더를 먼저 찾고 없으면 `.cache/live2d-samples/Hiyori/`(Git 제외)를 쓰며, 둘 다 없으면 실패한다. 회사 PC의 사본은 한국어 샘플 페이지판 `hiyori_free_t08`을 CubismWebSamples 이름으로 옮긴 것이다(model3.json은 참조 경로만 변경).
- 자료 입수: Live2D 공식 샘플 데이터 페이지(https://www.live2d.com/en/learn/sample/) 또는 공식 `Live2D/CubismWebSamples` 저장소 `Samples/Resources/Hiyori`. 다운로드 시 약관 동의와 다운로드 페이지가 지정한 저작권 표기가 필요하다.
- 이 폴더의 `emotions/*.exp3.json`은 앱이 작성한 파라미터 프리셋(표준 Cubism 파라미터 id)이며 Live2D 자료가 아니다.
- 표기: 웹 고지 페이지(`packages/web/notices/tanya.html`)에 "Hiyori Momose © Live2D Inc." 를 둔다.
