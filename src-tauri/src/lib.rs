pub mod ai;
pub mod chat_window;
pub mod comments;
pub mod contracts;
pub mod execution;
pub mod latex;
pub mod media;
pub mod migration;
pub mod process;
pub mod resources;
pub mod ssh_askpass;
pub mod state;
pub mod tray;
pub mod updates;
pub mod workspace;

use contracts::*;
use serde_json::{Value, json};
use state::{AppState, ArtifactGrant, atomic_json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};
use tauri::{Emitter, Manager, State, ipc::Channel};

fn lock_error() -> AppError {
    AppError::new("STATE_ERROR", "Application state lock poisoned")
}

#[tauri::command]
async fn update_status(state: State<'_, Arc<AppState>>) -> AppResult<updates::UpdateStatus> {
    updates::status(&state)
}
#[tauri::command]
async fn update_check(
    state: State<'_, Arc<AppState>>,
    force: bool,
) -> AppResult<updates::UpdateStatus> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updates::check(&state, force))
        .await
        .map_err(|e| AppError::new("UPDATE_CHECK_FAILED", e.to_string()))?
}

#[tauri::command]
async fn app_bootstrap(state: State<'_, Arc<AppState>>) -> AppResult<Value> {
    let settings = state.settings.lock().map_err(|_| lock_error())?.clone();
    let aliases = workspace::ssh_config::import_aliases().unwrap_or_default();
    Ok(
        json!({"dataDir":state.data_dir,"openPath":state.open_path,"settings":settings,"environments":settings.get("environments").cloned().unwrap_or_else(||json!([])),"recents":settings.get("recents").cloned().unwrap_or_else(||json!([])),"aliases":aliases}),
    )
}
#[tauri::command]
async fn app_settings(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: Value,
) -> AppResult<Value> {
    if !settings.is_object() || serde_json::to_vec(&settings)?.len() > 65536 {
        return Err(AppError::new(
            "INVALID_SETTINGS",
            "Settings must be an object of at most 64 KiB",
        ));
    }
    updates::validate_settings(&settings)?;
    let mut stored = state.settings.lock().map_err(|_| lock_error())?;
    let mut merged = stored.as_object().cloned().unwrap_or_default();
    for (key, value) in settings.as_object().expect("validated settings object") {
        merged.insert(key.clone(), value.clone());
    }
    let merged = Value::Object(merged);
    if serde_json::to_vec(&merged)?.len() > 65536 {
        return Err(AppError::new(
            "INVALID_SETTINGS",
            "Combined settings exceed 64 KiB",
        ));
    }
    atomic_json(&state.data_dir.join("settings.json"), &merged)?;
    *stored = merged.clone();
    drop(stored);
    tray::set_locale(
        &app,
        merged.get("locale").and_then(Value::as_str) == Some("en"),
    )
    .map_err(|error| AppError::new("TRAY_UPDATE_FAILED", error.to_string()))?;
    Ok(merged)
}
#[tauri::command]
async fn ssh_environments() -> AppResult<Value> {
    Ok(json!(workspace::ssh_config::environments()?))
}
#[tauri::command]
async fn pick_folder(state: State<'_, Arc<AppState>>) -> AppResult<Option<String>> {
    let english = state
        .settings
        .lock()
        .map_err(|_| lock_error())?
        .get("locale")
        .and_then(Value::as_str)
        == Some("en");
    tauri::async_runtime::spawn_blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title(if english {
                "Open paper project folder"
            } else {
                "논문 프로젝트 폴더 열기"
            })
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::new("DIALOG_ERROR", e.to_string()))?
}
#[tauri::command]
async fn ssh_prompt_answer(id: String, answer: Option<String>) -> AppResult<()> {
    ssh_askpass::answer_prompt(&id, answer)
}
#[tauri::command]
async fn workspace_open(
    state: State<'_, Arc<AppState>>,
    environment: Environment,
    root: String,
) -> AppResult<WorkspaceRef> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reference = {
            let mut manager = state.manager.lock().map_err(|_| lock_error())?;
            state.ensure_idle()?;
            manager.open(environment, root)?
        };
        state.grants.lock().map_err(|_| lock_error())?.clear();
        state.media.lock().map_err(|_| lock_error())?.clear();
        Ok(reference)
    })
    .await
    .map_err(|e| AppError::new("WORKSPACE_ERROR", e.to_string()))?
}
#[tauri::command]
async fn workspace_close(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    epoch: u64,
) -> AppResult<()> {
    {
        let mut manager = state.manager.lock().map_err(|_| lock_error())?;
        state.ensure_idle()?;
        manager.active(&workspace_id, epoch)?;
        manager.close()?;
    }
    state.grants.lock().map_err(|_| lock_error())?.clear();
    state.media.lock().map_err(|_| lock_error())?.clear();
    Ok(())
}

