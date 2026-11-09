//! First-close consent precedes background hiding; guarded main-window quit owns exit.
use crate::{
    contracts::{AppError, AppResult},
    state::AppState,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{
    Emitter, Manager, State, WebviewWindow,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

pub struct TrayState {
    open: MenuItem<tauri::Wry>,
    exit: MenuItem<tauri::Wry>,
    exiting: AtomicBool,
    authorized: AtomicBool,
}

fn labels(english: bool) -> (&'static str, &'static str) {
    if english {
        ("Open TexyPaper", "Exit TexyPaper")
    } else {
        ("TexyPaper 열기", "TexyPaper 종료")
    }
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let state = app.state::<Arc<AppState>>();
    let english = state
        .settings
        .lock()
        .ok()
        .is_some_and(|settings| settings.get("locale").and_then(Value::as_str) == Some("en"));
    let (open_label, exit_label) = labels(english);
    let open = MenuItem::with_id(app, "open", open_label, true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", exit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("TexyPaper tray icon is missing"))?;
    TrayIconBuilder::with_id("texypaper")
        .icon(icon)
        .tooltip("TexyPaper")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = restore(app);
            }
            "exit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let _ = restore(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayState {
        open,
        exit,
        exiting: AtomicBool::new(false),
        authorized: AtomicBool::new(false),
    });
    Ok(())
}

pub fn set_locale(app: &tauri::AppHandle, english: bool) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    let (open, exit) = labels(english);
    state.open.set_text(open)?;
    state.exit.set_text(exit)
}

fn explained(settings: &Value) -> bool {
    settings.get("trayCloseExplained").and_then(Value::as_bool) == Some(true)
}

fn acknowledge_close(
    settings: &mut Value,
    acknowledge: bool,
    persist: impl FnOnce(&Value) -> AppResult<()>,
) -> AppResult<()> {
    if !acknowledge && !explained(settings) {
        return Err(AppError::new(
            "TRAY_ACKNOWLEDGMENT_REQUIRED",
            "Choose whether TexyPaper should keep running in the tray first",
        ));
    }
    if acknowledge && !explained(settings) {
        let mut updated = settings.as_object().cloned().ok_or_else(|| {
            AppError::new("INVALID_SETTINGS", "Application settings must be an object")
        })?;
        updated.insert("trayCloseExplained".into(), json!(true));
        let updated = Value::Object(updated);
        if serde_json::to_vec(&updated)?.len() > 65536 {
            return Err(AppError::new(
                "INVALID_SETTINGS",
                "Combined settings exceed 64 KiB",
            ));
        }
        // Do not change the live policy if durable storage refused the acknowledgment.
        persist(&updated)?;
        *settings = updated;
    }
    Ok(())
}

pub fn close_requested(app: &tauri::AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let acknowledged = state
        .settings
        .lock()
        .is_ok_and(|settings| explained(&settings));
    if acknowledged {
        hide(app);
    } else {
        // In particular, do not restore/focus an unfocused window merely to explain X.
        let _ = app.emit_to("main", "texypaper:tray-close-requested", ());
    }
}

#[tauri::command]
pub async fn app_hide_to_tray(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    acknowledge: bool,
) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "WINDOW_ROLE_DENIED",
            "Only the main window can hide the application",
        ));
    }
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("STATE_ERROR", "Application settings lock poisoned"))?;
    acknowledge_close(&mut settings, acknowledge, |updated| {
        crate::state::atomic_json(&state.data_dir.join("settings.json"), updated)
    })?;
    drop(settings);
    hide(&app);
    Ok(())
}

pub fn restore(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(main) = app.get_webview_window("main") {
        main.show()?;
        main.unminimize()?;
        if let Some(chat) = app.get_webview_window("chat") {
            chat.show()?;
            chat.unminimize()?;
        }
        main.set_focus()?;
    }
    Ok(())
}

