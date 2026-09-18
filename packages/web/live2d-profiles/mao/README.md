# Mao 샘플 캐릭터 프로파일 (타냐 웹데모 기본)

- 모델 파일(`mao_pro.moc3`, `mao_pro.model3.json`, `mao_pro.physics3.json`, `mao_pro.pose3.json`, `mao_pro.2048/*.png`, `expressions/*`, `motions/*`)은 **Live2D Inc.의 샘플 자료 "니지이로 마오(프로 버전)"**로 Live2D Free Material License를 따른다. 자료 파일 자체의 재배포가 금지되므로 **비공개 저장소에만** `packages/web/live2d-samples/Mao/`로 둔다(공개 스냅샷 `tools/public-snapshot/export.mjs`가 `live2d-samples/` 전체를 제외). 원본 `mao_ko.zip`(2026-09-18 사용자 제공)의 `runtime/`을 그대로 옮기되, 4096px 텍스처(8MB)는 웹 전송을 위해 2048px(2.7MB)로 축소하고 `model3.json`의 텍스처 경로만 바꿨다. 에디터 파일(`.cmo3`, `.can3`)은 넣지 않는다.
- 자료 입수: Live2D 공식 샘플 데이터 페이지(https://www.live2d.com/ko/download/sample-data/) — 약관 동의 필요.
- 렌더러: 모델의 `pose3.json`(팔 A/B 그룹 배타)을 적용하도록 공용 `cubism-renderer.ts`가 Pose를 읽는다. 립싱크 파라미터는 모델의 LipSync 그룹 `ParamA`(`ParamMouthOpenY` 없음).
- `emotions/*.exp3.json`은 앱이 작성한 파라미터 프리셋(`ParamMouthUp/Down/Angry`, `ParamEyeLSmile`, `ParamCheek`, `ParamBrow*`, `ParamEyeEffect`)이며 Live2D 자료가 아니다. 모델 동봉 `expressions/exp_0x`는 쓰지 않는다.
- 히요리로 되돌리려면 `WEB_SAMPLE_CHARACTER=hiyori`로 빌드하고 `profile.ts`의 tanya 항목을 `characterDir: 'hiyori', manifest: hiyoriManifest`로 바꾼다.
- 표기: 웹 고지 페이지(`packages/web/notices/tanya.html`)에 "Mao © Live2D Inc." 를 둔다.
