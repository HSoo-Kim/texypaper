//! A single on-demand view of the main window's chat controller. This module never
//! opens a workspace, boots a provider, or executes a chat action itself.
use crate::contracts::{AppError, AppResult};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WindowEvent};

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_ACTION_BYTES: usize = 512 * 1024;
const EVENT: &str = "texypaper:chat";
const STATE_EVENT: &str = "texypaper:chat-state";

struct Session {
    id: String,
    revision: u64,
    sequence: u64,
    scope: Option<(String, u64)>,
}
pub struct ChatWindowState {
    profile: PathBuf,
    session: Mutex<Option<Session>>,
    closed: tokio::sync::Notify,
}
impl ChatWindowState {
    pub fn new(profile: PathBuf) -> Self {
        Self {
            profile,
            session: Mutex::new(None),
            closed: tokio::sync::Notify::new(),
        }
    }
}
fn denied(message: &str) -> AppError {
    AppError::new("CHAT_WINDOW_DENIED", message)
}
fn window_error(error: tauri::Error) -> AppError {
    AppError::new("CHAT_WINDOW_FAILED", error.to_string())
}
fn role(window: &WebviewWindow, expected: &str) -> AppResult<()> {
    if window.label() != expected {
        return Err(denied("This command is not available to this window"));
    }
    Ok(())
}
fn bounded_text(value: &Value, key: &str, maximum: usize) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() <= maximum)
}
fn valid_session(session: &str) -> bool {
    !session.is_empty()
        && session.len() <= 64
        && session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn lock(state: &ChatWindowState) -> AppResult<std::sync::MutexGuard<'_, Option<Session>>> {
    state
        .session
        .lock()
        .map_err(|_| denied("Chat window state is unavailable"))
}
fn active<'a>(state: &'a mut Option<Session>, id: &str) -> AppResult<&'a mut Session> {
    state
        .as_mut()
        .filter(|session| session.id == id)
        .ok_or_else(|| denied("The chat window session has ended"))
}

#[tauri::command]
pub async fn chat_window_open(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
    session: String,
) -> AppResult<()> {
    role(&window, "main")?;
    if !valid_session(&session) {
        return Err(denied("Invalid chat window session"));
    }
    {
        let mut stored = lock(&state)?;
        if let Some(current) = stored.as_ref() {
            if current.id != session {
                return Err(denied("Another chat window is already open"));
            }
            if let Some(chat) = app.get_webview_window("chat") {
                chat.set_focus().map_err(window_error)?;
                return Ok(());
            }
            return Err(denied("The chat window is still opening"));
        }
        *stored = Some(Session {
            id: session.clone(),
            revision: 0,
            sequence: 0,
            scope: None,
        });
    }
    let allowed_origin = window.url().map_err(window_error)?.origin();
    let built = tauri::WebviewWindowBuilder::new(
        &app,
        "chat",
        WebviewUrl::App("index.html?view=chat".into()),
    )
    .title("TexyPaper — AI")
    .inner_size(600.0, 800.0)
    .min_inner_size(360.0, 480.0)
    .decorations(true)
    .resizable(true)
    .visible(false)
    .focused(false)
    .disable_drag_drop_handler()
    .data_directory(state.profile.clone())
    .on_navigation(move |url| {
        url.origin() == allowed_origin
            && matches!(url.path(), "/" | "/index.html")
            && url.query() == Some("view=chat")
    })
    .build();
    let chat = match built {
        Ok(chat) => chat,
        Err(error) => {
            *lock(&state)? = None;
            return Err(AppError::new("CHAT_WINDOW_FAILED", error.to_string()));
        }
    };
    let handle = app.clone();
    let event_session = session.clone();
    chat.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            // Let the view flush its ordered draft actions before docking. A broken
            // webview still closes after the bounded fallback below.
            api.prevent_close();
            let _ = handle.emit_to("chat", "texypaper:chat-close-requested", &event_session);
            let app = handle.clone();
            let id = event_session.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                let state = app.state::<ChatWindowState>();
                let current = lock(&state)
                    .is_ok_and(|stored| stored.as_ref().is_some_and(|session| session.id == id));
                if current && let Some(chat) = app.get_webview_window("chat") {
                    let _ = chat.destroy();
                }
            });
        }
        WindowEvent::Destroyed => {
            let state = handle.state::<ChatWindowState>();
            if let Ok(mut stored) = lock(&state)
                && stored
                    .as_ref()
                    .is_some_and(|session| session.id == event_session)
            {
                *stored = None;
                state.closed.notify_waiters();
                let _ = handle.emit_to(
                    "main",
                    EVENT,
                    json!({ "kind": "closed", "session": event_session }),
                );
            }
        }
        _ => {}
    });
    // Creation can overlap main-window close. Decide visibility on the UI thread,
    // after registration, so a late child cannot reappear over a hidden workspace.
    let (shown, result) = tokio::sync::oneshot::channel();
    let owner = app.clone();
    app.run_on_main_thread(move || {
        let outcome = (|| -> tauri::Result<()> {
            if !crate::tray::is_exiting(&owner)
                && let Some(main) = owner.get_webview_window("main")
                && main.is_visible()?
            {
                chat.show()?;
                chat.set_focus()?;
            }
            Ok(())
        })();
        if outcome.is_err() {
            let _ = chat.destroy();
        }
        let _ = shown.send(outcome);
    })
    .map_err(window_error)?;
    result
        .await
        .map_err(|_| denied("Chat visibility request was interrupted"))?
        .map_err(window_error)?;
    Ok(())
}

