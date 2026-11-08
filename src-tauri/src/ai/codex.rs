use super::{
    auth::{Executable, sanitize_environment, verify},
    broker::BrokerEnvironment,
    events::{Events, JsonWriter, drain_stderr, json_reader},
    tools::TOOL_NAMES,
};
use crate::{
    contracts::{AppError, AppResult},
    process::OwnedChild,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    process::Stdio,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

const SCHEMA_DIR: &str = "0.153.2";
fn validate(name: &'static str, value: &Value) -> AppResult<()> {
    static VALIDATORS: LazyLock<Mutex<HashMap<&'static str, jsonschema::Validator>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut validators = VALIDATORS
        .lock()
        .map_err(|_| AppError::new("PROVIDER_PROTOCOL_ERROR", "Schema lock failed"))?;
    if !validators.contains_key(name) {
        let source = match name {
            "initialize" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v1/InitializeResponse.json"
            ),
            "account/read" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/GetAccountResponse.json"
            ),
            "account/login/start" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/LoginAccountResponse.json"
            ),
            "model/list" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/ModelListResponse.json"
            ),
            "thread/start" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/ThreadStartResponse.json"
            ),
            "thread/resume" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/ThreadResumeResponse.json"
            ),
            "turn/start" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/TurnStartResponse.json"
            ),
            "item/agentMessage/delta" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/AgentMessageDeltaNotification.json"
            ),
            "turn/completed" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/TurnCompletedNotification.json"
            ),
            "item/started" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/ItemStartedNotification.json"
            ),
            "item/completed" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/ItemCompletedNotification.json"
            ),
            "turn/diff/updated" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/TurnDiffUpdatedNotification.json"
            ),
            "account/login/completed" => include_str!(
                "../../../src/generated/codex-0.153.2/schema/v2/AccountLoginCompletedNotification.json"
            ),
            _ => return Ok(()),
        };
        let schema: Value = serde_json::from_str(source)?;
        let validator = jsonschema::validator_for(&schema)
            .map_err(|e| AppError::new("PROVIDER_PROTOCOL_UNSUPPORTED", e.to_string()))?;
        validators.insert(name, validator);
    }
    if let Some(error) = validators[name].iter_errors(value).next() {
        return Err(AppError::new(
            "PROVIDER_PROTOCOL_ERROR",
            format!("Codex {SCHEMA_DIR} {name}: {error}"),
        ));
    }
    Ok(())
}
pub struct Session {
    pub child: OwnedChild,
    stdin: JsonWriter,
    rx: Receiver<AppResult<Value>>,
    next_id: u64,
    cancel: Arc<AtomicBool>,
    interrupt: Option<Instant>,
    deadline: Instant,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub stderr: Arc<Mutex<Vec<u8>>>,
}
impl Session {
    pub fn spawn(
        executable: &Executable,
        data: &Path,
        cwd: &Path,
        exe: &Path,
        broker: Option<&BrokerEnvironment>,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<Self> {
        let deadline = Instant::now() + Duration::from_secs(20 * 60);
        verify(executable, "codex", data)?;
        let home = data.join("providers/codex");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(cwd)?;
        // Every launch replaces app-owned configuration, never the user's global CODEX_HOME.
        let mut config = String::from(
            "forced_login_method = \"chatgpt\"\nmodel_provider = \"openai\"\nweb_search = \"disabled\"\n[analytics]\nenabled = false\n",
        );
        if broker.is_some() {
            config.push_str(&format!("[mcp_servers.texypaper]\ncommand = {}\nargs = [\"--mcp-stdio\"]\nenv_vars = [\"TEXYPAPER_BROKER_ADDR\", \"TEXYPAPER_BROKER_CAPABILITY\", \"TEXYPAPER_TASK_ID\"]\nenabled_tools = {}\n",serde_json::to_string(&exe.to_string_lossy())?,serde_json::to_string(&TOOL_NAMES)?));
        }
        fs::write(home.join("config.toml"), config)?;
        let mut command = executable.command();
        for feature in [
            "shell_tool",
            "unified_exec",
            "code_mode",
            "code_mode_host",
            "code_mode_prewarm",
            "plugins",
            "hooks",
            "apps",
            "remote_plugin",
            "multi_agent",
            "multi_agent_v2",
            "browser_use",
            "browser_use_external",
            "browser_use_full_cdp_access",
            "computer_use",
            "in_app_browser",
            "in_app_local_automation",
            "image_generation",
            "view_image",
            "skill_search",
            "skill_mcp_dependency_install",
            "workspace_dependencies",
            "memories",
            "sleep_tool",
        ] {
            command.args(["-c", &format!("features.{feature}=false")]);
        }
        command.args([
            "-c",
            "features.skip_host_skill_discovery=true",
            "app-server",
            "--listen",
            "stdio://",
        ]);
        command
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitize_environment(&mut command, data, "codex");
        if let Some(env) = broker {
            command
                .env("TEXYPAPER_BROKER_ADDR", &env.address)
                .env("TEXYPAPER_BROKER_CAPABILITY", &env.capability)
                .env("TEXYPAPER_TASK_ID", &env.task_id);
        }
        let mut child = OwnedChild::spawn(&mut command)?;
        let stdin = child
            .child_mut()
            .stdin
            .take()
            .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing Codex stdin"))?;
        let stdout = child
            .child_mut()
            .stdout
            .take()
            .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing Codex stdout"))?;
        let stderr =
            drain_stderr(
                child.child_mut().stderr.take().ok_or_else(|| {
                    AppError::new("PROVIDER_PROCESS_ERROR", "Missing Codex stderr")
                })?,
            );
        let mut session = Self {
            child,
            stdin: JsonWriter::new(stdin),
            rx: json_reader(stdout),
            next_id: 1,
            cancel,
            interrupt: None,
            deadline,
            thread_id: None,
            turn_id: None,
            stderr,
        };
        session.rpc("initialize",json!({"clientInfo":{"name":"texypaper","title":"TexyPaper","version":"0.1.0"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}),None)?;
        session.send(json!({"method":"initialized"}))?;
        Ok(session)
    }
    fn send(&mut self, value: Value) -> AppResult<()> {
        self.stdin.send(
            &value,
            self.deadline.min(Instant::now() + Duration::from_secs(45)),
            Some(&self.cancel),
        )
    }
    fn next(&mut self, deadline: Instant) -> AppResult<Value> {
        loop {
            if self.cancel.load(Ordering::Acquire) {
                if self.interrupt.is_none() {
                    if let (Some(thread_id), Some(turn_id)) = (&self.thread_id, &self.turn_id) {
                        let started = Instant::now();
                        self.interrupt = Some(started);
                        let request = json!({"id":900000000,"method":"turn/interrupt","params":{"threadId":thread_id,"turnId":turn_id}});
                        let _ = self
                            .stdin
                            .send(&request, started + Duration::from_secs(2), None);
                    } else {
                        self.child.cancel()?;
                        return Err(AppError::new("AGENT_CANCELLED", "Task cancelled"));
                    }
                }
                if self
                    .interrupt
                    .is_some_and(|time| time.elapsed() >= Duration::from_secs(2))
                {
                    self.child.cancel()?;
                    return Err(AppError::new(
                        "AGENT_CANCELLED",
                        "Task cancelled; owned process tree stopped",
                    ));
                }
            }
            if Instant::now() > deadline.min(self.deadline) {
                self.child.cancel()?;
                return Err(AppError::new(
                    "PROVIDER_TIMEOUT",
                    "Provider request or 20-minute task deadline reached",
                ));
            }
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => return value,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    let status = self.child.try_wait()?;
                    return Err(AppError::new(
                        "PROVIDER_EXITED",
                        format!(
                            "Codex closed its output ({status:?}); inspect authentication, quota and network status"
                        ),
                    ));
                }
            }
        }
    }
    pub fn rpc(
        &mut self,
        method: &'static str,
        params: Value,
        events: Option<&Events>,
    ) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"id":id,"method":method,"params":params}))?;
        if method == "turn/start"
            && let Some(events) = events
        {
            events.prompt_sent()?;
        }
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let value = self.next(deadline)?;
            if value["id"].as_u64() == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(AppError::new("PROVIDER_REQUEST_FAILED", error.to_string()));
                }
                let result = value
                    .get("result")
                    .ok_or_else(|| AppError::new("PROVIDER_PROTOCOL_ERROR", "Missing result"))?
                    .clone();
                validate(method, &result)?;
                return Ok(result);
            }
            self.notification(value, events)?;
        }
    }
    fn notification(&mut self, message: Value, events: Option<&Events>) -> AppResult<()> {
        if message.get("id").is_some() && message.get("method").is_some() {
            // Native shell/filesystem and any unforeseen approval surface are never granted.
            let method = message["method"].as_str().unwrap_or("");
            let result = if method.contains("requestApproval") {
                json!({"decision":"decline"})
            } else {
                json!({"error":{"code":-32601,"message":"TexyPaper permits only its seven scoped MCP tools; native approvals and permission changes are denied"}})
            };
            if result.get("error").is_some() {
                self.send(json!({"id":message["id"],"error":result["error"]}))?;
            } else {
                self.send(json!({"id":message["id"],"result":result}))?;
            }
            return Ok(());
        }
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        validate(
            match method {
                "item/agentMessage/delta" => "item/agentMessage/delta",
                "turn/completed" => "turn/completed",
                "item/started" => "item/started",
                "item/completed" => "item/completed",
                "turn/diff/updated" => "turn/diff/updated",
                "account/login/completed" => "account/login/completed",
                _ => "unknown",
            },
            params,
        )?;
        if let Some(thread_id) = &self.thread_id
            && params.get("threadId").is_some()
            && params["threadId"] != *thread_id
        {
            return Ok(());
        }
        if let Some(turn_id) = &self.turn_id
            && params.get("turnId").is_some()
            && params["turnId"] != *turn_id
        {
            return Ok(());
        }
        if let Some(events) = events {
            match method {
            "item/agentMessage/delta"=>events.send("agent/text",json!({"provider":"codex","threadId":params["threadId"],"turnId":params["turnId"],"itemId":params["itemId"],"delta":params["delta"]})),
            "item/started"|"item/completed"=>{let item=&params["item"];if item["type"]=="mcpToolCall"{events.send("agent/tool",json!({"provider":"codex","itemId":item["id"],"tool":item["tool"],"status":item["status"]}));}},
            "turn/diff/updated"=>events.send("agent/diff",json!({"provider":"codex","diff":params["diff"],"replace":true,"authoritative":false})),
            "error" if params["willRetry"] != true => {
                return Err(AppError::new("PROVIDER_REQUEST_FAILED",params["error"].to_string()));
            },
            _ => {}
        }
        }
        Ok(())
    }
    pub fn status(&mut self) -> AppResult<Value> {
        let account = self.rpc("account/read", json!({"refreshToken":false}), None)?;
        let logged_in = !account["account"].is_null();
        let subscription = account["account"]["type"] == "chatgpt";
        Ok(
            json!({"provider":"codex","available":true,"version":"0.153.2","loggedIn":logged_in,"subscription":subscription,"code":if subscription{None}else{Some(if logged_in{"SUBSCRIPTION_REQUIRED"}else{"AUTH_REQUIRED"})},"message":if subscription{"ChatGPT 구독 계정 연결됨"}else{"TexyPaper 전용 Codex 계정 저장소에서 공식 ChatGPT 로그인이 필요합니다. 기존 토큰을 복사하지 않습니다."}}),
        )
    }
    pub fn models(&mut self, events: Option<&Events>) -> AppResult<Value> {
        let mut rows = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..8 {
            let page = self.rpc(
                "model/list",
                json!({
                    "limit":100, "includeHidden":true, "cursor":cursor
                }),
                events,
            )?;
            let page_rows = page["data"].as_array().ok_or_else(|| {
                AppError::new(
                    "PROVIDER_PROTOCOL_ERROR",
                    "Codex model catalog omitted data",
                )
            })?;
            rows.extend(page_rows.iter().cloned());
            let next = page["nextCursor"].as_str().map(str::to_owned);
            let mut catalog = page;
            if next.is_none() {
                catalog["data"] = json!(rows);
                return super::model_catalog::codex(catalog);
            }
            if !seen.insert(next.clone()) {
                return Err(AppError::new(
                    "PROVIDER_PROTOCOL_ERROR",
                    "Codex model catalog repeated a cursor",
                ));
            }
            cursor = next;
        }
        Err(AppError::new(
            "PROVIDER_PROTOCOL_ERROR",
            "Codex model catalog exceeds eight pages; no partial latest-model list is used",
        ))
    }

    pub fn login(&mut self, events: &Events) -> AppResult<Value> {
        let response = self.rpc(
            "account/login/start",
            json!({"type":"chatgpt"}),
            Some(events),
        )?;
        let url = response["authUrl"].as_str().ok_or_else(|| {
            AppError::new(
                "PROVIDER_PROTOCOL_ERROR",
                "Official login did not provide an authorization URL",
            )
        })?;
        if !url.starts_with("https://") {
            return Err(AppError::new(
                "PROVIDER_PROTOCOL_ERROR",
                "Authorization URL must use HTTPS",
            ));
        }
        events.send(
            "agent/login",
            json!({"provider":"codex","url":url,"status":"waiting"}),
        );
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            let message = self.next(deadline)?;
            if message["method"] == "account/login/completed" {
                validate("account/login/completed", &message["params"])?;
                if message["params"]["success"] != true {
                    return Err(AppError::new(
                        "AUTH_REQUIRED",
                        message["params"]["error"]
                            .as_str()
                            .unwrap_or("ChatGPT sign-in was not completed"),
                    ));
                }
                return self.status();
            }
            self.notification(message, Some(events))?;
        }
    }
    pub fn run(
        &mut self,
        run: &super::ProviderRun<'_>,
        on_session: impl Fn(&str) -> AppResult<()>,
    ) -> AppResult<()> {
        let prompt = run.prompt;
        let model = run.model;
        let session = run.resume;
        let cwd = run.cwd;
        let instructions = run.instructions;
        let events = run.events;
        let models = self.models(Some(events))?;
        super::model_catalog::validate_selection(&models, model, run.reasoning_effort)?;
        let mut params = json!({"cwd":cwd,"sandbox":"read-only","approvalPolicy":"never","model":model,"developerInstructions":instructions});
        // With an explicit model, resume does not restore the saved effort.
        // Omission therefore uses the provider default from the fresh private config.
        // ThreadStart/ResumeParams carry config overrides; TurnStartParams uses effort.
        if let Some(effort) = run.reasoning_effort {
            params["config"] = json!({"model_reasoning_effort":effort});
        }
        let response = if let Some(session) = session {
            params["threadId"] = json!(session);
            params["excludeTurns"] = json!(true);
            self.rpc("thread/resume", params, Some(events))?
        } else {
            self.rpc("thread/start", params, Some(events))?
        };
        let thread_id = response["thread"]["id"]
            .as_str()
            .ok_or_else(|| AppError::new("PROVIDER_PROTOCOL_ERROR", "Missing Codex thread id"))?
            .to_owned();
        self.thread_id = Some(thread_id.clone());
        on_session(&thread_id)?;
        let mut turn = json!({"threadId":thread_id,"input":[{"type":"text","text":prompt,"text_elements":[]}]});
        if let Some(effort) = run.reasoning_effort {
            turn["effort"] = json!(effort);
        }
        let started = self.rpc("turn/start", turn, Some(events))?;
        let turn_id = started["turn"]["id"]
            .as_str()
            .ok_or_else(|| AppError::new("PROVIDER_PROTOCOL_ERROR", "Missing Codex turn id"))?
            .to_owned();
        self.turn_id = Some(turn_id.clone());
        events.send(
            "agent/status",
            json!({"provider":"codex","status":"running","sessionId":thread_id,"turnId":turn_id}),
        );
        let deadline = Instant::now() + Duration::from_secs(20 * 60);
        loop {
            let message = self.next(deadline)?;
            let completed = message["method"] == "turn/completed"
                && message["params"]["threadId"] == thread_id
                && message["params"]["turn"]["id"] == turn_id;
            let completion = if completed {
                Some(message["params"]["turn"].clone())
            } else {
                None
            };
            self.notification(message, Some(events))?;
            if let Some(turn) = completion {
                self.turn_id = None;
                match turn["status"].as_str() {
                    Some("completed") => return Ok(()),
                    Some("interrupted") => {
                        return Err(AppError::new("AGENT_CANCELLED", "Codex turn interrupted"));
                    }
                    _ => {
                        return Err(AppError::new(
                            "PROVIDER_REQUEST_FAILED",
                            turn["error"].to_string(),
                        ));
                    }
                }
            }
        }
    }
    pub fn stop(&mut self) {
        let _ = self.child.cancel();
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}
