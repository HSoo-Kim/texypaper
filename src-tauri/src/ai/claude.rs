use super::{
    ProviderRun,
    auth::{sanitize_environment, verify},
    events::{JsonWriter, drain_stderr, json_reader},
    tools::TOOL_NAMES,
};
use crate::{
    contracts::{AppError, AppResult},
    process::OwnedChild,
};
use serde_json::{Value, json};
use std::{
    fs,
    process::Stdio,
    sync::{atomic::Ordering, mpsc::RecvTimeoutError},
    time::{Duration, Instant},
};

// Metadata-only SDK initialize: no prompt, no MCP servers and no native tools.
// ModelInfo.resolvedModel is provided by the installed official CLI, not guessed
// from a moving alias or the version of a previous conversation.
pub fn models(
    executable: &super::auth::Executable,
    data: &std::path::Path,
    cwd: &std::path::Path,
) -> AppResult<Value> {
    fs::create_dir_all(cwd)?;
    let mut command = executable.command();
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--tools",
        "",
        "--permission-mode",
        "default",
        "--permission-prompts",
        "none",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--disable-slash-commands",
        "--no-session-persistence",
    ]);
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_environment(&mut command, data, "claude");
    let mut child = OwnedChild::spawn(&mut command)?;
    let writer =
        JsonWriter::new(child.child_mut().stdin.take().ok_or_else(|| {
            AppError::new("PROVIDER_PROCESS_ERROR", "Missing Claude metadata stdin")
        })?);
    let reader = json_reader(child.child_mut().stdout.take().ok_or_else(|| {
        AppError::new("PROVIDER_PROCESS_ERROR", "Missing Claude metadata stdout")
    })?);
    let _stderr = drain_stderr(child.child_mut().stderr.take().ok_or_else(|| {
        AppError::new("PROVIDER_PROCESS_ERROR", "Missing Claude metadata stderr")
    })?);
    let deadline = Instant::now() + Duration::from_secs(45);
    writer.send(
        &json!({
            "type":"control_request", "request_id":"texypaper-model-catalog",
            "request":{"subtype":"initialize"}
        }),
        deadline,
        None,
    )?;
    let result = loop {
        let message = reader
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| {
                AppError::new(
                    if matches!(error, RecvTimeoutError::Timeout) {
                        "PROVIDER_TIMEOUT"
                    } else {
                        "PROVIDER_EXITED"
                    },
                    "Claude did not return its model metadata; no guessed fallback is available",
                )
            })??;
        if message["type"] == "control_request" {
            break Err(AppError::new(
                "PROVIDER_TOOL_POLICY",
                "Metadata discovery cannot grant permissions",
            ));
        }
        if message["type"] != "control_response"
            || message["response"]["request_id"] != "texypaper-model-catalog"
        {
            continue;
        }
        if message["response"]["subtype"] != "success" {
            break Err(AppError::new(
                "PROVIDER_MODEL_UNAVAILABLE",
                message["response"]["error"]
                    .as_str()
                    .unwrap_or("Claude model metadata is unavailable"),
            ));
        }
        break super::model_catalog::claude(&message["response"]["response"]["models"]);
    };
    drop(writer);
    child.cancel()?;
    result
}

