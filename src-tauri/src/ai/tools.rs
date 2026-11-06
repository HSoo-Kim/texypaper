use super::{
    events::Events,
    proposals::{ProposalStore, read_allowed, validate_relative},
};
use crate::{
    contracts::{AppError, AppResult},
    workspace::Workspace,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub const TOOL_NAMES: [&str; 7] = [
    "list_files",
    "read_text",
    "search_text",
    "get_build_status",
    "propose_changes",
    "propose_command",
    "get_command_status",
];
type ReadEvidence = (String, Vec<(usize, usize)>);
pub struct TexyPaperTools {
    pub workspace: Workspace,
    pub data: PathBuf,
    pub proposals: Arc<ProposalStore>,
    pub events: Events,
    provider: String,
    task_id: String,
    reads: Mutex<HashMap<String, ReadEvidence>>,
}
impl TexyPaperTools {
    pub fn new(
        workspace: Workspace,
        data: PathBuf,
        proposals: Arc<ProposalStore>,
        events: Events,
        provider: String,
        task_id: String,
    ) -> Self {
        Self {
            workspace,
            data,
            proposals,
            events,
            provider,
            task_id,
            reads: Mutex::new(HashMap::new()),
        }
    }
    pub fn call(&self, name: &str, mut args: Value) -> AppResult<Value> {
        if !TOOL_NAMES.contains(&name) {
            return Err(AppError::new(
                "AGENT_TOOL_DENIED",
                "Tool is not in the TexyPaper allowlist",
            ));
        }
        self.events.send(
            "agent/tool",
            json!({"tool":name,"path":args.get("path"),"status":"started"}),
        );
        match name {
            "list_files" => {
                let path = args["path"].as_str().unwrap_or("");
                validate_relative(path, true)?;
                if !read_allowed(path) {
                    return Err(AppError::new(
                        "AGENT_READ_DENIED",
                        "Private/auth/recovery paths cannot be read",
                    ));
                }
                let result = self
                    .workspace
                    .execute("list_dir", json!({"path":path,"_agentPolicy":true}))?;
                let rows = result
                    .as_array()
                    .or_else(|| result["entries"].as_array())
                    .ok_or_else(|| {
                        AppError::new(
                            "WORKSPACE_PROTOCOL_ERROR",
                            "Directory result has no entries",
                        )
                    })?;
                let cursor = parse_cursor(&args)?;
                let allowed = rows
                    .iter()
                    .filter(|r| r["path"].as_str().is_some_and(read_allowed))
                    .collect::<Vec<_>>();
                let mut page = Vec::new();
                let mut bytes = 1024usize;
                for row in allowed.iter().skip(cursor).take(256) {
                    let entry = json!({"path":row["path"],"name":row["name"],"kind":row["kind"],"byteLength":row.get("byteLength")});
                    let size = serde_json::to_vec(&entry)?.len();
                    if bytes + size > 60 * 1024 {
                        break;
                    }
                    bytes += size;
                    page.push(entry);
                }
                if page.is_empty() && cursor < allowed.len() {
                    return Err(AppError::new(
                        "DIRECTORY_ENTRY_LIMIT",
                        "A directory metadata entry exceeds 60 KiB",
                    ));
                }
                Ok(
                    json!({"entries":page,"nextCursor":if cursor+page.len()<allowed.len(){Some((cursor+page.len()).to_string())}else{None},"environmentId":self.workspace.reference.environment_id,"root":self.workspace.reference.root}),
                )
            }
            "read_text" => {
                let path = args["path"]
                    .as_str()
                    .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "path is required"))?;
                if !read_allowed(path) {
                    return Err(AppError::new(
                        "AGENT_READ_DENIED",
                        "Private keys, credentials, auth, recovery and history are never attached",
                    ));
                }
                let doc = self
                    .workspace
                    .execute("read_text", json!({"path":path,"_agentPolicy":true}))?;
                let text = doc["text"].as_str().ok_or_else(|| {
                    AppError::new(
                        "ENCODING_UNSUPPORTED",
                        "Only strict UTF-8 text is available to the agent",
                    )
                })?;
                let start = args["startLine"].as_u64().unwrap_or(1) as usize;
                let requested_end = args["endLine"].as_u64().unwrap_or(usize::MAX as u64) as usize;
                if start == 0 || requested_end < start {
                    return Err(AppError::new(
                        "INVALID_ARGUMENT",
                        "Line intervals are 1-based and ordered",
                    ));
                }
                let mut output = String::new();
                let mut end = start.saturating_sub(1);
                let mut continuation = None;
                let mut encoded_size = 0usize;
                let budget = (64 * 1024usize).saturating_sub(escaped_size(path) * 2 + 512);
                for (index, line) in text.split_inclusive('\n').enumerate() {
                    let number = index + 1;
                    if number < start {
                        continue;
                    }
                    if number > requested_end {
                        break;
                    }
                    let size = escaped_size(line);
                    if encoded_size + size > budget {
                        continuation = Some(number);
                        break;
                    }
                    encoded_size += size;
                    output.push_str(line);
                    end = number;
                }
                if end < start && continuation.is_some() {
                    return Err(AppError::new(
                        "AGENT_LINE_TOO_LONG",
                        "A single source line exceeds 60 KiB; use a smaller source file",
                    ));
                }
                let sha = doc["revision"]["sha256"].as_str().unwrap_or("").to_owned();
                let mut reads = self
                    .reads
                    .lock()
                    .map_err(|_| AppError::new("STATE_POISONED", "Evidence lock failed"))?;
                if reads.len() >= 256 && !reads.contains_key(path) {
                    return Err(AppError::new(
                        "AGENT_READ_LIMIT",
                        "Task inspected 256 files; start another task",
                    ));
                }
                let entry = reads
                    .entry(path.into())
                    .or_insert_with(|| (sha.clone(), Vec::new()));
                if entry.0 != sha {
                    *entry = (sha.clone(), Vec::new());
                }
                if entry.1.len() < 256 {
                    entry.1.push((start, end));
                }
                Ok(
                    json!({"path":path,"sha256":sha,"startLine":start,"endLine":end,"text":output,"continuation":continuation.map(|line|json!({"path":path,"startLine":line})),"truncated":continuation.is_some()}),
                )
            }
            "search_text" => {
                let path = args["path"].as_str().unwrap_or("");
                if !read_allowed(path) {
                    return Err(AppError::new(
                        "AGENT_READ_DENIED",
                        "Search path is excluded",
                    ));
                }
                let query = args["query"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096)
                    .ok_or_else(|| {
                        AppError::new("INVALID_ARGUMENT", "query must contain 1–4096 bytes")
                    })?;
                let result=self.workspace.execute("search_text",json!({"path":path,"query":query,"cursor":args.get("cursor"),"limit":200,"_agentPolicy":true}))?;
                let rows = result
                    .as_array()
                    .or_else(|| result["matches"].as_array())
                    .ok_or_else(|| {
                        AppError::new("WORKSPACE_PROTOCOL_ERROR", "Search result has no matches")
                    })?;
                let matches = rows
                    .iter()
                    .filter(|r| r["path"].as_str().is_some_and(read_allowed))
                    .take(200)
                    .cloned()
                    .collect::<Vec<_>>();
                let value = json!({"matches":matches,"nextCursor":result.get("nextCursor")});
                if serde_json::to_vec(&value)?.len() > 64 * 1024 {
                    return Err(AppError::new(
                        "SEARCH_RESULT_LIMIT",
                        "Narrow the search path/query: result exceeds 64 KiB",
                    ));
                }
                Ok(value)
            }
            "get_build_status" => {
                let mut status = self.workspace.execute("build_status", json!({}))?;
                if let Some(log) = status["logTail"].as_str() {
                    let start = log.len().saturating_sub(24 * 1024);
                    let start = (start..=log.len())
                        .find(|i| log.is_char_boundary(*i))
                        .unwrap_or(log.len());
                    status["logTail"] = json!(&log[start..]);
                }
                if let Some(rows) = status["diagnostics"].as_array_mut() {
                    rows.truncate(64);
                }
                if serde_json::to_vec(&status)?.len() > 64 * 1024 {
                    if let Some(object) = status.as_object_mut() {
                        object.remove("manifest");
                    }
                    status["manifestOmitted"] = json!(true);
                }
                if serde_json::to_vec(&status)?.len() > 64 * 1024 {
                    return Err(AppError::new(
                        "BUILD_STATUS_LIMIT",
                        "Build status exceeds 64 KiB; open the native build panel for full diagnostics",
                    ));
                }
                Ok(status)
            }
            "propose_changes" => {
                // Evidence must refer to chunks actually delivered by this task, not model-invented line references.
                let reads = self
                    .reads
                    .lock()
                    .map_err(|_| AppError::new("STATE_POISONED", "Evidence lock failed"))?;
                if let Some(evidence) = args["evidence"].as_array() {
                    for e in evidence {
                        let path = e["path"].as_str().unwrap_or("");
                        let sha = e["sha256"].as_str().unwrap_or("");
                        let start = e["startLine"].as_u64().unwrap_or(0) as usize;
                        let end = e["endLine"].as_u64().unwrap_or(0) as usize;
                        if !reads.get(path).is_some_and(|(s, ranges)| {
                            s == sha
                                && ranges
                                    .iter()
                                    .any(|(a, b)| start >= *a && end <= *b && end >= start)
                        }) {
                            return Err(AppError::new(
                                "EVIDENCE_UNREAD",
                                "Read each cited evidence range through read_text before proposing",
                            ));
                        }
                    }
                }
                if let Some(files) = args["files"].as_array() {
                    for f in files {
                        if f["action"] == "edit" {
                            let path = f["path"].as_str().unwrap_or("");
                            let sha = f["baseSha256"].as_str().unwrap_or("");
                            if !reads.get(path).is_some_and(|(s, _)| s == sha) {
                                return Err(AppError::new(
                                    "PROPOSAL_UNREAD",
                                    "Read every edited file at the proposal's base revision first",
                                ));
                            }
                        }
                    }
                }
                drop(reads);
                args["_provider"] = json!(self.provider);
                args["_taskId"] = json!(self.task_id);
                self.proposals
                    .stage(&self.workspace, &self.data, args, &self.events)
            }
            "propose_command" => {
                let mut command: Value = serde_json::to_value(serde_json::from_value::<
                    super::mcp::ProposeCommand,
                >(args)?)?;
                // Neither broker callers nor the model can forge attribution or approval.
                command["_provider"] = json!(self.provider);
                command["_taskId"] = json!(self.task_id);
                crate::execution::propose(&self.workspace, &self.data, command, &self.events)
            }
            "get_command_status" => {
                let request: super::mcp::GetCommandStatus = serde_json::from_value(args)?;
                crate::execution::get_status(&self.workspace, &request.id)
            }
            _ => unreachable!(),
        }
    }
}
fn parse_cursor(args: &Value) -> AppResult<usize> {
    match args["cursor"].as_str() {
        Some(v) => v
            .parse()
            .map_err(|_| AppError::new("INVALID_CURSOR", "Invalid cursor")),
        None => Ok(0),
    }
}
fn escaped_size(text: &str) -> usize {
    text.bytes()
        .map(|b| match b {
            b'\"' | b'\\' => 2,
            b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum()
}