struct OperationGuard(Arc<AppState>);
impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.operations.fetch_sub(1, Ordering::AcqRel);
    }
}
async fn dispatch(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    workspace_id: String,
    epoch: u64,
    command: &'static str,
    args: Value,
    events: Option<Channel<AppEvent>>,
) -> AppResult<Value> {
    let long = matches!(
        command,
        "build_start"
            | "agent_start"
            | "provider_login"
            | "file_save"
            | "file_create"
            | "file_rename"
            | "file_trash"
            | "file_restore"
            | "proposal_decide"
            | "pdf_apply_edit"
            | "comments_update"
            | "comments_refresh_pdf"
            | "project_update"
            | "undo_transaction"
            | "recovery_write"
            | "recovery_clear"
    );
    let (workspace, guard) = {
        let manager = state.manager.lock().map_err(|_| lock_error())?;
        let workspace = manager.active(&workspace_id, epoch)?;
        let guard = if long {
            state.operations.fetch_add(1, Ordering::AcqRel);
            Some(OperationGuard(state.clone()))
        } else {
            None
        };
        (workspace, guard)
    };
    tauri::async_runtime::spawn_blocking(move||{
  let _guard=guard;
  let event_state=state.clone();
  let emit:Arc<dyn Fn(AppEvent)+Send+Sync>=Arc::new({let app=app.clone();move|mut event|{event.sequence=event_state.sequence.fetch_add(1,Ordering::Relaxed)+1;if let Some(channel)=&events{let _=channel.send(event.clone());}let _=app.emit("texypaper:event",event);}});
  let event_context=json!({"path":args.get("path"),"rootTex":args.get("rootTex")});
  let result=match command {
   "project_trust"=>{
    let trusted=args.get("trusted").and_then(Value::as_bool).unwrap_or(false);
    if trusted {
     let english=state.settings.lock().map_err(|_|lock_error())?.get("locale").and_then(Value::as_str)==Some("en");
     let message=if english {"Project mode loads latexmk configuration, which can run commands with your account permissions. Trust only a project you have reviewed. Allow this project?"}else{"프로젝트 모드는 계정 권한으로 명령을 실행할 수 있는 latexmk 설정을 불러옵니다. 검토한 프로젝트만 신뢰하세요. 이 프로젝트를 허용할까요?"};
     let approved=rfd::MessageDialog::new().set_title("TexyPaper").set_description(format!("{message}\n\n{}",workspace.reference.root)).set_level(rfd::MessageLevel::Warning).set_buttons(rfd::MessageButtons::YesNo).show()==rfd::MessageDialogResult::Yes;
     if !approved {return Err(AppError::new("PROJECT_TRUST_DENIED","Project execution consent declined"));}
    }
    state::set_project_trust(&state.data_dir,&workspace,trusted)?;Ok(json!({"trusted":trusted}))
   },
   "recovery_read"|"recovery_write"|"recovery_clear"=>state.recovery(&workspace,command,&args),
   "provider_status"|"provider_login"|"provider_models"|"agent_start"|"agent_cancel"|"proposal_decide"|"proposal_list"|"agent_history"=>{let mut args=args;args["_dataDir"]=json!(state.data_dir);args["_exePath"]=json!(std::env::current_exe()?);ai::execute(&workspace,command,args,emit.clone())},
   "command_list"|"command_permission"|"command_decide"|"command_cancel"=>{let mut args=args;args["_dataDir"]=json!(state.data_dir);execution::execute(&workspace,command,args,emit.clone())},
   "build_start"=>{let mut build_args=args;build_args["_projectTrusted"]=json!(state::project_trusted(&state.data_dir,&workspace)?);latex::execute(&workspace,command,build_args)},
   "build_status"|"build_cancel"|"sync_forward"|"sync_inverse"|"sync_validate_fallback"|"pdf_map_selection"|"pdf_apply_edit"=>latex::execute(&workspace,command,args),
   "export_pdf"=>{
    let english=state.settings.lock().map_err(|_|lock_error())?.get("locale").and_then(Value::as_str)==Some("en");
    let destination=rfd::FileDialog::new().set_title(if english{"Export PDF"}else{"PDF 내보내기"}).add_filter("PDF",&["pdf"]).set_file_name("paper.pdf").save_file().ok_or_else(||AppError::new("CANCELLED","PDF export cancelled"))?;
    let mut export_args=args;export_args["_destination"]=json!(destination);
    latex::execute(&workspace,command,export_args)
   },
   "artifact_metadata"=>{
    let mut value=latex::execute(&workspace,command,args)?;
    let build_id=value.get("buildId").and_then(Value::as_str).ok_or_else(||AppError::new("ARTIFACT_INVALID","Artifact identity missing"))?.to_owned();
    let length=value.get("length").and_then(Value::as_u64).ok_or_else(||AppError::new("ARTIFACT_INVALID","Artifact length missing"))?;
    let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
    let mut grants=state.grants.lock().map_err(|_|lock_error())?;
    grants.clear();
    grants.insert(token.clone(),ArtifactGrant{workspace_id:workspace_id.clone(),epoch,build_id:build_id.clone(),length});
    value["url"]=json!(format!("http://texypaper.localhost/artifact/{workspace_id}/{build_id}?token={token}"));
    value["token"]=json!(token);Ok(value)
   },
   "image_metadata"=>media::image_metadata(&state,&workspace,&args),
   "file_metadata"=>media::file_metadata(&workspace,&args),
   "export_file"=>media::export_file(&state,&workspace,&args),
   "resource_snapshot"=>resources::snapshot(),
   "workspace_state_read"|"workspace_state_write"=>state.workspace_metadata(&workspace,command,&args),
   "comments_refresh_pdf"=>comments::refresh_pdf(&workspace,&args),
   "open_external"=>native_open_external(&workspace,&args),
   _=>{let op=match command{"directory_list"=>"list_dir","file_read"=>"read_text","file_save"=>"save_text","file_create"=>"create","file_rename"=>"rename","file_trash"=>"trash","file_restore"=>"restore","project_search"=>"search_text",other=>other};workspace.execute(op,args)}
  };
  if let Ok(value)=&result {
   let kind=match command{
    "build_start"=>Some(match value["status"].as_str(){
     Some("published"|"success")=>"build/published",
     Some("queued")=>"build/queued",
     Some("cancelled")=>"build/cancelled",
     Some("timeout")=>"build/timeout",
     Some("running")=>"build/started",
     _=>"build/failed",
    }),
    "file_save"|"file_create"|"file_rename"|"file_trash"|"file_restore"|"undo_transaction"=>Some("workspace/changed"),
    _=>None
   };
   if let Some(kind)=kind {emit(state.event(&workspace,kind,json!({"result":value,"args":event_context})));}
  }else if let Err(error)=&result {emit(state.event(&workspace,"operation/error",json!({"command":command,"error":error})));}
  result
 }).await.map_err(|e|AppError::new("TASK_FAILED",e.to_string()))?
}
macro_rules! workspace_commands {($($name:ident),* $(,)?)=>{$(
 #[tauri::command]
 async fn $name(app:tauri::AppHandle,webview:tauri::Webview,state:State<'_,Arc<AppState>>,workspace_id:String,epoch:u64,args:Value,events:Option<tauri::ipc::JavaScriptChannelId>)->AppResult<Value>{let events=events.map(|id|id.channel_on(webview));dispatch(app,state.inner().clone(),workspace_id,epoch,stringify!($name),args,events).await}
)*};}
workspace_commands!(
    directory_list,
    file_read,
    file_save,
    file_create,
    file_rename,
    file_trash,
    file_restore,
    project_search,
    scan_step,
    transaction_status,
    undo_transaction,
    project_read,
    project_update,
    project_trust,
    build_start,
    build_cancel,
    sync_forward,
    sync_inverse,
    pdf_map_selection,
    pdf_apply_edit,
    artifact_metadata,
    export_pdf,
    comments_read,
    comments_update,
    provider_status,
    provider_login,
    provider_models,
    agent_start,
    agent_cancel,
    proposal_decide,
    proposal_list,
    agent_history,
    command_list,
    command_permission,
    command_decide,
    command_cancel,
    recovery_read,
    recovery_write,
    recovery_clear,
    open_external
);
workspace_commands!(
    image_metadata,
    file_metadata,
    export_file,
    resource_snapshot,
    build_status,
    comments_refresh_pdf,
    workspace_state_read,
    workspace_state_write,
    sync_validate_fallback
);

fn native_open_external(workspace: &workspace::Workspace, args: &Value) -> AppResult<Value> {
    let relative = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "path required"))?;
    if relative.contains(['\0', ':'])
        || relative.starts_with(['/', '\\'])
        || relative.split(['/', '\\']).any(|p| p == "..")
    {
        return Err(AppError::new("PATH_ESCAPE", "Invalid relative path"));
    }
    let extension = std::path::Path::new(relative)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "tex"
            | "ltx"
            | "bib"
            | "txt"
            | "md"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "csv"
            | "json"
            | "py"
            | "rs"
            | "ts"
            | "css"
    ) {
        return Err(AppError::new(
            "EXTERNAL_OPEN_DENIED",
            "실행 가능한 형식은 외부 앱으로 열 수 없습니다.",
        ));
    }
    let root = workspace
        .local_root()
        .ok_or_else(|| {
            AppError::new(
                "REMOTE_COPY_REQUIRED",
                "원격 파일은 다운로드한 복사본으로 내보낸 후 열어야 합니다.",
            )
        })?
        .canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(&root) {
        return Err(AppError::new("PATH_ESCAPE", "Target is outside workspace"));
    }
    let program = if matches!(extension.as_str(), "py" | "rs" | "ts" | "css" | "json") {
        "notepad.exe"
    } else {
        "explorer.exe"
    };
    std::process::Command::new(program).arg(&path).spawn()?;
    Ok(json!({"opened":true}))
}
#[tauri::command]
async fn open_external_url(url: String) -> AppResult<()> {
    if url.contains(['\0', '\r', '\n'])
        || !(url.starts_with("https://")
            || url.starts_with("http://")
            || url.starts_with("mailto:"))
    {
        return Err(AppError::new(
            "URL_DENIED",
            "Only explicit HTTP(S) or mailto links can be opened",
        ));
    }
    open_url_with_default_handler(&url)
}
// explorer.exe treats long query strings as shell paths and can open a folder window
// instead of the browser (observed with the Codex sign-in URL). ShellExecuteW resolves
// the registered http/https/mailto handler without a shell command line.
#[cfg(windows)]
fn open_url_with_default_handler(url: &str) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::PCWSTR;
    let wide = |value: &str| {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let (verb, target) = (wide("open"), wide(url));
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success with a value greater than 32.
    if result.0 as isize <= 32 {
        return Err(AppError::new(
            "URL_OPEN_FAILED",
            format!(
                "The default browser could not open the link (ShellExecute {})",
                result.0 as isize
            ),
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
fn open_url_with_default_handler(url: &str) -> AppResult<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(url).spawn()?;
    Ok(())
}

fn artifact_response(
    state: &AppState,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Response, StatusCode};
    let fail = |status: StatusCode, text: &str| {
        Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "http://tauri.localhost")
            .body(text.as_bytes().to_vec())
            .expect("static HTTP response")
    };
    let uri = request.uri();
    let components: Vec<_> = uri.path().split('/').filter(|s| !s.is_empty()).collect();
    let token = uri
        .query()
        .and_then(|q| q.strip_prefix("token="))
        .unwrap_or("");
    if components.len() == 2
        && components[0] == "media"
        && request.method() == tauri::http::Method::GET
    {
        return media::response(state, components[1], token);
    }
    if components.len() != 3 || components[0] != "artifact" {
        return fail(StatusCode::NOT_FOUND, "ARTIFACT_NOT_FOUND");
    }
    let grants = match state.grants.lock() {
        Ok(g) => g,
        Err(_) => return fail(StatusCode::INTERNAL_SERVER_ERROR, "STATE_ERROR"),
    };
    let grant = match grants.get(token) {
        Some(g) if g.workspace_id == components[1] && g.build_id == components[2] => g,
        _ => return fail(StatusCode::FORBIDDEN, "ARTIFACT_UNAUTHORIZED"),
    };
    let workspace = match state.workspace(&grant.workspace_id, grant.epoch) {
        Ok(w) => w,
        Err(_) => return fail(StatusCode::FORBIDDEN, "WORKSPACE_STALE"),
    };
    let length = grant.length;
    let build_id = grant.build_id.clone();
    drop(grants);
    if request.method() == tauri::http::Method::OPTIONS {
        return Response::builder()
            .status(204)
            .header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
            .header("Access-Control-Allow-Headers", "Range")
            .header("Access-Control-Max-Age", "600")
            .body(Vec::new())
            .expect("valid preflight response");
    }
    if request.method() == tauri::http::Method::HEAD {
        return Response::builder()
            .status(200)
            .header("Content-Type", "application/pdf")
            .header("Content-Length", length)
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "http://tauri.localhost")
            .body(Vec::new())
            .expect("valid PDF headers");
    }
    if request.method() != tauri::http::Method::GET {
        return fail(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
    }
    let range = request
        .headers()
        .get("Range")
        .and_then(|r| r.to_str().ok())
        .and_then(|s| s.strip_prefix("bytes="));
    let Some((begin, end)) = range
        .and_then(|r| r.split_once('-'))
        .and_then(|(a, b)| Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?)))
    else {
        return fail(StatusCode::BAD_REQUEST, "RANGE_REQUIRED");
    };
    if begin > end || end >= length || end - begin >= 1048576 {
        return Response::builder()
            .status(416)
            .header("Content-Range", format!("bytes */{length}"))
            .body(Vec::new())
            .expect("valid range rejection");
    }
    match latex::artifact_range(&workspace, &build_id, begin, end + 1) {
        Ok(bytes) => Response::builder()
            .status(206)
            .header("Content-Type", "application/pdf")
            .header("Content-Length", bytes.len())
            .header("Content-Range", format!("bytes {begin}-{end}/{length}"))
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "http://tauri.localhost")
            .header(
                "Access-Control-Expose-Headers",
                "Content-Range,Content-Length,Accept-Ranges",
            )
            .body(bytes)
            .expect("valid PDF response"),
        Err(error) => fail(StatusCode::NOT_FOUND, &error.code),
    }
}