pub fn hide(app: &tauri::AppHandle) {
    // Fail visibly rather than leaving an unrecoverable partly hidden window pair.
    let result = (|| -> tauri::Result<()> {
        if let Some(chat) = app.get_webview_window("chat") {
            chat.hide()?;
        }
        if let Some(main) = app.get_webview_window("main") {
            main.hide()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = restore(app);
    }
}

pub fn request_quit(app: &tauri::AppHandle) {
    if restore(app).is_ok() {
        let _ = app.emit_to("main", "texypaper:quit-requested", ());
    }
}

pub fn is_exiting(app: &tauri::AppHandle) -> bool {
    app.state::<TrayState>().exiting.load(Ordering::Acquire)
}

pub fn authorized(app: &tauri::AppHandle) -> bool {
    app.state::<TrayState>().authorized.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn app_quit(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    workspace_id: Option<String>,
    epoch: Option<u64>,
    discard_paths: Vec<String>,
    allow_disconnected: bool,
) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "WINDOW_ROLE_DENIED",
            "Only the main window can finish quitting",
        ));
    }
    let tray = app.state::<TrayState>();
    if tray.exiting.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let state = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let workspace = match (workspace_id, epoch) {
            (Some(id), Some(epoch)) => Some(state.manager.lock().map_err(|_| AppError::new("STATE_ERROR", "Application state lock poisoned"))?.active(&id, epoch)?),
            (None, None) => None,
            _ => return Err(AppError::new("WORKSPACE_STALE", "Workspace identity is incomplete")),
        };
        if let Some(workspace) = &workspace {
            crate::ai::cancel_workspace(&workspace.reference.id, workspace.reference.epoch)?;
            crate::execution::cancel_workspace(&workspace.reference.id, workspace.reference.epoch)?;
            if let Err(error) = crate::latex::execute(workspace, "build_cancel", json!({})) {
                // A confirmed offline exit may close the local SSH process, but it
                // cannot assert that a remote build stopped. Other errors still abort.
                if !(allow_disconnected
                    && workspace.ssh_disconnected()
                    && error.code == "SSH_DISCONNECTED")
                {
                    return Err(error);
                }
            }
        }
        // Agent cancellation is asynchronous. Never turn a cancellation request into
        // process exit until its owned process and all in-flight mutations have settled.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let commands_active = workspace.as_ref().is_some_and(|workspace| crate::execution::active_workspace(&workspace.reference.id, workspace.reference.epoch));
            if state.ensure_idle().is_ok() && !commands_active { break; }
            if std::time::Instant::now() >= deadline {
                return Err(AppError::new("QUIT_BUSY", "TexyPaper could not confirm that its active work stopped. The app remains open."));
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if let Some(workspace) = &workspace {
            // A recovery timer already queued when Discard was chosen may have
            // rewritten a journal. The invoke gate now excludes new writes.
            for path in discard_paths {
                state.recovery(workspace, "recovery_clear", &json!({"path":path}))?;
            }
        }
        state.manager.lock().map_err(|_| AppError::new("STATE_ERROR", "Application state lock poisoned"))?.close()?;
        Ok(())
    }).await.map_err(|error| AppError::new("QUIT_FAILED", error.to_string())).and_then(|result| result);
    if let Err(error) = result {
        tray.exiting.store(false, Ordering::Release);
        return Err(error);
    }
    tray.authorized.store(true, Ordering::Release);
    // Destruction retains the existing detached-child cleanup; app.exit is only
    // reached after native owned-work cleanup and the frontend save/discard guard.
    if let Err(error) = window.destroy() {
        tray.authorized.store(false, Ordering::Release);
        tray.exiting.store(false, Ordering::Release);
        return Err(AppError::new("QUIT_FAILED", error.to_string()));
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unexplained_close_cannot_be_hidden_without_acknowledgment() {
        for mut settings in [
            json!({}),
            json!({"trayCloseExplained": false}),
            json!({"trayCloseExplained": "true"}),
        ] {
            assert_eq!(
                acknowledge_close(&mut settings, false, |_| panic!("must not persist"))
                    .unwrap_err()
                    .code,
                "TRAY_ACKNOWLEDGMENT_REQUIRED"
            );
            assert!(!explained(&settings));
        }
    }

    #[test]
    fn acknowledgment_becomes_effective_only_after_successful_persistence() {
        let mut settings = json!({"locale": "en", "recents": ["paper"]});
        let original = settings.clone();
        assert!(
            acknowledge_close(&mut settings, true, |_| {
                Err(AppError::new("IO_ERROR", "Synthetic storage refusal"))
            })
            .is_err()
        );
        assert_eq!(settings, original);
        acknowledge_close(&mut settings, true, |updated| {
            assert!(explained(updated));
            assert_eq!(updated["recents"], original["recents"]);
            Ok(())
        })
        .unwrap();
        assert!(explained(&settings));
        // Future closes need neither a fresh acknowledgment nor another write.
        acknowledge_close(&mut settings, false, |_| panic!("must not persist")).unwrap();
        acknowledge_close(&mut settings, true, |_| panic!("must not persist")).unwrap();
    }
}
