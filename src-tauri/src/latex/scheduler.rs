use super::{artifacts::*, diagnostics};
use crate::{
    contracts::{AppError, AppResult},
    process::OwnedChild,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Default)]
struct Job {
    running: bool,
    pending: Option<Value>,
    cancel: Arc<AtomicBool>,
    status: Value,
}
static JOBS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<Job>>>>> = LazyLock::new(Default::default);
fn jobs() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<Job>>>> {
    &JOBS
}
fn job(root: &Path) -> Arc<Mutex<Job>> {
    jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(root.to_path_buf())
        .or_default()
        .clone()
}
pub fn status(root: &Path) -> Value {
    let current = job(root)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .clone();
    let mut latest = fs::read(root.join(".texypaper/build/latest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({"status":"idle","diagnostics":[],"logTail":""}));
    if current.is_object() && current["status"] != "published" {
        let previous = latest["manifest"].clone();
        latest = current;
        if !previous.is_null() {
            latest["manifest"] = previous;
        }
    }
    if let Ok(manifest) = serde_json::from_value::<BuildManifest>(latest["manifest"].clone()) {
        let stale = !revisions_match(root, &manifest.sources);
        latest["stale"] = json!(stale);
        if stale {
            latest["manifest"]["mappingReady"] = json!(false);
            latest["manifest"]["mappingReason"] = json!("현재 원문과 게시된 PDF가 다릅니다");
        }
    }
    latest
}
pub fn cancel(root: &Path) -> Value {
    let j = job(root);
    let mut j = j.lock().unwrap_or_else(|e| e.into_inner());
    j.cancel.store(true, Ordering::SeqCst);
    j.pending = None;
    json!({"status":"cancelling"})
}
pub fn start(root: &Path, args: Value) -> AppResult<Value> {
    let handle = job(root);
    {
        let mut j = handle.lock().unwrap_or_else(|e| e.into_inner());
        if j.running {
            j.pending = Some(args);
            return Ok(json!({"status":"queued"}));
        }
        j.running = true;
        j.cancel = Arc::new(AtomicBool::new(false));
        j.status = json!({"status":"building"});
    }
    let mut request = args;
    loop {
        let cancel = {
            handle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cancel
                .clone()
        };
        let result = build(root, &request, &cancel).and_then(|value| {
            if value["status"] == "published" {
                crate::workspace::transactions::atomic_write(
                    &root.join(".texypaper/build/latest.json"),
                    &serde_json::to_vec(&value)?,
                )?;
            }
            Ok(value)
        });
        let mut j = handle.lock().unwrap_or_else(|e| e.into_inner());
        match &result {
            Ok(v) => j.status = v.clone(),
            Err(e) => j.status = json!({"status":"failed","error":e}),
        }
        if let Some(next) = j.pending.take() {
            request = next;
            j.cancel = Arc::new(AtomicBool::new(false));
            continue;
        }
        j.running = false;
        return result;
    }
}
fn drain<R: Read + Send + 'static>(
    mut input: R,
    tail: Arc<Mutex<Vec<u8>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(n) = input.read(&mut buffer) {
            if n == 0 {
                break;
            }
            let mut data = tail.lock().unwrap_or_else(|e| e.into_inner());
            if data.len() + n > 256 * 1024 {
                let cut = (data.len() + n - 256 * 1024).min(data.len());
                data.drain(..cut);
            }
            data.extend_from_slice(&buffer[..n]);
        }
    })
}
fn run(command: &mut Command, cancel: &AtomicBool, timeout: Duration) -> AppResult<(bool, String)> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let mut child = OwnedChild::spawn(command).map_err(|e| {
        AppError::new(
            "TEX_TOOL_MISSING",
            format!("latexmk를 실행할 수 없습니다: {}", e.message),
        )
    })?;
    let tail = Arc::new(Mutex::new(Vec::new()));
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| AppError::new("BUILD_IO", "출력 파이프 없음"))?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| AppError::new("BUILD_IO", "오류 파이프 없음"))?;
    let a = drain(stdout, tail.clone());
    let b = drain(stderr, tail.clone());
    let start = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst) {
            child.cancel()?;
            let _ = child.wait();
            break Err(AppError::new("BUILD_CANCELLED", "빌드가 취소되었습니다"));
        }
        if start.elapsed() > timeout {
            child.cancel()?;
            let _ = child.wait();
            break Err(AppError::new(
                "BUILD_TIMEOUT",
                "빌드 제한 시간을 초과했습니다",
            ));
        }
        if let Some(status) = child.try_wait()? {
            break Ok(status.success());
        }
        thread::sleep(Duration::from_millis(40));
    };
    let _ = a.join();
    let _ = b.join();
    let bytes = tail.lock().unwrap_or_else(|e| e.into_inner());
    let log = String::from_utf8_lossy(&bytes).into_owned();
    result.map(|ok| (ok, log))
}
fn find_artifacts(work: &Path) -> AppResult<(PathBuf, PathBuf, PathBuf)> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(work)? {
        let p = entry?.path();
        if p.extension().is_some_and(|e| e == "pdf") {
            let sync = if p.with_extension("synctex.gz").is_file() {
                p.with_extension("synctex.gz")
            } else {
                p.with_extension("synctex")
            };
            let fls = p.with_extension("fls");
            if sync.is_file() && fls.is_file() {
                let modified = fs::metadata(&fls)?.modified()?;
                candidates.push((modified, p, sync, fls));
            }
        }
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    if candidates.is_empty() || candidates.len() > 1 && candidates[0].0 == candidates[1].0 {
        return Err(AppError::new(
            "BUILD_ARTIFACT_AMBIGUOUS",
            "최종 PDF/SyncTeX/FLS 작업을 식별할 수 없습니다",
        ));
    }
    let (_, pdf, sync, fls) = candidates.remove(0);
    Ok((pdf, sync, fls))
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
fn build(root: &Path, args: &Value, cancel: &AtomicBool) -> AppResult<Value> {
    use notify::Watcher;
    let root = root.canonicalize()?;
    let root_tex = args["rootTex"]
        .as_str()
        .ok_or_else(|| AppError::new("ROOT_REQUIRED", "루트 TeX 파일을 선택하세요"))?;
    let source = checked(&root, root_tex)?;
    if !source.extension().is_some_and(|s| s == "tex" || s == "ltx") {
        return Err(AppError::new("ROOT_INVALID", "TeX 문서를 선택하세요"));
    }
    let cwd = source
        .parent()
        .ok_or_else(|| AppError::new("ROOT_INVALID", "부모 폴더 없음"))?;
    let engine = args["engine"].as_str().unwrap_or("pdflatex");
    if !matches!(engine, "pdflatex" | "xelatex" | "lualatex") {
        return Err(AppError::new("ENGINE_INVALID", "지원되지 않는 TeX 엔진"));
    }
    let project = args["profile"].as_str() == Some("project");
    if project && args["_projectTrusted"].as_bool() != Some(true) {
        return Err(AppError::new(
            "PROJECT_TRUST_REQUIRED",
            "프로젝트 latexmk 설정은 명령을 실행할 수 있습니다. 이 환경의 프로젝트를 명시적으로 신뢰하세요",
        ));
    }
    let root_id = hash_bytes(root_tex.as_bytes())[..24].to_string();
    let private = |suffix: &str| {
        crate::workspace::local::ensure_private_dir(
            &root,
            &format!(".texypaper/build/{root_id}/{suffix}"),
        )
    };
    let work = private("work")?;
    let base = work
        .parent()
        .ok_or_else(|| AppError::new("BUILD_IO", "출력 부모 폴더 없음"))?
        .to_path_buf();
    let id = uuid::Uuid::new_v4().to_string();
    let stage = private(&format!("staging/{id}"))?;
    let _stage_cleanup = Staging(stage.clone());
    let published_parent = private("published")?;
    let started = now();
    let deadline = Instant::now()
        + Duration::from_secs(
            args["timeoutSeconds"]
                .as_u64()
                .unwrap_or(120)
                .clamp(1, 3600),
        );
    let changed = Arc::new(AtomicBool::new(false));
    let watch_changed = changed.clone();
    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event
            && !matches!(event.kind, notify::EventKind::Access(_))
            && event.paths.iter().any(|p| {
                p.starts_with(&watch_root)
                    && !p.starts_with(watch_root.join(".texypaper"))
                    && !p.starts_with(watch_root.join(".paperdock")) // Legacy metadata is never a source change.
            })
        {
            watch_changed.store(true, Ordering::SeqCst);
        }
    })
    .map_err(|e| AppError::new("WATCH_UNAVAILABLE", e.to_string()))?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| AppError::new("WATCH_UNAVAILABLE", e.to_string()))?;
    let mut known = vec![root_tex.to_string()];
    if let Ok(data) = fs::read(base.join("dependencies.json"))
        && let Ok(paths) = serde_json::from_slice::<Vec<String>>(&data)
    {
        known.extend(paths)
    }
    known.sort();
    known.dedup();
    let mut tail = String::new();
    let mut ready = false;
    let mut final_sources = Vec::new();
    let mut outputs = None;
    let mut final_attempt = 0;
    for attempt in 0..3 {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::new("BUILD_CANCELLED", "빌드가 취소되었습니다"));
        }
        changed.store(false, Ordering::SeqCst);
        let before = known
            .iter()
            .map(|p| {
                (
                    p.clone(),
                    checked(&root, p)
                        .and_then(|p| Ok(fs::metadata(p)?.modified()?))
                        .ok(),
                )
            })
            .collect::<HashMap<_, _>>();
        let snapshots = stage.join(format!("sources-{attempt}"));
        let sources = snapshot(&root, &known, &snapshots)?;
        let proven = fs::read(root.join(".texypaper/build/latest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|v| serde_json::from_value::<BuildManifest>(v["manifest"].clone()).ok());
        let force = proven.as_ref().is_none_or(|m| {
            let previous = m
                .sources
                .iter()
                .map(|s| (s.path.as_str(), s.sha256.as_str()))
                .collect::<HashMap<_, _>>();
            !m.mapping_ready
                || m.root_tex != root_tex
                || m.engine != engine
                || previous.len() != sources.len()
                || sources
                    .iter()
                    .any(|s| previous.get(s.path.as_str()).is_none_or(|h| *h != s.sha256))
        });
        let mut command = Command::new("latexmk");
        command.current_dir(tool_path(cwd)?);
        if !project {
            command.arg("-norc");
        }
        match engine {
            "pdflatex" => {
                command.arg("-pdf");
                if !project {
                    command.arg("-pdflatex=pdflatex -no-shell-escape %O %S");
                }
            }
            "xelatex" => {
                command.arg("-pdfxe");
                if !project {
                    command.arg("-xelatex=xelatex -no-shell-escape %O %S");
                }
            }
            _ => {
                command.arg("-pdflua");
                if !project {
                    command.arg("-lualatex=lualatex -no-shell-escape %O %S");
                }
            }
        }
        command.args([
            "-synctex=1",
            "-interaction=nonstopmode",
            "-file-line-error",
            "-recorder",
        ]);
        if attempt > 0 || force {
            command.arg("-g");
        }
        command
            .arg(format!("-outdir={}", tool_path(&work)?))
            .arg(format!(
                "./{}",
                source
                    .file_name()
                    .ok_or_else(|| AppError::new("ROOT_INVALID", "파일명 없음"))?
                    .to_string_lossy()
            ));
        let timeout = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| AppError::new("BUILD_TIMEOUT", "빌드 제한 시간을 초과했습니다"))?;
        let (ok, log) = run(&mut command, cancel, timeout)?;
        tail = log;
        if !ok {
            return Ok(
                json!({"status":"failed","diagnostics":diagnostics::parse(&tail),"logTail":tail,"error":{"code":"BUILD_FAILED","message":"LaTeX 빌드가 실패했습니다. 이전 PDF를 유지합니다","retryable":true}}),
            );
        }
        let (pdf, sync, fls) = find_artifacts(&work)?;
        let discovered = discover_inputs(&root, cwd, &fls)?;
        let recorded = sources
            .iter()
            .map(|s| s.path.as_str())
            .collect::<std::collections::HashSet<_>>();
        let complete = discovered.iter().all(|p| recorded.contains(p.as_str()));
        let stable = revisions_match(&root, &sources)
            && !changed.load(Ordering::SeqCst)
            && before.iter().all(|(p, time)| {
                checked(&root, p)
                    .and_then(|p| Ok(fs::metadata(p)?.modified()?))
                    .ok()
                    == *time
            });
        final_sources = sources;
        outputs = Some((pdf, sync, fls));
        final_attempt = attempt;
        if complete && stable {
            ready = true;
            break;
        }
        known.extend(discovered);
        known.sort();
        known.dedup();
    }
    let (pdf, sync, fls) =
        outputs.ok_or_else(|| AppError::new("BUILD_ARTIFACT_MISSING", "빌드 산출물 없음"))?;
    if ready
        && let Ok(bytes) = fs::read(root.join(".texypaper/build/latest.json"))
        && let Ok(previous) = serde_json::from_slice::<Value>(&bytes)
        && let Ok(previous_manifest) =
            serde_json::from_value::<BuildManifest>(previous["manifest"].clone())
        && previous_manifest.root_tex == root_tex
        && previous_manifest.engine == engine
        && previous_manifest.mapping_ready
        && previous_manifest.pdf_sha256 == hash_file(&pdf)?
        && previous_manifest.sync_sha256 == hash_file(&sync)?
        && revisions_match(&root, &previous_manifest.sources)
    {
        return Ok(previous);
    }
    for attempt in 0..3 {
        if attempt != final_attempt {
            let old = stage.join(format!("sources-{attempt}"));
            if old.exists() {
                fs::remove_dir_all(old)?;
            }
        }
    }
    let job_name = pdf
        .file_stem()
        .ok_or_else(|| AppError::new("BUILD_ARTIFACT_MISSING", "작업명 없음"))?
        .to_string_lossy()
        .to_string();
    let pdf_name = pdf
        .file_name()
        .ok_or_else(|| AppError::new("BUILD_ARTIFACT_MISSING", "PDF 파일명 없음"))?;
    let sync_name = sync
        .file_name()
        .ok_or_else(|| AppError::new("BUILD_ARTIFACT_MISSING", "SyncTeX 파일명 없음"))?;
    let dest_pdf = stage.join(pdf_name);
    let dest_sync = stage.join(sync_name);
    fs::copy(&pdf, &dest_pdf)?;
    fs::copy(&sync, &dest_sync)?;
    fs::copy(&fls, stage.join(format!("{job_name}.fls")))?;
    let mut diagnostic = diagnostics::parse(&tail);
    for extension in ["log", "blg"] {
        let path = pdf.with_extension(extension);
        if path.is_file() {
            let mut bytes = Vec::new();
            fs::File::open(path)?
                .take(256 * 1024)
                .read_to_end(&mut bytes)?;
            diagnostic.extend(diagnostics::parse(&String::from_utf8_lossy(&bytes)));
        }
    }
    let mut seen = std::collections::HashSet::new();
    diagnostic.retain(|d| seen.insert((d.path.clone(), d.line, d.message.clone())));
    for d in &mut diagnostic {
        if let Some(path) = &d.path {
            let candidate = cwd.join(path);
            d.path = candidate
                .canonicalize()
                .ok()
                .and_then(|p| relative(&root, &p).ok());
        }
    }
    fs::write(
        stage.join("diagnostics.json"),
        serde_json::to_vec(&diagnostic)?,
    )?;
    let published = published_parent.join(&id);
    for s in &mut final_sources {
        s.snapshot_path = s
            .snapshot_path
            .replace(&format!("staging/{id}/"), &format!("published/{id}/"));
    }
    ready = ready && !changed.load(Ordering::SeqCst);
    let manifest = BuildManifest {
        version: 1,
        build_id: id.clone(),
        workspace_id: args["workspaceId"].as_str().unwrap_or_default().into(),
        root_tex: root_tex.into(),
        engine: engine.into(),
        cwd: cwd.to_string_lossy().into_owned(),
        job_name,
        started_at: started,
        finished_at: now(),
        pdf_sha256: hash_file(&dest_pdf)?,
        sync_sha256: hash_file(&dest_sync)?,
        sources: final_sources,
        mapping_ready: ready,
        pdf_length: fs::metadata(&dest_pdf)?.len(),
        pdf_path: relative(&root, &published.join(pdf_name))?,
        sync_path: relative(&root, &published.join(sync_name))?,
        mapping_reason: if ready {
            None
        } else {
            Some("입력 파일이 안정화되지 않아 원문 이동만 가능합니다".into())
        },
    };
    fs::write(
        stage.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::rename(&stage, &published)?;
    crate::workspace::transactions::atomic_write(
        &base.join("dependencies.json"),
        &serde_json::to_vec(&known)?,
    )?;
    prune_generations(&root, &root_id, &id)?;
    Ok(json!({"status":"published","manifest":manifest,"diagnostics":diagnostic,"logTail":tail}))
}
