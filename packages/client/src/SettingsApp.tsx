import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_CLIENT_SETTINGS, parseClientSettings, serializeClientSettings, CLIENT_SETTINGS_STORAGE_KEY, type ClientSettings } from "./client-settings";
import { APP_SETTINGS_STORAGE_KEY, createSettingsChangedPayload, DEFAULT_APP_SETTINGS, parseAppSettings, serializeAppSettings, SETTINGS_CHANGED_EVENT, type AppSettings, type LlmRoleSettings } from "./settings-schema";
import { googleCapability, googleRuntime, type GoogleConnection, type GoogleTarget } from "./google-integration";
import { resolveGoogleClientId } from "./google-client-config";
import { BrainConnectionPanel } from "./BrainConnectionPanel";
import { runBrainDiagnosis, type BrainDiagnosis } from "./brain-url";
import { BRAIN_RECONNECT_EVENT } from "./settings-schema";
import { Live2DFramingControls } from "./Live2DFramingControls";

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="settings-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function LlmFields({ title, value, onChange }: { title: string; value: LlmRoleSettings; onChange(value: LlmRoleSettings): void }) {
  const update = (key: keyof LlmRoleSettings, next: string) => onChange({ ...value, [key]: next });
  return <fieldset className="llm-fields"><legend>{title}</legend>
    <label>Provider<input value={value.provider} onChange={(event) => update("provider", event.target.value)} /></label>
    <label>Model<input value={value.model} onChange={(event) => update("model", event.target.value)} placeholder="Brain 기본값 사용" /></label>
    <label>Endpoint<input value={value.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="비워두면 Brain 설정 사용" /></label>
  </fieldset>;
}

