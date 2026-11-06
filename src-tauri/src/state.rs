use crate::{
    contracts::*,
    workspace::{Workspace, WorkspaceManager},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

pub struct ArtifactGrant {
    pub workspace_id: String,
    pub epoch: u64,
    pub build_id: String,
    pub length: u64,
}
pub struct AppState {
    pub manager: Mutex<WorkspaceManager>,
    pub data_dir: PathBuf,
    pub open_path: Option<String>,
    pub settings: Mutex<Value>,
    pub grants: Mutex<HashMap<String, ArtifactGrant>>,
    pub sequence: AtomicU64,
    pub operations: AtomicUsize,
    pub artifact_slots: std::sync::Arc<tokio::sync::Semaphore>,
    pub media: Mutex<HashMap<String, crate::media::MediaGrant>>,
    pub update_lock: Mutex<()>,
}
impl AppState {
    pub fn new(data_dir: PathBuf, open_path: Option<String>) -> AppResult<Self> {
        fs::create_dir_all(&data_dir)?;
        let settings = match fs::read(data_dir.join("settings.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            manager: Mutex::new(WorkspaceManager::new(data_dir.clone())),
            data_dir,
            open_path,
            settings: Mutex::new(settings),
            grants: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            operations: AtomicUsize::new(0),
            artifact_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(8)),
            media: Mutex::new(HashMap::new()),
            update_lock: Mutex::new(()),
        })
    }
    pub fn workspace(&self, id: &str, epoch: u64) -> AppResult<Workspace> {
        self.manager
            .lock()
            .map_err(|_| AppError::new("STATE_ERROR", "Workspace lock poisoned"))?
            .active(id, epoch)
    }
    pub fn event(&self, w: &Workspace, kind: &str, payload: Value) -> AppEvent {
        AppEvent {
            workspace_id: w.reference.id.clone(),
            epoch: w.reference.epoch,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            kind: kind.into(),
            payload,
        }
    }
    pub fn ensure_idle(&self) -> AppResult<()> {
        if crate::ai::active_task() {
            return Err(AppError::new(
                "AGENT_BUSY",
                "Stop the active agent task before switching projects",
            ));
        }
        if self.operations.load(Ordering::Acquire) > 0 {
            Err(AppError::new(
                "WORKSPACE_BUSY",
                "Stop the active operation before switching projects",
            ))
        } else {
            Ok(())
        }
    }
    pub fn recovery(&self, w: &Workspace, op: &str, args: &Value) -> AppResult<Value> {
        let dir = self
            .data_dir
            .join("workspaces")
            .join(&w.reference.id)
            .join("recovery");
        fs::create_dir_all(&dir)?;
        let path = args.get("path").and_then(Value::as_str);
        if op == "recovery_read" && path.is_none() {
            let mut documents = Vec::new();
            for entry in fs::read_dir(&dir)?.take(256) {
                let entry = entry?;
                if entry.path().extension().is_some_and(|x| x == "json") {
                    documents.push(serde_json::from_slice::<Value>(&fs::read(entry.path())?)?);
                }
            }
            return Ok(json!({"documents":documents}));
        }
        let path = path.ok_or_else(|| AppError::new("INVALID_ARGUMENT", "path required"))?;
        let key = format!("{:x}", Sha256::digest(path.as_bytes()));
        let target = dir.join(format!("{key}.json"));
        match op {
            "recovery_read" => match fs::read(&target) {
                Ok(b) => Ok(serde_json::from_slice(&b)?),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
                Err(e) => Err(e.into()),
            },
            "recovery_write" => {
                let text = args
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "text required"))?;
                let value = json!({"path":path,"text":text,"baseSha256":args.get("baseSha256"),"transactionId":args.get("transactionId")});
                atomic_json(&target, &value)?;
                Ok(json!({"saved":true}))
            }
            "recovery_clear" => {
                if target.exists() {
                    fs::remove_file(target)?;
                }
                Ok(json!({"cleared":true}))
            }
            _ => Err(AppError::new("INVALID_OPERATION", op)),
        }
    }
    pub fn workspace_metadata(&self, w: &Workspace, op: &str, args: &Value) -> AppResult<Value> {
        let path = self
            .data_dir
            .join("workspaces")
            .join(&w.reference.id)
            .join("state.json");
        if op == "workspace_state_read" {
            return match fs::read(path) {
                Ok(bytes) => {
                    if bytes.len() > 65536 {
                        return Err(AppError::new(
                            "METADATA_LIMIT",
                            "Workspace metadata exceeds 64 KiB",
                        ));
                    }
                    let value: Value = serde_json::from_slice(&bytes)?;
                    let input = value.as_object().ok_or_else(|| {
                        AppError::new("INVALID_ARGUMENT", "Invalid workspace metadata")
                    })?;
                    workspace_reading_metadata(input)?;
                    Ok(value)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
                Err(error) => Err(error.into()),
            };
        }
        let input = args
            .get("state")
            .and_then(Value::as_object)
            .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "state metadata required"))?;
        let paths = input
            .get("openPaths")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "openPaths required"))?;
        if paths.len() > 256
            || paths
                .iter()
                .any(|v| v.as_str().is_none_or(|s| s.len() > 4096))
        {
            return Err(AppError::new(
                "METADATA_LIMIT",
                "Tab metadata exceeds its bounded size",
            ));
        }
        let trash = input.get("trash").cloned().unwrap_or_else(|| json!([]));
        let entries = trash
            .as_array()
            .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "trash must be metadata array"))?;
        if entries.len() > 100
            || entries.iter().any(|entry| {
                entry
                    .get("path")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.len() > 4096)
                    || entry
                        .get("transactionId")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.len() > 128)
            })
        {
            return Err(AppError::new(
                "METADATA_LIMIT",
                "Trash metadata exceeds its bounded size",
            ));
        }
        if input
            .get("activePath")
            .is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| s.len() > 4096))
        {
            return Err(AppError::new(
                "INVALID_ARGUMENT",
                "activePath must be a relative path string",
            ));
        }
        if input.get("view").is_some_and(|v| {
            !v.is_null() && !matches!(v.as_str(), Some("source" | "pdf" | "split"))
        }) {
            return Err(AppError::new("INVALID_ARGUMENT", "Unknown workspace view"));
        }
        let mut value = json!({"version":1,"openPaths":paths,"activePath":input.get("activePath"),"view":input.get("view"),"trash":entries.iter().map(|entry|json!({"path":entry["path"],"transactionId":entry["transactionId"]})).collect::<Vec<_>>()});
        value
            .as_object_mut()
            .unwrap()
            .extend(workspace_reading_metadata(input)?);
        if serde_json::to_vec(&value)?.len() > 65536 {
            return Err(AppError::new(
                "METADATA_LIMIT",
                "Tab metadata exceeds 64 KiB",
            ));
        }
        atomic_json(&path, &value)?;
        Ok(value)
    }
}

