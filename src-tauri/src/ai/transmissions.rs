//! Metadata only: successful handoffs to the provider CLI, not proof of cloud receipt.
use crate::contracts::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_ENTRIES: usize = 500;
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transmission {
    pub id: String,
    pub task_id: String,
    pub provider: String,
    pub timestamp: u64,
    pub tool: String,
    pub paths: Vec<String>,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub page: Option<u64>,
    pub bytes: usize,
    pub characters: Option<usize>,
    pub count: usize,
}
impl Transmission {
    pub fn metadata(tool: &str, value: &Value) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: String::new(),
            provider: String::new(),
            timestamp: 0,
            tool: tool.into(),
            paths: value["path"]
                .as_str()
                .map(str::to_owned)
                .into_iter()
                .collect(),
            start_line: value["startLine"].as_u64(),
            end_line: value["endLine"].as_u64(),
            page: value["page"].as_u64(),
            bytes: 0,
            characters: None,
            count: 1,
        }
    }
    pub fn stamp(&mut self, task: &str, provider: &str) {
        self.task_id = task.into();
        self.provider = provider.into();
        self.timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
    }
}
pub fn prompt(
    context: &Value,
    commands: &Value,
    outcome: &Value,
    prompt: &str,
    workspace_root: &str,
) -> Vec<Transmission> {
    let mut rows = Vec::new();
    let mut request = Transmission::metadata("prompt", &Value::Null);
    request.bytes = prompt.len();
    request.characters = Some(prompt.chars().count());
    rows.push(request);
    for (kind, field, text_field) in [("source", "sources", "text"), ("pdf", "pdfs", "quote")] {
        for value in context[field].as_array().into_iter().flatten() {
            let mut row = Transmission::metadata(kind, value);
            if kind == "pdf" {
                row.paths = value["buildId"]
                    .as_str()
                    .map(|id| format!("PDF build {id}"))
                    .into_iter()
                    .collect();
            }
            let text = value[text_field].as_str().unwrap_or("");
            row.bytes = text.len();
            row.characters = Some(text.chars().count());
            rows.push(row);
        }
    }
    for path in context["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let mut row = Transmission::metadata("attachment-path", &Value::Null);
        row.paths.push(path.into());
        row.bytes = path.len();
        rows.push(row);
    }
    for command in commands["requests"].as_array().into_iter().flatten() {
        rows.push(tool("command-context", &Value::Null, command));
    }
    if !outcome.is_null() {
        rows.push(tool("previous-outcome", &Value::Null, outcome));
    }
    let mut environment = Transmission::metadata("workspace-context", &Value::Null);
    environment.paths.push(workspace_root.into());
    environment.bytes = workspace_root.len();
    rows.push(environment);
    rows
}
pub fn tool(name: &str, args: &Value, result: &Value) -> Transmission {
    let mut row = Transmission::metadata(name, result);
    if row.paths.is_empty() {
        row.paths = args["path"]
            .as_str()
            .map(str::to_owned)
            .into_iter()
            .collect();
    }
    row.bytes = serde_json::to_vec(result).map_or(0, |bytes| bytes.len());
    if let Some(text) = result["text"].as_str() {
        row.bytes = text.len();
        row.characters = Some(text.chars().count());
    }
    for field in ["entries", "matches", "diagnostics"] {
        if let Some(values) = result[field].as_array() {
            row.count = values.len();
            for value in values {
                if let Some(path) = value["path"].as_str()
                    && !row.paths.iter().any(|p| p == path)
                {
                    row.paths.push(path.into());
                }
            }
        }
    }
    if let Some(cwd) = result["cwd"].as_str() {
        row.paths.push(cwd.into());
    }
    row
}
pub fn load(directory: &Path) -> AppResult<Vec<Transmission>> {
    let path = directory.join("transmissions.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut rows: Vec<Transmission> = serde_json::from_slice(&fs::read(path)?)?;
    let overflow = rows.len().saturating_sub(MAX_ENTRIES);
    rows.drain(..overflow);
    Ok(rows)
}
pub fn append(directory: &Path, rows: &[Transmission]) -> AppResult<()> {
    let _lock = JOURNAL_LOCK.lock().map_err(|_| {
        crate::contracts::AppError::new("STATE_POISONED", "Transmission journal lock failed")
    })?;
    let mut retained = load(directory)?;
    retained.extend_from_slice(rows);
    let overflow = retained.len().saturating_sub(MAX_ENTRIES);
    retained.drain(..overflow);
    fs::create_dir_all(directory)?;
    let temporary = directory.join("transmissions.tmp");
    fs::write(&temporary, serde_json::to_vec(&retained)?)?;
    super::atomic_replace(&temporary, &directory.join("transmissions.json"))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn records_only_metadata_and_actual_read_range() {
        let row = tool(
            "read_text",
            &json!({"path":"paper.tex","startLine":1,"endLine":99}),
            &json!({"path":"paper.tex","startLine":1,"endLine":2,"text":"비밀 secret\n"}),
        );
        assert_eq!(row.paths, ["paper.tex"]);
        assert_eq!(row.start_line, Some(1));
        assert_eq!(row.end_line, Some(2));
        assert_eq!(row.bytes, "비밀 secret\n".len());
        let encoded = serde_json::to_string(&row).unwrap();
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("\"text\":"));
    }
    #[test]
    fn bounded_journal_survives_restart_and_clears_with_history() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("workspaces/fixture/agent-history");
        let rows = (0..MAX_ENTRIES + 5)
            .map(|n| {
                let mut row = tool(
                    "read_text",
                    &json!({"path":format!("{n}.tex")}),
                    &json!({"text":"never persist me"}),
                );
                row.stamp("turn", "codex");
                row
            })
            .collect::<Vec<_>>();
        append(&dir, &rows).unwrap();
        let restored = load(&dir).unwrap();
        assert_eq!(restored.len(), MAX_ENTRIES);
        assert_eq!(restored[0].paths, ["5.tex"]);
        assert!(
            !fs::read_to_string(dir.join("transmissions.json"))
                .unwrap()
                .contains("never persist me")
        );
        let session = temp.path().join("workspaces/fixture/codex-session.json");
        fs::write(&session, b"{\"sessionId\":\"old\"}").unwrap();
        super::super::events::clear_history(temp.path(), "fixture").unwrap();
        assert!(!session.exists());
        assert!(load(&dir).unwrap().is_empty());
    }
}
