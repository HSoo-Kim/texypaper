use super::transactions::{self, Change};
use crate::contracts::{AppError, AppResult, Entry, Revision};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
const PAPER: &[&str] = &["tex", "ltx", "bib", "cls", "sty", "bst", "bbx", "cbx"];
const EXCLUDED: &[&str] = &[
    ".git",
    ".texypaper",
    ".paperdock", // Legacy private metadata remains excluded after migration.
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
];
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn hash_reader(mut reader: impl Read) -> AppResult<String> {
    let mut digest = Sha256::new();
    let mut chunk = [0u8; 65536];
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        digest.update(&chunk[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub fn hash_file(path: &Path) -> AppResult<String> {
    hash_reader(File::open(path)?)
}
pub fn revision(path: &Path) -> AppResult<Revision> {
    let metadata = fs::metadata(path)?;
    Ok(Revision {
        sha256: hash_file(path)?,
        byte_length: metadata.len(),
        modified_ns: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_nanos().to_string())
            .unwrap_or_else(|| "0".into()),
    })
}
pub fn agent_read_denied(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|p| {
        p.starts_with(".env")
            || matches!(
                *p,
                ".git"
                    | ".ssh"
                    | ".aws"
                    | ".azure"
                    | ".gnupg"
                    | "credentials"
                    | ".texypaper"
                    | ".paperdock" // Both metadata generations stay private.
            )
    }) {
        return true;
    }
    let name = parts.last().copied().unwrap_or("");
    if matches!(
        name,
        "auth.json"
            | "credentials.json"
            | ".credentials.json"
            | "id_rsa"
            | "id_ed25519"
            | "id_ecdsa"
    ) || [".pem", ".key", ".p12", ".pfx"]
        .iter()
        .any(|extension| name.ends_with(extension))
    {
        return true;
    }
    false
}
pub fn check_agent_path(root: &Path, target: &Path, write: bool) -> AppResult<()> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| {
            AppError::new(
                "PATH_OUTSIDE_WORKSPACE",
                "Agent target is outside workspace",
            )
        })?
        .to_string_lossy()
        .replace('\\', "/");
    if agent_read_denied(&relative) {
        return Err(AppError::new(
            "AGENT_READ_DENIED",
            "Credentials and private application stores are not available to agents",
        ));
    }
    if write
        && (relative.split('/').any(|part| {
            part.eq_ignore_ascii_case(".texypaper") || part.eq_ignore_ascii_case(".paperdock")
        }) || !target
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| PAPER.contains(&s.to_ascii_lowercase().as_str())))
    {
        return Err(AppError::new(
            "AGENT_WRITE_DENIED",
            "Agent proposals may change only TeX and bibliography sources",
        ));
    }
    Ok(())
}
pub fn validate_relative(path: &str) -> AppResult<()> {
    if path.contains('\0')
        || path.contains(':')
        || path.contains('\\')
        || path.starts_with('/')
        || path.split('/').any(|p| p == ".." || p == ".")
    {
        return Err(AppError::new(
            "PATH_OUTSIDE_WORKSPACE",
            "Only normalized workspace-relative paths are permitted",
        ));
    }
    if !path.is_empty() && path.split('/').any(str::is_empty) {
        return Err(AppError::new("PATH_INVALID", "Empty path segment"));
    }
    if Path::new(path)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(AppError::new("PATH_INVALID", "Invalid relative path"));
    }
    #[cfg(windows)]
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.ends_with(' ')
            || part.ends_with('.')
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit()
        {
            return Err(AppError::new(
                "PATH_INVALID",
                "Windows device or alias path is not allowed",
            ));
        }
    }
    Ok(())
}
pub fn resolve(root: &Path, path: &str, allow_new: bool) -> AppResult<PathBuf> {
    validate_relative(path)?;
    let candidate = root.join(path);
    let resolved = if candidate.exists() || fs::symlink_metadata(&candidate).is_ok() {
        fs::canonicalize(&candidate)?
    } else if allow_new {
        let parent = candidate
            .parent()
            .ok_or_else(|| AppError::new("PATH_INVALID", "Missing parent"))?;
        let parent = fs::canonicalize(parent)?;
        if !parent.starts_with(root) {
            return Err(AppError::new(
                "PATH_OUTSIDE_WORKSPACE",
                "Parent resolves outside the workspace",
            ));
        }
        parent.join(
            candidate
                .file_name()
                .ok_or_else(|| AppError::new("PATH_INVALID", "Missing filename"))?,
        )
    } else {
        return Err(AppError::new(
            "FILE_NOT_FOUND",
            format!("File not found: {path}"),
        ));
    };
    if !resolved.starts_with(root) {
        return Err(AppError::new(
            "PATH_OUTSIDE_WORKSPACE",
            "Symlink target escapes the workspace",
        ));
    }
    Ok(resolved)
}
pub fn ensure_private_dir(root: &Path, path: &str) -> AppResult<PathBuf> {
    validate_relative(path)?;
    let mut current = root.to_path_buf();
    for part in path.split('/') {
        current.push(part);
        if current.exists() {
            let canonical = fs::canonicalize(&current)?;
            if !canonical.starts_with(root) {
                return Err(AppError::new(
                    "PATH_OUTSIDE_WORKSPACE",
                    "Private directory symlink escapes workspace",
                ));
            }
            if !canonical.is_dir() {
                return Err(AppError::new(
                    "NOT_DIRECTORY",
                    "Private store is not a directory",
                ));
            }
            current = canonical;
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(current)
}
pub fn read_bytes(root: &Path, path: &str, offset: u64, length: usize) -> AppResult<Vec<u8>> {
    if length > 1024 * 1024 {
        return Err(AppError::new("RANGE_TOO_LARGE", "Maximum range is 1 MiB"));
    }
    let mut file = File::open(resolve(root, path, false)?)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; length];
    let mut read = 0;
    while read < length {
        let n = file.read(&mut bytes[read..])?;
        if n == 0 {
            break;
        }
        read += n;
    }
    bytes.truncate(read);
    Ok(bytes)
}
fn str_arg<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args[key]
        .as_str()
        .ok_or_else(|| AppError::new("ARGUMENT_INVALID", format!("Missing string: {key}")))
}
fn transaction_id(args: &Value) -> String {
    args["transactionId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}
#[cfg(windows)]
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CompareStringEx(
            locale: *const u16,
            flags: u32,
            a: *const u16,
            a_len: i32,
            b: *const u16,
            b_len: i32,
            version: *const std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
            param: isize,
        ) -> i32;
    }
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let result = unsafe {
        CompareStringEx(
            std::ptr::null(),
            0x8 | 1,
            a.as_ptr(),
            a.len() as i32,
            b.as_ptr(),
            b.len() as i32,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        )
    };
    match result {
        1 => std::cmp::Ordering::Less,
        3 => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    }
}
#[cfg(not(windows))]
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (left.peek(), right.peek()) {
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut x = String::new();
                let mut y = String::new();
                while left.peek().is_some_and(char::is_ascii_digit) {
                    x.push(left.next().unwrap());
                }
                while right.peek().is_some_and(char::is_ascii_digit) {
                    y.push(right.next().unwrap());
                }
                let x = x.trim_start_matches('0');
                let y = y.trim_start_matches('0');
                let order = x.len().cmp(&y.len()).then_with(|| x.cmp(y));
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let order = left.next().cmp(&right.next());
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
            _ => return left.next().cmp(&right.next()),
        }
    }
}
pub fn is_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[255, 254]) || bytes.starts_with(&[254, 255]) {
        return false;
    }
    if bytes.contains(&0)
        || [
            b"%PDF-".as_slice(),
            b"\x89PNG\r\n\x1a\n",
            b"\xff\xd8\xff",
            b"PK\x03\x04",
            b"\x7fELF",
        ]
        .iter()
        .any(|magic| bytes.starts_with(magic))
    {
        return true;
    }
    let controls = bytes
        .iter()
        .filter(|byte| **byte < 32 && !matches!(**byte, 9 | 10 | 12 | 13))
        .count();
    controls > 0 && controls.saturating_mul(100) > bytes.len()
}
pub fn read_text(
    root: &Path,
    workspace_id: &str,
    path: &str,
    allow_large: bool,
) -> AppResult<Value> {
    let target = resolve(root, path, false)?;
    let metadata = fs::metadata(&target)?;
    if !metadata.is_file() {
        return Err(AppError::new("NOT_FILE", "Selection is not a regular file"));
    }
    let truncated = metadata.len() > 4 * 1024 * 1024 && !allow_large;
    let bytes = if truncated {
        let mut bytes = Vec::with_capacity(1024 * 1024);
        File::open(&target)?
            .take(1024 * 1024)
            .read_to_end(&mut bytes)?;
        if let Err(error) = std::str::from_utf8(&bytes)
            && error.error_len().is_none()
        {
            bytes.truncate(error.valid_up_to());
        }
        bytes
    } else {
        fs::read(&target)?
    };
    if is_binary(&bytes) {
        let mut error = AppError::new(
            "BINARY_FILE",
            "This file is binary; use metadata, preview, or export instead of the source editor.",
        );
        error.path = Some(path.into());
        return Err(error);
    }
    let raw_length = bytes.len();
    let content_revision = if truncated {
        revision(&target)?
    } else {
        Revision {
            sha256: hash(&bytes),
            byte_length: raw_length as u64,
            modified_ns: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_nanos().to_string())
                .unwrap_or_else(|| "0".into()),
        }
    };
    let bom = bytes.starts_with(&[239, 187, 191]);
    let mut bytes = bytes;
    if bom {
        drop(bytes.drain(..3));
    }
    let (text, unsupported) = match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
    };
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let newline = if text.matches('\r').count() > crlf {
        "mixed"
    } else if crlf == 0 {
        "lf"
    } else if crlf == lf {
        "crlf"
    } else {
        "mixed"
    };
    let mut value = json!({"file":{"workspaceId":workspace_id,"path":path},"revision":content_revision,"encoding":if unsupported{"unsupported"}else if bom{"utf8Bom"}else{"utf8"},"newline":newline,"readOnly":unsupported||(!allow_large&&(truncated||raw_length>4*1024*1024))});
    value["text"] = Value::String(text);
    if unsupported {
        value["warning"] = json!({"code":"ENCODING_UNSUPPORTED","message":"Legacy or invalid UTF-8 is read-only. Save an explicitly converted copy; the original bytes are unchanged."});
    } else if metadata.len() > 4 * 1024 * 1024 && !allow_large {
        value["warning"] = json!({"code":"LARGE_FILE","message":"This source is larger than 4 MiB. Explicit editing permission is required."});
    }
    if truncated {
        value["truncated"] = json!(true);
    }
    Ok(value)
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanState {
    #[serde(skip)]
    frontier: VecDeque<(String, usize)>,
    #[serde(default)]
    frontier_read: usize,
    marks: BTreeMap<String, String>,
    evidence: BTreeMap<String, Vec<String>>,
    scanned: usize,
    complete: bool,
    initialized: bool,
}
fn index_path(root: &Path, data_dir: &Path) -> AppResult<PathBuf> {
    let folder = data_dir
        .join("index")
        .join(hash(root.to_string_lossy().as_bytes()));
    fs::create_dir_all(&folder)?;
    Ok(folder.join("state.json"))
}
fn load_scan(root: &Path, data_dir: &Path) -> AppResult<ScanState> {
    let path = index_path(root, data_dir)?;
    let mut state = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<ScanState>(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScanState::default());
        }
        Err(error) => return Err(error.into()),
    };
    let frontier = path.with_file_name("frontier.jsonl");
    if frontier.exists() {
        for line in BufReader::new(File::open(frontier)?)
            .lines()
            .skip(state.frontier_read)
        {
            state.frontier.push_back(serde_json::from_str(&line?)?);
        }
    } else if !state.complete {
        state.frontier.push_back((String::new(), 0));
    }
    state.frontier_read = 0;
    Ok(state)
}
fn save_scan(root: &Path, data_dir: &Path, state: &ScanState) -> AppResult<()> {
    let path = index_path(root, data_dir)?;
    let mut lines = Vec::new();
    for entry in &state.frontier {
        serde_json::to_writer(&mut lines, entry)?;
        lines.push(b'\n');
    }
    transactions::atomic_write(&path.with_file_name("frontier.jsonl"), &lines)?;
    transactions::atomic_write(&path, &serde_json::to_vec(state)?)
}
pub(crate) fn reopen_scan(root: &Path, data_dir: &Path) -> AppResult<()> {
    let mut state = load_scan(root, data_dir)?;
    state.evidence.retain(|directory, files| {
        files.retain(|name| {
            let relative = if directory.is_empty() {
                name.clone()
            } else {
                format!("{directory}/{name}")
            };
            resolve(root, &relative, false).is_ok_and(|path| {
                fs::symlink_metadata(root.join(&relative)).is_ok_and(|metadata| metadata.is_file())
                    && path.is_file()
            })
        });
        !files.is_empty()
    });
    state.marks.clear();
    for (directory, evidence) in state.evidence.clone() {
        mark_positive(&mut state, &directory, evidence);
    }
    if !state
        .frontier
        .iter()
        .any(|(path, cursor)| path.is_empty() && *cursor == 0)
    {
        state.frontier.push_back((String::new(), 0));
    }
    state.initialized = true;
    state.complete = false;
    save_scan(root, data_dir, &state)
}
fn evidence_names(directory: &Path) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    for item in fs::read_dir(directory)? {
        let item = item?;
        if item.file_type()?.is_file()
            && Path::new(&item.file_name())
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| PAPER.contains(&s.to_ascii_lowercase().as_str()))
        {
            names.push(item.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    Ok(names)
}
fn mark_positive(state: &mut ScanState, path: &str, evidence: Vec<String>) {
    state.evidence.insert(path.into(), evidence);
    state.marks.insert(path.into(), "direct".into());
    let mut ancestor = path;
    while let Some((parent, _)) = ancestor.rsplit_once('/') {
        if state.marks.get(parent).is_none_or(|m| m != "direct") {
            state.marks.insert(parent.into(), "descendant".into());
        }
        ancestor = parent;
    }
    if !path.is_empty() && state.marks.get("").is_none_or(|m| m != "direct") {
        state.marks.insert(String::new(), "descendant".into());
    }
}
fn entry_for(
    root: &Path,
    parent: &str,
    item: &fs::DirEntry,
    state: &mut ScanState,
    explicit: bool,
) -> AppResult<Entry> {
    let name = item.file_name().to_string_lossy().into_owned();
    let path = if parent.is_empty() {
        name.clone()
    } else {
        format!("{parent}/{name}")
    };
    let kind = item.file_type()?;
    let mut paper = "none".to_owned();
    let mut evidence = Vec::new();
    if kind.is_dir() {
        paper = state
            .marks
            .get(&path)
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        evidence = state.evidence.get(&path).cloned().unwrap_or_default();
        if explicit && !EXCLUDED.contains(&name.as_str()) {
            let child = resolve(root, &path, false)?;
            evidence = evidence_names(&child)?;
            if !evidence.is_empty() {
                mark_positive(state, &path, evidence.clone());
                paper = "direct".into();
            } else if paper == "direct" {
                state.marks.remove(&path);
                state.evidence.remove(&path);
                paper = "unknown".into();
            }
        }
    }
    Ok(Entry {
        path,
        name,
        kind: if kind.is_symlink() {
            "symlink"
        } else if kind.is_dir() {
            "directory"
        } else {
            "file"
        }
        .into(),
        byte_length: if kind.is_file() {
            Some(item.metadata()?.len())
        } else {
            None
        },
        paper,
        main: false,
        evidence,
    })
}
fn list_dir(root: &Path, data_dir: &Path, args: &Value) -> AppResult<Value> {
    let path = args["path"].as_str().unwrap_or("");
    let directory = resolve(root, path, false)?;
    let mut state = load_scan(root, data_dir)?;
    if args["_agentPolicy"] == true {
        check_agent_path(root, &directory, false)?;
    }
    let show = args["showHidden"].as_bool().unwrap_or(false);
    let mut items = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    items.retain(|e| show || !e.file_name().to_string_lossy().starts_with('.'));
    if args["_agentPolicy"] == true {
        items.retain(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if path.is_empty() {
                name
            } else {
                format!("{path}/{name}")
            };
            !agent_read_denied(&relative)
                && resolve(root, &relative, false)
                    .is_ok_and(|target| check_agent_path(root, &target, false).is_ok())
        });
    }
    items.sort_by(|a, b| {
        let ad = a.file_type().is_ok_and(|t| t.is_dir());
        let bd = b.file_type().is_ok_and(|t| t.is_dir());
        bd.cmp(&ad).then_with(|| {
            compare_names(
                &a.file_name().to_string_lossy(),
                &b.file_name().to_string_lossy(),
            )
        })
    });
    let cursor = args["cursor"]
        .as_str()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| AppError::new("CURSOR_INVALID", "Invalid directory cursor"))?;
    let own_evidence = evidence_names(&resolve(root, path, false)?)?;
    if own_evidence.is_empty() {
        state.evidence.remove(path);
    } else {
        mark_positive(&mut state, path, own_evidence);
    }
    state
        .evidence
        .retain(|directory, _| root.join(directory).is_dir());
    state
        .marks
        .retain(|_, mark| mark != "direct" && mark != "descendant");
    for (directory, evidence) in state.evidence.clone() {
        mark_positive(&mut state, &directory, evidence);
    }
    let total = items.len();
    let mut entries = items
        .iter()
        .skip(cursor)
        .take(256)
        .map(|e| entry_for(root, path, e, &mut state, true))
        .collect::<AppResult<Vec<_>>>()?;
    let settings = project_read(root)?;
    if let Some(main) = settings["rootTex"].as_str() {
        for entry in &mut entries {
            entry.main = entry.path == main;
        }
    }
    save_scan(root, data_dir, &state)?;
    let cache =
        index_path(root, data_dir)?.with_file_name(format!("{}.json", hash(path.as_bytes())));
    let directory_metadata = fs::metadata(resolve(root, path, false)?)?;
    let modified = directory_metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos().to_string())
        .unwrap_or_else(|| "0".into());
    transactions::atomic_write(
        &cache,
        &serde_json::to_vec(
            &json!({"path":path,"cursor":cursor,"directoryRevision":modified,"entries":entries,"paper":state.marks.get(path)}),
        )?,
    )?;
    Ok(
        json!({"entries":entries,"nextCursor":if cursor+256<total{Some((cursor+256).to_string())}else{None}}),
    )
}
fn scan_step(root: &Path, data_dir: &Path, args: &Value) -> AppResult<Value> {
    let mut state = load_scan(root, data_dir)?;
    if args["restart"].as_bool() == Some(true) {
        state = ScanState::default();
    }
    if !state.initialized {
        state.frontier.push_back((String::new(), 0));
        state.initialized = true;
    }
    let budget = args["limit"].as_u64().unwrap_or(256).clamp(1, 256) as usize;
    let mut entries = Vec::new();
    let start = state.scanned;
    while entries.len() < budget && state.scanned - start < 20000 {
        let Some((path, cursor)) = state.frontier.pop_front() else {
            break;
        };
        let directory = match resolve(root, &path, false) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let iterator = match fs::read_dir(&directory) {
            Ok(i) => i,
            Err(_) => continue,
        };
        let mut consumed = cursor;
        let mut exhausted = true;
        for item in iterator.skip(cursor) {
            let item = item?;
            consumed += 1;
            state.scanned += 1;
            let name = item.file_name().to_string_lossy().into_owned();
            if EXCLUDED.contains(&name.as_str()) {
                continue;
            }
            let entry = entry_for(root, &path, &item, &mut state, false)?;
            if entry.kind == "directory" {
                state.frontier.push_back((entry.path.clone(), 0));
            }
            if entry.kind == "file"
                && Path::new(&entry.name)
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| PAPER.contains(&s.to_ascii_lowercase().as_str()))
            {
                let mut evidence = state.evidence.get(&path).cloned().unwrap_or_default();
                if !evidence.contains(&entry.name) {
                    evidence.push(entry.name.clone());
                }
                mark_positive(&mut state, &path, evidence);
            }
            entries.push(entry);
            if entries.len() >= budget || state.scanned - start >= 20000 {
                state.frontier.push_front((path.clone(), consumed));
                exhausted = false;
                break;
            }
        }
        if exhausted && !state.marks.contains_key(&path) {
            state.marks.insert(path, "none".into());
        }
    }
    state.complete = state.frontier.is_empty();
    save_scan(root, data_dir, &state)?;
    Ok(
        json!({"entries":entries,"complete":state.complete,"scanned":state.scanned-start,"totalScanned":state.scanned,"frontierCount":state.frontier.len()}),
    )
}
pub(crate) fn invalidate_paths(root: &Path, data_dir: &Path, paths: &[String]) -> AppResult<()> {
    let mut state = load_scan(root, data_dir)?;
    let parents = paths
        .iter()
        .map(|p| {
            p.rsplit_once('/')
                .map(|(parent, _)| parent.to_owned())
                .unwrap_or_default()
        })
        .collect::<std::collections::BTreeSet<_>>();
    state.evidence.retain(|path, _| {
        !parents.contains(path)
            && !paths
                .iter()
                .any(|changed| path == changed || path.starts_with(&format!("{changed}/")))
    });
    state.marks.retain(|path, mark| {
        mark != "direct"
            && mark != "descendant"
            && !parents.contains(path)
            && !paths
                .iter()
                .any(|changed| path == changed || path.starts_with(&format!("{changed}/")))
    });
    for (directory, evidence) in state.evidence.clone() {
        mark_positive(&mut state, &directory, evidence);
    }
    for parent in parents {
        if resolve(root, &parent, false).is_ok() {
            state.frontier.retain(|(path, _)| path != &parent);
            state.frontier.push_front((parent, 0));
        }
    }
    state.initialized = true;
    state.complete = false;
    save_scan(root, data_dir, &state)
}
#[derive(Serialize, Deserialize)]
struct SearchState {
    query: String,
    base: String,
    pending: VecDeque<(String, usize)>,
}
fn search(root: &Path, data_dir: &Path, args: &Value) -> AppResult<Value> {
    let query = str_arg(args, "query")?;
    if query.is_empty() || query.len() > 4096 {
        return Err(AppError::new(
            "SEARCH_INVALID",
            "Query must contain 1–4096 bytes",
        ));
    }
    let base = args["path"].as_str().unwrap_or("");
    resolve(root, base, false)?;
    let folder = data_dir
        .join("search")
        .join(hash(root.to_string_lossy().as_bytes()));
    fs::create_dir_all(&folder)?;
    let id = args["cursor"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(AppError::new("CURSOR_INVALID", "Invalid search cursor"));
    }
    let state_path = folder.join(format!("{id}.json"));
    let mut state = if args["cursor"].is_string() {
        serde_json::from_slice::<SearchState>(&fs::read(&state_path)?)?
    } else {
        SearchState {
            query: query.into(),
            base: base.into(),
            pending: VecDeque::from([(base.into(), 0)]),
        }
    };
    if state.query != query || state.base != base {
        return Err(AppError::new(
            "CURSOR_INVALID",
            "Search cursor belongs to a different query",
        ));
    }
    let mut matches = Vec::new();
    let mut rendered_bytes = 0usize;
    let mut scanned = 0usize;
    let started = std::time::Instant::now();
    while let Some((relative, skip)) = state.pending.pop_front() {
        if scanned >= 20000 || started.elapsed() > std::time::Duration::from_millis(500) {
            state.pending.push_front((relative, skip));
            break;
        }
        scanned += 1;
        let target = match resolve(root, &relative, false) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let lexical = root.join(&relative);
        let metadata = fs::symlink_metadata(&lexical)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if args["_agentPolicy"] == true
            && (agent_read_denied(&relative) || check_agent_path(root, &target, false).is_err())
        {
            continue;
        }
        if metadata.is_dir() {
            let mut children = fs::read_dir(target)?.collect::<Result<Vec<_>, _>>()?;
            children.sort_by_key(|e| e.file_name());
            for child in children {
                let name = child.file_name().to_string_lossy().into_owned();
                if EXCLUDED.contains(&name.as_str()) {
                    continue;
                }
                let path = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                state.pending.push_back((path, 0));
            }
            continue;
        }
        if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
            continue;
        }
        let reader = BufReader::new(File::open(target)?);
        let mut paused = false;
        for (index, line) in reader.lines().enumerate().skip(skip) {
            let text = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if text.len() <= 65536 && text.contains(query) {
                rendered_bytes += text.len();
                matches.push(json!({"path":relative,"line":index+1,"text":text}));
            }
            if matches.len() >= 200
                || rendered_bytes >= 65536
                || started.elapsed() > std::time::Duration::from_millis(500)
            {
                state.pending.push_front((relative.clone(), index + 1));
                paused = true;
                break;
            }
        }
        if paused {
            break;
        }
    }
    let more = !state.pending.is_empty();
    if more {
        transactions::atomic_write(&state_path, &serde_json::to_vec(&state)?)?;
    } else if state_path.exists() {
        fs::remove_file(state_path)?;
    }
    Ok(
        json!({"matches":matches,"nextCursor":if more{Some(id)}else{None},"incomplete":more,"scanned":scanned}),
    )
}
fn trash(root: &Path, args: &Value) -> AppResult<Value> {
    let path = str_arg(args, "path")?;
    if path.is_empty() || path == ".texypaper" || path.starts_with(".texypaper/") {
        return Err(AppError::new(
            "PATH_INVALID",
            "Cannot trash workspace/private root",
        ));
    }
    resolve(root, path, false)?;
    let target = root.join(path);
    let id = transaction_id(args);
    if id.is_empty()
        || id.len() > 100
        || id
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_')
    {
        return Err(AppError::new(
            "TRANSACTION_ID_INVALID",
            "Invalid trash identifier",
        ));
    }
    let store = ensure_private_dir(root, &format!(".texypaper/trash/{id}"))?;
    if store.join("metadata.json").exists() {
        return Err(AppError::new(
            "TRANSACTION_EXISTS",
            "Trash operation already exists",
        ));
    }
    transactions::atomic_write(
        &store.join("metadata.json"),
        &serde_json::to_vec(&json!({"path":path,"status":"prepared"}))?,
    )?;
    fs::rename(target, store.join("content"))?;
    transactions::atomic_write(
        &store.join("metadata.json"),
        &serde_json::to_vec(&json!({"path":path,"status":"trashed"}))?,
    )?;
    Ok(json!({"path":path,"transactionId":id,"status":"trashed"}))
}
fn restore(root: &Path, args: &Value) -> AppResult<Value> {
    let id = str_arg(args, "transactionId")?;
    validate_relative(id)?;
    if id.contains('/') {
        return Err(AppError::new(
            "TRANSACTION_ID_INVALID",
            "Invalid trash identifier",
        ));
    }
    let store = resolve(root, &format!(".texypaper/trash/{id}"), false)?;
    let metadata: Value = serde_json::from_slice(&fs::read(store.join("metadata.json"))?)?;
    let path = str_arg(&metadata, "path")?;
    let target = resolve(root, path, true)?;
    if target.exists() {
        return Err(AppError::new("FILE_CONFLICT", "Restore destination exists"));
    }
    fs::rename(store.join("content"), target)?;
    transactions::atomic_write(
        &store.join("metadata.json"),
        &serde_json::to_vec(&json!({"path":path,"status":"restored"}))?,
    )?;
    Ok(json!({"path":path,"transactionId":id,"status":"restored"}))
}
fn project_read(root: &Path) -> AppResult<Value> {
    let path = root.join(".texypaper/project.json");
    if !path.exists() {
        return Ok(
            json!({"version":1,"rootTex":null,"engine":"pdflatex","profile":"basic","autoBuild":true}),
        );
    }
    Ok(serde_json::from_slice(&fs::read(resolve(
        root,
        ".texypaper/project.json",
        false,
    )?)?)?)
}
fn project_update(root: &Path, args: &Value) -> AppResult<Value> {
    let settings = args.get("settings").unwrap_or(args);
    if settings["version"] != 1
        || !matches!(
            settings["engine"].as_str(),
            Some("pdflatex" | "xelatex" | "lualatex")
        )
        || !matches!(settings["profile"].as_str(), Some("basic" | "project"))
        || !settings["autoBuild"].is_boolean()
    {
        return Err(AppError::new(
            "PROJECT_SETTINGS_INVALID",
            "Invalid project settings",
        ));
    }
    if let Some(path) = settings["rootTex"].as_str() {
        resolve(root, path, false)?;
    }
    let clean = json!({"version":1,"rootTex":settings["rootTex"],"engine":settings["engine"],"profile":settings["profile"],"autoBuild":settings["autoBuild"]});
    ensure_private_dir(root, ".texypaper")?;
    let path = resolve(root, ".texypaper/project.json", true)?;
    transactions::atomic_write(&path, &serde_json::to_vec_pretty(&clean)?)?;
    Ok(clean)
}
pub fn execute(
    root: &Path,
    workspace_id: &str,
    data_dir: &Path,
    op: &str,
    args: Value,
) -> AppResult<Value> {
    crate::migration::migrate_project(root)?;
    match op {
        "list_dir" => list_dir(root, data_dir, &args),
        "read_text" => {
            let path = str_arg(&args, "path")?;
            if args["_agentPolicy"] == true {
                if agent_read_denied(path) {
                    return Err(AppError::new(
                        "AGENT_READ_DENIED",
                        "Credential path is denied",
                    ));
                }
                check_agent_path(root, &resolve(root, path, false)?, false)?;
            }
            read_text(
                root,
                workspace_id,
                path,
                args["allowLarge"].as_bool().unwrap_or(false),
            )
        }
        "canonical_path" => {
            let target = resolve(root, str_arg(&args, "path")?, args["allowNew"] == true)?;
            let path = target
                .strip_prefix(root)
                .map_err(|_| AppError::new("PATH_OUTSIDE_WORKSPACE", "Outside root"))?
                .to_string_lossy()
                .replace('\\', "/");
            Ok(json!({"path":path}))
        }
        "stat_many" => {
            let paths = args["paths"]
                .as_array()
                .ok_or_else(|| AppError::new("ARGUMENT_INVALID", "paths required"))?;
            if paths.len() > 256 {
                return Err(AppError::new("REQUEST_LIMIT", "At most 256 stats"));
            }
            let rows=paths.iter().map(|p|{
                let name=p.as_str().unwrap_or("");
                let result=(||->AppResult<Value>{
                    let target=resolve(root,name,false)?;let metadata=fs::symlink_metadata(root.join(name))?;
                    let kind=if metadata.file_type().is_symlink(){"symlink"}else if metadata.is_dir(){"directory"}else{"file"};
                    let modified=metadata.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_nanos().to_string()).unwrap_or_else(||"0".into());
                    let revision=if metadata.is_file(){serde_json::to_value(revision(&target)?)?}else{Value::Null};
                    Ok(json!({"path":name,"kind":kind,"byteLength":metadata.len(),"modifiedNs":modified,"revision":revision}))
                })();
                result.unwrap_or_else(|error|json!({"path":name,"error":error}))
            }).collect::<Vec<_>>();
            Ok(json!({"entries":rows}))
        }
        "save_text" => transactions::save_text(
            root,
            str_arg(&args, "path")?,
            str_arg(&args, "expectedSha256")?,
            str_arg(&args, "text")?,
            &transaction_id(&args),
        ),
        "apply_proposal" => {
            let changes = serde_json::from_value::<Vec<Change>>(args["files"].clone())?;
            if args["_agentPolicy"] == true {
                transactions::apply_agent_proposal(root, &transaction_id(&args), changes)
            } else {
                transactions::apply_proposal(root, &transaction_id(&args), changes)
            }
        }
        "undo_transaction" => {
            transactions::undo_transaction(root, str_arg(&args, "transactionId")?)
        }
        "transaction_status" => transactions::status(root, str_arg(&args, "transactionId")?),
        "create" => {
            let path = str_arg(&args, "path")?;
            let target = resolve(root, path, true)?;
            if target.exists() {
                return Err(AppError::new("FILE_CONFLICT", "Destination exists"));
            }
            let result = if args["kind"] == "directory" {
                fs::create_dir(target)?;
                json!({"path":path,"kind":"directory"})
            } else {
                transactions::apply_proposal(
                    root,
                    &transaction_id(&args),
                    vec![Change {
                        path: path.into(),
                        base_sha256: None,
                        content: args["content"]
                            .as_str()
                            .or_else(|| args["text"].as_str())
                            .unwrap_or("")
                            .into(),
                        action: "create".into(),
                    }],
                )?
            };
            invalidate_paths(root, data_dir, &[path.into()])?;
            Ok(result)
        }
        "rename" => {
            let path = str_arg(&args, "path")?;
            let to = args["newPath"]
                .as_str()
                .or_else(|| args["to"].as_str())
                .ok_or_else(|| AppError::new("ARGUMENT_INVALID", "newPath required"))?;
            if path.is_empty()
                || to.is_empty()
                || path == ".texypaper"
                || path.starts_with(".texypaper/")
                || to == ".texypaper"
                || to.starts_with(".texypaper/")
            {
                return Err(AppError::new(
                    "PATH_INVALID",
                    "Cannot rename private/root paths",
                ));
            }
            resolve(root, path, false)?;
            let dest = resolve(root, to, true)?;
            if dest.exists() {
                return Err(AppError::new("FILE_CONFLICT", "Rename destination exists"));
            }
            fs::rename(root.join(path), dest)?;
            invalidate_paths(root, data_dir, &[path.into(), to.into()])?;
            crate::comments::rename_source(root, path, to)?;
            Ok(json!({"path":path,"newPath":to}))
        }
        "trash" => {
            let result = trash(root, &args)?;
            invalidate_paths(root, data_dir, &[str_arg(&args, "path")?.into()])?;
            Ok(result)
        }
        "restore" => {
            let result = restore(root, &args)?;
            invalidate_paths(root, data_dir, &[str_arg(&result, "path")?.into()])?;
            Ok(result)
        }
        "scan_step" => scan_step(root, data_dir, &args),
        "search_text" => search(root, data_dir, &args),
        "comments_read" => crate::comments::read(root),
        "comments_update" => crate::comments::update(root, &args),
        "project_read" => project_read(root),
        "project_update" => project_update(root, &args),
        "build_start" | "build_cancel" | "synctex_view" | "synctex_edit" | "artifact_manifest"
        | "build_status" => crate::latex::local_execute(root, op, args),
        "ping" => Ok(json!({"ok":true})),
        _ => Err(AppError::new(
            "OPERATION_UNKNOWN",
            format!("Unsupported workspace operation: {op}"),
        )),
    }
}