export function SettingsApp() {
  const [settings, setSettings] = useState(() => parseAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)));
  const [client, setClient] = useState(() => parseClientSettings(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)));
  const [google, setGoogle] = useState<GoogleConnection>({ connected: false, scopes: [] });
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const [calendars, setCalendars] = useState<GoogleTarget[]>([]);
  const [taskLists, setTaskLists] = useState<GoogleTarget[]>([]);
  const [diagnosis, setDiagnosis] = useState<BrainDiagnosis | null>(null);
  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  useEffect(() => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, serializeAppSettings(settings));
    localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, serializeClientSettings(client));
    if (isTauri()) void emit(SETTINGS_CHANGED_EVENT, createSettingsChangedPayload(settings, client))
      .catch((error) => console.error("설정 변경 알림 실패", error));
  }, [settings, client]);
  useEffect(() => { if (isTauri()) void googleRuntime.status().then((status) => { setGoogle(status); if (googleCapability(status.scopes).targetSelection) void loadGoogleTargets(); }).catch(() => undefined); }, []);
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const updateClient = (key: keyof ClientSettings, value: number) => setClient((current) => ({ ...current, [key]: value }));
  const googleAccess = googleCapability(google.scopes);
  const googleClientId = resolveGoogleClientId(import.meta.env.VITE_GOOGLE_CLIENT_ID, settings.googleClientId);
  async function loadGoogleTargets() {
    try { const [nextCalendars, nextTaskLists] = await Promise.all([googleRuntime.calendars(), googleRuntime.taskLists()]); setCalendars(nextCalendars); setTaskLists(nextTaskLists); }
    catch (error) { setGoogleError(error instanceof Error ? error.message : String(error)); }
  }
  async function testBrainConnection() {
    setDiagnosisBusy(true);
    try { setDiagnosis(await runBrainDiagnosis(settings.brainUrl)); }
    finally { setDiagnosisBusy(false); }
  }
  async function requestReconnect() {
    if (!isTauri()) return;
    try { await emit(BRAIN_RECONNECT_EVENT); }
    catch (error) { console.error("재연결 요청 실패", error); }
  }
  async function connectGoogle(writeAccess = false) {
    setGoogleBusy(true); setGoogleError("");
    try { const status = await googleRuntime.connect(googleClientId, writeAccess); setGoogle(status); if (googleCapability(status.scopes).targetSelection) await loadGoogleTargets(); }
    catch (error) { setGoogleError(error instanceof Error ? error.message : String(error)); }
    finally { setGoogleBusy(false); }
  }
  async function disconnectGoogle() {
    setGoogleBusy(true); setGoogleError("");
    try { await googleRuntime.disconnect(); setGoogle({ connected: false, scopes: [] }); }
    catch (error) { setGoogleError(error instanceof Error ? error.message : String(error)); }
    finally { setGoogleBusy(false); }
  }

  return <main className="settings-window">
    <header className="settings-titlebar"><div><strong>타냐 설정</strong><span>일상 경험과 연결을 관리해</span></div><button onClick={() => void getCurrentWindow().close()} aria-label="설정 닫기">×</button></header>
    <div className="settings-content">
      <section><h2>외형과 위치</h2><Toggle label="항상 위에 표시" checked={settings.alwaysOnTop} onChange={(value) => update("alwaysOnTop", value)} /><Toggle label="전체 화면 앱에서 자동 숨김" checked={settings.autoHideFullscreen} onChange={(value) => update("autoHideFullscreen", value)} /><Toggle label="가까운 마우스 시선 추적" checked={settings.gazeTracking} onChange={(value) => update("gazeTracking", value)} />
        <Live2DFramingControls
          framing={{ scale: client.live2dScale, offsetX: client.live2dOffsetX, offsetY: client.live2dOffsetY }}
          onChange={(framing) => setClient((current) => ({
            ...current,
            live2dScale: framing.scale,
            live2dOffsetX: framing.offsetX,
            live2dOffsetY: framing.offsetY,
          }))}
        />
      </section>
      <section><h2>음성 및 립싱크</h2><Toggle label="말하는 중 자막 표시" checked={settings.captions} onChange={(value) => update("captions", value)} />
        <label className="range-row">립싱크 민감도 <output>{client.lipSyncSensitivity.toFixed(1)}</output><input type="range" min="1" max="10" step="0.1" value={client.lipSyncSensitivity} onChange={(event) => updateClient("lipSyncSensitivity", Number(event.target.value))} /></label>
        <label className="range-row">입 움직임 부드러움 <output>{Math.round(client.lipSyncSmoothing * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={client.lipSyncSmoothing} onChange={(event) => updateClient("lipSyncSmoothing", Number(event.target.value))} /></label>
      </section>
      <section><h2>단축키</h2><label className="text-row">상호작용<input value={settings.interactionShortcut} readOnly /></label><label className="text-row">PTT<input value={settings.pttShortcut} readOnly /></label></section>
      <section><h2>선제 제안과 방해 금지</h2><Toggle label="타냐의 선제 제안" checked={settings.proactiveSuggestions} onChange={(value) => update("proactiveSuggestions", value)} /><Toggle label="방해 금지" checked={settings.dndEnabled} onChange={(value) => update("dndEnabled", value)} /></section>
      <details><summary>Brain 연결 및 진단</summary>
        <BrainConnectionPanel
          url={settings.brainUrl}
          busy={diagnosisBusy}
          result={diagnosis}
          canReconnect={isTauri()}
          onUrlChange={(value) => { update("brainUrl", value); setDiagnosis(null); }}
          onTest={() => void testBrainConnection()}
          onReconnect={() => void requestReconnect()}
        />
      </details>
      <details><summary>일상용·작업용 LLM</summary><LlmFields title="일상 대화" value={settings.casualLlm} onChange={(value) => update("casualLlm", value)} /><LlmFields title="작업 실행" value={settings.taskLlm} onChange={(value) => update("taskLlm", value)} /></details>
      <details><summary>Google 계정</summary><p className="settings-note">한 번 연결하면 같은 계정에서 Google Calendar 일정과 Google Tasks 할 일을 함께 불러옵니다.</p>
        {google.connected ? <><p className="settings-note">연결됨{google.email ? ` · ${google.email}` : ""}<br />일정 조회 {googleAccess.calendar ? "허용" : "미허용"} · 할 일 조회 {googleAccess.tasks ? "허용" : "미허용"}<br />일정 생성 {googleAccess.calendarWrite ? "허용" : "미허용"} · 할 일 생성 {googleAccess.tasksWrite ? "허용" : "미허용"}</p>{(!googleAccess.calendarWrite || !googleAccess.tasksWrite) && <button onClick={() => void connectGoogle(true)} disabled={googleBusy || !googleClientId}>일정·할 일 생성 권한 추가</button>} <button onClick={() => void disconnectGoogle()} disabled={googleBusy}>연결 해제</button></>
          : <><button className="google-login-button" onClick={() => void connectGoogle(false)} disabled={googleBusy || !googleClientId || !isTauri()}><span aria-hidden="true">G</span>{googleBusy ? "Google 로그인 기다리는 중…" : "Google로 로그인"}</button>{!googleClientId && <p className="settings-note">이 개발 빌드에는 Google OAuth Client ID가 설정되지 않았습니다. <code>VITE_GOOGLE_CLIENT_ID</code>를 구성한 뒤 다시 빌드해 주세요.</p>}</>}
        {googleError && <p className="settings-error" role="alert">{googleError}</p>}
        {google.connected && googleAccess.calendarWrite && googleAccess.tasksWrite && !googleAccess.targetSelection && <p className="settings-note"><button onClick={() => void connectGoogle(true)} disabled={googleBusy}>대상 목록 선택 권한 추가</button></p>}
        {googleAccess.targetSelection && <div className="google-targets">
          <label>기본 Calendar<select value={settings.googleCalendarId} onChange={(event) => update("googleCalendarId", event.target.value)}><option value="primary">기본 캘린더</option>{calendars.filter((item) => item.id !== "primary").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>기본 Task 목록<select value={settings.googleTaskListId} onChange={(event) => update("googleTaskListId", event.target.value)}><option value="@default">기본 목록</option>{taskLists.filter((item) => item.id !== "@default").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>}
      </details>
    </div>
    <footer><button onClick={() => { setSettings(structuredClone(DEFAULT_APP_SETTINGS)); setClient({ ...DEFAULT_CLIENT_SETTINGS }); }}>기본값 복원</button></footer>
  </main>;
}
