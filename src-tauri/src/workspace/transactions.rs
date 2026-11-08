use super::local::{hash, resolve, revision};
use crate::contracts::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[cfg(not(windows))]
use std::fs::File;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub base_sha256: Option<String>,
    pub content: String,
    pub action: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    path: String,
    before: Option<String>,
    after: String,
    backup: String,
    stage: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u32,
    transaction_id: String,
    status: String,
    records: Vec<Record>,
    affected: Vec<String>,
}
fn transaction_dir(root: &Path, id: &str) -> AppResult<PathBuf> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::new(
            "TRANSACTION_ID_INVALID",
            "Invalid transaction identifier",
        ));
    }
    let private = root.join(".texypaper");
    if private.exists() {
        resolve(root, ".texypaper", false)?;
    }
    let parent = root.join(".texypaper/transactions");
    let parent = if parent.exists() {
        resolve(root, ".texypaper/transactions", false)?
    } else {
        parent
    };
    let path = parent.join(id);
    if path.exists() {
        resolve(root, &format!(".texypaper/transactions/{id}"), false)?;
    }
    Ok(path)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("PATH_INVALID", "No parent directory"))?;
    let temp = parent.join(format!(".texypaper-{}.tmp", uuid::Uuid::new_v4()));
    let mut temporary_permissions = None;
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        temporary_permissions = Some(file.metadata()?.permissions());
        file.write_all(bytes)?;
        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temp, metadata.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        replace(&temp, path)?;
        #[cfg(not(windows))]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if temp.exists() {
        if let Some(permissions) = temporary_permissions {
            let _ = fs::set_permissions(&temp, permissions);
        }
        let _ = fs::remove_file(&temp);
    }
    result
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> AppResult<()> {
    fs::rename(from, to)?;
    Ok(())
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(old: *const u16, new: *const u16, flags: u32) -> i32;
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Two in-process writers replacing one target at once fail on Windows (access denied
    // while the other ReplaceFile is in flight), so replacements of a path are serialized.
    static LOCKS: [std::sync::Mutex<()>; 64] = [const { std::sync::Mutex::new(()) }; 64];
    let stripe = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        to.hash(&mut hasher);
        hasher.finish() as usize % LOCKS.len()
    };
    let _guard = LOCKS[stripe]
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A TeX engine, indexer or antivirus scanner may briefly hold the target without
    // FILE_SHARE_DELETE. Those failures leave both files in place, so a bounded retry
    // is safe; every other error is reported unchanged.
    const SHARING_VIOLATION: i32 = 32;
    const UNABLE_TO_REMOVE_REPLACED: i32 = 1175;
    const UNABLE_TO_MOVE_REPLACEMENT: i32 = 1176;
    const ALREADY_EXISTS: i32 = 183;
    const MOVEFILE_REPLACE_EXISTING: u32 = 1;
    const MOVEFILE_WRITE_THROUGH: u32 = 8;
    let mut attempt = 0;
    loop {
        let exists = to.exists();
        // ReplaceFile preserves the replaced file's security descriptor and attributes.
        let result = unsafe {
            if exists {
                ReplaceFileW(
                    to_wide.as_ptr(),
                    from_wide.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            } else {
                MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), MOVEFILE_WRITE_THROUGH)
            }
        };
        if result != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            // Without a backup name, this documented state means the replaced file is
            // gone and the replacement still has its temporary name: finish the move.
            Some(UNABLE_TO_MOVE_REPLACEMENT) => {
                if unsafe {
                    MoveFileExW(
                        from_wide.as_ptr(),
                        to_wide.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                } != 0
                {
                    return Ok(());
                }
                return Err(std::io::Error::last_os_error().into());
            }
            // Another writer created the target after the existence check; replace it
            // on the next attempt, matching POSIX rename (last writer wins).
            Some(ALREADY_EXISTS) if !exists && attempt < 40 => attempt += 1,
            Some(SHARING_VIOLATION | UNABLE_TO_REMOVE_REPLACED) if attempt < 40 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt.min(4)));
            }
            _ => return Err(error.into()),
        }
    }
}
fn save_journal(dir: &Path, journal: &Journal) -> AppResult<()> {
    atomic_write(&dir.join("journal.json"), &serde_json::to_vec(journal)?)
}
fn current_hash(path: &Path) -> AppResult<Option<String>> {
    match OpenOptions::new().read(true).open(path) {
        Ok(file) => Ok(Some(super::local::hash_reader(file)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn modified_ns(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos().to_string())
        .unwrap_or_else(|| "0".into())
}
fn conflict(root: &Path, path: &str, current: Option<String>) -> AppError {
    let mut e = AppError::new(
        "FILE_CONFLICT",
        "File changed since it was read; compare, reload, or save a copy.",
    );
    e.path = Some(path.into());
    let revision = resolve(root, path, false)
        .and_then(|target| revision(&target))
        .ok();
    e.details = Some(json!({"currentSha256":current,"currentRevision":revision}));
    e
}
pub fn apply_proposal(root: &Path, id: &str, changes: Vec<Change>) -> AppResult<Value> {
    apply_with_policy(root, id, changes, false)
}
pub fn apply_agent_proposal(root: &Path, id: &str, changes: Vec<Change>) -> AppResult<Value> {
    apply_with_policy(root, id, changes, true)
}
fn apply_with_policy(root: &Path, id: &str, changes: Vec<Change>, agent: bool) -> AppResult<Value> {
    if changes.is_empty() || changes.len() > 16 {
        return Err(AppError::new(
            "TRANSACTION_LIMIT",
            "A transaction requires 1–16 files",
        ));
    }
    let dir = transaction_dir(root, id)?;
    if dir.exists() {
        return Err(AppError::new(
            "TRANSACTION_EXISTS",
            "Query transaction_status before retrying an existing transaction",
        ));
    }
    let mut paths = std::collections::HashSet::new();
    let mut prepared = Vec::new();
    for change in &changes {
        if !paths.insert(change.path.clone()) {
            return Err(AppError::new(
                "TRANSACTION_INVALID",
                "Duplicate transaction path",
            ));
        }
        let target = resolve(root, &change.path, change.action == "create")?;
        if agent {
            if super::local::agent_read_denied(&change.path) {
                return Err(AppError::new(
                    "AGENT_WRITE_DENIED",
                    "Private path is not writable by agents",
                ));
            }
            super::local::check_agent_path(root, &target, true)?;
        }
        if !matches!(change.action.as_str(), "edit" | "create") {
            return Err(AppError::new(
                "TRANSACTION_INVALID",
                "Unknown change action",
            ));
        }
        let original = match fs::read(&target) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let actual = original.as_ref().map(|b| hash(b));
        if actual != change.base_sha256
            || (change.action == "create" && original.is_some())
            || (change.action == "edit" && original.is_none())
        {
            return Err(conflict(root, &change.path, actual));
        }
        if original
            .as_ref()
            .is_some_and(|bytes| super::local::is_binary(bytes))
        {
            return Err(AppError::new(
                "BINARY_FILE",
                "Binary files cannot be overwritten through a source-text save",
            ));
        }
        if original
            .as_ref()
            .is_some_and(|bytes| std::str::from_utf8(bytes).is_err())
        {
            return Err(AppError::new(
                "ENCODING_UNSUPPORTED",
                "Invalid UTF-8 must be saved as an explicitly converted copy, not overwritten.",
            ));
        }
        let mut bytes = change.content.as_bytes().to_vec();
        if original
            .as_ref()
            .is_some_and(|b| b.starts_with(&[239, 187, 191]))
        {
            let mut encoded = Vec::with_capacity(bytes.len() + 3);
            encoded.extend_from_slice(&[239, 187, 191]);
            encoded.extend(bytes);
            bytes = encoded;
        }
        prepared.push((target, original, bytes));
    }
    super::local::ensure_private_dir(root, ".texypaper/transactions")?;
    fs::create_dir(&dir)?;
    let mut journal = Journal {
        version: 1,
        transaction_id: id.into(),
        status: "staged".into(),
        records: Vec::new(),
        affected: Vec::new(),
    };
    for (index, ((_, original, bytes), change)) in prepared.iter().zip(&changes).enumerate() {
        let backup = format!("{index}.before");
        let stage = format!("{index}.after");
        if let Some(original) = original {
            atomic_write(&dir.join(&backup), original)?;
        }
        atomic_write(&dir.join(&stage), bytes)?;
        journal.records.push(Record {
            path: change.path.clone(),
            before: original.as_ref().map(|b| hash(b)),
            after: hash(bytes),
            backup,
            stage,
        });
    }
    save_journal(&dir, &journal)?;
    journal.status = "applying".into();
    save_journal(&dir, &journal)?;
    let mut written = Vec::new();
    let result = (|| -> AppResult<()> {
        for record in &journal.records {
            let target = resolve(root, &record.path, record.before.is_none())?;
            if agent {
                super::local::check_agent_path(root, &target, true)?;
            }
            let actual = current_hash(&target)?;
            if actual != record.before {
                return Err(conflict(root, &record.path, actual));
            }
            atomic_write(&target, &fs::read(dir.join(&record.stage))?)?;
            written.push(record.clone());
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut partial = Vec::new();
        for record in written.iter().rev() {
            let recovered = (|| -> AppResult<()> {
                let target = resolve(root, &record.path, false)?;
                if current_hash(&target)? != Some(record.after.clone()) {
                    return Err(conflict(root, &record.path, current_hash(&target)?));
                }
                if record.before.is_some() {
                    atomic_write(&target, &fs::read(dir.join(&record.backup))?)?;
                } else {
                    fs::remove_file(target)?;
                }
                Ok(())
            })();
            if recovered.is_err() {
                partial.push(record.path.clone());
            }
        }
        journal.status = if partial.is_empty() {
            "rolledBack"
        } else {
            "partial"
        }
        .into();
        journal.affected = partial.clone();
        save_journal(&dir, &journal)?;
        if !partial.is_empty() {
            let mut e = AppError::new(
                "TRANSACTION_PARTIAL",
                "Rollback stopped because a later edit must not be overwritten. Recovery material retained.",
            );
            e.details = Some(json!({"transactionId":id,"affectedPaths":partial,"cause":error}));
            return Err(e);
        }
        return Err(error);
    }
    journal.status = "committed".into();
    save_journal(&dir, &journal)?;
    let mut warnings = Vec::new();
    for ((_, original, bytes), change) in prepared.iter().zip(&changes) {
        if !change.path.starts_with(".texypaper/")
            && let Err(error) = crate::comments::map_source_change(
                root,
                &change.path,
                original.as_deref().unwrap_or_default(),
                bytes,
            )
        {
            warnings.push(json!({"path":change.path,"error":error}));
        }
    }
    let changed=journal.records.iter().zip(&prepared).map(|(record,(_,_,bytes))|json!({
        "path":record.path,"revision":{"sha256":record.after,"byteLength":bytes.len(),"modifiedNs":modified_ns(&root.join(&record.path))}
    })).collect::<Vec<_>>();
    prune(root);
    Ok(json!({"transactionId":id,"status":"committed","changed":changed,"warnings":warnings}))
}
pub fn save_text(
    root: &Path,
    path: &str,
    expected: &str,
    text: &str,
    id: &str,
) -> AppResult<Value> {
    let result = apply_proposal(
        root,
        id,
        vec![Change {
            path: path.into(),
            base_sha256: Some(expected.into()),
            content: text.into(),
            action: "edit".into(),
        }],
    )?;
    Ok(
        json!({"transactionId":id,"revision":result["changed"][0]["revision"],"changed":result["changed"],"warnings":result["warnings"],"status":"committed"}),
    )
}
pub fn status(root: &Path, id: &str) -> AppResult<Value> {
    let dir = transaction_dir(root, id)?;
    if !dir.exists() {
        return Ok(json!({"transactionId":id,"status":"unknown"}));
    }
    let journal: Journal = serde_json::from_slice(&fs::read(dir.join("journal.json"))?)?;
    let files=journal.records.iter().map(|r| {
        match resolve(root,&r.path,true).and_then(|path|current_hash(&path)){
            Ok(current)=>json!({"path":r.path,"beforeSha256":r.before,"resultSha256":r.after,"currentSha256":current,"matchesResult":current.as_ref()==Some(&r.after),"matchesOriginal":current==r.before}),
            Err(error)=>json!({"path":r.path,"beforeSha256":r.before,"resultSha256":r.after,"matchesResult":false,"matchesOriginal":false,"error":error}),
        }
    }).collect::<Vec<_>>();
    Ok(
        json!({"transactionId":id,"status":journal.status,"affectedPaths":journal.affected,"files":files}),
    )
}
pub fn undo_transaction(root: &Path, id: &str) -> AppResult<Value> {
    let dir = transaction_dir(root, id)?;
    if !dir.exists() {
        return Err(AppError::new(
            "UNDO_UNAVAILABLE",
            "Transaction journal is unavailable",
        ));
    }
    let mut journal: Journal = serde_json::from_slice(&fs::read(dir.join("journal.json"))?)?;
    if journal.status != "committed" {
        return Err(AppError::new(
            "UNDO_UNAVAILABLE",
            "Only a committed transaction can be undone",
        ));
    }
    for record in &journal.records {
        let target = resolve(root, &record.path, false)?;
        let current = current_hash(&target)?;
        if current != Some(record.after.clone()) {
            return Err(conflict(root, &record.path, current));
        }
    }
    journal.status = "undoing".into();
    save_journal(&dir, &journal)?;
    let mut changed = Vec::new();
    let mut warnings = Vec::new();
    for record in journal.records.iter().rev() {
        let target = resolve(root, &record.path, false)?;
        if current_hash(&target)? != Some(record.after.clone()) {
            journal.status = "partial".into();
            journal.affected.push(record.path.clone());
            save_journal(&dir, &journal)?;
            return Err(AppError::new(
                "TRANSACTION_PARTIAL",
                "Undo interrupted by an external edit; journal retained",
            ));
        }
        let old = fs::read(&target)?;
        let result = if record.before.is_some() {
            fs::read(dir.join(&record.backup))
                .map_err(AppError::from)
                .and_then(|bytes| {
                    atomic_write(&target, &bytes)?;
                    if !record.path.starts_with(".texypaper/")
                        && let Err(error) =
                            crate::comments::map_source_change(root, &record.path, &old, &bytes)
                    {
                        warnings.push(json!({"path":record.path,"error":error}));
                    }
                    Ok(())
                })
        } else {
            fs::remove_file(&target).map_err(AppError::from)
        };
        if let Err(mut error) = result {
            journal.status = "partial".into();
            journal.affected.push(record.path.clone());
            save_journal(&dir, &journal)?;
            error.code = "TRANSACTION_PARTIAL".into();
            return Err(error);
        }
        let restored_revision = if let Some(before) = &record.before {
            json!({"sha256":before,"byteLength":fs::metadata(dir.join(&record.backup))?.len(),"modifiedNs":modified_ns(&target)})
        } else {
            Value::Null
        };
        changed.push(json!({"path":record.path,"revision":restored_revision}));
    }
    journal.status = "undone".into();
    save_journal(&dir, &journal)?;
    Ok(json!({"transactionId":id,"status":"undone","changed":changed,"warnings":warnings}))
}
fn prune(root: &Path) {
    let Ok(parent) = super::local::ensure_private_dir(root, ".texypaper/transactions") else {
        return;
    };
    let Ok(dirs) = fs::read_dir(parent) else {
        return;
    };
    let mut groups: [Vec<_>; 2] = [Vec::new(), Vec::new()];
    for entry in dirs.filter_map(Result::ok) {
        let Some((source, modified, path)) = (|| {
            if entry.file_type().ok()?.is_symlink() {
                return None;
            }
            let journal: Journal =
                serde_json::from_slice(&fs::read(entry.path().join("journal.json")).ok()?).ok()?;
            if !matches!(
                journal.status.as_str(),
                "committed" | "undone" | "rolledBack"
            ) {
                return None;
            }
            Some((
                journal
                    .records
                    .iter()
                    .any(|record| !record.path.starts_with(".texypaper/")),
                entry.metadata().ok()?.modified().ok()?,
                entry.path(),
            ))
        })() else {
            continue;
        };
        groups[usize::from(source)].push((modified, path));
    }
    for group in &mut groups {
        group.sort_by_key(|entry| entry.0);
        let count = group.len().saturating_sub(100);
        for (_, path) in group.drain(..count) {
            let _ = fs::remove_dir_all(path);
        }
    }
}
