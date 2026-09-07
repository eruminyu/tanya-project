use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Local, TimeZone, Utc};
use keyring::Entry;
use rand::{distr::Alphanumeric, Rng};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::{Read, Write}, net::TcpListener, thread, time::{Duration as StdDuration, Instant}};
use url::Url;

const SERVICE: &str = "dev.tanya.client";
const ACCOUNT: &str = "google-oauth";
const RECEIPTS_ACCOUNT: &str = "google-write-receipts";
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const TASKS_SCOPE: &str = "https://www.googleapis.com/auth/tasks.readonly";
const CALENDAR_WRITE_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";
const TASKS_WRITE_SCOPE: &str = "https://www.googleapis.com/auth/tasks";
const CALENDAR_LIST_SCOPE: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const CLIENT_SECRET: Option<&str> = option_env!("TANYA_GOOGLE_CLIENT_SECRET");

fn client_secret() -> Result<&'static str, String> {
    CLIENT_SECRET.filter(|value| !value.trim().is_empty())
        .ok_or("이 Tanya 빌드에 Google Desktop OAuth Client Secret이 구성되지 않았습니다.".into())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredToken {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    scopes: Vec<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GoogleStatus {
    connected: bool,
    scopes: Vec<String>,
    email: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCreateRequest { request_id: String, title: String, start_at: String, end_at: String }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateRequest { request_id: String, title: String, due: Option<String> }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleWriteReceipt { request_id: String, provider_id: String, title: String, duplicate: bool }

fn credential() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|error| format!("Windows 자격 증명 저장소 초기화 실패: {error}"))
}

fn receipts_credential() -> Result<Entry, String> {
    Entry::new(SERVICE, RECEIPTS_ACCOUNT).map_err(|error| format!("Google 생성 기록 저장소 초기화 실패: {error}"))
}

fn load_receipts() -> Result<HashMap<String, GoogleWriteReceipt>, String> {
    match receipts_credential()?.get_password() {
        Ok(value) => serde_json::from_str(&value).map_err(|error| format!("Google 생성 기록 손상: {error}")),
        Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
        Err(error) => Err(format!("Google 생성 기록 읽기 실패: {error}")),
    }
}

fn save_receipt(receipt: &GoogleWriteReceipt) -> Result<(), String> {
    let mut receipts = load_receipts()?;
    receipts.insert(receipt.request_id.clone(), receipt.clone());
    let value = serde_json::to_string(&receipts).map_err(|error| error.to_string())?;
    receipts_credential()?.set_password(&value).map_err(|error| format!("Google 생성 기록 저장 실패: {error}"))
}

fn previous_receipt(request_id: &str) -> Result<Option<GoogleWriteReceipt>, String> {
    Ok(load_receipts()?.get(request_id).cloned().map(|mut receipt| { receipt.duplicate = true; receipt }))
}

fn load_token() -> Result<Option<StoredToken>, String> {
    let entry = credential()?;
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|error| format!("저장된 Google 인증 정보 손상: {error}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Google 인증 정보 읽기 실패: {error}")),
    }
}

fn save_token(token: &StoredToken) -> Result<(), String> {
    let value = serde_json::to_string(token).map_err(|error| error.to_string())?;
    credential()?.set_password(&value).map_err(|error| format!("Google 인증 정보 저장 실패: {error}"))
}

fn status_from(token: Option<StoredToken>) -> GoogleStatus {
    match token {
        Some(token) => GoogleStatus { connected: true, scopes: token.scopes, email: token.email },
        None => GoogleStatus { connected: false, scopes: Vec::new(), email: None },
    }
}

#[tauri::command]
pub fn google_status() -> Result<GoogleStatus, String> { load_token().map(status_from) }