// Persist positions only: never source content, conversation text, credentials, or execution authority.
fn workspace_reading_metadata(
    input: &serde_json::Map<String, Value>,
) -> AppResult<serde_json::Map<String, Value>> {
    let invalid = || AppError::new("INVALID_ARGUMENT", "Invalid workspace reading position");
    let string = |value: &Value, max: usize| value.as_str().is_some_and(|s| s.len() <= max);
    let number = |value: &Value, min: f64, max: f64| {
        value
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= min && n <= max)
    };
    let integer =
        |value: &Value, min: u64, max: u64| value.as_u64().is_some_and(|n| n >= min && n <= max);
    let mut output = serde_json::Map::new();
    if let Some(reference) = input.get("referencePath") {
        if !string(reference, 4096) {
            return Err(invalid());
        }
        output.insert("referencePath".into(), reference.clone());
    }
    if let Some(editors) = input.get("editors") {
        let rows = editors
            .as_array()
            .filter(|rows| rows.len() <= 64)
            .ok_or_else(invalid)?;
        let mut clean = Vec::with_capacity(rows.len());
        for row in rows {
            let position = &row["position"];
            if !string(&row["path"], 4096)
                || !["anchor", "head", "top"]
                    .iter()
                    .all(|key| integer(&position[*key], 0, 1_000_000_000))
                || !number(&position["inset"], -100_000.0, 100_000.0)
                || !number(&position["left"], 0.0, 10_000_000.0)
            {
                return Err(invalid());
            }
            clean.push(json!({"path":row["path"],"position":{"anchor":position["anchor"],"head":position["head"],"top":position["top"],"inset":position["inset"],"left":position["left"]}}));
        }
        output.insert("editors".into(), json!(clean));
    }
    if let Some(pdfs) = input.get("pdfs") {
        let rows = pdfs
            .as_array()
            .filter(|rows| rows.len() <= 16)
            .ok_or_else(invalid)?;
        let mut clean = Vec::with_capacity(rows.len());
        for row in rows {
            if !string(&row["identity"], 4608)
                || !integer(&row["page"], 1, 1_000_000)
                || !number(&row["fraction"], 0.0, 1.0)
                || !number(&row["zoom"], 0.5, 3.0)
                || row["fit"].as_bool().is_none()
                || !matches!(row["rotation"].as_u64(), Some(0 | 90 | 180 | 270))
            {
                return Err(invalid());
            }
            clean.push(json!({"identity":row["identity"],"page":row["page"],"fraction":row["fraction"],"zoom":row["zoom"],"fit":row["fit"],"rotation":row["rotation"]}));
        }
        output.insert("pdfs".into(), json!(clean));
    }
    if let Some(layout) = input.get("layout") {
        if !number(&layout["sourceFraction"], 25.0, 75.0)
            || !number(&layout["explorerWidth"], 180.0, 340.0)
            || !number(&layout["inspectorWidth"], 360.0, 720.0)
            || !["explorer", "search", "inspector"]
                .iter()
                .all(|key| layout[*key].as_bool().is_some())
            || !matches!(layout["tab"].as_str(), Some("ai" | "comments"))
        {
            return Err(invalid());
        }
        output.insert("layout".into(), json!({"sourceFraction":layout["sourceFraction"],"explorerWidth":layout["explorerWidth"],"inspectorWidth":layout["inspectorWidth"],"explorer":layout["explorer"],"search":layout["search"],"inspector":layout["inspector"],"tab":layout["tab"]}));
    }
    if let Some(chat) = input.get("chat") {
        if !valid_chat_reading_position(chat) {
            return Err(invalid());
        }
        output.insert("chat".into(), chat.clone());
    }
    Ok(output)
}

