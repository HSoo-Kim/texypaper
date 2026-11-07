use crate::{
    contracts::{AppError, AppResult},
    workspace::local::{hash, validate_relative},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const MAX_FILES: usize = 400;
pub const MAX_TEXT: usize = 8 * 1024 * 1024;
pub const MAX_FILE: usize = 1024 * 1024;
const MAX_JSON: u64 = 52 * 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointFile {
    pub path: String,
    pub sha256: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub files: Vec<CheckpointFile>,
}
fn limit(message: &str) -> AppError {
    AppError::new("CHECKPOINT_LIMIT", message)
}
fn valid_id(id: &str) -> AppResult<()> {
    if id.len() != 36
        || uuid::Uuid::parse_str(id).is_err()
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(AppError::new(
            "CHECKPOINT_ID",
            "Checkpoint id must be a hyphenated UUID",
        ));
    }
    Ok(())
}
fn validate(record: &Checkpoint) -> AppResult<usize> {
    valid_id(&record.id)?;
    if record.name.trim().is_empty() || record.name.chars().count() > 120 {
        return Err(limit("Checkpoint name must contain 1–120 characters"));
    }
    let stamp = record.created_at.as_bytes();
    if stamp.len() != 24
        || !stamp.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            19 => *b == b'.',
            23 => *b == b'Z',
            _ => b.is_ascii_digit(),
        })
        || !("01"..="12").contains(&&record.created_at[5..7])
        || !("01"..="31").contains(&&record.created_at[8..10])
        || &record.created_at[11..13] > "23"
        || &record.created_at[14..16] > "59"
        || &record.created_at[17..19] > "59"
    {
        return Err(AppError::new(
            "INVALID_ARGUMENT",
            "createdAt must be an ISO UTC timestamp, for example 2026-11-07T12:00:00.000Z",
        ));
    }
    if record.files.len() > MAX_FILES {
        return Err(limit("A checkpoint can contain at most 400 files"));
    }
    let mut paths = HashSet::new();
    let mut total = 0;
    for file in &record.files {
        validate_relative(&file.path)?;
        if file.path.is_empty()
            || file.path.len() > 4096
            || file.path.split('/').any(|p| {
                p.starts_with('.')
                    || matches!(
                        p,
                        "node_modules" | "venv" | "__pycache__" | "build" | "dist" | "target"
                    )
            })
            || !paths.insert(&file.path)
        {
            return Err(AppError::new(
                "CHECKPOINT_PATH",
                "Checkpoint paths must be unique, non-private workspace files",
            ));
        }
        if file.text.len() > MAX_FILE {
            return Err(limit(
                "Each checkpoint file must be at most 1 MiB of UTF-8 text",
            ));
        }
        total += file.text.len();
        if total > MAX_TEXT {
            return Err(limit("Checkpoint text must be at most 8 MiB"));
        }
        if file.sha256 != hash(file.text.as_bytes()) {
            return Err(AppError::new(
                "CHECKPOINT_HASH",
                "Checkpoint text does not match its SHA-256",
            ));
        }
        if file
            .encoding
            .as_deref()
            .is_some_and(|encoding| !matches!(encoding, "utf8" | "utf8Bom"))
        {
            return Err(AppError::new(
                "ENCODING_UNSUPPORTED",
                "Checkpoints require UTF-8 text",
            ));
        }
    }
    Ok(total)
}
fn read_record(path: &Path) -> AppResult<Checkpoint> {
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > MAX_JSON {
        return Err(limit("Checkpoint JSON exceeds its storage limit"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_JSON + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_JSON {
        return Err(limit("Checkpoint JSON exceeds its storage limit"));
    }
    let record: Checkpoint = serde_json::from_slice(&bytes)?;
    validate(&record)?;
    if path.file_stem().and_then(|s| s.to_str()) != Some(&record.id) {
        return Err(AppError::new(
            "CHECKPOINT_CORRUPT",
            "Checkpoint filename and identity differ",
        ));
    }
    Ok(record)
}
fn summaries(dir: &Path) -> AppResult<Vec<Value>> {
    let mut rows = Vec::new();
    if !dir.exists() {
        return Ok(rows);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|s| s.to_str()) != Some("json")
        {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if valid_id(id).is_err() {
            continue;
        }
        rows.push(match read_record(&path) {
            Ok(record) => json!({"id":record.id,"name":record.name,"createdAt":record.created_at,"fileCount":record.files.len(),"byteLength":record.files.iter().map(|f|f.text.len()).sum::<usize>()}),
            Err(_) => json!({"id":id,"name":"","createdAt":"","fileCount":0,"byteLength":0,"corrupt":true}),
        });
    }
    rows.sort_by(|a, b| {
        b["createdAt"]
            .as_str()
            .cmp(&a["createdAt"].as_str())
            .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
    });
    Ok(rows)
}
/// App-data only: local and SSH workspaces use the same stable workspace identity.
pub fn execute(data_dir: &Path, workspace_id: &str, op: &str, args: &Value) -> AppResult<Value> {
    let _guard = LOCK
        .lock()
        .map_err(|_| AppError::new("STATE_ERROR", "Checkpoint lock poisoned"))?;
    // The caller supplies its authenticated workspace id, never a renderer path.
    if workspace_id.is_empty()
        || !workspace_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::new("CHECKPOINT_ID", "Invalid workspace identity"));
    }
    let dir: PathBuf = data_dir
        .join("workspaces")
        .join(workspace_id)
        .join("checkpoints");
    if op == "checkpoint_list" {
        return Ok(json!(summaries(&dir)?));
    }
    let id = args["id"]
        .as_str()
        .ok_or_else(|| AppError::new("CHECKPOINT_ID", "Checkpoint id required"))?;
    valid_id(id)?;
    let target = dir.join(format!("{id}.json"));
    match op {
        "checkpoint_get" => {
            let record = read_record(&target).map_err(|error| {
                if error.code == "IO_ERROR" {
                    error
                } else {
                    AppError::new("CHECKPOINT_CORRUPT", error.message)
                }
            })?;
            Ok(serde_json::to_value(record)?)
        }
        "checkpoint_delete" => {
            fs::remove_file(target)?;
            Ok(json!({"deleted":true}))
        }
        "checkpoint_put" => {
            let record: Checkpoint = Checkpoint::deserialize(args)?;
            validate(&record)?;
            fs::create_dir_all(&dir)?;
            if target.try_exists()? {
                return Err(AppError::new(
                    "CHECKPOINT_EXISTS",
                    "A checkpoint with this id already exists",
                ));
            }
            let temporary = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
            let result: AppResult<()> = (|| {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                serde_json::to_writer(&mut file, &record)?;
                file.flush()?;
                file.sync_all()?;
                drop(file);
                fs::rename(&temporary, &target)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result?;
            let rows = summaries(&dir)?;
            let mut pruned = Vec::new();
            // Retain the newly created checkpoint even when its supplied timestamp is older.
            for row in rows
                .iter()
                .filter(|row| row["id"].as_str() != Some(id))
                .rev()
                .take(rows.len().saturating_sub(50))
            {
                let old = row["id"].as_str().unwrap();
                fs::remove_file(dir.join(format!("{old}.json")))?;
                pruned.push(old.to_owned());
            }
            Ok(json!({"saved":true,"id":id,"pruned":pruned}))
        }
        _ => Err(AppError::new("INVALID_OPERATION", op)),
    }
}