#[tauri::command]
pub async fn google_connect(client_id: String, write_access: Option<bool>) -> Result<GoogleStatus, String> {
    let client_id = client_id.trim().to_owned();
    if client_id.is_empty() || !client_id.ends_with(".apps.googleusercontent.com") {
        return Err("Google Desktop OAuth Client ID 형식이 올바르지 않습니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || connect_blocking(client_id, write_access.unwrap_or(false)))
        .await.map_err(|error| format!("Google 로그인 작업 실패: {error}"))?
}

fn connect_blocking(client_id: String, write_access: bool) -> Result<GoogleStatus, String> {
    let client_secret = client_secret()?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("OAuth 콜백 포트 열기 실패: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let verifier: String = rand::rng().sample_iter(&Alphanumeric).take(64).map(char::from).collect();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state: String = rand::rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect();
    let mut requested_scopes = vec!["openid", "email", CALENDAR_SCOPE, TASKS_SCOPE];
    if write_access { requested_scopes.extend([CALENDAR_WRITE_SCOPE, TASKS_WRITE_SCOPE, CALENDAR_LIST_SCOPE]); }
    let scopes = requested_scopes.join(" ");
    let mut auth = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").map_err(|error| error.to_string())?;
    auth.query_pairs_mut()
        .append_pair("client_id", &client_id).append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code").append_pair("scope", &scopes)
        .append_pair("code_challenge", &challenge).append_pair("code_challenge_method", "S256")
        .append_pair("state", &state).append_pair("access_type", "offline").append_pair("prompt", "consent");
    open::that(auth.as_str()).map_err(|error| format!("시스템 브라우저 열기 실패: {error}"))?;

    let started = Instant::now();
    let callback = loop {
        if started.elapsed() > StdDuration::from_secs(300) { return Err("Google 로그인이 5분 안에 완료되지 않았습니다.".into()); }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0_u8; 8192];
                let read = stream.read(&mut buffer).map_err(|error| error.to_string())?;
                let request = String::from_utf8_lossy(&buffer[..read]);
                let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).ok_or("OAuth 콜백 요청을 해석할 수 없습니다.")?;
                let body = "<!doctype html><meta charset=utf-8><title>타냐</title><p>Google 승인 응답을 타냐에게 전달했습니다. 최종 연결 결과는 타냐 설정 창에서 확인해 주세요.</p>";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.as_bytes().len(), body);
                let _ = stream.write_all(response.as_bytes());
                break Url::parse(&format!("http://127.0.0.1{target}")).map_err(|error| error.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(StdDuration::from_millis(100)),
            Err(error) => return Err(format!("OAuth 콜백 수신 실패: {error}")),
        }
    };
    let values: std::collections::HashMap<_, _> = callback.query_pairs().into_owned().collect();
    if values.get("state") != Some(&state) { return Err("OAuth state 검증에 실패했습니다.".into()); }
    if let Some(error) = values.get("error") { return Err(format!("Google 로그인이 취소되거나 거부되었습니다: {error}")); }
    let code = values.get("code").ok_or("Google 인증 코드가 없습니다.")?;
    let client = Client::new();
    let response = client.post("https://oauth2.googleapis.com/token").form(&[
        ("client_id", client_id.as_str()), ("client_secret", client_secret), ("code", code.as_str()), ("code_verifier", verifier.as_str()),
        ("redirect_uri", redirect_uri.as_str()), ("grant_type", "authorization_code"),
    ]).send().map_err(|error| format!("Google 토큰 교환 실패: {error}"))?;
    let status = response.status();
    let response_body = response.text().map_err(|error| format!("Google 토큰 응답 읽기 실패: {error}"))?;
    if !status.is_success() { return Err(google_token_error(status.as_u16(), &response_body)); }
    let token_response: TokenResponse = serde_json::from_str(&response_body).map_err(|error| format!("Google 토큰 응답 해석 실패: {error}"))?;
    let granted = token_response.scope.unwrap_or_default().split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    let email = fetch_email(&client, &token_response.access_token).ok();
    let token = StoredToken {
        client_id, access_token: token_response.access_token,
        refresh_token: token_response.refresh_token.ok_or("Google refresh token이 발급되지 않았습니다. 연결을 해제한 뒤 다시 시도해 주세요.")?,
        expires_at: Utc::now().timestamp() + token_response.expires_in,
        scopes: granted, email,
    };
    save_token(&token)?;
    Ok(status_from(Some(token)))
}

fn fetch_email(client: &Client, access_token: &str) -> Result<String, String> {
    let value: Value = client.get("https://openidconnect.googleapis.com/v1/userinfo").bearer_auth(access_token).send().map_err(|e| e.to_string())?.json().map_err(|e| e.to_string())?;
    value.get("email").and_then(Value::as_str).map(str::to_owned).ok_or("Google 이메일을 확인할 수 없습니다.".into())
}

fn google_token_error(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let code = parsed.as_ref().and_then(|value| value.get("error")).and_then(Value::as_str).unwrap_or("unknown_error");
    let description = parsed.as_ref().and_then(|value| value.get("error_description")).and_then(Value::as_str).unwrap_or("Google에서 상세 설명을 제공하지 않았습니다.");
    format!("Google 토큰 교환 실패 ({status}): {code} — {description}")
}