pub(crate) fn valid_chat_reading_position(value: &Value) -> bool {
    let Some(chat) = value.as_object() else {
        return false;
    };
    if chat.keys().any(|key| {
        !matches!(
            key.as_str(),
            "provider" | "historyPage" | "following" | "scrollTop" | "anchor"
        )
    }) {
        return false;
    }
    let Some(page) = chat.get("historyPage").and_then(Value::as_str) else {
        return false;
    };
    let valid = matches!(value["provider"].as_str(), Some("codex" | "claude"))
        && !page.is_empty()
        && page.len() <= 255
        && page.ends_with(".jsonl")
        && !page
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        && value["following"].as_bool().is_some()
        && value["scrollTop"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=1_000_000_000.0).contains(&n));
    valid
        && chat.get("anchor").is_none_or(|anchor| {
            anchor.as_object().is_some_and(|fields| {
                fields.len() == 2 && fields.contains_key("id") && fields.contains_key("inset")
            }) && anchor["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id.len() <= 1024)
                && anchor["inset"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 1_000_000_000.0)
        })
}
pub fn atomic_json(path: &Path, value: &Value) -> AppResult<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("INVALID_PATH", "Missing parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, value)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn trust_path(data_dir: &Path, workspace: &Workspace) -> PathBuf {
    let identity = format!(
        "{}\0{}",
        workspace.reference.environment_id, workspace.reference.root
    );
    data_dir
        .join("trust")
        .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())))
}
pub fn project_trusted(data_dir: &Path, workspace: &Workspace) -> AppResult<bool> {
    match fs::read(trust_path(data_dir, workspace)) {
        Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)?
            .get("trusted")
            .and_then(Value::as_bool)
            == Some(true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
pub fn set_project_trust(data_dir: &Path, workspace: &Workspace, trusted: bool) -> AppResult<()> {
    atomic_json(
        &trust_path(data_dir, workspace),
        &json!({"version":1,"environmentId":workspace.reference.environment_id,"root":workspace.reference.root,"trusted":trusted}),
    )
}

#[cfg(test)]
mod workspace_reading_tests {
    use super::*;

    fn environment() -> Environment {
        Environment {
            id: "local".into(),
            label: "Fixture".into(),
            kind: "local".into(),
            host_alias: None,
            hostname: None,
            user: None,
            port: None,
            identity_file: None,
            ssh_config_file: None,
        }
    }

    fn reading_state() -> Value {
        json!({
            "openPaths":["main.tex"],"activePath":"main.tex","view":"split","trash":[],
            "referencePath":"reference.pdf",
            "editors":[{"path":"main.tex","position":{"anchor":120,"head":90,"top":40,"inset":12.5,"left":0}}],
            "pdfs":[{"identity":"build:hash","page":8,"fraction":0.4,"zoom":1.5,"fit":false,"rotation":90}],
            "layout":{"sourceFraction":62,"explorerWidth":260,"inspectorWidth":420,"explorer":true,"search":false,"inspector":true,"tab":"ai"},
            "chat":{"provider":"codex","historyPage":"current.jsonl","following":false,"scrollTop":800,"anchor":{"id":"message-8","inset":-12}}
        })
    }

    #[test]
    fn complete_metadata_survives_reopen_and_different_workspace_is_isolated() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let state = AppState::new(data.path().into(), None).unwrap();
        let mut manager = WorkspaceManager::new(data.path().into());
        let first = manager
            .open(environment(), root.path().to_string_lossy().into())
            .unwrap();
        let workspace = manager.active(&first.id, first.epoch).unwrap();
        let saved = state
            .workspace_metadata(
                &workspace,
                "workspace_state_write",
                &json!({"state":reading_state()}),
            )
            .unwrap();
        manager.close().unwrap();
        let reopened = manager
            .open(environment(), root.path().to_string_lossy().into())
            .unwrap();
        assert!(reopened.epoch > first.epoch);
        assert_eq!(
            saved,
            state
                .workspace_metadata(
                    &manager.active(&reopened.id, reopened.epoch).unwrap(),
                    "workspace_state_read",
                    &json!({})
                )
                .unwrap()
        );
        manager.close().unwrap();
        let other = manager
            .open(environment(), other_root.path().to_string_lossy().into())
            .unwrap();
        assert_eq!(
            json!({}),
            state
                .workspace_metadata(
                    &manager.active(&other.id, other.epoch).unwrap(),
                    "workspace_state_read",
                    &json!({})
                )
                .unwrap()
        );
        manager.close().unwrap();
    }

    #[test]
    fn malformed_and_oversized_positions_cannot_replace_good_metadata() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(data.path().into(), None).unwrap();
        let mut manager = WorkspaceManager::new(data.path().into());
        let reference = manager
            .open(environment(), root.path().to_string_lossy().into())
            .unwrap();
        let workspace = manager.active(&reference.id, reference.epoch).unwrap();
        let good = state
            .workspace_metadata(
                &workspace,
                "workspace_state_write",
                &json!({"state":reading_state()}),
            )
            .unwrap();
        let mut malformed = reading_state();
        malformed["editors"][0]["position"]["head"] = json!(-1);
        assert!(
            state
                .workspace_metadata(
                    &workspace,
                    "workspace_state_write",
                    &json!({"state":malformed})
                )
                .is_err()
        );
        let mut malformed = reading_state();
        malformed["pdfs"][0]["fraction"] = json!(1.1);
        assert!(
            state
                .workspace_metadata(
                    &workspace,
                    "workspace_state_write",
                    &json!({"state":malformed})
                )
                .is_err()
        );
        let mut malformed = reading_state();
        malformed["layout"]["inspector"] = json!("yes");
        assert!(
            state
                .workspace_metadata(
                    &workspace,
                    "workspace_state_write",
                    &json!({"state":malformed})
                )
                .is_err()
        );
        let mut oversized = reading_state();
        oversized["editors"] = json!((0..64).map(|i| json!({"path":format!("{}-{i}.tex", "x".repeat(4000)),"position":{"anchor":0,"head":0,"top":0,"inset":0,"left":0}})).collect::<Vec<_>>());
        assert!(
            state
                .workspace_metadata(
                    &workspace,
                    "workspace_state_write",
                    &json!({"state":oversized})
                )
                .is_err()
        );
        assert_eq!(
            good,
            state
                .workspace_metadata(&workspace, "workspace_state_read", &json!({}))
                .unwrap()
        );
        manager.close().unwrap();
    }

    #[test]
    fn legacy_tabs_remain_compatible_and_new_nested_fields_are_whitelisted() {
        assert!(workspace_reading_metadata(json!({"openPaths":["main.tex"],"activePath":"main.tex","view":"source","trash":[]}).as_object().unwrap()).unwrap().is_empty());
        let mut value = reading_state();
        value["editors"][0]["position"]["text"] = json!("must not persist");
        value["pdfs"][0]["credentials"] = json!("must not persist");
        value["layout"]["approval"] = json!(true);
        let cleaned = workspace_reading_metadata(value.as_object().unwrap()).unwrap();
        assert!(cleaned["editors"][0]["position"].get("text").is_none());
        assert!(cleaned["pdfs"][0].get("credentials").is_none());
        assert!(cleaned["layout"].get("approval").is_none());
    }

    #[test]
    fn shared_chat_validator_rejects_paths_authority_and_malformed_anchors() {
        let good = reading_state()["chat"].clone();
        assert!(valid_chat_reading_position(&good));
        for page in [
            "../secret.jsonl",
            "C:secret.jsonl",
            "folder/current.jsonl",
            "current.txt",
            "bad\n.jsonl",
        ] {
            let mut value = good.clone();
            value["historyPage"] = json!(page);
            assert!(!valid_chat_reading_position(&value), "{page}");
        }
        for key in ["consent", "approved", "task", "credentials"] {
            let mut value = good.clone();
            value[key] = json!(true);
            assert!(!valid_chat_reading_position(&value));
            assert!(
                workspace_reading_metadata(json!({"chat":value}).as_object().unwrap()).is_err()
            );
        }
        for anchor in [
            json!({"id":"","inset":0}),
            json!({"id":"m","inset":"0"}),
            json!({"id":"m","inset":0,"approved":true}),
        ] {
            let mut value = good.clone();
            value["anchor"] = anchor;
            assert!(!valid_chat_reading_position(&value));
        }
        let mut value = good;
        value["scrollTop"] = json!(-1);
        assert!(!valid_chat_reading_position(&value));
    }
}
