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
                Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
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
        let value = json!({"version":1,"openPaths":paths,"activePath":input.get("activePath"),"view":input.get("view"),"trash":entries.iter().map(|entry|json!({"path":entry["path"],"transactionId":entry["transactionId"]})).collect::<Vec<_>>()});
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
