use crate::{contracts::*, state::AppState, workspace::Workspace};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
};

pub struct MediaGrant {
    pub workspace_id: String,
    pub epoch: u64,
    pub path: PathBuf,
    pub mime: &'static str,
    pub length: u64,
}
fn metadata(workspace: &Workspace, path: &str) -> AppResult<Value> {
    let result = workspace.execute("stat_many", json!({"paths":[path]}))?;
    let entry = result
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .ok_or_else(|| AppError::new("FILE_NOT_FOUND", "File metadata unavailable"))?
        .clone();
    if let Some(error) = entry.get("error") {
        return Err(AppError::new("FILE_NOT_FOUND", error.to_string()));
    }
    if entry.get("kind").and_then(Value::as_str) != Some("file") {
        return Err(AppError::new("NOT_A_FILE", "Select a regular file"));
    }
    Ok(entry)
}
pub fn file_metadata(workspace: &Workspace, args: &Value) -> AppResult<Value> {
    metadata(
        workspace,
        args.get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "path required"))?,
    )
}
pub fn image_metadata(state: &AppState, workspace: &Workspace, args: &Value) -> AppResult<Value> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "path required"))?;
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => {
            return Err(AppError::new(
                "IMAGE_UNSUPPORTED",
                "PNG, JPEG, WebP and SVG previews are supported",
            ));
        }
    };
    let meta = metadata(workspace, path)?;
    let length = meta.get("byteLength").and_then(Value::as_u64).unwrap_or(0);
    if length > 16 * 1024 * 1024 {
        return Err(AppError::new(
            "IMAGE_LARGE",
            "Image exceeds the 16 MiB preview budget; export a copy to open externally",
        ));
    }
    let hash = meta
        .pointer("/revision/sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("REVISION_MISSING", "Image revision unavailable"))?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new("REVISION_INVALID", "Malformed image digest"));
    }
    let directory = state.data_dir.join("media").join(&workspace.reference.id);
    fs::create_dir_all(&directory)?;
    let destination = directory.join(format!("{hash}.{extension}"));
    stream_copy(workspace, path, &destination, length, Some(hash))?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut grants = state
        .media
        .lock()
        .map_err(|_| AppError::new("STATE_ERROR", "Media lock poisoned"))?;
    for previous in grants.values() {
        if previous.path != destination {
            let _ = fs::remove_file(&previous.path);
        }
    }
    grants.clear();
    grants.insert(
        token.clone(),
        MediaGrant {
            workspace_id: workspace.reference.id.clone(),
            epoch: workspace.reference.epoch,
            path: destination,
            mime,
            length,
        },
    );
    Ok(
        json!({"url":format!("http://texypaper.localhost/media/{}?token={token}",workspace.reference.id),"byteLength":length,"sha256":hash,"mime":mime}),
    )
}
pub fn stream_copy(
    workspace: &Workspace,
    path: &str,
    destination: &std::path::Path,
    length: u64,
    expected: Option<&str>,
) -> AppResult<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::new("INVALID_PATH", "Destination parent missing"))?;
    let temp = parent.join(format!(".texypaper-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        let mut offset = 0;
        let mut hash = Sha256::new();
        while offset < length {
            let bytes =
                workspace.read_bytes(path, offset, (length - offset).min(65536) as usize)?;
            if bytes.is_empty() {
                return Err(AppError::new(
                    "FILE_CHANGED",
                    "File changed while downloading",
                ));
            }
            output.write_all(&bytes)?;
            hash.update(&bytes);
            offset += bytes.len() as u64;
        }
        if expected.is_some_and(|h| h != format!("{:x}", hash.finalize())) {
            return Err(AppError::new(
                "FILE_CHANGED",
                "File revision changed while downloading",
            ));
        }
        output.sync_all()?;
        drop(output);
        fs::rename(&temp, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn export_file(state: &AppState, workspace: &Workspace, args: &Value) -> AppResult<Value> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_ARGUMENT", "path required"))?;
    let meta = metadata(workspace, path)?;
    let english = state
        .settings
        .lock()
        .map_err(|_| AppError::new("STATE_ERROR", "Settings lock poisoned"))?
        .get("locale")
        .and_then(Value::as_str)
        == Some("en");
    let file_name = std::path::Path::new(path)
        .file_name()
        .and_then(|p| p.to_str())
        .unwrap_or("file")
        .to_owned();
    let destination = crate::dialogs::run(move || {
        rfd::FileDialog::new()
            .set_title(if english {
                "Export downloaded copy"
            } else {
                "다운로드한 복사본 내보내기"
            })
            .set_file_name(file_name)
            .save_file()
    })?
    .ok_or_else(|| AppError::new("CANCELLED", "Export cancelled"))?;
    stream_copy(
        workspace,
        path,
        &destination,
        meta.get("byteLength").and_then(Value::as_u64).unwrap_or(0),
        meta.pointer("/revision/sha256").and_then(Value::as_str),
    )?;
    Ok(json!({"exported":true,"copy":workspace.local_root().is_none(),"destination":destination}))
}
pub fn response(
    state: &AppState,
    workspace_id: &str,
    token: &str,
) -> tauri::http::Response<Vec<u8>> {
    let result = (|| -> AppResult<(&'static str, Vec<u8>)> {
        let grants = state
            .media
            .lock()
            .map_err(|_| AppError::new("STATE_ERROR", "Media lock poisoned"))?;
        let grant = grants
            .get(token)
            .filter(|g| g.workspace_id == workspace_id)
            .ok_or_else(|| AppError::new("MEDIA_UNAUTHORIZED", "Preview authorization expired"))?;
        state.workspace(&grant.workspace_id, grant.epoch)?;
        let mut bytes = Vec::with_capacity(grant.length as usize);
        fs::File::open(&grant.path)?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != grant.length {
            return Err(AppError::new("FILE_CHANGED", "Cached preview changed"));
        }
        Ok((grant.mime, bytes))
    })();
    match result {
        Ok((mime, bytes)) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Content-Length", bytes.len())
            .header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            )
            .header("X-Content-Type-Options", "nosniff")
            .header("Access-Control-Allow-Origin", "http://tauri.localhost")
            .body(bytes)
            .expect("valid image response"),
        Err(error) => tauri::http::Response::builder()
            .status(403)
            .body(error.code.into_bytes())
            .expect("static error response"),
    }
}