fn valid_access_token() -> Result<StoredToken, String> {
    let mut token = load_token()?.ok_or("Google 계정이 연결되지 않았습니다.")?;
    if token.expires_at > Utc::now().timestamp() + 60 { return Ok(token); }
    let response = Client::new().post("https://oauth2.googleapis.com/token").form(&[
        ("client_id", token.client_id.as_str()), ("client_secret", client_secret()?), ("refresh_token", token.refresh_token.as_str()), ("grant_type", "refresh_token"),
    ]).send().map_err(|error| format!("Google 토큰 갱신 실패: {error}"))?;
    if !response.status().is_success() { return Err(format!("Google 토큰 갱신 실패 ({})", response.status())); }
    let refreshed: TokenResponse = response.json().map_err(|error| error.to_string())?;
    token.access_token = refreshed.access_token;
    token.expires_at = Utc::now().timestamp() + refreshed.expires_in;
    if let Some(scope) = refreshed.scope { token.scopes = scope.split_whitespace().map(str::to_owned).collect(); }
    save_token(&token)?;
    Ok(token)
}

fn has_scope(scopes: &[String], required_scope: &str) -> bool {
    scopes.iter().any(|scope| scope == required_scope)
        || (required_scope == CALENDAR_SCOPE && scopes.iter().any(|scope| scope == CALENDAR_WRITE_SCOPE))
        || (required_scope == TASKS_SCOPE && scopes.iter().any(|scope| scope == TASKS_WRITE_SCOPE))
}

fn api_array(url: &str, field: &str, required_scope: &str) -> Result<Vec<Value>, String> {
    let token = valid_access_token()?;
    if !has_scope(&token.scopes, required_scope) { return Err("필요한 Google 읽기 권한이 승인되지 않았습니다.".into()); }
    let response = Client::new().get(url).bearer_auth(&token.access_token).send().map_err(|error| format!("Google API 요청 실패: {error}"))?;
    if !response.status().is_success() { return Err(format!("Google API 요청 실패 ({})", response.status())); }
    let value: Value = response.json().map_err(|error| error.to_string())?;
    Ok(value.get(field).and_then(Value::as_array).cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn google_calendar_today() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let today = Local::now().date_naive();
        let start = Local.from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap()).earliest().ok_or("오늘 시작 시간을 계산할 수 없습니다.")?.with_timezone(&Utc).to_rfc3339();
        let end = Local.from_local_datetime(&(today + Duration::days(1)).and_hms_opt(0, 0, 0).unwrap()).earliest().ok_or("내일 시작 시간을 계산할 수 없습니다.")?.with_timezone(&Utc).to_rfc3339();
        let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events").unwrap();
        url.query_pairs_mut().append_pair("timeMin", &start).append_pair("timeMax", &end).append_pair("singleEvents", "true").append_pair("orderBy", "startTime");
        api_array(url.as_str(), "items", CALENDAR_SCOPE)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn google_tasks() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| api_array("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=false&showHidden=false", "items", TASKS_SCOPE))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn google_calendars() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| api_array("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer", "items", CALENDAR_LIST_SCOPE))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn google_task_lists() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| api_array("https://tasks.googleapis.com/tasks/v1/users/@me/lists", "items", TASKS_WRITE_SCOPE))
        .await.map_err(|error| error.to_string())?
}

fn collection_url(base: &str, id: &str, collection: &str) -> Result<String, String> {
    if id.trim().is_empty() { return Err("Google 대상 ID가 없습니다.".into()); }
    let mut url = Url::parse(base).map_err(|error| error.to_string())?;
    url.path_segments_mut().map_err(|_| "Google API URL을 구성할 수 없습니다.")?.pop_if_empty().push(id).push(collection);
    Ok(url.into())
}

fn validate_create(request_id: &str, title: &str) -> Result<(), String> {
    if request_id.trim().is_empty() { return Err("Google 생성 요청 ID가 없습니다.".into()); }
    if title.trim().is_empty() { return Err("Google에 생성할 제목이 없습니다.".into()); }
    Ok(())
}

fn post_google(url: &str, required_scope: &str, body: Value) -> Result<Value, String> {
    let token = valid_access_token()?;
    if !has_scope(&token.scopes, required_scope) { return Err("필요한 Google 생성 권한이 승인되지 않았습니다. 설정에서 생성 권한을 추가해 주세요.".into()); }
    let response = Client::new().post(url).bearer_auth(&token.access_token).json(&body).send().map_err(|error| format!("Google 생성 요청 실패: {error}"))?;
    let status = response.status();
    let response_body = response.text().map_err(|error| format!("Google 생성 응답 읽기 실패: {error}"))?;
    if !status.is_success() { return Err(format!("Google 생성 요청 실패 ({status}): {}", google_api_error(&response_body))); }
    serde_json::from_str(&response_body).map_err(|error| format!("Google 생성 응답 해석 실패: {error}"))
}

fn google_api_error(body: &str) -> String {
    serde_json::from_str::<Value>(body).ok()
        .and_then(|value| value.pointer("/error/message").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "Google에서 상세 설명을 제공하지 않았습니다.".into())
}

