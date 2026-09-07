#[cfg(desktop)]
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

#[cfg(desktop)]
mod google;
#[cfg(desktop)]
mod fullscreen;

#[cfg(desktop)]
const TOGGLE_CHAT_PANEL_EVENT: &str = "tanya://toggle-chat-panel";
#[cfg(desktop)]
const VOICE_PTT_EVENT: &str = "tanya://voice-ptt";

#[cfg(desktop)]
#[derive(Clone, Debug, serde::Serialize)]
struct ShortcutStatus {
    available: bool,
    accelerator: &'static str,
    error: Option<String>,
}

#[cfg(desktop)]
struct ShortcutRegistryState(Mutex<Vec<ShortcutStatus>>);

#[cfg(desktop)]
struct AutoHideFullscreenState(Arc<AtomicBool>);

#[cfg(desktop)]
#[tauri::command]
fn set_auto_hide_fullscreen(enabled: bool, state: tauri::State<'_, AutoHideFullscreenState>) {
    state.0.store(enabled, Ordering::Relaxed);
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, serde::Serialize)]
struct VoicePttPayload {
    pressed: bool,
}

#[cfg(desktop)]
fn voice_ptt_payload(pressed: bool) -> VoicePttPayload {
    VoicePttPayload { pressed }
}

#[cfg(desktop)]
#[tauri::command]
fn shortcut_status(state: tauri::State<'_, ShortcutRegistryState>) -> Result<Vec<ShortcutStatus>, String> {
    state.0.lock().map(|status| status.clone()).map_err(|_| "단축키 상태를 읽을 수 없습니다.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            google::google_status,
            google::google_connect,
            google::google_disconnect,
            google::google_calendar_today,
            google::google_tasks,
            google::google_calendar_create,
            google::google_task_create,
            google::google_calendars,
            google::google_task_lists,
            shortcut_status,
            set_auto_hide_fullscreen,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            let statuses = register_global_shortcuts(app);
            for status in &statuses {
                if let Some(error) = &status.error {
                    eprintln!("[shortcut] {} 등록 실패, 화면 조작으로 계속 실행합니다: {error}", status.accelerator);
                }
            }
            app.manage(ShortcutRegistryState(Mutex::new(statuses)));
            let auto_hide_fullscreen = Arc::new(AtomicBool::new(false));
            app.manage(AutoHideFullscreenState(auto_hide_fullscreen.clone()));
            start_fullscreen_watcher(app.handle().clone(), auto_hide_fullscreen);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("타냐 클라이언트 실행 중 오류가 발생했습니다.");
}

#[cfg(target_os = "windows")]
fn start_fullscreen_watcher(app: tauri::AppHandle, enabled: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let Some(window) = app.get_webview_window("main") else { return; };
        let Ok(own_window) = window.hwnd() else { return; };
        let mut hidden_by_fullscreen = false;
        loop {
            let should_hide = enabled.load(Ordering::Relaxed)
                && fullscreen::is_foreground_fullscreen(own_window);
            if should_hide && !hidden_by_fullscreen {
                if window.hide().is_ok() {
                    hidden_by_fullscreen = true;
                }
            } else if !should_hide && hidden_by_fullscreen {
                if window.show().is_ok() {
                    hidden_by_fullscreen = false;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn start_fullscreen_watcher(_app: tauri::AppHandle, _enabled: Arc<AtomicBool>) {}

#[cfg(desktop)]
fn register_global_shortcuts(
    app: &mut tauri::App,
) -> Vec<ShortcutStatus> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let toggle_chat = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    let voice_ptt = Shortcut::new(Some(Modifiers::ALT), Code::KeyV);
    let handled_toggle_chat = toggle_chat.clone();
    let handled_voice_ptt = voice_ptt.clone();
    let plugin_result = app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &handled_toggle_chat && event.state() == ShortcutState::Pressed {
                    if let Err(error) = app.emit(TOGGLE_CHAT_PANEL_EVENT, ()) {
                        eprintln!("[shortcut] 채팅 패널 토글 이벤트 전송 실패: {error}");
                    }
                } else if shortcut == &handled_voice_ptt {
                    let pressed = event.state() == ShortcutState::Pressed;
                    if let Err(error) = app.emit(VOICE_PTT_EVENT, voice_ptt_payload(pressed)) {
                        eprintln!("[shortcut] 음성 PTT 이벤트 전송 실패: {error}");
                    }
                }
            })
            .build(),
    );
    if let Err(error) = plugin_result {
        let message = error.to_string();
        return vec![
            ShortcutStatus { available: false, accelerator: "Ctrl+Space", error: Some(message.clone()) },
            ShortcutStatus { available: false, accelerator: "Alt+V", error: Some(message) },
        ];
    }

    let shortcuts = app.global_shortcut();
    let register = |shortcut, accelerator| match shortcuts.register(shortcut) {
        Ok(()) => ShortcutStatus { available: true, accelerator, error: None },
        Err(error) => ShortcutStatus { available: false, accelerator, error: Some(error.to_string()) },
    };
    vec![register(toggle_chat, "Ctrl+Space"), register(voice_ptt, "Alt+V")]
}

#[cfg(all(test, desktop))]
mod tests {
    use super::voice_ptt_payload;

    #[test]
    fn voice_ptt_payload_distinguishes_press_and_release() {
        assert!(voice_ptt_payload(true).pressed);
        assert!(!voice_ptt_payload(false).pressed);
    }
}