static INSTANCE_LOCK: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();
pub fn run() {
    let mut arguments = std::env::args().skip(1);
    let mut data_dir = None;
    let mut open_path = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--data-dir" => {
                let Some(path) = arguments
                    .next()
                    .filter(|path| !path.is_empty() && !path.starts_with("--"))
                else {
                    eprintln!("--data-dir requires an explicit isolated directory");
                    std::process::exit(2);
                };
                data_dir = Some(PathBuf::from(path));
            }
            "--open" => open_path = arguments.next(),
            _ => {}
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Tokio runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    tauri::Builder::default()
        .setup(move |app| {
            let explicit_profile = data_dir.is_some();
            #[cfg(debug_assertions)]
            if !explicit_profile {
                return Err(std::io::Error::other("Development builds require an isolated --data-dir; default user profiles are never changed").into());
            }
            let directory = match data_dir {
                Some(path) => path,
                None => app.path().app_data_dir()?,
            };
            // Migration and the exclusive lifetime lock precede settings, workspace
            // manager and WebView creation. No credential file is opened or copied.
            let instance = match migration::prepare_profile(&directory, explicit_profile) {
                Ok(instance) => instance,
                Err(error) => {
                    let running = error.code == "PROFILE_IN_USE";
                    let guidance = match error.code.as_str() {
                        "PROFILE_IN_USE" => "실행 중인 TexyPaper는 트레이에서 열 수 있습니다. 이전 앱은 트레이에서 완전히 종료하세요.\nOpen the running TexyPaper from its tray icon. Fully exit the legacy app before migration.",
                        "MIGRATION_CONFLICT" => "두 저장소를 모두 보존하고 백업한 뒤 충돌을 해결하세요. 자동 병합하거나 삭제하지 않았습니다.\nPreserve and back up both profiles before resolving the conflict. Neither was merged or deleted.",
                        _ => "저장소와 복구 파일을 임의로 삭제하지 마세요. 경로와 접근 권한을 확인하세요.\nDo not delete profile or recovery files. Check the storage path and access permissions.",
                    };
                    let description = format!("{}: {}\n\n{}", error.code, error.message, guidance);
                    eprintln!("{description}");
                    rfd::MessageDialog::new()
                        .set_title("TexyPaper")
                        .set_description(description)
                        .set_level(if running { rfd::MessageLevel::Info } else { rfd::MessageLevel::Error })
                        .set_buttons(rfd::MessageButtons::Ok)
                        .show();
                    std::process::exit(if running { 0 } else { 1 });
                }
            };
            let _ = INSTANCE_LOCK.set(instance);
            let profile = directory.join("webview");
            let state = Arc::new(
                AppState::new(directory, open_path)
                    .map_err(|e| std::io::Error::other(e.message))?,
            );
            app.manage(state.clone());
            app.manage(chat_window::ChatWindowState::new(profile.clone()));
            let change_handle = app.handle().clone();
            workspace::set_change_handler(Arc::new(move |mut event| {
                event.sequence = state.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = change_handle.emit("texypaper:event", event);
            }));
            let handle = app.handle().clone();
            ssh_askpass::set_prompt_handler(Arc::new(move |prompt| {
                let _ = handle.emit("texypaper:ssh-prompt", prompt);
            }));
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(profile)
                .build()?;
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        tray::hide(window.app_handle());
                    }
                    tauri::WindowEvent::Destroyed => chat_window::main_destroyed(window.app_handle()),
                    _ => {}
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol("texypaper", |context, request, responder| {
            let state = context
                .app_handle()
                .state::<Arc<AppState>>()
                .inner()
                .clone();
            let permit = state.artifact_slots.clone().try_acquire_owned();
            match permit {
                Ok(permit) => {
                    std::thread::spawn(move || {
                        let _permit = permit;
                        let origin = request
                            .headers()
                            .get("Origin")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("http://tauri.localhost")
                            .to_owned();
                        if !matches!(
                            origin.as_str(),
                            "http://tauri.localhost"
                                | "https://tauri.localhost"
                                | "tauri://localhost"
                        ) && !(cfg!(debug_assertions) && origin == "http://127.0.0.1:1420")
                        {
                            responder.respond(
                                tauri::http::Response::builder()
                                    .status(403)
                                    .body(b"ORIGIN_DENIED".to_vec())
                                    .expect("static origin rejection"),
                            );
                            return;
                        }
                        let mut response = artifact_response(&state, request);
                        response.headers_mut().insert(
                            "Access-Control-Allow-Origin",
                            origin.parse().expect("validated origin"),
                        );
                        responder.respond(response);
                    });
                }
                Err(_) => responder.respond(
                    tauri::http::Response::builder()
                        .status(429)
                        .header("Retry-After", "1")
                        .body(b"ARTIFACT_BUSY".to_vec())
                        .expect("static busy response"),
                ),
            }
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            chat_window::chat_window_open,
            chat_window::chat_window_dock,
            chat_window::chat_window_focus,
            chat_window::chat_window_ready,
            chat_window::chat_window_action,
            chat_window::chat_window_snapshot,
            tray::app_quit,
            app_bootstrap,
            app_settings,
            update_status,
            update_check,
            ssh_environments,
            pick_folder,
            ssh_prompt_answer,
            workspace_open,
            workspace_close,
            open_external_url,
            directory_list,
            file_read,
            file_save,
            file_create,
            file_rename,
            file_trash,
            file_restore,
            project_search,
            scan_step,
            transaction_status,
            undo_transaction,
            project_read,
            project_update,
            project_trust,
            build_start,
            build_cancel,
            build_status,
            sync_forward,
            sync_inverse,
            sync_validate_fallback,
            pdf_map_selection,
            pdf_apply_edit,
            artifact_metadata,
            export_pdf,
            comments_read,
            comments_update,
            comments_refresh_pdf,
            provider_status,
            provider_login,
            provider_models,
            agent_start,
            agent_cancel,
            proposal_decide,
            proposal_list,
            agent_history,
            command_list,
            command_permission,
            command_decide,
            command_cancel,
            recovery_read,
            recovery_write,
            recovery_clear,
            open_external,
            image_metadata,
            file_metadata,
            export_file,
            resource_snapshot,
            workspace_state_read,
            workspace_state_write
            ];
            move |invoke: tauri::ipc::Invoke| {
                // App commands are otherwise callable by every local webview.
                // The chat view may only announce readiness and relay UI intent;
                // workspace/provider/execution commands remain main-window-owned.
                if invoke.message.webview_ref().label() != "main"
                    && !matches!(
                        invoke.message.command(),
                        "chat_window_ready" | "chat_window_action"
                    )
                {
                    invoke.resolver.reject(AppError::new(
                        "WINDOW_ROLE_DENIED",
                        "This command is only available in the main window",
                    ));
                    return true;
                }
                if tray::is_exiting(invoke.message.webview_ref().app_handle())
                    && invoke.message.command() != "app_quit"
                {
                    invoke.resolver.reject(AppError::new(
                        "APP_EXITING",
                        "TexyPaper is stopping its owned work before exiting",
                    ));
                    return true;
                }
                handler(invoke)
            }
        })
        .build(tauri::generate_context!())
        .expect("TexyPaper runtime failed")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !tray::authorized(app)
            {
                api.prevent_exit();
                tray::request_quit(app);
            }
        });
}