#[tauri::command]
pub async fn google_calendar_create(request: CalendarCreateRequest, calendar_id: Option<String>) -> Result<GoogleWriteReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_create(&request.request_id, &request.title)?;
        if let Some(receipt) = previous_receipt(&request.request_id)? { return Ok(receipt); }
        let start = chrono::DateTime::parse_from_rfc3339(&request.start_at).map_err(|_| "일정 시작 시간이 올바르지 않습니다.")?;
        let end = chrono::DateTime::parse_from_rfc3339(&request.end_at).map_err(|_| "일정 종료 시간이 올바르지 않습니다.")?;
        if end <= start { return Err("일정 종료 시간은 시작보다 뒤여야 합니다.".into()); }
        let url = collection_url("https://www.googleapis.com/calendar/v3/calendars/", calendar_id.as_deref().unwrap_or("primary"), "events")?;
        let value = post_google(&url, CALENDAR_WRITE_SCOPE, serde_json::json!({
            "summary": request.title.trim(), "start": { "dateTime": request.start_at }, "end": { "dateTime": request.end_at }
        }))?;
        let receipt = GoogleWriteReceipt { request_id: request.request_id, provider_id: value.get("id").and_then(Value::as_str).ok_or("Google 일정 ID가 없습니다.")?.to_owned(), title: request.title.trim().to_owned(), duplicate: false };
        save_receipt(&receipt)?;
        Ok(receipt)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn google_task_create(request: TaskCreateRequest, task_list_id: Option<String>) -> Result<GoogleWriteReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_create(&request.request_id, &request.title)?;
        if let Some(receipt) = previous_receipt(&request.request_id)? { return Ok(receipt); }
        let mut body = serde_json::json!({ "title": request.title.trim() });
        if let Some(due) = request.due.as_deref().filter(|value| !value.is_empty()) {
            chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").map_err(|_| "할 일 기한이 올바르지 않습니다.")?;
            body["due"] = Value::String(format!("{due}T00:00:00.000Z"));
        }
        let url = collection_url("https://tasks.googleapis.com/tasks/v1/lists/", task_list_id.as_deref().unwrap_or("@default"), "tasks")?;
        let value = post_google(&url, TASKS_WRITE_SCOPE, body)?;
        let receipt = GoogleWriteReceipt { request_id: request.request_id, provider_id: value.get("id").and_then(Value::as_str).ok_or("Google 할 일 ID가 없습니다.")?.to_owned(), title: request.title.trim().to_owned(), duplicate: false };
        save_receipt(&receipt)?;
        Ok(receipt)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn google_disconnect() -> Result<(), String> {
    match credential()?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(error) => return Err(format!("Google 연결 해제 실패: {error}")) }
    match receipts_credential()?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(error) => Err(format!("Google 생성 기록 삭제 실패: {error}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disconnected_status_has_no_scopes() {
        let status = status_from(None);
        assert!(!status.connected);
        assert!(status.scopes.is_empty());
    }

    #[test]
    fn token_error_exposes_google_code_without_tokens() {
        let message = google_token_error(400, r#"{"error":"invalid_grant","error_description":"Bad Request"}"#);
        assert_eq!(message, "Google 토큰 교환 실패 (400): invalid_grant — Bad Request");
    }

    #[test]
    fn write_scopes_also_allow_read_operations() {
        assert!(has_scope(&[CALENDAR_WRITE_SCOPE.to_owned()], CALENDAR_SCOPE));
        assert!(has_scope(&[TASKS_WRITE_SCOPE.to_owned()], TASKS_SCOPE));
        assert!(!has_scope(&[CALENDAR_SCOPE.to_owned()], CALENDAR_WRITE_SCOPE));
    }

    #[test]
    fn create_validation_rejects_missing_identity_and_title() {
        assert!(validate_create("", "회의").is_err());
        assert!(validate_create("request", " ").is_err());
        assert!(validate_create("request", "회의").is_ok());
    }

    #[test]
    fn canonical_utc_calendar_time_is_accepted() {
        assert!(chrono::DateTime::parse_from_rfc3339("2026-08-17T06:00:00.000Z").is_ok());
    }

    #[test]
    fn google_api_error_extracts_message_without_exposing_tokens() {
        assert_eq!(google_api_error(r#"{"error":{"message":"invalid time"}}"#), "invalid time");
    }

    #[test]
    fn google_target_ids_are_encoded_as_single_path_segments() {
        assert_eq!(collection_url("https://example.com/calendars/", "team/name@example.com", "events").unwrap(), "https://example.com/calendars/team%2Fname@example.com/events");
    }
}