#[tauri::command]
pub async fn chat_window_focus(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
    session: String,
) -> AppResult<()> {
    role(&window, "main")?;
    {
        let mut stored = lock(&state)?;
        active(&mut stored, &session)?;
    }
    let chat = app
        .get_webview_window("chat")
        .ok_or_else(|| denied("The chat window is closed"))?;
    chat.show().map_err(window_error)?;
    chat.unminimize().map_err(window_error)?;
    chat.set_focus().map_err(window_error)?;
    Ok(())
}

#[tauri::command]
pub async fn chat_window_dock(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
    session: String,
) -> AppResult<()> {
    role(&window, "main")?;
    {
        let mut stored = lock(&state)?;
        if stored.is_none() {
            return Ok(());
        }
        active(&mut stored, &session)?;
    }
    let closed = state.closed.notified();
    tokio::pin!(closed);
    closed.as_mut().enable();
    if let Some(chat) = app.get_webview_window("chat") {
        chat.destroy().map_err(window_error)?;
        // Resolve docking only after the old webview has actually gone away, so
        // an immediate detach cannot race a still-registered `chat` label.
        tokio::time::timeout(std::time::Duration::from_secs(3), closed)
            .await
            .map_err(|_| denied("The chat window did not finish closing"))?;
        return Ok(());
    }
    let mut stored = lock(&state)?;
    if stored.as_ref().is_some_and(|current| current.id == session) {
        *stored = None;
        state.closed.notify_waiters();
        app.emit_to(
            "main",
            EVENT,
            json!({ "kind": "closed", "session": session }),
        )
        .map_err(window_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn chat_window_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
) -> AppResult<Value> {
    role(&window, "chat")?;
    let (session, sequence) = {
        let stored = lock(&state)?;
        let current = stored
            .as_ref()
            .ok_or_else(|| denied("No detached chat session is active"))?;
        (current.id.clone(), current.sequence)
    };
    app.emit_to(
        "main",
        EVENT,
        json!({ "kind": "ready", "session": session }),
    )
    .map_err(window_error)?;
    Ok(json!({ "session": session, "sequence": sequence }))
}

fn valid_action(action: &Value) -> bool {
    let Some(object) = action.as_object() else {
        return false;
    };
    let Some(kind) = action.get("type").and_then(Value::as_str) else {
        return false;
    };
    let keys = |expected: &[&str]| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    };
    match kind {
        "send" | "cancel" | "refresh" | "login" | "open-login" | "save-executable"
        | "dismiss-error" | "detach" | "dock" | "focus" => keys(&["type"]),
        "prompt" => keys(&["type", "value"]) && bounded_text(action, "value", 262144),
        "disclosure" | "settings" => keys(&["type", "value"]) && action["value"].is_boolean(),
        "provider" => {
            keys(&["type", "value"]) && matches!(action["value"].as_str(), Some("claude" | "codex"))
        }
        "model" => keys(&["type", "value"]) && bounded_text(action, "value", 2048),
        "executable" => keys(&["type", "value"]) && bounded_text(action, "value", 16384),
        "history" => keys(&["type", "page"]) && bounded_text(action, "page", 16384),
        "reading-position" => {
            keys(&["type", "value"]) && crate::state::valid_chat_reading_position(&action["value"])
        }
        "undo" => keys(&["type", "id"]) && bounded_text(action, "id", 1024) && action["id"] != "",
        "decide" => {
            keys(&["type", "id", "decision"])
                && bounded_text(action, "id", 1024)
                && action["id"] != ""
                && matches!(action["decision"].as_str(), Some("apply" | "reject"))
        }
        "execution-permission" => {
            (keys(&["type", "value"])
                || (keys(&["type", "value", "acknowledged"])
                    && action["acknowledged"].is_boolean()))
                && matches!(action["value"].as_str(), Some("deny" | "ask" | "session"))
        }
        "execution-decide" => {
            keys(&["type", "id", "decision"])
                && bounded_text(action, "id", 1024)
                && action["id"] != ""
                && matches!(action["decision"].as_str(), Some("approve" | "reject"))
        }
        "execution-cancel" => {
            keys(&["type", "id"]) && bounded_text(action, "id", 1024) && action["id"] != ""
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn chat_window_action(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
    frame: Value,
) -> AppResult<()> {
    role(&window, "chat")?;
    if serde_json::to_vec(&frame)?.len() > MAX_ACTION_BYTES || !valid_action(&frame["action"]) {
        return Err(denied("Invalid or oversized chat action"));
    }
    let id = frame["session"]
        .as_str()
        .ok_or_else(|| denied("Missing chat session"))?;
    let sequence = frame["sequence"]
        .as_u64()
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or_else(|| denied("Invalid action sequence"))?;
    let workspace = frame["workspaceId"]
        .as_str()
        .ok_or_else(|| denied("Missing workspace identity"))?;
    let epoch = frame["epoch"]
        .as_u64()
        .ok_or_else(|| denied("Missing workspace epoch"))?;
    {
        let mut stored = lock(&state)?;
        let current = active(&mut stored, id)?;
        if sequence <= current.sequence
            || current
                .scope
                .as_ref()
                .is_none_or(|scope| scope.0 != workspace || scope.1 != epoch)
        {
            return Err(denied("Stale chat action"));
        }
        current.sequence = sequence;
    }
    app.emit_to("main", EVENT, json!({ "kind": "action", "frame": frame }))
        .map_err(window_error)?;
    Ok(())
}

#[tauri::command]
pub async fn chat_window_snapshot(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ChatWindowState>,
    frame: Value,
) -> AppResult<()> {
    role(&window, "main")?;
    if serde_json::to_vec(&frame)?.len() > MAX_FRAME_BYTES {
        return Err(denied("Chat snapshot exceeds the 16 MiB relay limit"));
    }
    let id = frame["session"]
        .as_str()
        .ok_or_else(|| denied("Missing chat session"))?;
    let revision = frame["revision"]
        .as_u64()
        .ok_or_else(|| denied("Missing snapshot revision"))?;
    {
        let mut stored = lock(&state)?;
        let current = active(&mut stored, id)?;
        if revision != current.revision + 1 {
            return Err(denied("Out-of-order chat snapshot"));
        }
        match frame["kind"].as_str() {
            Some("snapshot") => {
                let workspace = &frame["snapshot"]["workspace"];
                let id = workspace["id"]
                    .as_str()
                    .filter(|id| id.len() <= 256)
                    .ok_or_else(|| denied("Invalid snapshot workspace"))?;
                let epoch = workspace["epoch"]
                    .as_u64()
                    .ok_or_else(|| denied("Invalid snapshot epoch"))?;
                current.scope = Some((id.to_owned(), epoch));
            }
            Some("patch") if current.scope.is_some() && frame["patch"].is_object() => {}
            _ => return Err(denied("Invalid chat snapshot frame")),
        }
        current.revision = revision;
    }
    app.emit_to("chat", STATE_EVENT, frame)
        .map_err(window_error)?;
    Ok(())
}

pub fn main_destroyed(app: &tauri::AppHandle) {
    if let Some(chat) = app.get_webview_window("chat") {
        let _ = chat.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_accepts_ui_intent_not_command_replacements() {
        assert!(valid_action(&json!({ "type": "send" })));
        assert!(valid_action(
            &json!({ "type": "execution-decide", "id": "staged", "decision": "approve" })
        ));
        assert!(!valid_action(
            &json!({ "type": "execution-decide", "id": "staged", "decision": "approve", "argv": ["replacement"] })
        ));
        assert!(!valid_action(
            &json!({ "type": "agent_start", "prompt": "run" })
        ));
        assert!(!valid_action(&json!({ "type": "send", "extra": true })));
        assert!(!valid_action(
            &json!({ "type": "execution-cancel", "id": "" })
        ));
        assert!(valid_action(
            &json!({ "type": "execution-permission", "value": "session", "acknowledged": true })
        ));
        assert!(!valid_action(
            &json!({ "type": "execution-permission", "value": "session", "acknowledged": "true" })
        ));
        assert!(!valid_action(
            &json!({ "type": "prompt", "value": "x".repeat(262145) })
        ));
    }

    #[test]
    fn reading_position_cannot_smuggle_authority_or_paths() {
        let mut action = json!({
            "type": "reading-position",
            "value": {
                "provider": "claude",
                "historyPage": "current.jsonl",
                "following": false,
                "scrollTop": 320,
                "anchor": { "id": "message-7", "inset": 12 }
            }
        });
        assert!(valid_action(&action));
        action["value"]["executionPermission"] = json!("session");
        assert!(!valid_action(&action));
        action["value"]
            .as_object_mut()
            .unwrap()
            .remove("executionPermission");
        action["value"]["historyPage"] = json!("../other/current.jsonl");
        assert!(!valid_action(&action));
        action["value"]["historyPage"] = json!("current.jsonl");
        action["value"]["scrollTop"] = json!(-1);
        assert!(!valid_action(&action));
        action["value"]["scrollTop"] = json!(320);
        action["acknowledged"] = json!(true);
        assert!(!valid_action(&action));
    }

    #[test]
    fn stale_native_sessions_cannot_reuse_the_relay() {
        let mut stored = Some(Session {
            id: "current".into(),
            revision: 0,
            sequence: 0,
            scope: None,
        });
        assert!(active(&mut stored, "old").is_err());
        assert!(active(&mut stored, "current").is_ok());
        assert!(!valid_session("../chat"));
        assert!(!valid_session(""));
        assert!(!valid_session(&"x".repeat(65)));
        assert!(valid_session("chat-session-1"));
    }
}