pub fn run(run: ProviderRun<'_>, on_session: impl Fn(&str) -> AppResult<()>) -> AppResult<()> {
    let ProviderRun {
        executable,
        data,
        cwd,
        exe,
        broker,
        prompt,
        model,
        reasoning_effort,
        resume,
        instructions,
        cancel,
        events,
    } = run;
    let deadline = Instant::now() + Duration::from_secs(20 * 60);
    verify(executable, "claude", data)?;
    let catalog = models(executable, data, cwd)?;
    super::model_catalog::validate_selection(&catalog, model, reasoning_effort)?;
    fs::create_dir_all(cwd)?;
    let config = cwd.join("texypaper-mcp.json");
    // Capability lives exclusively in the environment, never the generated config or transcript.
    fs::write(
        &config,
        serde_json::to_vec(
            &json!({"mcpServers":{"texypaper":{"type":"stdio","command":exe,"args":["--mcp-stdio"]}}}),
        )?,
    )?;
    let mut command = executable.command();
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--restricted",
        "--tools",
        "",
        "--permission-mode",
        "default",
        "--permission-prompts",
        "none",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
    ]);
    command.arg(&config);
    command.arg("--allowedTools");
    for name in TOOL_NAMES {
        command.arg(format!("mcp__texypaper__{name}"));
    }
    command.args([
        "--model",
        model,
        "--append-system-prompt",
        instructions,
        "--disable-slash-commands",
    ]);
    // Explicit launch flags also override the saved effort when resuming.
    // Omission leaves Claude's own model/managed default in force.
    if let Some(effort) = reasoning_effort {
        command.args(["--effort", effort]);
    }
    if let Some(session) = resume {
        command.args(["--resume", session]);
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_environment(&mut command, data, "claude");
    command
        .env("TEXYPAPER_BROKER_ADDR", &broker.address)
        .env("TEXYPAPER_BROKER_CAPABILITY", &broker.capability)
        .env("TEXYPAPER_TASK_ID", &broker.task_id);
    let mut child = OwnedChild::spawn(&mut command)?;
    let mut stdin = JsonWriter::new(
        child
            .child_mut()
            .stdin
            .take()
            .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing Claude stdin"))?,
    );
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing Claude stdout"))?;
    let _stderr = drain_stderr(
        child
            .child_mut()
            .stderr
            .take()
            .ok_or_else(|| AppError::new("PROVIDER_PROCESS_ERROR", "Missing Claude stderr"))?,
    );
    let rx = json_reader(stdout);
    let mut envelope = json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":prompt},"parent_tool_use_id":null});
    if let Some(session) = resume {
        envelope["session_id"] = json!(session);
    }
    stdin.send(
        &envelope,
        deadline.min(Instant::now() + Duration::from_secs(45)),
        Some(&cancel),
    )?;
    events.prompt_sent()?;
    let mut interrupted = None;
    let mut initialized = false;
    let mut session_id = None;
    let mut completed = None;
    let mut text_seen = false;
    loop {
        if cancel.load(Ordering::Acquire) && interrupted.is_none() {
            let started = Instant::now();
            interrupted = Some(started);
            let _ = write_line(
                &mut stdin,
                &json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":{"subtype":"interrupt"}}),
            );
        }
        if interrupted.is_some_and(|time| time.elapsed() > Duration::from_secs(2)) {
            child.cancel()?;
            return Err(AppError::new(
                "AGENT_CANCELLED",
                "Claude task interrupted and owned process tree stopped",
            ));
        }
        if Instant::now() > deadline {
            child.cancel()?;
            return Err(AppError::new(
                "PROVIDER_TIMEOUT",
                "Claude task exceeded 20-minute deadline",
            ));
        }
        let message = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => v?,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match message["type"].as_str() {
            Some("system") if message["subtype"] == "init" => {
                let tools = message["tools"].as_array().ok_or_else(|| {
                    AppError::new(
                        "PROVIDER_PROTOCOL_ERROR",
                        "Claude init omitted the initialized tool inventory",
                    )
                })?;
                for tool in tools {
                    let name = tool.as_str().ok_or_else(|| {
                        AppError::new(
                            "PROVIDER_PROTOCOL_ERROR",
                            "Claude tool inventory is malformed",
                        )
                    })?;
                    if !TOOL_NAMES
                        .iter()
                        .any(|allowed| name == format!("mcp__texypaper__{allowed}"))
                    {
                        child.cancel()?;
                        return Err(AppError::new(
                            "PROVIDER_TOOL_POLICY",
                            format!(
                                "Managed policy exposed an unexpected tool: {name}. Task stopped without granting access."
                            ),
                        ));
                    }
                }
                if !TOOL_NAMES.iter().all(|name| {
                    tools
                        .iter()
                        .any(|tool| tool == &Value::String(format!("mcp__texypaper__{name}")))
                }) {
                    child.cancel()?;
                    return Err(AppError::new(
                        "PROVIDER_TOOL_UNAVAILABLE",
                        "The seven TexyPaper MCP tools did not all initialize. Check CLI policy/MCP startup.",
                    ));
                }
                if message["model"].as_str() != Some(model) {
                    child.cancel()?;
                    return Err(AppError::new(
                        "PROVIDER_MODEL_UNAVAILABLE",
                        format!(
                            "Claude selected {} instead of requested {model}; implicit model substitution is not accepted",
                            message["model"]
                        ),
                    ));
                }
                let id = message["session_id"].as_str().ok_or_else(|| {
                    AppError::new("PROVIDER_PROTOCOL_ERROR", "Claude init omitted session_id")
                })?;
                on_session(id)?;
                session_id = Some(id.to_owned());
                initialized = true;
                events.send(
                    "agent/status",
                    json!({"provider":"claude","status":"running","sessionId":id}),
                );
            }
            Some("stream_event") => {
                if !initialized {
                    continue;
                }
                let event = &message["event"];
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    let delta = event["delta"]["text"].as_str().ok_or_else(|| {
                        AppError::new("PROVIDER_PROTOCOL_ERROR", "Claude text delta is malformed")
                    })?;
                    text_seen = true;
                    events.send(
                        "agent/text",
                        json!({"provider":"claude","sessionId":session_id,"delta":delta}),
                    );
                } else if event["type"] == "content_block_start"
                    && event["content_block"]["type"] == "tool_use"
                {
                    events.send("agent/tool",json!({"provider":"claude","tool":event["content_block"]["name"],"status":"running"}));
                }
            }
            Some("result") => {
                // Official interruption may finish with is_error:true; accepted user cancellation is not a provider failure.
                if cancel.load(Ordering::Acquire) {
                    completed = Some(message);
                    break;
                }
                if !initialized {
                    return Err(AppError::new(
                        "PROVIDER_PROTOCOL_ERROR",
                        "Claude result arrived without an initialized, verified tool policy",
                    ));
                }
                if message["is_error"] == true {
                    return Err(AppError::new(
                        "PROVIDER_REQUEST_FAILED",
                        message
                            .get("errors")
                            .unwrap_or(&message["result"])
                            .to_string(),
                    ));
                }
                if message["subtype"] != "success" {
                    return Err(AppError::new(
                        "PROVIDER_REQUEST_FAILED",
                        format!("Claude result: {}", message["subtype"]),
                    ));
                }
                if !text_seen && let Some(text) = message["result"].as_str() {
                    events.send(
                        "agent/text",
                        json!({"provider":"claude","sessionId":session_id,"delta":text}),
                    );
                }
                completed = Some(message);
                break;
            }
            Some("control_request") => {
                // No native approval or policy expansion can be self-approved.
                write_line(
                    &mut stdin,
                    &json!({"type":"control_response","response":{"subtype":"error","request_id":message["request_id"],"error":"TexyPaper only permits its scoped MCP tools; native approvals are denied"}}),
                )?;
            }
            _ => {}
        }
    }
    drop(stdin);
    let exit_deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() > exit_deadline {
            child.cancel()?;
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::new(
                    "AGENT_CANCELLED",
                    "Claude task cancelled; owned process tree stopped after EOF grace",
                ));
            }
            return Err(AppError::new(
                "PROVIDER_EXIT_TIMEOUT",
                "Claude result received but the CLI did not terminate after EOF",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::new("AGENT_CANCELLED", "Claude task cancelled"));
    }
    if completed.is_none() || !status.success() {
        return Err(AppError::new(
            "PROVIDER_EXITED",
            format!("Claude did not produce a successful authoritative result and exit: {status}"),
        ));
    }
    Ok(())
}
fn write_line(writer: &mut JsonWriter, value: &Value) -> AppResult<()> {
    writer.send(value, Instant::now() + Duration::from_secs(2), None)
}
