//! User-authorized, workspace/epoch-scoped command execution. cwd is not a sandbox.
use crate::{
    ai::events::{Emit, Events},
    contracts::{AppError, AppResult},
    process::OwnedChild,
    workspace::Workspace,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Condvar, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 16 * 1024;
const TERMINAL_LIMIT: usize = 20;
const PENDING_LIMIT: usize = 8;
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));
#[derive(Default)]
struct State {
    identity: Option<(String, u64)>,
    permission: String,
    rows: VecDeque<Entry>,
    active: Option<Arc<Run>>,
}
struct Entry {
    row: Value,
    events: Events,
}
struct Run {
    id: String,
    cancel: AtomicBool,
    spawn_gate: Mutex<()>,
    done: Mutex<bool>,
    wake: Condvar,
}
impl Run {
    fn wait(&self) {
        let mut done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        while !*done {
            done = self.wake.wait(done).unwrap_or_else(|e| e.into_inner());
        }
    }
    fn stop(&self) {
        let gate = self.spawn_gate.lock().unwrap_or_else(|e| e.into_inner());
        self.cancel.store(true, Ordering::Release);
        drop(gate);
        self.wait();
    }
}
fn invalid(message: &str) -> AppError {
    AppError::new("COMMAND_INVALID", message)
}
fn lock() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}
fn identity(state: &mut State, workspace: &Workspace) -> AppResult<()> {
    workspace.ensure_open()?;
    let key = (workspace.reference.id.clone(), workspace.reference.epoch);
    if state.identity.as_ref() != Some(&key) {
        if state.active.is_some() {
            return Err(AppError::new(
                "COMMAND_BUSY",
                "Another workspace still owns a command",
            ));
        }
        state.identity = Some(key);
        state.permission = "ask".into();
        state.rows.clear();
    }
    Ok(())
}
fn terminal(row: &Value) -> bool {
    !matches!(row["status"].as_str(), Some("pending" | "running"))
}
fn trim(state: &mut State) {
    while state.rows.iter().filter(|e| terminal(&e.row)).count() > TERMINAL_LIMIT {
        if let Some(index) = state.rows.iter().position(|e| terminal(&e.row)) {
            state.rows.remove(index);
        }
    }
}
fn find<'a>(state: &'a mut State, id: &str) -> AppResult<&'a mut Entry> {
    state
        .rows
        .iter_mut()
        .find(|e| e.row["id"].as_str() == Some(id))
        .ok_or_else(|| {
            AppError::new(
                "COMMAND_STALE",
                "Command does not belong to the current workspace epoch or has expired",
            )
        })
}
fn validate(args: &Value) -> AppResult<(String, String, Vec<String>, u64)> {
    let object = args
        .as_object()
        .ok_or_else(|| invalid("Command arguments must be an object"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "summary" | "cwd" | "argv" | "timeoutSeconds" | "_provider" | "_taskId"
        )
    }) || serde_json::to_vec(args)?.len() > 16 * 1024
        || ["_provider", "_taskId"]
            .iter()
            .any(|key| args[*key].as_str().is_some_and(|s| s.len() > 128))
    {
        return Err(invalid(
            "Command request exceeds its bound or contains unsupported authority/environment fields",
        ));
    }
    let summary = args["summary"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 1024 && !s.contains('\0'))
        .ok_or_else(|| invalid("summary must contain 1..1024 bytes"))?
        .to_owned();
    let cwd = args["cwd"]
        .as_str()
        .filter(|s| s.len() <= 2048)
        .ok_or_else(|| invalid("cwd must be a workspace-relative directory"))?
        .to_owned();
    validate_relative(&cwd)?;
    let values = args["argv"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(|| invalid("argv must contain 1..128 exact string arguments"))?;
    let mut argv = Vec::with_capacity(values.len());
    let mut total = 0;
    for value in values {
        let value = value
            .as_str()
            .filter(|s| s.len() <= 4096 && !s.contains('\0'))
            .ok_or_else(|| {
                invalid("Each argv item must be a string of at most 4096 bytes without NUL")
            })?;
        total += value.len();
        if total > 8192 {
            return Err(invalid("argv exceeds 8192 bytes"));
        }
        argv.push(value.to_owned());
    }
    if argv[0].is_empty() || argv[0].starts_with('-') {
        return Err(invalid("argv[0] must identify an executable"));
    }
    // An executable is a host PATH name or a workspace-relative path, never a model-chosen absolute path.
    if argv[0].contains('/') || argv[0].contains('\\') || argv[0].contains(':') {
        let executable = argv[0].strip_prefix("./").unwrap_or(&argv[0]);
        validate_relative(executable)?;
        if executable.is_empty() {
            return Err(invalid("Executable path is empty"));
        }
    }
    let timeout = match args.get("timeoutSeconds") {
        None => 120,
        Some(value) => value
            .as_u64()
            .filter(|s| (1..=1200).contains(s))
            .ok_or_else(|| invalid("timeoutSeconds must be an integer from 1 to 1200"))?,
    };
    Ok((summary, cwd, argv, timeout))
}
fn validate_relative(value: &str) -> AppResult<()> {
    if value.contains(['\0', '\\', ':'])
        || value.starts_with('/')
        || (!value.is_empty()
            && value
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
    {
        return Err(invalid(
            "Paths must be normalized workspace-relative paths without traversal",
        ));
    }
    Ok(())
}
fn local_directory(root: &Path, cwd: &str) -> AppResult<PathBuf> {
    validate_relative(cwd)?;
    let canonical_root = root.canonicalize()?;
    if canonical_root != root {
        return Err(AppError::new(
            "WORKSPACE_ROOT_CHANGED",
            "Workspace canonical root changed; reopen the workspace",
        ));
    }
    let root = canonical_root;
    let directory = root.join(cwd).canonicalize()?;
    if !directory.starts_with(&root) || !directory.is_dir() {
        return Err(AppError::new(
            "PATH_OUTSIDE_ROOT",
            "Command cwd must be an existing canonical directory within the workspace",
        ));
    }
    Ok(directory)
}
fn canonical_cwd(workspace: &Workspace, cwd: &str) -> AppResult<String> {
    if let Some(root) = workspace.local_root() {
        return Ok(local_directory(&root, cwd)?
            .strip_prefix(root.canonicalize()?)
            .map_err(|_| invalid("cwd escapes workspace"))?
            .to_string_lossy()
            .replace('\\', "/"));
    }
    let canonical = workspace.execute("canonical_path", json!({"path":cwd}))?;
    let path = canonical["path"]
        .as_str()
        .ok_or_else(|| invalid("Remote did not confirm cwd"))?;
    let path = if path == "." { "" } else { path };
    validate_relative(path)?;
    let info = workspace.execute("stat_many", json!({"paths":[path]}))?;
    if info["entries"][0]["kind"] != "directory" {
        return Err(invalid("cwd must be an existing directory"));
    }
    Ok(path.into())
}

pub fn propose(
    workspace: &Workspace,
    _data: &Path,
    args: Value,
    events: &Events,
) -> AppResult<Value> {
    let (summary, cwd, argv, timeout) = validate(&args)?;
    // Check permission before any backend call; check it again after canonicalization.
    {
        let mut state = lock();
        identity(&mut state, workspace)?;
        if state.permission == "deny" {
            return Err(AppError::new(
                "COMMAND_DENIED",
                "The user has denied command execution",
            ));
        }
    }
    let cwd = canonical_cwd(workspace, &cwd)?;
    if cwd.len() > 2048 {
        return Err(invalid("Canonical cwd exceeds 2048 bytes"));
    }
    let mut state = lock();
    identity(&mut state, workspace)?;
    if state.permission == "deny" {
        return Err(AppError::new(
            "COMMAND_DENIED",
            "The user has denied command execution",
        ));
    }
    if state
        .rows
        .iter()
        .filter(|e| e.row["status"] == "pending")
        .count()
        >= PENDING_LIMIT
    {
        return Err(AppError::new(
            "COMMAND_QUEUE_FULL",
            "At most eight commands may await user approval",
        ));
    }
    let row = json!({"id":uuid::Uuid::new_v4().to_string(),"workspaceId":workspace.reference.id,"epoch":workspace.reference.epoch,
        "provider":args["_provider"].as_str().unwrap_or(""),"taskId":args["_taskId"].as_str().unwrap_or(""),
        "summary":summary,"cwd":cwd,"argv":argv,"timeoutSeconds":timeout,"status":"pending",
        "stdout":"","stderr":"","exitCode":null,"truncated":false});
    let id = row["id"].as_str().unwrap().to_owned();
    state.rows.push_back(Entry {
        row: row.clone(),
        events: events.clone(),
    });
    events.send("command/updated", row);
    if state.permission == "session" && state.active.is_none() {
        start(&mut state, workspace, &id)?;
    }
    let result = find(&mut state, &id)?.row.clone();
    drop(state);
    let mut response = result;
    if response["status"] == "pending" {
        response["notice"] = json!(
            "Not executed. Await user approval; stop and ask the user. The model cannot approve commands."
        );
    }
    Ok(response)
}
/// Read-only bounded outcomes for the next agent turn; never starts queued requests.
pub fn recent(workspace: &Workspace) -> AppResult<Value> {
    let mut state = lock();
    identity(&mut state, workspace)?;
    Ok(
        json!({"permission":state.permission,"requests":state.rows.iter().map(|e| e.row.clone()).collect::<Vec<_>>()}),
    )
}
pub fn get_status(workspace: &Workspace, id: &str) -> AppResult<Value> {
    let mut state = lock();
    identity(&mut state, workspace)?;
    let mut row = find(&mut state, id)?.row.clone();
    // Escaping, invalid UTF-8 replacement and argv can expand the wire representation.
    while serde_json::to_vec(&row)?.len() > 63 * 1024 {
        for key in ["stdout", "stderr"] {
            let text = row[key].as_str().unwrap_or("");
            let mut cut = text.len() / 2;
            while !text.is_char_boundary(cut) {
                cut += 1;
            }
            row[key] = json!(&text[cut..]);
        }
        row["truncated"] = json!(true);
    }
    if row["status"] == "pending" {
        row["notice"] =
            json!("Not executed. Await user approval; do not poll or approve your own request.");
    }
    Ok(row)
}

pub fn execute(workspace: &Workspace, op: &str, args: Value, emit: Emit) -> AppResult<Value> {
    if op == "command_list" {
        return recent(workspace);
    }
    let events = Events::new(workspace.reference.clone(), emit, &workspace.data_dir());
    let mut state = lock();
    identity(&mut state, workspace)?;
    match op {
        "command_permission" => {
            let permission = args["permission"]
                .as_str()
                .filter(|s| matches!(*s, "deny" | "ask" | "session"))
                .ok_or_else(|| invalid("Unknown command permission"))?;
            if permission == "session" && args["acknowledged"] != true {
                return Err(AppError::new(
                    "COMMAND_ACK_REQUIRED",
                    "Session execution requires explicit user acknowledgement: commands run as your account, may affect files outside the project, and are not sandboxed or undoable",
                ));
            }
            state.permission = permission.into();
            let mut updates = Vec::new();
            let active = if permission == "deny" {
                for entry in &mut state.rows {
                    if entry.row["status"] == "pending" {
                        entry.row["status"] = json!("rejected");
                        updates.push((entry.events.clone(), entry.row.clone()));
                    }
                }
                let active = state.active.clone();
                if let Some(run) = &active {
                    run.cancel.store(true, Ordering::Release);
                }
                active
            } else {
                None
            };
            trim(&mut state);
            events.send("command/permission", json!({"permission":permission}));
            for (events, row) in updates {
                events.send("command/updated", row);
            }
            drop(state);
            if let Some(run) = active {
                run.stop();
            }
            recent(workspace)
        }
        "command_decide" => {
            let id = args["id"]
                .as_str()
                .ok_or_else(|| invalid("Command id is required"))?;
            let decision = args["decision"]
                .as_str()
                .filter(|s| matches!(*s, "approve" | "reject"))
                .ok_or_else(|| invalid("Decision must be approve or reject"))?;
            let pending = find(&mut state, id)?.row["status"] == "pending";
            if pending && decision == "approve" {
                if state.permission == "deny" {
                    return Err(AppError::new(
                        "COMMAND_DENIED",
                        "Command execution is denied",
                    ));
                }
                start(&mut state, workspace, id)?;
            } else if pending {
                find(&mut state, id)?.row["status"] = json!("rejected");
            }
            let entry = find(&mut state, id)?;
            let row = entry.row.clone();
            let events = entry.events.clone();
            events.send("command/updated", row.clone());
            trim(&mut state);
            drop(state);
            Ok(row)
        }
        "command_cancel" => {
            let id = args["id"]
                .as_str()
                .ok_or_else(|| invalid("Command id is required"))?;
            let entry = find(&mut state, id)?;
            if entry.row["status"] == "pending" {
                entry.row["status"] = json!("rejected");
                let row = entry.row.clone();
                entry.events.send("command/updated", row.clone());
                trim(&mut state);
                return Ok(row);
            }
            let events = entry.events.clone();
            let active = state.active.as_ref().filter(|r| r.id == id).cloned();
            if let Some(run) = &active {
                run.cancel.store(true, Ordering::Release);
            }
            drop(state);
            if let Some(run) = active {
                run.stop();
            }
            let row = get_status(workspace, id)?;
            events.send("command/updated", row.clone());
            Ok(row)
        }
        _ => Err(AppError::new(
            "UNKNOWN_OPERATION",
            "Unknown command execution operation",
        )),
    }
}
fn start(state: &mut State, workspace: &Workspace, id: &str) -> AppResult<()> {
    if state.active.is_some() {
        return Err(AppError::new(
            "COMMAND_BUSY",
            "Only one command may run at a time; retry approval after it finishes",
        ));
    }
    workspace.ensure_open()?;
    let entry = find(state, id)?;
    if entry.row["status"] != "pending" {
        return Ok(());
    }
    entry.row["status"] = json!("running");
    let row = entry.row.clone();
    let events = entry.events.clone();
    let run = Arc::new(Run {
        id: id.into(),
        cancel: AtomicBool::new(false),
        spawn_gate: Mutex::new(()),
        done: Mutex::new(false),
        wake: Condvar::new(),
    });
    state.active = Some(run.clone());
    events.send("command/updated", row.clone());
    let workspace = workspace.clone();
    let runner = run.clone();
    if let Err(error) = thread::Builder::new()
        .name("texypaper-command".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_command(&workspace, &row, &runner, &events)
            }));
            let result = match outcome {
                Ok(result) => result,
                Err(_) => Err(AppError::new(
                    "COMMAND_INTERRUPTED",
                    "Command supervision was interrupted; command is never replayed",
                )),
            };
            let uncertain = result
                .as_ref()
                .err()
                .is_some_and(|error| error.code == "COMMAND_REMOTE_UNCERTAIN");
            let mut state = lock();
            if let Ok(entry) = find(&mut state, &runner.id) {
                match result {
                    Ok(result) => {
                        for key in [
                            "status",
                            "stdout",
                            "stderr",
                            "exitCode",
                            "truncated",
                            "error",
                        ] {
                            if let Some(value) = result.get(key) {
                                entry.row[key] = value.clone();
                            }
                        }
                    }
                    Err(error) => {
                        entry.row["status"] = json!("failed");
                        entry.row["error"] = json!(error);
                    }
                }
                let final_row = entry.row.clone();
                let revoked = uncertain && state.permission == "session";
                if revoked {
                    state.permission = "ask".into();
                }
                events.send("command/updated", final_row);
                if revoked {
                    events.send("command/permission", json!({"permission":"ask"}));
                }
                events.send(
                    "workspace/changed",
                    json!({"paths":[],"commandId":runner.id}),
                );
            }
            state.active = None;
            trim(&mut state);
            *runner.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
            runner.wake.notify_all();
            drop(state);
        })
    {
        state.active = None;
        let entry = find(state, id)?;
        entry.row["status"] = json!("failed");
        entry.row["error"] = json!(AppError::from(error));
        entry.events.send("command/updated", entry.row.clone());
        *run.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        run.wake.notify_all();
    }
    Ok(())
}
fn update(id: &str, partial: &Value, events: &Events) {
    let mut state = lock();
    if let Ok(entry) = find(&mut state, id) {
        let mut changed = false;
        for key in ["stdout", "stderr", "truncated"] {
            if let Some(value) = partial.get(key)
                && entry.row[key] != *value
            {
                entry.row[key] = value.clone();
                changed = true;
            }
        }
        if changed {
            let row = entry.row.clone();
            events.send("command/updated", row);
        }
    }
}
#[derive(Default)]
struct Capture {
    bytes: VecDeque<u8>,
    truncated: bool,
    error: Option<String>,
}
impl Capture {
    fn append(&mut self, bytes: &[u8]) {
        let excess = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(OUTPUT_LIMIT);
        if excess > 0 {
            self.truncated = true;
        }
        if bytes.len() >= OUTPUT_LIMIT {
            self.bytes.clear();
            self.bytes.extend(&bytes[bytes.len() - OUTPUT_LIMIT..]);
        } else {
            self.bytes.drain(..excess);
            self.bytes.extend(bytes);
        }
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.iter().copied().collect::<Vec<_>>()).into_owned()
    }
}
fn drain(input: impl Read + Send + 'static) -> (Arc<Mutex<Capture>>, thread::JoinHandle<()>) {
    let capture = Arc::new(Mutex::new(Capture::default()));
    let result = capture.clone();
    let handle = thread::spawn(move || {
        let mut input = input;
        let mut bytes = [0u8; 8192];
        loop {
            match input.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => capture
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .append(&bytes[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    capture.lock().unwrap_or_else(|e| e.into_inner()).error =
                        Some(error.to_string());
                    break;
                }
            }
        }
    });
    (result, handle)
}
fn captured(stdout: &Arc<Mutex<Capture>>, stderr: &Arc<Mutex<Capture>>) -> Value {
    let out = stdout.lock().unwrap_or_else(|e| e.into_inner());
    let err = stderr.lock().unwrap_or_else(|e| e.into_inner());
    json!({"stdout":out.text(),"stderr":err.text(),"truncated":out.truncated||err.truncated})
}
fn run_command(workspace: &Workspace, row: &Value, run: &Run, events: &Events) -> AppResult<Value> {
    if let Some(remote) = workspace.command_remote() {
        let gate = run.spawn_gate.lock().unwrap_or_else(|e| e.into_inner());
        workspace.ensure_open()?;
        if run.cancel.load(Ordering::Acquire) {
            return Ok(json!({"status":"cancelled"}));
        }
        let started = remote_call(&remote, "command_start", row.clone());
        drop(gate);
        let mut result = started?;
        loop {
            if run.cancel.load(Ordering::Acquire) {
                result = remote_call(&remote, "command_cancel", json!({"id":run.id}))?;
            }
            if result["status"] != "running" {
                return Ok(result);
            }
            update(&run.id, &result, events);
            thread::sleep(Duration::from_millis(750));
            result = remote_call(&remote, "command_status", json!({"id":run.id}))?;
        }
    }
    let root = workspace
        .local_root()
        .ok_or_else(|| invalid("Workspace backend is unavailable"))?;
    let gate = run.spawn_gate.lock().unwrap_or_else(|e| e.into_inner());
    workspace.ensure_open()?;
    if run.cancel.load(Ordering::Acquire) {
        return Ok(json!({"status":"cancelled"}));
    }
    let cwd = local_directory(&root, row["cwd"].as_str().unwrap_or(""))?;
    let argv = row["argv"]
        .as_array()
        .ok_or_else(|| invalid("Missing immutable argv"))?;
    let program = argv[0].as_str().unwrap();
    let executable = if program.contains('/') {
        let executable = cwd.join(program).canonicalize()?;
        if !executable.starts_with(root.canonicalize()?) {
            return Err(AppError::new(
                "PATH_OUTSIDE_ROOT",
                "Command executable escapes workspace",
            ));
        }
        executable
    } else {
        path_program(program)?
    };
    if executable.extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_ascii_lowercase().as_str(),
            "bat" | "cmd"
        )
    }) {
        return Err(invalid(
            "Batch files require an explicitly approved cmd interpreter; implicit shells are forbidden",
        ));
    }
    let mut command = Command::new(executable);
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("TEXYPAPER_")
            || upper.starts_with("PAPERDOCK_") // Legacy capability secrets must not leak to child commands.
            || matches!(
                upper.as_str(),
                "ANTHROPIC_API_KEY"
                    | "ANTHROPIC_AUTH_TOKEN"
                    | "OPENAI_API_KEY"
                    | "OPENAI_ACCESS_TOKEN"
                    | "CLAUDE_CODE_OAUTH_TOKEN"
                    | "CODEX_API_KEY"
                    | "AZURE_OPENAI_API_KEY"
                    | "GEMINI_API_KEY"
                    | "GOOGLE_API_KEY"
            )
        {
            command.env_remove(key);
        }
    }
    command
        .args(argv[1..].iter().map(|v| v.as_str().unwrap()))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(&mut command)?;
    drop(gate);
    let (stdout, out_reader) = drain(
        child
            .child_mut()
            .stdout
            .take()
            .ok_or_else(|| invalid("Missing stdout pipe"))?,
    );
    let (stderr, err_reader) = drain(
        child
            .child_mut()
            .stderr
            .take()
            .ok_or_else(|| invalid("Missing stderr pipe"))?,
    );
    let deadline =
        Instant::now() + Duration::from_secs(row["timeoutSeconds"].as_u64().unwrap_or(120));
    let mut last = Instant::now();
    let mut reason = None;
    let exit = loop {
        if run.cancel.load(Ordering::Acquire) {
            reason = Some("cancelled");
            child.cancel()?;
            break child.wait()?;
        }
        if Instant::now() >= deadline {
            reason = Some("timeout");
            child.cancel()?;
            break child.wait()?;
        }
        if let Some(exit) = child.try_wait()? {
            break exit;
        }
        if last.elapsed() >= Duration::from_millis(750) {
            update(&run.id, &captured(&stdout, &stderr), events);
            last = Instant::now();
        }
        thread::sleep(Duration::from_millis(25));
    };
    // Even a successful launcher can leave descendants holding output handles.
    child.cancel()?;
    let out_join = out_reader.join();
    let err_join = err_reader.join();
    let mut result = captured(&stdout, &stderr);
    result["status"] = json!(reason.unwrap_or(if exit.success() {
        "completed"
    } else {
        "failed"
    }));
    result["exitCode"] = json!(exit.code());
    if reason == Some("timeout") {
        result["error"] = json!(AppError::new(
            "COMMAND_TIMEOUT",
            "Command exceeded its approved time limit; the owned process tree was stopped"
        ));
    }
    let read_error = stdout
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .error
        .clone()
        .or_else(|| {
            stderr
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .error
                .clone()
        });
    if out_join.is_err() || err_join.is_err() || read_error.is_some() {
        result["error"] = json!(AppError::new(
            "COMMAND_OUTPUT",
            read_error.unwrap_or_else(|| "Output reader was interrupted".into())
        ));
        if reason.is_none() {
            result["status"] = json!("failed");
        }
    }
    Ok(result)
}
#[cfg(windows)]
fn path_program(program: &str) -> AppResult<PathBuf> {
    let paths = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&paths) {
        let candidate = directory.join(program);
        let candidates = if candidate.extension().is_some() {
            vec![candidate]
        } else {
            vec![
                candidate.with_extension("exe"),
                candidate.with_extension("com"),
            ]
        };
        for candidate in candidates {
            if candidate.is_file() {
                return Ok(candidate.canonicalize()?);
            }
        }
    }
    Err(AppError::new(
        "COMMAND_NOT_FOUND",
        format!("Executable not found on the host PATH: {program}"),
    ))
}
#[cfg(not(windows))]
fn path_program(program: &str) -> AppResult<PathBuf> {
    Ok(PathBuf::from(program))
}
fn remote_call(
    remote: &crate::workspace::ssh::SshBackend,
    op: &str,
    args: Value,
) -> AppResult<Value> {
    remote.execute(op, args).map_err(|error| {
        // Closing the transport triggers the server worker's EOF cleanup. Never retry a start.
        let _ = remote.close();
        remote_uncertain(error)
    })
}
fn remote_uncertain(error: AppError) -> AppError {
    let detail = format!("{}: {}", error.code, error.message)
        .chars()
        .take(2048)
        .collect::<String>();
    AppError::new(
        "COMMAND_REMOTE_UNCERTAIN",
        format!(
            "Remote status is unknown after transport failure; never replayed. The worker stops its owned group on disconnect, but termination could not be confirmed. {detail}"
        ),
    )
}
pub fn cancel_workspace(workspace_id: &str, epoch: u64) -> AppResult<()> {
    let mut state = lock();
    if state.identity.as_ref() != Some(&(workspace_id.to_owned(), epoch)) {
        return Ok(());
    }
    state.permission = "ask".into();
    let mut updates = Vec::new();
    for entry in &mut state.rows {
        if entry.row["status"] == "pending" {
            entry.row["status"] = json!("rejected");
            updates.push((entry.events.clone(), entry.row.clone()));
        }
    }
    let active = state.active.clone();
    if let Some(run) = &active {
        run.cancel.store(true, Ordering::Release);
    }
    let permission_events = state.rows.back().map(|e| e.events.clone());
    trim(&mut state);
    for (events, row) in updates {
        events.send("command/updated", row);
    }
    if let Some(events) = permission_events {
        events.send("command/permission", json!({"permission":"ask"}));
    }
    drop(state);
    if let Some(run) = active {
        run.stop();
    }
    Ok(())
}
pub fn active_workspace(workspace_id: &str, epoch: u64) -> bool {
    let state = lock();
    state.identity.as_ref() == Some(&(workspace_id.to_owned(), epoch)) && state.active.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    static SERIAL: Mutex<()> = Mutex::new(());
    fn fixture() -> (
        PathBuf,
        crate::workspace::WorkspaceManager,
        Workspace,
        Events,
    ) {
        let base =
            std::env::temp_dir().join(format!("texypaper-command-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("project")).unwrap();
        let mut manager = crate::workspace::WorkspaceManager::new(base.join("data"));
        let reference = manager
            .open(
                crate::contracts::Environment {
                    id: "local".into(),
                    label: "test".into(),
                    kind: "local".into(),
                    host_alias: None,
                    hostname: None,
                    user: None,
                    port: None,
                    identity_file: None,
                    ssh_config_file: None,
                },
                base.join("project").to_string_lossy().into(),
            )
            .unwrap();
        let workspace = manager.active(&reference.id, reference.epoch).unwrap();
        let events = Events::new(reference, Arc::new(|_| {}), &base.join("data"));
        (base, manager, workspace, events)
    }
    fn python(script: &str) -> Value {
        json!({"summary":"Synthetic isolated command","cwd":"","argv":[if cfg!(windows){"python"}else{"python3"},"-c",script],"_provider":"test","_taskId":"fixture"})
    }
    fn ui(workspace: &Workspace, op: &str, args: Value) -> AppResult<Value> {
        execute(workspace, op, args, Arc::new(|_| {}))
    }
    fn finish(workspace: &Workspace, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let row = get_status(workspace, id).unwrap();
            if row["status"] != "running" {
                return row;
            }
            assert!(Instant::now() < deadline, "command did not terminate");
            thread::sleep(Duration::from_millis(20));
        }
    }
    #[test]
    fn pending_deny_duplicate_and_epoch_authority() {
        let _serial = SERIAL.lock().unwrap();
        let (base, mut manager, workspace, events) = fixture();
        let args = python(
            "from pathlib import Path; p=Path('marker'); p.write_text(p.read_text()+'x' if p.exists() else 'x')",
        );
        let row = propose(&workspace, &base, args.clone(), &events).unwrap();
        let id = row["id"].as_str().unwrap();
        assert_eq!(row["status"], "pending");
        assert!(!base.join("project/marker").exists());
        ui(
            &workspace,
            "command_permission",
            json!({"permission":"deny"}),
        )
        .unwrap();
        assert_eq!(get_status(&workspace, id).unwrap()["status"], "rejected");
        assert_eq!(
            propose(&workspace, &base, args.clone(), &events)
                .unwrap_err()
                .code,
            "COMMAND_DENIED"
        );
        assert!(!base.join("project/marker").exists());
        ui(
            &workspace,
            "command_permission",
            json!({"permission":"ask"}),
        )
        .unwrap();
        let row = propose(&workspace, &base, args, &events).unwrap();
        let id = row["id"].as_str().unwrap();
        ui(
            &workspace,
            "command_decide",
            json!({"id":id,"decision":"approve"}),
        )
        .unwrap();
        ui(
            &workspace,
            "command_decide",
            json!({"id":id,"decision":"approve"}),
        )
        .unwrap();
        assert_eq!(finish(&workspace, id)["status"], "completed");
        ui(
            &workspace,
            "command_decide",
            json!({"id":id,"decision":"approve"}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(base.join("project/marker")).unwrap(),
            "x"
        );
        let mut escape = python("pass");
        escape["cwd"] = json!("../");
        assert!(propose(&workspace, &base, escape, &events).is_err());
        assert!(
            ui(
                &workspace,
                "command_permission",
                json!({"permission":"session"})
            )
            .is_err()
        );
        manager.close().unwrap();
        assert!(get_status(&workspace, id).is_err());
        let reference = manager
            .open(
                crate::contracts::Environment {
                    id: "local".into(),
                    label: "test".into(),
                    kind: "local".into(),
                    host_alias: None,
                    hostname: None,
                    user: None,
                    port: None,
                    identity_file: None,
                    ssh_config_file: None,
                },
                base.join("project").to_string_lossy().into(),
            )
            .unwrap();
        let reopened = manager.active(&reference.id, reference.epoch).unwrap();
        assert!(reference.epoch > workspace.reference.epoch);
        assert_eq!(recent(&reopened).unwrap()["permission"], "ask");
        assert!(
            ui(
                &reopened,
                "command_decide",
                json!({"id":id,"decision":"approve"})
            )
            .is_err()
        );
        manager.close().unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn output_nonzero_timeout_and_cancel_are_actual() {
        let _serial = SERIAL.lock().unwrap();
        let (base, mut manager, workspace, events) = fixture();
        ui(
            &workspace,
            "command_permission",
            json!({"permission":"session","acknowledged":true}),
        )
        .unwrap();
        let row = propose(
            &workspace,
            &base,
            python("import sys; print('x'*100000); print('error',file=sys.stderr); sys.exit(7)"),
            &events,
        )
        .unwrap();
        let result = finish(&workspace, row["id"].as_str().unwrap());
        assert_eq!(result["exitCode"], 7);
        assert_eq!(result["status"], "failed");
        assert_eq!(result["truncated"], true);
        assert!(result["stderr"].as_str().unwrap().contains("error"));
        let row=propose(&workspace,&base,python("import sys; print('LIVE',flush=True); print('LIVEERR',file=sys.stderr,flush=True); import time; time.sleep(30)"),&events).unwrap();
        let id = row["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let live = get_status(&workspace, id).unwrap();
            if live["stdout"].as_str().unwrap().contains("LIVE")
                && live["stderr"].as_str().unwrap().contains("LIVEERR")
            {
                assert_eq!(live["status"], "running");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Both output channels must stream before process exit"
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            ui(&workspace, "command_cancel", json!({"id":id})).unwrap()["status"],
            "cancelled"
        );
        let mut args = python("import time; time.sleep(30)");
        args["timeoutSeconds"] = json!(1);
        let row = propose(&workspace, &base, args, &events).unwrap();
        assert_eq!(
            finish(&workspace, row["id"].as_str().unwrap())["status"],
            "timeout"
        );
        let row = propose(
            &workspace,
            &base,
            python("import time; time.sleep(30)"),
            &events,
        )
        .unwrap();
        let result = ui(&workspace, "command_cancel", json!({"id":row["id"]})).unwrap();
        assert_eq!(result["status"], "cancelled");
        assert!(!active_workspace(
            &workspace.reference.id,
            workspace.reference.epoch
        ));
        manager.close().unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn deny_and_close_stop_the_owned_descendant_tree() {
        let _serial = SERIAL.lock().unwrap();
        let (base, mut manager, workspace, events) = fixture();
        let child = "import time; from pathlib import Path; time.sleep(2); Path('orphan').write_text('bad')";
        let script = format!(
            "import subprocess,sys,time; from pathlib import Path; subprocess.Popen([sys.executable,'-c',{}]); Path('ready').write_text('ready'); time.sleep(30)",
            serde_json::to_string(child).unwrap()
        );
        for close in [false, true] {
            ui(
                &workspace,
                "command_permission",
                json!({"permission":"session","acknowledged":true}),
            )
            .unwrap();
            let row = propose(&workspace, &base, python(&script), &events).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !base.join("project/ready").exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                base.join("project/ready").exists(),
                "real command must have spawned its child"
            );
            if close {
                manager.close().unwrap();
            } else {
                let denied = ui(
                    &workspace,
                    "command_permission",
                    json!({"permission":"deny"}),
                )
                .unwrap();
                assert_eq!(denied["permission"], "deny");
                assert_eq!(
                    get_status(&workspace, row["id"].as_str().unwrap()).unwrap()["status"],
                    "cancelled"
                );
            }
            assert!(!active_workspace(
                &workspace.reference.id,
                workspace.reference.epoch
            ));
            thread::sleep(Duration::from_millis(2200));
            assert!(
                !base.join("project/orphan").exists(),
                "cancel/close must kill descendants before returning"
            );
            std::fs::remove_file(base.join("project/ready")).unwrap();
        }
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn pending_queue_is_bounded_and_only_one_immutable_request_runs() {
        let _serial = SERIAL.lock().unwrap();
        let (base, mut manager, workspace, events) = fixture();
        let mut rows = Vec::new();
        for _ in 0..PENDING_LIMIT {
            rows.push(
                propose(
                    &workspace,
                    &base,
                    python("import time; time.sleep(30)"),
                    &events,
                )
                .unwrap(),
            );
        }
        assert_eq!(
            propose(&workspace, &base, python("pass"), &events)
                .unwrap_err()
                .code,
            "COMMAND_QUEUE_FULL"
        );
        let id = rows[0]["id"].as_str().unwrap();
        ui(
            &workspace,
            "command_decide",
            json!({"id":id,"decision":"approve","argv":["not-a-replacement"]}),
        )
        .unwrap();
        let busy = ui(
            &workspace,
            "command_decide",
            json!({"id":rows[1]["id"],"decision":"approve"}),
        )
        .unwrap_err();
        assert_eq!(busy.code, "COMMAND_BUSY");
        assert_eq!(get_status(&workspace, id).unwrap()["argv"], rows[0]["argv"]);
        let denied = ui(
            &workspace,
            "command_permission",
            json!({"permission":"deny"}),
        )
        .unwrap();
        assert_eq!(
            denied["requests"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["status"] == "rejected")
                .count(),
            PENDING_LIMIT - 1
        );
        ui(
            &workspace,
            "command_permission",
            json!({"permission":"ask"}),
        )
        .unwrap();
        for _ in 0..30 {
            let row = propose(&workspace, &base, python("pass"), &events).unwrap();
            assert_eq!(
                ui(&workspace, "command_cancel", json!({"id":row["id"]})).unwrap()["status"],
                "rejected"
            );
        }
        assert_eq!(
            recent(&workspace).unwrap()["requests"]
                .as_array()
                .unwrap()
                .len(),
            TERMINAL_LIMIT
        );
        manager.close().unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn malformed_authority_and_size_fields_are_rejected_before_spawn() {
        let mut args = python("pass");
        for timeout in [json!(0), json!(1201), json!(1.5), json!("1")] {
            args["timeoutSeconds"] = timeout;
            assert!(validate(&args).is_err());
        }
        args = python("pass");
        args["env"] = json!({"TEXYPAPER_BROKER_CAPABILITY":"forbidden"});
        assert!(validate(&args).is_err());
        args = python("pass");
        args["permission"] = json!("session");
        assert!(validate(&args).is_err());
        args = python("pass");
        args["argv"] = json!(vec!["x"; 129]);
        assert!(validate(&args).is_err());
        args = python("pass");
        args["argv"] = json!(["python", "x".repeat(9000)]);
        assert!(validate(&args).is_err());
        args = python("pass");
        args["argv"] = json!(["python", "nul\0argument"]);
        assert!(validate(&args).is_err());
        args = python("pass");
        args["argv"] = json!(["/outside/executable"]);
        assert!(validate(&args).is_err());
    }
}
