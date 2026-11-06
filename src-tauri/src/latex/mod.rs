pub mod artifacts;
pub mod diagnostics;
pub mod prose_map;
pub mod scheduler;
pub mod synctex;
pub mod synctex_parser;
use crate::{
    contracts::{AppError, AppResult},
    workspace::Workspace,
};
use artifacts::{BuildManifest, hash_file};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};
#[derive(Clone)]
struct Reference {
    workspace: String,
    epoch: u64,
    path: String,
    length: u64,
    hash: String,
}
static REFERENCES: LazyLock<Mutex<HashMap<String, Reference>>> = LazyLock::new(Default::default);
pub fn local_execute(root: &Path, op: &str, args: Value) -> AppResult<Value> {
    match op {
        "build_start" => scheduler::start(root, args),
        "build_cancel" => Ok(scheduler::cancel(root)),
        "build_status" => Ok(scheduler::status(root)),
        "artifact_manifest" => Ok(serde_json::to_value(artifacts::manifest(
            root,
            args["buildId"].as_str().unwrap_or_default(),
        )?)?),
        "synctex_view" => synctex::local(root, &args, true),
        "synctex_edit" => synctex::local(root, &args, false),
        _ => Err(AppError::new(
            "OP_UNSUPPORTED",
            format!("지원되지 않는 LaTeX 작업: {op}"),
        )),
    }
}
pub fn get_manifest(workspace: &Workspace, id: &str) -> AppResult<BuildManifest> {
    let mut manifest = if let Some(root) = workspace.local_root() {
        artifacts::manifest(&root, id)?
    } else {
        serde_json::from_value(workspace.execute("artifact_manifest", json!({"buildId":id}))?)?
    };
    let valid_hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if manifest.version != 1
        || manifest.build_id != id
        || !valid_hash(&manifest.pdf_sha256)
        || !valid_hash(&manifest.sync_sha256)
        || manifest.sources.len() > 20000
    {
        return Err(AppError::new(
            "MANIFEST_INVALID",
            "원격 게시 기록이 유효하지 않습니다",
        ));
    }
    manifest.workspace_id = workspace.reference.id.clone();
    Ok(manifest)
}
pub fn sync(workspace: &Workspace, args: Value, forward: bool) -> AppResult<Value> {
    let build_id = args["buildId"].as_str().unwrap_or_default().to_string();
    // The manifest is needed locally for fallback validation and for inverse results, which must be
    // reported as project-relative paths of this build instead of host-specific TeX input strings.
    let manifest = if workspace.local_root().is_some() || !forward {
        Some(get_manifest(workspace, &build_id)?)
    } else {
        None
    };
    if let Some(manifest) = &manifest
        && workspace.local_root().is_some()
    {
        synctex::restore_validation(workspace, manifest);
    }
    let response = workspace.execute(
        if forward {
            "synctex_view"
        } else {
            "synctex_edit"
        },
        args,
    )?;
    let mut result = if let Some(output) = response["output"].as_str() {
        synctex::parse_output(output)?
    } else {
        response
    };
    result["buildId"] = json!(build_id);
    if !forward
        && let Some(manifest) = &manifest
        && let Some(records) = result["records"].as_array_mut()
    {
        for record in records.iter_mut() {
            let relative = record["input"]
                .as_str()
                .and_then(|input| prose_map::host_relative(manifest, input, workspace).ok())
                .filter(|path| manifest.sources.iter().any(|source| &source.path == path));
            if let Some(relative) = relative {
                record["path"] = json!(relative);
            }
        }
    }
    Ok(result)
}
fn descriptor(workspace: &Workspace, id: &str) -> AppResult<(String, u64, String)> {
    if let Some(reference) = REFERENCES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
    {
        if reference.workspace != workspace.reference.id
            || reference.epoch != workspace.reference.epoch
        {
            return Err(AppError::new(
                "ARTIFACT_UNAUTHORIZED",
                "다른 작업 공간의 PDF입니다",
            ));
        }
        return Ok((reference.path, reference.length, reference.hash));
    }
    let manifest = get_manifest(workspace, id)?;
    Ok((manifest.pdf_path, manifest.pdf_length, manifest.pdf_sha256))
}
#[derive(Clone)]
struct CachedArtifact {
    path: PathBuf,
    relative_path: String,
    length: u64,
    hash: String,
    modified: std::time::SystemTime,
}
type ArtifactCache = HashMap<(String, u64, String), CachedArtifact>;
static CACHE: LazyLock<Mutex<ArtifactCache>> = LazyLock::new(Default::default);
fn disk_artifact(workspace: &Workspace, id: &str) -> AppResult<CachedArtifact> {
    let key = (
        workspace.reference.id.clone(),
        workspace.reference.epoch,
        id.to_string(),
    );
    if let Some(cached) = CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .cloned()
    {
        let path = if let Some(root) = workspace.local_root() {
            artifacts::checked(&root, &cached.relative_path)?
        } else {
            cached.path.clone()
        };
        let metadata = fs::metadata(&path)?;
        if metadata.len() != cached.length || metadata.modified()? != cached.modified {
            return Err(AppError::new(
                "ARTIFACT_CHANGED",
                "승인된 PDF 파일이 변경되었습니다",
            ));
        }
        return Ok(cached);
    }
    let (path, length, hash) = descriptor(workspace, id)?;
    let target = if let Some(root) = workspace.local_root() {
        let p = artifacts::checked(&root, &path)?;
        if fs::metadata(&p)?.len() != length || hash_file(&p)? != hash {
            return Err(AppError::new("ARTIFACT_CHANGED", "PDF가 변경되었습니다"));
        }
        p
    } else {
        let cache = workspace
            .data_dir()
            .join("artifact-cache")
            .join(artifacts::hash_bytes(workspace.reference.id.as_bytes()));
        fs::create_dir_all(&cache)?;
        let target = cache.join(format!("{hash}.pdf"));
        if !target.is_file()
            || fs::metadata(&target)?.len() != length
            || hash_file(&target)? != hash
        {
            let tmp = cache.join(format!("{}.part", uuid::Uuid::new_v4()));
            let transfer = (|| -> AppResult<()> {
                let mut output = fs::File::create(&tmp)?;
                let mut offset = 0;
                while offset < length {
                    let bytes = workspace.read_bytes(
                        &path,
                        offset,
                        (length - offset).min(65536) as usize,
                    )?;
                    if bytes.is_empty() || bytes.len() as u64 > length - offset {
                        return Err(AppError::new(
                            "ARTIFACT_TRUNCATED",
                            "원격 PDF 전송이 중단되었습니다",
                        ));
                    }
                    output.write_all(&bytes)?;
                    offset += bytes.len() as u64;
                }
                output.sync_all()?;
                drop(output);
                if hash_file(&tmp)? != hash {
                    return Err(AppError::new(
                        "ARTIFACT_CHANGED",
                        "원격 PDF 해시가 일치하지 않습니다",
                    ));
                }
                if target.exists() {
                    fs::remove_file(&target)?;
                }
                fs::rename(&tmp, &target)?;
                Ok(())
            })();
            if transfer.is_err() {
                let _ = fs::remove_file(&tmp);
            }
            transfer?;
        }
        let mut retained = fs::read_dir(&cache)?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|s| s == "pdf"))
            .collect::<Vec<_>>();
        retained.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
        for old in retained.into_iter().skip(2) {
            if old.path() != target {
                let _ = fs::remove_file(old.path());
            }
        }
        target
    };
    let cached = CachedArtifact {
        modified: fs::metadata(&target)?.modified()?,
        path: target,
        relative_path: path,
        length,
        hash,
    };
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|(wid, epoch, _), _| {
        wid == &workspace.reference.id && epoch == &workspace.reference.epoch
    });
    if cache.len() >= 3 {
        cache.clear()
    }
    cache.insert(key, cached.clone());
    Ok(cached)
}
pub fn artifact_range(
    workspace: &Workspace,
    build_id: &str,
    begin: u64,
    end: u64,
) -> AppResult<Vec<u8>> {
    let artifact = disk_artifact(workspace, build_id)?;
    if begin >= end || end > artifact.length || end - begin > 1024 * 1024 {
        return Err(AppError::new(
            "RANGE_NOT_SATISFIABLE",
            "범위는 PDF 크기 안의 최대 1 MiB여야 합니다",
        ));
    }
    let mut f = fs::File::open(artifact.path)?;
    f.seek(SeekFrom::Start(begin))?;
    let mut bytes = vec![0; (end - begin) as usize];
    f.read_exact(&mut bytes)?;
    Ok(bytes)
}
pub fn execute(workspace: &Workspace, op: &str, mut args: Value) -> AppResult<Value> {
    match op {
        "build_start" => {
            let settings = workspace.execute("project_read", json!({}))?;
            for key in ["rootTex", "engine", "profile", "autoBuild"] {
                if args.get(key).is_none_or(Value::is_null) {
                    args[key] = settings[key].clone();
                }
            }
            args["workspaceId"] = json!(workspace.reference.id);
            args["epoch"] = json!(workspace.reference.epoch);
            workspace.execute("build_start", args)
        }
        "build_cancel" => workspace.execute(op, args),
        "build_status" => {
            let mut result = workspace.execute(op, args)?;
            if result["manifest"].is_object() {
                result["manifest"]["workspaceId"] = json!(workspace.reference.id);
            }
            Ok(result)
        }
        "sync_forward" => sync(workspace, args, true),
        "sync_inverse" => sync(workspace, args, false),
        "sync_validate_fallback" => synctex::validate_pair(workspace, args),
        "pdf_map_selection" => match prose_map::map_selection(workspace, args) {
            Ok(value) => Ok(value),
            Err(error) => {
                Ok(json!({"kind":"unavailable","code":error.code,"reason":error.message}))
            }
        },
        "pdf_apply_edit" => prose_map::apply_proven_edit(workspace, args),
        "artifact_metadata" => {
            let id = if let Some(path) = args["path"].as_str() {
                if !path.to_ascii_lowercase().ends_with(".pdf") {
                    return Err(AppError::new("PDF_REQUIRED", "PDF 파일을 선택하세요"));
                }
                let prefix = workspace.read_bytes(path, 0, 1024)?;
                if !prefix.windows(5).any(|bytes| bytes == b"%PDF-") {
                    return Err(AppError::new("PDF_INVALID", "PDF 헤더가 없습니다"));
                }
                let doc = workspace.execute("stat_many", json!({"paths":[path]}))?;
                let length = doc["entries"][0]["byteLength"]
                    .as_u64()
                    .or(doc["rows"][0]["byteLength"].as_u64())
                    .or(doc[0]["byteLength"].as_u64())
                    .ok_or_else(|| {
                        AppError::new("PDF_STAT_FAILED", "PDF 크기를 읽을 수 없습니다")
                    })?;
                let id = uuid::Uuid::new_v4().to_string();
                use sha2::Digest;
                let mut hash = sha2::Sha256::new();
                let mut offset = 0;
                while offset < length {
                    let bytes = workspace.read_bytes(
                        path,
                        offset,
                        (length - offset).min(65536) as usize,
                    )?;
                    if bytes.is_empty() {
                        return Err(AppError::new(
                            "ARTIFACT_CHANGED",
                            "PDF를 읽는 동안 변경되었습니다",
                        ));
                    }
                    offset += bytes.len() as u64;
                    hash.update(&bytes);
                }
                let reference = Reference {
                    workspace: workspace.reference.id.clone(),
                    epoch: workspace.reference.epoch,
                    path: path.into(),
                    length,
                    hash: format!("{:x}", hash.finalize()),
                };
                let mut references = REFERENCES.lock().unwrap_or_else(|e| e.into_inner());
                references.clear();
                references.insert(id.clone(), reference);
                id
            } else {
                args["buildId"]
                    .as_str()
                    .ok_or_else(|| AppError::new("BUILD_UNKNOWN", "빌드 ID 없음"))?
                    .to_string()
            };
            let artifact = disk_artifact(workspace, &id)?;
            Ok(json!({"length":artifact.length,"sha256":artifact.hash,"buildId":id}))
        }
        "export_pdf" => {
            let id = args["buildId"]
                .as_str()
                .ok_or_else(|| AppError::new("BUILD_UNKNOWN", "빌드 ID 없음"))?;
            let destination = args["_destination"].as_str().ok_or_else(|| {
                AppError::new("EXPORT_DESTINATION_REQUIRED", "PDF 저장 위치를 선택하세요")
            })?;
            let source = disk_artifact(workspace, id)?.path;
            if Path::new(destination)
                .canonicalize()
                .is_ok_and(|p| p == source)
            {
                return Err(AppError::new(
                    "EXPORT_SAME_FILE",
                    "원본과 다른 내보내기 위치를 선택하세요",
                ));
            }
            let mut input = fs::File::open(source)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(destination)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            Ok(json!({"status":"exported","path":destination}))
        }
        _ => Err(AppError::new(
            "OP_UNSUPPORTED",
            format!("지원되지 않는 PDF 작업: {op}"),
        )),
    }
}
