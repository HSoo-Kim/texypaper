use crate::{
    contracts::{AppError, AppResult},
    process::OwnedChild,
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Executable {
    pub path: PathBuf,
    pub prefix: Vec<OsString>,
}
impl Executable {
    pub fn command(&self) -> Command {
        let mut c = Command::new(&self.path);
        c.args(&self.prefix);
        c
    }
}
fn existing(path: PathBuf) -> Option<Executable> {
    if path.is_file() {
        Some(Executable {
            path,
            prefix: Vec::new(),
        })
    } else {
        None
    }
}
pub fn discover(provider: &str, data: &Path) -> AppResult<Executable> {
    if !matches!(provider, "codex" | "claude") {
        return Err(AppError::new(
            "PROVIDER_INVALID",
            "Provider must be codex or claude",
        ));
    }
    if let Ok(bytes) = std::fs::read(data.join("settings.json"))
        && let Ok(settings) = serde_json::from_slice::<Value>(&bytes)
        && let Some(configured) = settings["providerExecutables"][provider]
            .as_str()
            .filter(|s| !s.trim().is_empty())
    {
        let path = PathBuf::from(configured);
        if !path.is_absolute()
            || !path.is_file()
            || (cfg!(windows)
                && path
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe")))
        {
            return Err(AppError::new(
                "PROVIDER_UNAVAILABLE",
                "Configured provider executable must be an existing absolute native executable. Clear the configured path to resume discovery.",
            ));
        }
        return Ok(Executable {
            path,
            prefix: Vec::new(),
        });
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let mut candidates = Vec::new();
    if provider == "codex"
        && let Some(local) = local
    {
        candidates.push(local.join("Programs/OpenAI/Codex/bin/codex.exe"));
    }
    if let Some(home) = home {
        candidates.push(home.join(format!(".local/bin/{provider}.exe")));
        candidates.push(home.join(format!(".local/bin/{provider}")));
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        candidates.push(directory.join(format!("{provider}.exe")));
        if !cfg!(windows) {
            candidates.push(directory.join(provider));
        }
    }
    for path in candidates {
        if let Some(found) = existing(path) {
            return Ok(found);
        }
    }
    // Known npm wrappers are launched by node with their package entrypoint; never cmd /c.
    if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
        let entry = if provider == "codex" {
            roaming.join("npm/node_modules/@openai/codex/bin/codex.js")
        } else {
            roaming.join("npm/node_modules/@anthropic-ai/claude-code/cli.js")
        };
        if entry.is_file() {
            for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
                let node = directory.join(if cfg!(windows) { "node.exe" } else { "node" });
                if node.is_file() {
                    return Ok(Executable {
                        path: node,
                        prefix: vec![entry.into_os_string()],
                    });
                }
            }
        }
    }
    Err(AppError::new(
        "PROVIDER_UNAVAILABLE",
        format!(
            "Official {provider} CLI is not installed. Install it and refresh; TexyPaper does not install CLI packages automatically."
        ),
    ))
}
pub fn sanitize_environment(command: &mut Command, data: &Path, provider: &str) {
    let keys = [
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "USER",
        "USERNAME",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ];
    let values = keys
        .iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (*key, value)))
        .collect::<Vec<_>>();
    command.env_clear();
    for (key, value) in values {
        command.env(key, value);
    }
    command.env("NO_COLOR", "1");
    if provider == "codex" {
        command.env("CODEX_HOME", data.join("providers/codex"));
    }
}
pub fn capture(
    mut command: Command,
    timeout: Duration,
    limit: usize,
) -> AppResult<(std::process::ExitStatus, Vec<u8>)> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(&mut command)?;
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing provider stdout"))?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing provider stderr"))?;
    let _tail = super::events::drain_stderr(stderr);
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let bytes = rx.recv_timeout(Duration::from_secs(2)).map_err(|_| {
                AppError::new("PROVIDER_PROTOCOL_ERROR", "Provider output did not close")
            })??;
            if bytes.len() > limit {
                return Err(AppError::new(
                    "PROVIDER_PROTOCOL_ERROR",
                    "Provider status output exceeds its bound",
                ));
            }
            return Ok((status, bytes));
        }
        if start.elapsed() > timeout {
            child.cancel()?;
            return Err(AppError::new(
                "PROVIDER_TIMEOUT",
                "Provider status command timed out",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}
pub fn verify(executable: &Executable, provider: &str, data: &Path) -> AppResult<String> {
    let mut command = executable.command();
    command.arg("--version");
    sanitize_environment(&mut command, data, provider);
    let (status, output) = capture(command, Duration::from_secs(15), 8192)?;
    let version = String::from_utf8_lossy(&output).trim().to_owned();
    let expected = if provider == "codex" {
        "0.153.2"
    } else {
        "2.1.300"
    };
    if !status.success()
        || !version
            .split(|c: char| !c.is_ascii_digit() && c != '.')
            .any(|v| v == expected)
    {
        return Err(AppError::new(
            "PROVIDER_PROTOCOL_UNSUPPORTED",
            format!(
                "Installed {provider}: {version}; tested/required version: {expected}. Refresh/install this supported version; unrestricted fallback is disabled."
            ),
        ));
    }
    Ok(version)
}
pub fn claude_status(executable: &Executable, data: &Path) -> AppResult<Value> {
    let version = verify(executable, "claude", data)?;
    let mut command = executable.command();
    command.args(["auth", "status", "--json"]);
    sanitize_environment(&mut command, data, "claude");
    let (_status, bytes) = capture(command, Duration::from_secs(20), 65536)?;
    let account: Value = serde_json::from_slice(&bytes).map_err(|e| {
        AppError::new(
            "PROVIDER_PROTOCOL_ERROR",
            format!("claude auth status returned invalid JSON: {e}"),
        )
    })?;
    let logged_in = account["loggedIn"].as_bool().unwrap_or(false);
    let subscription =
        logged_in && account["authMethod"] == "claude.ai" && account["apiProvider"] == "firstParty";
    Ok(
        json!({"provider":"claude","available":true,"version":version,"loggedIn":logged_in,"subscription":subscription,"code":if subscription{None}else{Some(if logged_in{"SUBSCRIPTION_REQUIRED"}else{"AUTH_REQUIRED"})},"message":if subscription{"Claude 구독 계정 연결됨"}else{"공식 CLI에서 claude auth login을 실행하여 claude.ai 구독 계정으로 로그인하세요. API/Console/타사 계정으로 자동 전환하지 않습니다."}}),
    )
}
pub fn require_subscription(status: &Value) -> AppResult<()> {
    if status["loggedIn"] != true {
        return Err(AppError::new(
            "AUTH_REQUIRED",
            status["message"]
                .as_str()
                .unwrap_or("Official subscription sign-in is required"),
        ));
    }
    if status["subscription"] != true {
        return Err(AppError::new(
            "SUBSCRIPTION_REQUIRED",
            "Only an official first-party subscription login is supported; API billing fallback is disabled",
        ));
    }
    Ok(())
}
