use super::events::Events;
use crate::{
    contracts::{AppError, AppResult},
    workspace::Workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replacement {
    pub old_text: String,
    pub new_text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProposedFile {
    #[serde(rename_all = "camelCase")]
    Edit {
        path: String,
        base_sha256: String,
        replacements: Vec<Replacement>,
    },
    #[serde(rename_all = "camelCase")]
    Create {
        path: String,
        base_sha256: Option<String>,
        content: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub path: String,
    pub sha256: String,
    pub start_line: usize,
    pub end_line: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub action: String,
    pub path: String,
    pub base_sha256: Option<String>,
    pub content: String,
    pub before: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub workspace_id: String,
    pub epoch: u64,
    pub provider: String,
    pub task_id: String,
    pub summary: String,
    pub status: String,
    pub files: Vec<StagedFile>,
    pub evidence: Vec<Evidence>,
    pub transaction_id: Option<String>,
    pub error: Option<AppError>,
}
#[derive(Default)]
pub struct ProposalStore {
    mutation: Mutex<()>,
}

pub fn validate_relative(path: &str, allow_empty: bool) -> AppResult<()> {
    if (!allow_empty && path.is_empty())
        || path.contains(['\0', '\\', ':'])
        || path.starts_with('/')
        || path
            .split('/')
            .any(|p| p == ".." || p == "." || (!path.is_empty() && p.is_empty()))
    {
        return Err(AppError::new(
            "PATH_INVALID",
            "Only normalized workspace-relative paths are permitted",
        ));
    }
    Ok(())
}
pub fn read_allowed(path: &str) -> bool {
    if validate_relative(path, true).is_err() {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    !lower.split('/').any(|p| {
        p == ".git"
            || p == ".texypaper"
            || p == ".paperdock" // Legacy private metadata is never AI source input.
            || p == ".ssh"
            || p == ".aws"
            || p == ".azure"
            || p == ".gnupg"
            || p == "credentials"
            || p.starts_with(".env")
            || p == "auth.json"
            || p == "credentials.json"
            || p == ".credentials.json"
            || p == "id_rsa"
            || p == "id_ed25519"
            || p == "id_ecdsa"
            || p.ends_with(".pem")
            || p.ends_with(".key")
            || p.ends_with(".p12")
            || p.ends_with(".pfx")
    })
}
pub fn write_allowed(path: &str) -> bool {
    read_allowed(path)
        && path.rsplit('.').next().is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "tex" | "ltx" | "bib" | "sty" | "cls" | "bst" | "bbx" | "cbx"
            )
        })
}
pub fn apply_replacements(source: &str, replacements: &[Replacement]) -> AppResult<String> {
    if replacements.is_empty() {
        return Err(AppError::new(
            "PROPOSAL_INVALID",
            "At least one replacement is required",
        ));
    }
    let mut spans = Vec::new();
    for r in replacements {
        if r.old_text.is_empty() {
            return Err(AppError::new(
                "PROPOSAL_AMBIGUOUS",
                "Empty oldText cannot identify a unique interval",
            ));
        }
        let hits = source
            .match_indices(&r.old_text)
            .map(|(i, _)| i)
            .take(2)
            .collect::<Vec<_>>();
        if hits.len() != 1 {
            return Err(AppError::new(
                "PROPOSAL_AMBIGUOUS",
                "oldText must match exactly once in the stated base revision",
            ));
        }
        spans.push((hits[0], hits[0] + r.old_text.len(), &r.new_text));
    }
    spans.sort_by_key(|s| s.0);
    if spans.windows(2).any(|w| w[0].1 > w[1].0) {
        return Err(AppError::new(
            "PROPOSAL_OVERLAP",
            "Replacement intervals overlap",
        ));
    }
    let mut output = String::new();
    let mut position = 0;
    for (start, end, text) in spans {
        output.push_str(&source[position..start]);
        output.push_str(text);
        position = end;
    }
    output.push_str(&source[position..]);
    Ok(output)
}
fn directory(data: &Path, workspace: &Workspace) -> PathBuf {
    data.join("workspaces")
        .join(&workspace.reference.id)
        .join("proposals")
}
fn persist(path: &Path, proposal: &Proposal) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("PROPOSAL_STORAGE", "Invalid proposal location"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    {
        use std::io::Write;
        let mut f = fs::File::create(&temp)?;
        f.write_all(&serde_json::to_vec(proposal)?)?;
        f.sync_all()?;
    }
    super::atomic_replace(&temp, path)?;
    Ok(())
}
impl ProposalStore {
    pub fn stage(
        &self,
        workspace: &Workspace,
        data: &Path,
        args: Value,
        events: &Events,
    ) -> AppResult<Value> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| AppError::new("STATE_POISONED", "Proposal lock failed"))?;
        let summary = args["summary"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
            .ok_or_else(|| {
                AppError::new(
                    "PROPOSAL_INVALID",
                    "A nonempty summary up to 8 KiB is required",
                )
            })?
            .to_owned();
        let files: Vec<ProposedFile> = serde_json::from_value(args["files"].clone())?;
        let evidence: Vec<Evidence> =
            serde_json::from_value(args.get("evidence").cloned().unwrap_or(json!([])))?;
        if files.is_empty() || files.len() > 16 || evidence.len() > 128 {
            return Err(AppError::new(
                "PROPOSAL_LIMIT",
                "Proposals permit 1–16 files and at most 128 evidence ranges",
            ));
        }
        let mut staged = Vec::new();
        let mut changed = 0usize;
        let mut seen = std::collections::HashSet::new();
        for file in files {
            let path = match &file {
                ProposedFile::Edit { path, .. } | ProposedFile::Create { path, .. } => path,
            };
            if !write_allowed(path) || !seen.insert(path.clone()) {
                return Err(AppError::new(
                    "AGENT_WRITE_DENIED",
                    format!("This file is not an allowed unique TeX write: {path}"),
                ));
            }
            let item = match file {
                ProposedFile::Edit {
                    path,
                    base_sha256,
                    replacements,
                } => {
                    let doc =
                        workspace.execute("read_text", json!({"path":path,"_agentPolicy":true}))?;
                    if doc["revision"]["sha256"].as_str() != Some(&base_sha256) {
                        return Err(AppError::new(
                            "FILE_CONFLICT",
                            format!("Base revision changed: {path}"),
                        ));
                    }
                    if doc["readOnly"].as_bool() == Some(true) {
                        return Err(AppError::new("FILE_READ_ONLY", path));
                    }
                    let before = doc["text"]
                        .as_str()
                        .ok_or_else(|| {
                            AppError::new("ENCODING_UNSUPPORTED", "File is not UTF-8 text")
                        })?
                        .to_owned();
                    for r in &replacements {
                        changed = changed.saturating_add(r.old_text.len() + r.new_text.len());
                    }
                    let content = apply_replacements(&before, &replacements)?;
                    StagedFile {
                        action: "edit".into(),
                        path,
                        base_sha256: Some(base_sha256),
                        content,
                        before,
                    }
                }
                ProposedFile::Create {
                    path,
                    base_sha256,
                    content,
                } => {
                    if base_sha256.is_some() {
                        return Err(AppError::new(
                            "PROPOSAL_INVALID",
                            "Creates require baseSha256:null",
                        ));
                    }
                    match workspace.execute("read_text", json!({"path":path,"_agentPolicy":true})) {
                        Ok(_) => {
                            return Err(AppError::new(
                                "FILE_CONFLICT",
                                format!("Create target already exists: {path}"),
                            ));
                        }
                        Err(e)
                            if matches!(
                                e.code.as_str(),
                                "FILE_NOT_FOUND" | "NOT_FOUND" | "PATH_NOT_FOUND"
                            ) => {}
                        Err(e) => return Err(e),
                    }
                    changed = changed.saturating_add(content.len());
                    StagedFile {
                        action: "create".into(),
                        path,
                        base_sha256: None,
                        content,
                        before: String::new(),
                    }
                }
            };
            if changed > 1024 * 1024 {
                return Err(AppError::new(
                    "PROPOSAL_LIMIT",
                    "Changed text exceeds 1 MiB",
                ));
            }
            staged.push(item);
        }
        for item in &evidence {
            if !read_allowed(&item.path) || item.start_line == 0 || item.end_line < item.start_line
            {
                return Err(AppError::new(
                    "EVIDENCE_INVALID",
                    "Evidence requires an allowed path and actual 1-based line interval",
                ));
            }
            let doc =
                workspace.execute("read_text", json!({"path":item.path,"_agentPolicy":true}))?;
            if doc["revision"]["sha256"].as_str() != Some(&item.sha256) {
                return Err(AppError::new(
                    "EVIDENCE_STALE",
                    format!("Evidence revision changed: {}", item.path),
                ));
            }
            if item.end_line > doc["text"].as_str().unwrap_or("").split('\n').count() {
                return Err(AppError::new(
                    "EVIDENCE_INVALID",
                    "Evidence line lies outside the file",
                ));
            }
        }
        let proposal = Proposal {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace.reference.id.clone(),
            epoch: workspace.reference.epoch,
            provider: args["_provider"].as_str().unwrap_or("unknown").into(),
            task_id: args["_taskId"].as_str().unwrap_or("").into(),
            summary,
            status: "pending".into(),
            files: staged,
            evidence,
            transaction_id: None,
            error: None,
        };
        persist(
            &directory(data, workspace).join(format!("{}.json", proposal.id)),
            &proposal,
        )?;
        events.send("proposal/created", serde_json::to_value(&proposal)?);
        Ok(
            json!({"proposalId":proposal.id,"status":"pending","filesUnchanged":true,"message":"승인 대기. Source files are unchanged. Only the user can Apply in TexyPaper; this tool cannot approve."}),
        )
    }
    pub fn list(&self, workspace: &Workspace, data: &Path) -> AppResult<Value> {
        let dir = directory(data, workspace);
        if !dir.exists() {
            return Ok(json!({"proposals":[]}));
        }
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| AppError::new("STATE_POISONED", "Proposal lock failed"))?;
        let mut proposals = Vec::new();
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let mut p: Proposal = serde_json::from_slice(&fs::read(&path)?)?;
            if p.status == "applying" {
                let transaction_id = p.transaction_id.as_deref().ok_or_else(|| {
                    AppError::new(
                        "PROPOSAL_RECOVERY_REQUIRED",
                        "Interrupted proposal has no transaction identity",
                    )
                })?;
                let state = workspace.execute(
                    "transaction_status",
                    json!({"transactionId":transaction_id}),
                )?;
                p.status = if state["status"] == "committed" {
                    "applied"
                } else {
                    "conflicted"
                }
                .into();
                if p.status == "conflicted" {
                    let mut error = AppError::new(
                        "PROPOSAL_RECOVERY_REQUIRED",
                        "Interrupted apply is not replayed. Review its exact transaction status before any further source change.",
                    );
                    error.details = Some(state);
                    p.error = Some(error);
                }
                persist(&path, &p)?;
            }
            if matches!(p.status.as_str(), "pending" | "conflicted") {
                proposals.push(p);
            }
        }
        Ok(json!({"proposals":proposals}))
    }
    pub fn decide(
        &self,
        workspace: &Workspace,
        data: &Path,
        args: &Value,
        events: &Events,
    ) -> AppResult<Value> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| AppError::new("STATE_POISONED", "Proposal lock failed"))?;
        let id = args["id"]
            .as_str()
            .ok_or_else(|| AppError::new("PROPOSAL_INVALID", "Missing proposal id"))?;
        uuid::Uuid::parse_str(id)
            .map_err(|_| AppError::new("PROPOSAL_INVALID", "Invalid proposal id"))?;
        let path = directory(data, workspace).join(format!("{id}.json"));
        let mut p: Proposal = serde_json::from_slice(&fs::read(&path)?)?;
        if p.workspace_id != workspace.reference.id
            || !matches!(p.status.as_str(), "pending" | "conflicted")
        {
            return Err(AppError::new(
                "PROPOSAL_STATE",
                "Proposal is not awaiting this user's approval",
            ));
        }
        match args["decision"].as_str() {
            Some("reject") => {
                p.status = "rejected".into();
                persist(&path, &p)?;
                events.send("proposal/rejected", json!({"id":id,"status":"rejected"}));
                Ok(json!({"id":id,"status":"rejected","changed":[]}))
            }
            Some("apply") => {
                let transaction_id = uuid::Uuid::new_v4().to_string();
                p.status = "applying".into();
                p.transaction_id = Some(transaction_id.clone());
                persist(&path, &p)?;
                let files=p.files.iter().map(|f|json!({"path":f.path,"baseSha256":f.base_sha256,"content":f.content,"action":f.action})).collect::<Vec<_>>();
                match workspace.execute("apply_proposal",json!({"transactionId":transaction_id,"files":files,"summary":p.summary,"_agentPolicy":true})) {
                    Ok(mut result)=>{p.status="applied".into();if let Err(error)=persist(&path,&p){result["proposalRecordError"]=json!(error);}events.send("proposal/applied",json!({"id":id,"result":result}));Ok(result)},
                    Err(e)=>{p.status="conflicted".into();p.error=Some(e.clone());let _=persist(&path,&p);events.send("proposal/conflicted",json!({"id":id,"error":e}));Err(e)}
                }
            }
            _ => Err(AppError::new(
                "PROPOSAL_INVALID",
                "Decision must be apply or reject",
            )),
        }
    }
}
pub fn digest(text: &[u8]) -> String {
    format!("{:x}", Sha256::digest(text))
}
