//! Window close hides live controllers; only the main window's guarded quit can exit.
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
            crate::latex::execute(workspace, "build_cancel", json!({}))?;
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
