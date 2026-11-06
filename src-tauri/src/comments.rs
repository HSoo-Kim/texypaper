use crate::contracts::{AppError, AppResult};
use crate::workspace::{
    local::{self, hash, resolve},
    transactions,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{LazyLock, Mutex},
};
const COMMENT_PATH: &str = ".texypaper/comments.json";
static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
fn lock() -> &'static Mutex<()> {
    &LOCK
}
fn raw_read(root: &Path) -> AppResult<(Value, Option<String>)> {
    let target = root.join(COMMENT_PATH);
    if !target.exists() {
        return Ok((json!({"version":1,"revision":"","threads":[]}), None));
    }
    let bytes = fs::read(resolve(root, COMMENT_PATH, false)?)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(AppError::new(
            "COMMENTS_LIMIT",
            "Comment sidecar exceeds 4 MiB",
        ));
    }
    let mut value: Value = serde_json::from_slice(&bytes)?;
    validate(root, &value["threads"])?;
    if value["version"] != 1 {
        return Err(AppError::new(
            "COMMENTS_VERSION_UNSUPPORTED",
            "Unsupported comment document version",
        ));
    }
    let digest = hash(&bytes);
    value["revision"] = json!(digest);
    Ok((value, Some(digest)))
}
fn validate(root: &Path, threads: &Value) -> AppResult<()> {
    let threads = threads
        .as_array()
        .ok_or_else(|| AppError::new("COMMENTS_INVALID", "threads must be an array"))?;
    if threads.len() > 10000 {
        return Err(AppError::new(
            "COMMENTS_LIMIT",
            "At most 10000 threads per project",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for thread in threads {
        let id = thread["id"]
            .as_str()
            .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Thread ID required"))?;
        if id.is_empty() || id.len() > 128 || !ids.insert(id) {
            return Err(AppError::new(
                "COMMENTS_INVALID",
                "Duplicate or invalid thread ID",
            ));
        }
        if !matches!(
            thread["status"].as_str(),
            Some("open" | "resolved" | "orphaned")
        ) {
            return Err(AppError::new("COMMENTS_INVALID", "Invalid comment status"));
        }
        if let Some(source) = thread.get("source").filter(|s| !s.is_null()) {
            let path = source["path"]
                .as_str()
                .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Source path required"))?;
            local::validate_relative(path)?;
            // A missing file is a valid orphan, but an existing escape is never valid.
            if root.join(path).exists() {
                resolve(root, path, false)?;
            }
            let start = source["startByte"]
                .as_u64()
                .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Invalid source start"))?;
            let end = source["endByte"]
                .as_u64()
                .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Invalid source end"))?;
            if end < start
                || source["baseSha256"].as_str().is_none()
                || source["quote"].as_str().is_none()
                || source["before"].as_str().is_none()
                || source["after"].as_str().is_none()
            {
                return Err(AppError::new("COMMENTS_INVALID", "Invalid source anchor"));
            }
        }
        if let Some(pdf) = thread.get("pdf").filter(|s| !s.is_null()) {
            if pdf["buildId"].as_str().is_none()
                || pdf["pdfSha256"].as_str().is_none()
                || pdf["page"].as_u64().unwrap_or(0) == 0
                || pdf["quote"].as_str().is_none()
            {
                return Err(AppError::new("COMMENTS_INVALID", "Invalid PDF anchor"));
            }
            let rects = pdf["rects"]
                .as_array()
                .ok_or_else(|| AppError::new("COMMENTS_INVALID", "PDF rectangles required"))?;
            if rects.len() > 1000
                || rects.iter().any(|r| {
                    r.as_array().is_none_or(|a| {
                        a.len() != 4 || a.iter().any(|v| v.as_f64().is_none_or(|n| !n.is_finite()))
                    })
                })
            {
                return Err(AppError::new("COMMENTS_INVALID", "Invalid PDF rectangles"));
            }
        }
        let messages = thread["messages"]
            .as_array()
            .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Messages required"))?;
        let mut message_ids = std::collections::HashSet::new();
        if messages.len() > 10000 {
            return Err(AppError::new("COMMENTS_LIMIT", "Too many messages"));
        }
        for message in messages {
            let id = message["id"]
                .as_str()
                .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Message ID required"))?;
            if !message_ids.insert(id)
                || message["author"] != "me"
                || message["text"].as_str().is_none_or(|t| t.len() > 65536)
                || message["createdAt"].as_str().is_none()
                || message["updatedAt"].as_str().is_none()
            {
                return Err(AppError::new("COMMENTS_INVALID", "Invalid message"));
            }
        }
    }
    Ok(())
}
fn persist(
    root: &Path,
    mut document: Value,
    expected: Option<String>,
    transaction_id: &str,
) -> AppResult<Value> {
    local::ensure_private_dir(root, ".texypaper")?;
    document["revision"] = json!(uuid::Uuid::new_v4().to_string());
    let bytes = serde_json::to_vec_pretty(&document)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(AppError::new(
            "COMMENTS_LIMIT",
            "Comment sidecar exceeds 4 MiB",
        ));
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| AppError::new("COMMENTS_INVALID", "Invalid UTF-8"))?;
    let action = if expected.is_some() { "edit" } else { "create" };
    transactions::apply_proposal(
        root,
        transaction_id,
        vec![transactions::Change {
            path: COMMENT_PATH.into(),
            base_sha256: expected,
            content,
            action: action.into(),
        }],
    )?;
    document["revision"] = json!(hash(&bytes));
    Ok(document)
}
pub fn read(root: &Path) -> AppResult<Value> {
    let _guard = lock()
        .lock()
        .map_err(|_| AppError::new("COMMENTS_LOCK", "Comment lock failed"))?;
    let (mut document, _) = raw_read(root)?;
    if let Some(threads) = document["threads"].as_array_mut() {
        for thread in threads {
            refresh_anchor(root, thread)?;
        }
    }
    Ok(document)
}
pub fn update(root: &Path, args: &Value) -> AppResult<Value> {
    let _guard = lock()
        .lock()
        .map_err(|_| AppError::new("COMMENTS_LOCK", "Comment lock failed"))?;
    let (current, expected) = raw_read(root)?;
    let wanted = args["expectedRevision"]
        .as_str()
        .ok_or_else(|| AppError::new("COMMENTS_INVALID", "expectedRevision is required"))?;
    if current["revision"].as_str().unwrap_or("") != wanted {
        let mut error = AppError::new(
            "FILE_CONFLICT",
            "Comments were changed outside this edit; reload before saving.",
        );
        error.path = Some(COMMENT_PATH.into());
        error.details = Some(json!({"currentRevision":current["revision"]}));
        return Err(error);
    }
    validate(root, &args["threads"])?;
    let id = args["transactionId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    persist(
        root,
        json!({"version":1,"revision":"","threads":args["threads"]}),
        expected,
        &id,
    )
}
/// Exact byte anchors survive only unique quote-and-context matches in the same source file.
pub fn find_unique_anchor(
    text: &str,
    quote: &str,
    before: &str,
    after: &str,
) -> Option<(usize, usize)> {
    if quote.is_empty() {
        return None;
    }
    let mut found = None;
    let mut offset = 0;
    while offset < text.len() {
        let Some(relative) = text[offset..].find(quote) else {
            break;
        };
        let start = offset + relative;
        let end = start + quote.len();
        if text[..start].ends_with(before) && text[end..].starts_with(after) {
            if found.is_some() {
                return None;
            }
            found = Some((start, end));
        }
        offset = start + text[start..].chars().next()?.len_utf8();
    }
    found
}
fn refresh_anchor(root: &Path, thread: &mut Value) -> AppResult<()> {
    let Some(source) = thread.get("source").filter(|s| !s.is_null()).cloned() else {
        return Ok(());
    };
    let path = source["path"].as_str().unwrap_or("");
    let target = match resolve(root, path, false) {
        Ok(path) => path,
        Err(error) if error.code == "FILE_NOT_FOUND" => {
            thread["status"] = json!("orphaned");
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let bytes = fs::read(target)?;
    let digest = hash(&bytes);
    let Ok(text) = std::str::from_utf8(&bytes) else {
        thread["status"] = json!("orphaned");
        return Ok(());
    };
    let start = source["startByte"].as_u64().unwrap_or(0) as usize;
    let end = source["endByte"].as_u64().unwrap_or(0) as usize;
    if source["baseSha256"] == digest && text.get(start..end) == source["quote"].as_str() {
        return Ok(());
    }
    if let Some((start, end)) = find_unique_anchor(
        text,
        source["quote"].as_str().unwrap_or(""),
        source["before"].as_str().unwrap_or(""),
        source["after"].as_str().unwrap_or(""),
    ) {
        thread["source"]["startByte"] = json!(start);
        thread["source"]["endByte"] = json!(end);
        thread["source"]["baseSha256"] = json!(digest);
        if thread["status"] == "orphaned" {
            thread["status"] = json!("open");
        }
    } else {
        thread["status"] = json!("orphaned");
    }
    Ok(())
}
pub fn map_source_change(root: &Path, path: &str, before: &[u8], after: &[u8]) -> AppResult<()> {
    if !root.join(COMMENT_PATH).exists() {
        return Ok(());
    }
    let _guard = lock()
        .lock()
        .map_err(|_| AppError::new("COMMENTS_LOCK", "Comment lock failed"))?;
    let (mut document, expected) = raw_read(root)?;
    let mut prefix = before.iter().zip(after).take_while(|(a, b)| a == b).count();
    while prefix > 0
        && ((before.get(prefix).is_some_and(|b| b & 0xc0 == 0x80))
            || (after.get(prefix).is_some_and(|b| b & 0xc0 == 0x80)))
    {
        prefix -= 1;
    }
    let max_suffix = before.len().min(after.len()).saturating_sub(prefix);
    let mut suffix = before
        .iter()
        .rev()
        .zip(after.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    while suffix > 0
        && ((before
            .get(before.len() - suffix)
            .is_some_and(|b| b & 0xc0 == 0x80))
            || (after
                .get(after.len() - suffix)
                .is_some_and(|b| b & 0xc0 == 0x80)))
    {
        suffix -= 1;
    }
    let old_end = before.len() - suffix;
    let new_end = after.len() - suffix;
    let old_hash = hash(before);
    let new_hash = hash(after);
    let mut changed = false;
    if let Some(threads) = document["threads"].as_array_mut() {
        for thread in threads {
            if thread["source"]["path"] != path {
                continue;
            }
            changed = true;
            let start = thread["source"]["startByte"].as_u64().unwrap_or(0) as usize;
            let end = thread["source"]["endByte"].as_u64().unwrap_or(0) as usize;
            if thread["source"]["baseSha256"] == old_hash && end <= before.len() {
                let mapped = if end <= prefix {
                    Some((start, end))
                } else if start >= old_end {
                    Some((start - old_end + new_end, end - old_end + new_end))
                } else {
                    None
                };
                if let Some((start, end)) = mapped {
                    if let Ok(text) = std::str::from_utf8(after) {
                        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                            refresh_anchor(root, thread)?;
                            continue;
                        }
                        thread["source"]["startByte"] = json!(start);
                        thread["source"]["endByte"] = json!(end);
                        thread["source"]["baseSha256"] = json!(new_hash);
                        let before_start = text[..start]
                            .char_indices()
                            .rev()
                            .nth(31)
                            .map(|(i, _)| i)
                            .unwrap_or(0);
                        let after_end = text[end..]
                            .char_indices()
                            .nth(32)
                            .map(|(i, _)| end + i)
                            .unwrap_or(text.len());
                        thread["source"]["before"] = json!(&text[before_start..start]);
                        thread["source"]["after"] = json!(&text[end..after_end]);
                    } else {
                        thread["status"] = json!("orphaned");
                    }
                } else {
                    refresh_anchor(root, thread)?;
                }
            } else {
                refresh_anchor(root, thread)?;
            }
        }
    }
    if changed {
        persist(root, document, expected, &uuid::Uuid::new_v4().to_string())?;
    }
    Ok(())
}
pub fn rename_source(root: &Path, old: &str, new: &str) -> AppResult<()> {
    if !root.join(COMMENT_PATH).exists() {
        return Ok(());
    }
    let _guard = lock()
        .lock()
        .map_err(|_| AppError::new("COMMENTS_LOCK", "Comment lock failed"))?;
    let (mut document, expected) = raw_read(root)?;
    let mut changed = false;
    if let Some(threads) = document["threads"].as_array_mut() {
        for thread in threads {
            if let Some(path) = thread["source"]["path"].as_str()
                && (path == old || path.starts_with(&format!("{old}/")))
            {
                thread["source"]["path"] = json!(format!("{new}{}", &path[old.len()..]));
                changed = true;
            }
        }
    }
    if changed {
        persist(root, document, expected, &uuid::Uuid::new_v4().to_string())?;
    }
    Ok(())
}
/// Refresh at most 32 source-backed placements against one immutable, matching build.
/// PDF-only comments deliberately remain bound to their original PDF hash.
pub fn refresh_pdf(workspace: &crate::workspace::Workspace, args: &Value) -> AppResult<Value> {
    let build_id = args["buildId"]
        .as_str()
        .ok_or_else(|| AppError::new("BUILD_UNKNOWN", "A build ID is required"))?;
    let manifest = workspace.execute("artifact_manifest", json!({"buildId":build_id}))?;
    let mut document = workspace.execute("comments_read", json!({}))?;
    let expected = document["revision"].clone();
    let cursor = args["cursor"].as_u64().unwrap_or(0) as usize;
    let total = document["threads"].as_array().map_or(0, Vec::len);
    if cursor > total {
        return Err(AppError::new(
            "CURSOR_INVALID",
            "Comment refresh cursor is out of range",
        ));
    }
    let end = cursor.saturating_add(32).min(total);
    let mut warnings = Vec::new();
    let mut changed = false;
    if manifest["mappingReady"] == true {
        for index in cursor..end {
            let source = document["threads"][index]["source"].clone();
            if source.is_null() || document["threads"][index]["status"] == "orphaned" {
                continue;
            }
            let path = source["path"].as_str().unwrap_or("");
            let recorded = manifest["sources"]
                .as_array()
                .and_then(|sources| sources.iter().find(|entry| entry["path"] == path));
            if !recorded.is_some_and(|entry| entry["sha256"] == source["baseSha256"]) {
                continue;
            }
            let result = (|| -> AppResult<Value> {
                let current = workspace.execute("read_text", json!({"path":path}))?;
                if current["revision"]["sha256"] != source["baseSha256"]
                    || current["truncated"] == true
                {
                    return Err(AppError::new(
                        "PDF_STALE",
                        "Comment source no longer matches this build",
                    ));
                }
                let text = current["text"]
                    .as_str()
                    .ok_or_else(|| AppError::new("COMMENTS_INVALID", "Source text unavailable"))?;
                let bom = if current["encoding"] == "utf8Bom" {
                    3
                } else {
                    0
                };
                let offset = source["startByte"].as_u64().unwrap_or(0) as usize;
                let offset = offset.checked_sub(bom).ok_or_else(|| {
                    AppError::new("COMMENTS_INVALID", "Anchor lies inside the encoding marker")
                })?;
                if !text.is_char_boundary(offset) {
                    return Err(AppError::new(
                        "COMMENTS_INVALID",
                        "Anchor is not a UTF-8 boundary",
                    ));
                }
                let line = text[..offset].bytes().filter(|byte| *byte == b'\n').count() + 1;
                let positions = crate::latex::execute(
                    workspace,
                    "sync_forward",
                    json!({"buildId":build_id,"file":path,"line1":line}),
                )?;
                let records = positions["records"].as_array().ok_or_else(|| {
                    AppError::new("SYNC_NO_MATCH", "Comment has no source-map result")
                })?;
                let mut page = None;
                let mut rects = Vec::new();
                for record in records {
                    let Some(current_page) = record["page"].as_u64().filter(|page| *page > 0)
                    else {
                        continue;
                    };
                    let (Some(h), Some(v), Some(width), Some(height)) = (
                        record["h"].as_f64(),
                        record["v"].as_f64(),
                        record["W"].as_f64(),
                        record["H"].as_f64(),
                    ) else {
                        continue;
                    };
                    if ![h, v, width, height]
                        .iter()
                        .all(|number| number.is_finite())
                        || width < 0.0
                        || height < 0.0
                    {
                        continue;
                    }
                    if page.is_some_and(|page| page != current_page) {
                        return Err(AppError::new(
                            "SYNC_AMBIGUOUS",
                            "Comment maps to several pages; source navigation remains available",
                        ));
                    }
                    page = Some(current_page);
                    rects.push(json!([h, v - height, h + width, v]));
                }
                let page = page.ok_or_else(|| {
                    AppError::new("SYNC_NO_MATCH", "Comment has no valid PDF rectangle")
                })?;
                Ok(
                    json!({"buildId":build_id,"pdfSha256":manifest["pdfSha256"],"page":page,"rects":rects,"quote":source["quote"]}),
                )
            })();
            match result {
                Ok(pdf) => {
                    if document["threads"][index]["pdf"] != pdf {
                        document["threads"][index]["pdf"] = pdf;
                        changed = true;
                    }
                }
                Err(error) => warnings
                    .push(json!({"threadId":document["threads"][index]["id"],"error":error})),
            }
        }
    }
    if changed {
        document=workspace.execute("comments_update",json!({"expectedRevision":expected,"threads":document["threads"],"transactionId":uuid::Uuid::new_v4().to_string()}))?;
    }
    Ok(
        json!({"comments":document,"nextCursor":if end<total{Some(end)}else{None},"warnings":warnings}),
    )
}
