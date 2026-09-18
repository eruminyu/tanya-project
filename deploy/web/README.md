# Kirian 공개 웹 데모 배포

VM에 두 서비스를 올린다. 도메인·TLS·외부 라우팅은 이 절차 밖이다(기존 Cloudflare 프록시 도메인을 8090으로 연결).

| 서비스 | 유닛 | 주소 | 역할 |
| --- | --- | --- | --- |
| 공개 Brain | `kirian-public-brain.service` | `127.0.0.1:8099` | `public_demo` 모드, 무상태, 서버 Ollama·TTS만 사용 |
| 게이트웨이 | `kirian-web-gateway.service` | `0.0.0.0:8090` | 정적 웹, 방문자 토큰, Brain WS 프록시, 요청 제한 |

개인 PC의 Brain·기존 `tanya-*`·`kirian-stt/tts` 서비스와 데이터는 건드리지 않는다. 방문자 대화는 저장되지 않는다.

## 1. PC에서 릴리스 만들기

```powershell
npm --prefix packages/web run build
npm --prefix packages/web-gateway run bundle
node deploy/web/prepare_release.mjs
```

`.cache/web-release-<날짜>/`에 `gateway/`(단일 파일 번들), `web/`(정적 빌드·Live2D 자산), `brain/`(rearchitecture 소스·고정 requirements), `contracts/`(Python 패키지), `deploy/`(유닛·env 예제·`public-host.json`·`install.sh`·`qwen3-tts/` 음성 서비스), `SHA256SUMS`가 생긴다. 음성은 Qwen3-TTS 기본 음성 `Sohee`(`deploy/qwen3-tts/README.md`)라 `public-host.json`에 참조 음성 항목이 없다.

## 2. VM에 올리고 설치 (kirian 계정, sudo 없음)

```sh
scp -r .cache/web-release-<날짜> kirian@<server>:/home/kirian/web-release-<날짜>
ssh kirian@<server> 'bash /home/kirian/web-release-<날짜>/deploy/install.sh'
```

`install.sh`는 SHA 대조 후 ① `~/.local/node`에 Node v24.21.0(nodejs.org 공식 tarball, SHASUMS256 대조) ② `~/.venvs/kirian-public-brain` venv(고정 requirements + contracts) ③ `~/kirian-web/releases/<이름>`과 `current` 링크 ④ `brain-token`(최초 1회 생성, 0600)·`brain.env`·`gateway.env`·`public-host.json`(있으면 보존)을 준비하고 ⑤ 이 venv로 Brain 설정을 실제로 읽어 확인한다.

## 3. 관리자 1회 등록

음성 서비스가 먼저 필요하다: `bash ~/kirian-web/current/deploy/qwen3-tts/install.sh` 뒤 그 출력의 `kirian-qwen3-tts.service` 등록(19882). 기존 `kirian-tts-cpufast`(19881, GPT-SoVITS)는 이 데모가 쓰지 않는다.

```sh
sudo cp ~/kirian-web/current/deploy/kirian-public-brain.service ~/kirian-web/current/deploy/kirian-web-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kirian-public-brain.service kirian-web-gateway.service
curl -s http://127.0.0.1:8090/demo/health
```

새 릴리스 뒤에는 `install.sh` 재실행 → `sudo systemctl restart kirian-public-brain kirian-web-gateway`.

## 4. 운영 값

`gateway.env`: IP당 시간당 세션 20, 동시 세션 2, 전체 동시 세션 40, 동시 생성 2(GPU 1대), 세션당 30턴, 메시지 500자, 유휴 10분, 세션 60분. Cloudflare 뒤이므로 `KIRIAN_GATEWAY_TRUST_PROXY=1`(방문자 주소는 `cf-connecting-ip`). 상태: `GET /demo/health`.

## 5. 캘린더 실행 방식

- **handoff(기본):** 승인한 초안을 Google 캘린더 "미리 채운 일정" 링크와 `.ics`로 방문자에게 건넨다. 서버는 아무것도 쓰지 않는다.
- **google_demo:** 승인한 초안을 **데모 계정의 전용 공개 캘린더**에 실제로 만들고(데스크톱과 같은 `GoogleCalendarAccount`, 실행 표식 재조회로 증명), 영수증에 일정 ID·재조회 결과·Google 링크를, 페이지에는 "공개 데모 캘린더" 목록(`GET /demo/calendar`)을 보여준다. 방문자 문구가 공개되므로 제목에 `[데모] ` 접두사를 붙이고 `KIRIAN_GATEWAY_GOOGLE_DEMO_CLEANUP_MINUTES`(기본 60분) 뒤 자동 삭제하며, 서비스 시작 시 남아 있는 `[데모]` 일정을 모두 지운다. **개인 계정·개인 캘린더는 절대 쓰지 않는다.**

google_demo 준비(운영자, PC에서 1회):

```powershell
npm --prefix packages/web-gateway run build
npm --prefix packages/web-gateway run authorize -- --client-id <OAuth 클라이언트 ID> --client-secret <시크릿> --out .cache/google-demo-credential.json
```

OAuth 클라이언트는 반드시 **"데스크톱 앱"** 유형(JSON의 `installed` 키)이어야 한다 — "웹 애플리케이션" 유형은 등록된 리다이렉트 URI만 허용해 CLI의 loopback 임의 포트를 거부한다(`redirect_uri_mismatch`). 출력된 주소를 브라우저에서 열어 **데모 계정**으로 로그인·허용하면 자격증명 파일이 생기고 쓰기 가능한 캘린더 ID 목록이 출력된다. 데모 전용 캘린더를 만들어(또는 전용 계정이면 기본 캘린더) Google 캘린더 설정에서 **"공개 사용 설정(모든 사용자가 볼 수 있음)"**을 켜고, 캘린더 시간대가 `Asia/Seoul`인지 확인한다(도구 설명이 캘린더 시간대로 오프셋을 지시하므로 UTC면 시각이 어긋난다). 공개 여부는 `curl -s -o /dev/null -w "%{http_code}" "https://calendar.google.com/calendar/ical/<캘린더 ID URL 인코딩>/public/basic.ics"`가 200이면 된다. 자격증명 파일을 VM `~/kirian-web/google-demo-credential.json`(0600)로 옮기고 `gateway.env`의 `KIRIAN_GATEWAY_EXECUTOR=google_demo`와 캘린더 ID를 설정한 뒤 게이트웨이를 재시작한다. 토큰 갱신은 게이트웨이가 같은 파일에 다시 쓴다. 파일·시크릿은 Git과 출력에 넣지 않는다.
