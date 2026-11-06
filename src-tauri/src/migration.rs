//! One-time legacy storage migration. The old application must be closed first.
use crate::contracts::{AppError, AppResult};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

const LEGACY_PROJECT: &str = ".paperdock";
const PROJECT: &str = ".texypaper";
const MARKER: &str = ".texypaper-migration";

fn failure(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn unsafe_metadata(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn metadata(path: &Path) -> AppResult<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(value) if unsafe_metadata(&value) => Err(failure(
            "MIGRATION_UNSAFE_PATH",
            "Storage migration refuses symbolic links and reparse points",
        )),
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn directory(path: &Path) -> AppResult<bool> {
    match metadata(path)? {
        Some(value) if !value.is_dir() => Err(failure(
            "MIGRATION_UNSAFE_PATH",
            "Storage location is not a directory",
        )),
        Some(_) => Ok(true),
        None => Ok(false),
    }
}
// Inspect directory entries only. In particular, profile credential bytes are never opened.
fn inspect_storage(root: &Path, mut on_file: impl FnMut(PathBuf)) -> AppResult<()> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let value = metadata(&path)?.ok_or_else(|| {
                failure("MIGRATION_UNSAFE_PATH", "Storage changed during migration")
            })?;
            if value.is_dir() {
                pending.push(path);
            } else if value.is_file() {
                on_file(path);
            } else {
                return Err(failure(
                    "MIGRATION_UNSAFE_PATH",
                    "Storage contains a special file",
                ));
            }
        }
    }
    Ok(())
}
/// The handle remains owned by the caller for the full profile lifetime.
pub fn lock_profile(path: &Path) -> AppResult<File> {
    if let Some(value) = metadata(&path.join("instance.lock"))?
        && !value.is_file()
    {
        return Err(failure(
            "MIGRATION_UNSAFE_PATH",
            "Instance lock is not a regular file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Match the legacy exclusive lock; callers cannot remove a live lock file.
        options.share_mode(0);
    }
    let file = options.open(path.join("instance.lock")).map_err(|error| {
        if matches!(error.raw_os_error(), Some(32 | 33)) {
            failure(
                "PROFILE_IN_USE",
                "Close the application using this profile before starting TexyPaper",
            )
        } else {
            error.into()
        }
    })?;
    #[cfg(not(windows))]
    file.try_lock()
        .map_err(|_| failure("PROFILE_IN_USE", "This profile is already in use"))?;
    Ok(file)
}
/// Explicit profiles never inspect or migrate any default profile.
/// Debug callers must supply an isolated explicit profile before calling this function.
pub fn prepare_profile(target: &Path, explicit: bool) -> AppResult<File> {
    let parent = target
        .parent()
        .ok_or_else(|| failure("MIGRATION_UNSAFE_PATH", "Profile parent is missing"))?;
    for ancestor in parent.ancestors() {
        if let Some(value) = metadata(ancestor)?
            && !value.is_dir()
        {
            return Err(failure(
                "MIGRATION_UNSAFE_PATH",
                "Profile ancestor is not a directory",
            ));
        }
    }
    if !explicit
        && target.file_name().and_then(|name| name.to_str()) != Some("dev.texypaper.desktop")
    {
        return Err(failure(
            "MIGRATION_UNSAFE_PATH",
            "Unexpected default profile directory",
        ));
    }
    if !explicit && directory(parent)? {
        // Serializes migrations by new clients, not old software. The old client
        // lock below is authoritative; old software must stay closed throughout.
        let guard_path = parent.join(".texypaper-profile-migration.lock");
        if let Some(value) = metadata(&guard_path)?
            && !value.is_file()
        {
            return Err(failure(
                "MIGRATION_UNSAFE_PATH",
                "Migration lock is not a regular file",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let _migration_guard = options
            .open(guard_path)
            .map_err(|_| failure("PROFILE_IN_USE", "Another profile migration is running"))?;
        #[cfg(not(windows))]
        _migration_guard
            .try_lock()
            .map_err(|_| failure("PROFILE_IN_USE", "Another profile migration is running"))?;
        let legacy = parent.join("dev.paperdock.desktop");
        let old_exists = directory(&legacy)?;
        let new_exists = directory(target)?;
        if old_exists && new_exists {
            return Err(failure(
                "MIGRATION_CONFLICT",
                "Both legacy and TexyPaper profiles exist; neither was merged or removed",
            ));
        }
        if old_exists {
            let lock = lock_profile(&legacy)?;
            inspect_storage(&legacy, |_| {})?;
            // Windows refuses a directory rename with an open descendant, even
            // with FILE_SHARE_DELETE. Keep the sibling migration guard, close our
            // probe, then acquire the moved instance lock before releasing it.
            // The legacy application must remain closed throughout migration.
            #[cfg(windows)]
            drop(lock);
            fs::rename(&legacy, target)?;
            #[cfg(windows)]
            return lock_profile(target);
            #[cfg(not(windows))]
            return Ok(lock);
        }
    }
    directory(target)?;
    fs::create_dir_all(target)?;
    lock_profile(target)
}
fn private_path(value: &mut Value) -> AppResult<()> {
    let Some(path) = value.as_str() else {
        return Ok(());
    };
    let first = path.split(['/', '\\', ':', '\0']).next().unwrap_or("");
    if !matches!(first, LEGACY_PROJECT | PROJECT) {
        return Ok(());
    }
    if path.contains(['\\', ':', '\0'])
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(failure(
            "MIGRATION_INVALID_RECORD",
            "Metadata contains an unsafe private path",
        ));
    }
    if path == LEGACY_PROJECT {
        *value = json!(PROJECT);
    } else if let Some(suffix) = path.strip_prefix(".paperdock/") {
        *value = json!(format!(".texypaper/{suffix}"));
    }
    Ok(())
}
fn path_fields(value: &mut Value, fields: &[&str]) -> AppResult<()> {
    if !value.is_object() {
        return Err(failure(
            "MIGRATION_INVALID_RECORD",
            "Expected a metadata object",
        ));
    }
    for field in fields {
        if let Some(path) = value.get_mut(*field) {
            private_path(path)?;
        }
    }
    Ok(())
}
fn path_list(value: &mut Value, field: &str) -> AppResult<()> {
    if let Some(paths) = value.get_mut(field) {
        let paths = paths
            .as_array_mut()
            .ok_or_else(|| failure("MIGRATION_INVALID_RECORD", "Expected a metadata path list"))?;
        for path in paths {
            private_path(path)?;
        }
    }
    Ok(())
}
fn build_manifest(value: &mut Value) -> AppResult<()> {
    path_fields(value, &["pdfPath", "syncPath"])?;
    if let Some(sources) = value.get_mut("sources") {
        let sources = sources
            .as_array_mut()
            .ok_or_else(|| failure("MIGRATION_INVALID_RECORD", "Expected build source records"))?;
        for source in sources {
            path_fields(source, &["snapshotPath"])?;
        }
    }
    // SyncTeX and engine caches contain opaque embedded legacy paths. Preserve
    // artifacts, but never claim their source mapping remains valid after move.
    value["mappingReady"] = json!(false);
    value["mappingReason"] = json!("Rebuild after storage migration to restore source mapping");
    Ok(())
}
fn remote_fingerprint(value: &Value) -> Option<String> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry<'a> {
        path: &'a str,
        base_sha256: &'a Value,
        action: &'a str,
        result_sha256: &'a Value,
    }
    let records = value.get("files")?.as_array()?;
    let mut entries = Vec::with_capacity(records.len());
    for record in records {
        entries.push(Entry {
            path: record.get("path")?.as_str()?,
            base_sha256: record.get("beforeSha256")?,
            action: record.get("action")?.as_str()?,
            result_sha256: record.get("afterSha256")?,
        });
    }
    Some(crate::workspace::local::hash(
        &serde_json::to_vec(&entries).ok()?,
    ))
}
fn journal_paths(value: &mut Value) -> AppResult<()> {
    let update_fingerprint = value
        .get("fingerprint")
        .and_then(Value::as_str)
        .is_some_and(|stored| remote_fingerprint(value).as_deref() == Some(stored));
    // Both native and remote journal schemas can be present in copied projects.
    path_fields(value, &["path", "source", "destination"])?;
    for field in ["affected", "affectedPaths", "paths"] {
        path_list(value, field)?;
    }
    for field in ["records", "files"] {
        if let Some(records) = value.get_mut(field) {
            let records = records.as_array_mut().ok_or_else(|| {
                failure(
                    "MIGRATION_INVALID_RECORD",
                    "Expected transaction file records",
                )
            })?;
            for record in records {
                path_fields(record, &["path"])?;
            }
        }
    }
    if let Some(result) = value.get_mut("result").filter(|result| !result.is_null()) {
        path_fields(result, &["path", "newPath"])?;
        path_list(result, "paths")?;
        for field in ["revisions", "changed"] {
            if let Some(revisions) = result.get_mut(field) {
                let revisions = revisions.as_array_mut().ok_or_else(|| {
                    failure("MIGRATION_INVALID_RECORD", "Expected transaction revisions")
                })?;
                for revision in revisions {
                    path_fields(revision, &["path"])?;
                    if let Some(file) = revision.get_mut("file").filter(|file| !file.is_null()) {
                        path_fields(file, &["path"])?;
                    }
                }
            }
        }
    }
    // backup/stage/beforeFile/afterFile are transaction-local basenames, never rewritten.
    for field in ["records", "files"] {
        let mut seen = std::collections::HashSet::new();
        if let Some(records) = value.get(field).and_then(Value::as_array) {
            for record in records {
                let path = record.get("path").and_then(Value::as_str).ok_or_else(|| {
                    failure("MIGRATION_INVALID_RECORD", "Journal path is missing")
                })?;
                if !seen.insert(path) {
                    return Err(failure(
                        "MIGRATION_INVALID_RECORD",
                        "Journal paths collide after migration",
                    ));
                }
            }
        }
    }
    if value.get("source").is_some() && value.get("source") == value.get("destination") {
        return Err(failure(
            "MIGRATION_INVALID_RECORD",
            "Journal move paths collide after migration",
        ));
    }
    if update_fingerprint && let Some(fingerprint) = remote_fingerprint(value) {
        value["fingerprint"] = json!(fingerprint);
    }
    Ok(())
}
fn project_updates(base: &Path, files: &[PathBuf]) -> AppResult<Vec<(PathBuf, Vec<u8>)>> {
    let mut updates = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(base)
            .map_err(|_| failure("MIGRATION_UNSAFE_PATH", "Metadata escaped its directory"))?;
        let parts = relative
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let transaction =
            parts.len() == 3 && parts[0] == "transactions" && parts[2] == "journal.json";
        let build = parts.first().is_some_and(|p| p == "build")
            && ((parts.len() == 2 && matches!(parts[1].as_str(), "latest.json" | "status.json"))
                || (parts.len() == 3 && parts[2] == "latest.json")
                || (parts.len() == 5
                    && matches!(parts[2].as_str(), "pending" | "published")
                    && parts[4] == "manifest.json"));
        if !transaction && !build {
            continue;
        }
        if fs::metadata(file)?.len() > 16 * 1024 * 1024 {
            return Err(failure(
                "MIGRATION_INVALID_RECORD",
                "Migration record exceeds safe size",
            ));
        }
        let mut value: Value = serde_json::from_slice(&fs::read(file)?).map_err(|_| {
            failure(
                "MIGRATION_INVALID_RECORD",
                "Migration record is not valid JSON",
            )
        })?;
        if !value.is_object() {
            return Err(failure(
                "MIGRATION_INVALID_RECORD",
                "Migration record is not an object",
            ));
        }
        if transaction {
            journal_paths(&mut value)?;
        } else if parts.len() == 2 {
            if let Some(manifest) = value
                .get_mut("manifest")
                .filter(|manifest| !manifest.is_null())
            {
                build_manifest(manifest)?;
            }
        } else {
            build_manifest(&mut value)?;
        }
        updates.push((relative.to_path_buf(), serde_json::to_vec(&value)?));
    }
    Ok(updates)
}
/// Call before project operations/recovery. Only explicit metadata path fields are
/// rewritten; comments, source text, backups, recovery and trash contents are opaque.
pub fn migrate_project(root: &Path) -> AppResult<()> {
    let legacy = root.join(LEGACY_PROJECT);
    let target = root.join(PROJECT);
    let old_exists = directory(&legacy)?;
    let new_exists = directory(&target)?;
    if old_exists && new_exists {
        return Err(failure(
            "MIGRATION_CONFLICT",
            "Both legacy and TexyPaper project metadata exist; neither was merged or removed",
        ));
    }
    if !old_exists && !new_exists {
        return Ok(());
    }
    let base = if old_exists { &legacy } else { &target };
    let marker = base.join(MARKER);
    let resume = if let Some(value) = metadata(&marker)? {
        if !value.is_file() || value.len() != 2 || fs::read(&marker)? != b"1\n" {
            return Err(failure(
                "MIGRATION_INVALID_RECORD",
                "Unrecognized migration marker; no recovery was attempted",
            ));
        }
        true
    } else {
        false
    };
    if !old_exists && !resume {
        return Ok(());
    }
    let mut files = Vec::new();
    inspect_storage(base, |path| files.push(path))?;
    let updates = project_updates(base, &files)?;
    if old_exists {
        if !resume {
            let mut marker_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)?;
            use std::io::Write;
            marker_file.write_all(b"1\n")?;
            marker_file.sync_all()?;
            #[cfg(not(windows))]
            File::open(&legacy)?.sync_all()?;
        }
        fs::rename(&legacy, &target)?;
        #[cfg(not(windows))]
        File::open(root)?.sync_all()?;
    }
    // Every rewrite is atomic and prefix-idempotent. A crash leaves the marker,
    // causing the entire recognized-record pass to finish before the next open.
    for (relative, bytes) in updates {
        crate::workspace::transactions::atomic_write(&target.join(relative), &bytes)?;
    }
    fs::remove_file(target.join(MARKER))?;
    #[cfg(not(windows))]
    File::open(&target)?.sync_all()?;
    Ok(())
}
