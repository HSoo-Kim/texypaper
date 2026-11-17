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
            format!(
                "{}를 실행할 수 없습니다: {}",
                command.get_program().to_string_lossy(),
                e.message
            ),
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

fn clear_final_artifacts(work: &Path) -> AppResult<()> {
    for entry in fs::read_dir(work)? {
        let entry = entry?;
        let path = entry.path();
        let final_artifact = path
            .extension()
            .is_some_and(|e| e == "pdf" || e == "fls" || e == "synctex")
            || path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.ends_with(".synctex.gz"));
        if final_artifact {
            // Delete only private work files/links, never a published generation.
            if entry.file_type()?.is_dir() {
                return Err(AppError::new(
                    "BUILD_ARTIFACT_INVALID",
                    "산출물 경로가 파일이 아닙니다",
                ));
            }
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct IncrementalInput {
    sha256: String,
    size: u64,
    modified_seconds: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct IncrementalCheckpoint {
    version: u8,
    root_tex: String,
    engine: String,
    project: bool,
    inputs: HashMap<String, IncrementalInput>,
    work: std::collections::BTreeMap<String, String>,
    // Direct passes leave latexmk's source MD5/history untouched. A source
    // reversion must never make that old database declare the new PDF current.
    driver_current: bool,
    direct: Option<DirectProof>,
}

// A failed/canceled compiler may have partially rewritten any of these files. Never
// treat its persistent working directory as the last successfully published cache.
fn work_hashes(
    work: &Path,
    verified: &[(&Path, &str)],
    volatile_job: Option<&str>,
) -> Option<std::collections::BTreeMap<String, String>> {
    let mut pending = vec![work.to_path_buf()];
    let mut hashes = std::collections::BTreeMap::new();
    let mut count = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).ok()? {
            let path = entry.ok()?.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            count += 1;
            if count > 20000 || metadata.file_type().is_symlink() {
                return None;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let relative = path.strip_prefix(work).ok()?.to_str()?.replace('\\', "/");
                if volatile_job.is_some_and(|job| volatile_output(&relative, job)) {
                    continue;
                }
                hashes.insert(
                    relative,
                    if let Some((_, hash)) = verified
                        .iter()
                        .find(|(verified, _)| *verified == path.as_path())
                    {
                        (*hash).to_string()
                    } else {
                        hash_file(&path).ok()?
                    },
                );
            } else {
                return None;
            }
        }
    }
    Some(hashes)
}

fn source_stamp(root: &Path, path: &str) -> Option<(u64, u64)> {
    let metadata = fs::metadata(checked(root, path).ok()?).ok()?;
    // latexmk versions using integer-second stat must also see the change.
    let seconds = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((metadata.len(), seconds))
}

fn incremental_sources_match(
    checkpoint: &IncrementalCheckpoint,
    root: &Path,
    sources: &[SourceRevision],
) -> bool {
    checkpoint.inputs.len() == sources.len()
        && sources.iter().all(|source| {
            let Some(previous) = checkpoint.inputs.get(&source.path) else {
                return false;
            };
            if previous.sha256 == source.sha256 {
                return true;
            }
            // Only ordinary TeX edits can use latexmk's incremental rules. Assets,
            // bibliography/style inputs and metadata-preserving edits need all rules.
            let tex = Path::new(&source.path)
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("tex") || s.eq_ignore_ascii_case("ltx"));
            tex && source_stamp(root, &source.path).is_some_and(|(size, seconds)| {
                size != previous.size || seconds != previous.modified_seconds
            })
        })
}

fn save_incremental_checkpoint(
    path: &Path,
    root: &Path,
    work: &Path,
    project: bool,
    manifest: &BuildManifest,
    driver_current: bool,
    generators_before: Option<&std::collections::BTreeMap<PathBuf, String>>,
) {
    if project {
        return;
    }
    let sources = &manifest.sources;
    let Some(source) = checked(root, &manifest.root_tex).ok() else {
        return;
    };
    let Some(cwd) = source.parent() else { return };
    let Some(name) = source.file_name() else {
        return;
    };
    let Some(database) = database_inputs(&work.join(name).with_extension("fdb_latexmk")) else {
        return;
    };
    let mut stamps = HashMap::new();
    for input in database {
        if input.missing {
            continue;
        }
        if let Ok(path) = cwd.join(input.path).canonicalize()
            && let Ok(path) = relative(root, &path)
        {
            let stamp = (input.size, input.modified_seconds);
            if stamps
                .insert(path, stamp)
                .is_some_and(|previous| previous != stamp)
            {
                return;
            }
        }
    }
    // Use latexmk's recorded stat, not a post-compile filesystem stat: a touch
    // after compilation must not hide a later edit restored to the cached time.
    let Some(inputs) = sources
        .iter()
        .map(|source| {
            let &(size, modified_seconds) = stamps.get(&source.path)?;
            Some((
                source.path.clone(),
                IncrementalInput {
                    sha256: source.sha256.clone(),
                    size,
                    modified_seconds,
                },
            ))
        })
        .collect::<Option<HashMap<_, _>>>()
    else {
        return;
    };
    let Some(pdf_name) = Path::new(&manifest.pdf_path).file_name() else {
        return;
    };
    let Some(sync_name) = Path::new(&manifest.sync_path).file_name() else {
        return;
    };
    // These two potentially large files were just hashed for publication/reuse.
    let direct = if manifest.engine == "pdflatex" {
        direct_proof(root, cwd, &source, &manifest.job_name, work, sources).filter(|proof| {
            proof.dependencies.is_empty()
                || generators_before.is_some_and(|before| before == &proof.dependencies)
        })
    } else {
        None
    };
    let driver_current = driver_current && (manifest.engine != "pdflatex" || direct.is_some());
    let Some(work_state) = work_hashes(
        work,
        &[
            (&work.join(pdf_name), &manifest.pdf_sha256),
            (&work.join(sync_name), &manifest.sync_sha256),
        ],
        None,
    ) else {
        return;
    };
    let checkpoint = IncrementalCheckpoint {
        version: 2,
        root_tex: manifest.root_tex.clone(),
        engine: manifest.engine.clone(),
        project,
        inputs,
        work: work_state,
        driver_current,
        direct,
    };
    if let Ok(bytes) = serde_json::to_vec(&checkpoint)
        && bytes.len() <= 4 * 1024 * 1024
    {
        let _ = crate::workspace::transactions::atomic_write(path, &bytes);
    }
}

struct DatabaseInput {
    path: PathBuf,
    size: u64,
    modified_seconds: u64,
    missing: bool,
    primary: bool,
}

// Recorder files omit BibTeX/Biber inputs. Read source records (not generated
// records) from latexmk's plain-text database too; never execute its contents.
fn database_inputs(database: &Path) -> Option<Vec<DatabaseInput>> {
    if fs::metadata(database).ok()?.len() > 64 * 1024 * 1024 {
        return None;
    }
    let text = fs::read_to_string(database).ok()?;
    let mut lines = text.lines();
    if !matches!(lines.next()?, "# Fdb version 3" | "# Fdb version 4") {
        return None;
    }
    static SOURCE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r#"^\s+"([^"]+)"\s+(-?[0-9.]+)\s+(-?[0-9]+)\s+(?:[0-9a-fA-F]{32}|0)\s+"[^"]*"\s*$"#,
        )
        .unwrap()
    });
    let mut inputs = Vec::new();
    let mut primary = None;
    for line in lines {
        if let Some(header) = line.strip_prefix("[\"") {
            let (rule, _) = header.split_once("\"]")?;
            primary = Some(rule == "pdflatex");
        }
        if let Some(capture) = SOURCE.captures(line) {
            let time = capture[2].parse::<f64>().ok()?;
            let size = capture[3].parse::<i64>().ok()?;
            if time.is_finite() && time >= 0.0 {
                inputs.push(DatabaseInput {
                    path: PathBuf::from(&capture[1]),
                    size: size.max(0) as u64,
                    modified_seconds: time as u64,
                    missing: size < 0,
                    primary: primary?,
                });
            }
        } else if let Some(quoted) = line.trim().strip_prefix('"')
            && !quoted
                .strip_suffix('"')
                .is_some_and(|path| !path.contains('"'))
        {
            return None;
        }
        if inputs.len() > 20000 {
            return None;
        }
    }
    Some(inputs)
}

fn build_inputs(root: &Path, cwd: &Path, fls: &Path) -> AppResult<Vec<String>> {
    let mut inputs = discover_inputs(root, cwd, fls)?;
    let database = database_inputs(&fls.with_extension("fdb_latexmk"));
    if let Some(paths) = database {
        for path in paths {
            if let Ok(path) = cwd.join(path.path).canonicalize()
                && path.is_file()
                && path.starts_with(root)
                && !path.starts_with(root.join(".texypaper"))
                && !path.starts_with(root.join(".paperdock"))
            {
                inputs.push(relative(root, &path)?);
            }
        }
    }
    inputs.sort();
    inputs.dedup();
    if inputs.len() > 20000 {
        return Err(AppError::new(
            "BUILD_INPUT_LIMIT",
            "작업 공간 입력 파일이 20,000개를 초과했습니다",
        ));
    }
    Ok(inputs)
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct RecorderState {
    inputs: std::collections::BTreeSet<PathBuf>,
    outputs: std::collections::BTreeSet<PathBuf>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DirectProof {
    recorder: RecorderState,
    dependencies: std::collections::BTreeMap<PathBuf, String>,
}

fn volatile_output(path: &str, job: &str) -> bool {
    path.strip_prefix(job).is_some_and(|suffix| {
        matches!(
            suffix,
            ".pdf" | ".log" | ".fls" | ".synctex" | ".synctex.gz"
        )
    })
}

// A pass is at a fixed point only if all private control state is unchanged,
// including unknown/new dependency extensions, not just familiar aux files.
fn control_state_matches(
    before: &std::collections::BTreeMap<String, String>,
    after: &std::collections::BTreeMap<String, String>,
    job: &str,
) -> bool {
    before
        .iter()
        .filter(|(path, _)| !volatile_output(path, job))
        .eq(after.iter())
}

fn direct_eligible(
    checkpoint: &IncrementalCheckpoint,
    engine: &str,
    project: bool,
    sources: &[SourceRevision],
) -> bool {
    engine == "pdflatex"
        && !project
        && checkpoint.direct.is_some()
        && checkpoint.inputs.len() == sources.len()
        && sources.iter().all(|source| {
            checkpoint.inputs.get(&source.path).is_some_and(|previous| {
                previous.sha256 == source.sha256
                    || Path::new(&source.path)
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            extension.eq_ignore_ascii_case("tex")
                                || extension.eq_ignore_ascii_case("ltx")
                        })
            })
        })
}

fn driver_force(
    checkpoint: Option<&IncrementalCheckpoint>,
    root: &Path,
    sources: &[SourceRevision],
    attempt: usize,
    direct_attempted: bool,
) -> bool {
    attempt > 0
        || direct_attempted
        || checkpoint.is_none_or(|checkpoint| {
            !checkpoint.driver_current || !incremental_sources_match(checkpoint, root, sources)
        })
}

fn recorder_state(work: &Path, cwd: &Path, job: &str) -> Option<RecorderState> {
    let fls = work.join(format!("{job}.fls"));
    if fs::metadata(&fls).ok()?.len() > 64 * 1024 * 1024 {
        return None;
    }
    let text = fs::read_to_string(fls).ok()?;
    let mut base = cwd.to_path_buf();
    let mut state = RecorderState {
        inputs: Default::default(),
        outputs: Default::default(),
    };
    for line in text.lines() {
        if let Some(pwd) = line.strip_prefix("PWD ") {
            let pwd = Path::new(pwd);
            if !pwd.is_absolute() {
                return None;
            }
            base = pwd.canonicalize().ok()?;
        } else if let Some(input) = line.strip_prefix("INPUT ") {
            let input = base.join(input).canonicalize().ok()?;
            if !input.is_file() {
                return None;
            }
            if let Ok(relative) = input.strip_prefix(work)
                && volatile_output(&relative.to_string_lossy().replace('\\', "/"), job)
            {
                return None;
            }
            state.inputs.insert(input);
        } else if let Some(output) = line.strip_prefix("OUTPUT ") {
            let output = base.join(output).canonicalize().ok()?;
            if !output.starts_with(work) || !output.is_file() {
                return None;
            }
            state.outputs.insert(output);
        }
        if state.inputs.len() + state.outputs.len() > 20000 {
            return None;
        }
    }
    if state.inputs.is_empty() || state.outputs.is_empty() {
        return None;
    }
    Some(state)
}

fn log_is_converged(work: &Path, job: &str) -> bool {
    let log = work.join(format!("{job}.log"));
    if !fs::metadata(&log).is_ok_and(|metadata| metadata.len() <= 16 * 1024 * 1024) {
        return false;
    }
    let Ok(bytes) = fs::read(log) else {
        return false;
    };
    static RERUN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"(?i)\b(?:re-?run|undefined)\b|\(re\)run|please\s+run|no file |not found|does not exist|labels? may have changed"
    ).unwrap()
    });
    !RERUN.is_match(&String::from_utf8_lossy(&bytes))
}

fn generator_dependencies(
    root: &Path,
    cwd: &Path,
    source: &Path,
    work: &Path,
    sources: &[SourceRevision],
) -> Option<std::collections::BTreeMap<PathBuf, String>> {
    let database = database_inputs(&work.join(source.file_name()?).with_extension("fdb_latexmk"))?;
    if !database.iter().any(|input| input.primary) {
        return None;
    }
    let sources = sources
        .iter()
        .map(|source| (source.path.as_str(), source.sha256.as_str()))
        .collect::<HashMap<_, _>>();
    let mut dependencies = std::collections::BTreeMap::new();
    // Only inputs to skipped generators need extra hashing; the engine rereads
    // its own fonts/packages/assets. Work inputs are covered by the work proof.
    for input in database.into_iter().filter(|input| !input.primary) {
        if input.missing {
            return None;
        }
        let path = cwd.join(input.path).canonicalize().ok()?;
        if !path.is_file() {
            return None;
        }
        if path.starts_with(work) {
            continue;
        }
        let relative = relative(root, &path).ok();
        let sha = relative
            .as_ref()
            .and_then(|relative| sources.get(relative.as_str()))
            .map(|sha| (*sha).to_string())
            .or_else(|| hash_file(&path).ok())?;
        dependencies.insert(path, sha);
    }
    Some(dependencies)
}

fn direct_proof(
    root: &Path,
    cwd: &Path,
    source: &Path,
    job: &str,
    work: &Path,
    sources: &[SourceRevision],
) -> Option<DirectProof> {
    if source.file_stem().and_then(|name| name.to_str()) != Some(job) {
        return None;
    }
    if !log_is_converged(work, job) {
        return None;
    }
    let recorder = recorder_state(work, cwd, job)?;
    let dependencies = generator_dependencies(root, cwd, source, work, sources)?;
    Some(DirectProof {
        recorder,
        dependencies,
    })
}

fn try_direct_pass(
    checkpoint: &IncrementalCheckpoint,
    work: &Path,
    cwd: &Path,
    source: &Path,
    cancel: &AtomicBool,
    deadline: Instant,
) -> AppResult<Option<String>> {
    let Some(proof) = &checkpoint.direct else {
        return Ok(None);
    };
    let Some(job) = source.file_stem().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let dependencies_match = || {
        proof
            .dependencies
            .iter()
            .all(|(path, sha)| hash_file(path).is_ok_and(|current| current == *sha))
    };
    if !dependencies_match() {
        return Ok(None);
    }
    // Remove only this job's volatile targets. All auxiliary/dependency files are
    // retained, and every byte of that control state must survive unchanged.
    for suffix in [".pdf", ".log", ".fls", ".synctex", ".synctex.gz"] {
        match fs::remove_file(work.join(format!("{job}{suffix}"))) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut command = Command::new("pdflatex");
    command
        .current_dir(tool_path(cwd)?)
        .args([
            "-no-shell-escape",
            "-synctex=1",
            "-interaction=nonstopmode",
            "-file-line-error",
            "-recorder",
        ])
        .arg(format!("-output-directory={}", tool_path(work)?))
        .arg(format!(
            "./{}",
            source.file_name().unwrap().to_string_lossy()
        ));
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| AppError::new("BUILD_TIMEOUT", "빌드 제한 시간을 초과했습니다"))?;
    let (ok, log) = run(&mut command, cancel, timeout)?;
    if !ok
        || !log_is_converged(work, job)
        || recorder_state(work, cwd, job).as_ref() != Some(&proof.recorder)
        || !work.join(format!("{job}.pdf")).is_file()
        || !(work.join(format!("{job}.synctex.gz")).is_file()
            || work.join(format!("{job}.synctex")).is_file())
        || !dependencies_match()
    {
        return Ok(None);
    }
    let Some(control) = work_hashes(work, &[], Some(job)) else {
        return Ok(None);
    };
    if !control_state_matches(&checkpoint.work, &control, job) {
        return Ok(None);
    }
    Ok(Some(log))
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
    let checkpoint_path = base.join("incremental.json");
    let checkpoint = fs::metadata(&checkpoint_path)
        .ok()
        .filter(|metadata| metadata.len() <= 4 * 1024 * 1024)
        .and_then(|_| fs::read(&checkpoint_path).ok())
        .and_then(|bytes| serde_json::from_slice::<IncrementalCheckpoint>(&bytes).ok())
        .filter(|c| {
            c.version == 2
                && c.root_tex == root_tex
                && c.engine == engine
                && c.project == project
                && !project
        })
        .filter(|c| work_hashes(&work, &[], None).is_some_and(|hashes| hashes == c.work));
    match fs::remove_file(&checkpoint_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
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
    let mut driver_current = true;
    let mut final_generators = None;
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
        // Close the compile-to-checkpoint race for external generator inputs.
        // A newly discovered/changed style can enable direct mode only after a
        // full driver pass observes the same hashes on both sides of compilation.
        let generators_before = if engine == "pdflatex" && !project {
            generator_dependencies(&root, cwd, &source, &work, &sources)
        } else {
            None
        };
        let direct_attempted = attempt == 0
            && checkpoint
                .as_ref()
                .is_some_and(|checkpoint| direct_eligible(checkpoint, engine, project, &sources));
        let direct_log = if direct_attempted {
            try_direct_pass(
                checkpoint.as_ref().unwrap(),
                &work,
                cwd,
                &source,
                cancel,
                deadline,
            )?
        } else {
            None
        };
        let (ok, log) = if let Some(log) = direct_log {
            driver_current = false;
            (true, log)
        } else {
            driver_current = true;
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
            command
                .arg(format!("-outdir={}", tool_path(&work)?))
                .arg(format!(
                    "./{}",
                    source
                        .file_name()
                        .ok_or_else(|| AppError::new("ROOT_INVALID", "파일명 없음"))?
                        .to_string_lossy()
                ));
            if driver_force(
                checkpoint.as_ref(),
                &root,
                &sources,
                attempt,
                direct_attempted,
            ) {
                clear_final_artifacts(&work)?;
                command.arg("-g");
            }
            let timeout = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| AppError::new("BUILD_TIMEOUT", "빌드 제한 시간을 초과했습니다"))?;
            run(&mut command, cancel, timeout)?
        };
        tail = log;
        if !ok {
            let diagnostics = project_diagnostics(diagnostics::parse(&tail), cwd, &root);
            return Ok(
                json!({"status":"failed","diagnostics":diagnostics,"logTail":tail,"error":{"code":"BUILD_FAILED","message":"LaTeX 빌드가 실패했습니다. 이전 PDF를 유지합니다","retryable":true}}),
            );
        }
        let (pdf, sync, fls) = find_artifacts(&work)?;
        let discovered = build_inputs(&root, cwd, &fls)?;
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
        final_generators = generators_before;
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
        && previous_manifest.sources.len() == final_sources.len()
        && previous_manifest
            .sources
            .iter()
            .zip(&final_sources)
            .all(|(previous, current)| {
                previous.path == current.path && previous.sha256 == current.sha256
            })
        && previous_manifest.pdf_sha256 == hash_file(&pdf)?
        && previous_manifest.sync_sha256 == hash_file(&sync)?
        && revisions_match(&root, &previous_manifest.sources)
    {
        save_incremental_checkpoint(
            &checkpoint_path,
            &root,
            &work,
            project,
            &previous_manifest,
            driver_current,
            final_generators.as_ref(),
        );
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
    let diagnostic = project_diagnostics(diagnostic, cwd, &root);
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
    if ready {
        save_incremental_checkpoint(
            &checkpoint_path,
            &root,
            &work,
            project,
            &manifest,
            driver_current,
            final_generators.as_ref(),
        );
    }
    Ok(json!({"status":"published","manifest":manifest,"diagnostics":diagnostic,"logTail":tail}))
}

/// TeX logs name files relative to the build directory (`./main.tex`), but the UI opens files by
/// project-relative path. Keep only the locations that resolve to a file inside the project.
fn project_diagnostics(
    list: Vec<diagnostics::Diagnostic>,
    cwd: &Path,
    root: &Path,
) -> Vec<diagnostics::Diagnostic> {
    diagnostics::filter_driver_noise(list, |path| {
        cwd.join(path)
            .canonicalize()
            .ok()
            .and_then(|p| relative(root, &p).ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision(root: &Path, path: &str) -> SourceRevision {
        SourceRevision {
            path: path.into(),
            sha256: hash_file(&root.join(path)).unwrap(),
            snapshot_path: String::new(),
        }
    }

    fn checkpoint(root: &Path, sources: &[SourceRevision]) -> IncrementalCheckpoint {
        IncrementalCheckpoint {
            version: 2,
            root_tex: "main.tex".into(),
            engine: "pdflatex".into(),
            project: false,
            inputs: sources
                .iter()
                .map(|source| {
                    let (size, modified_seconds) = source_stamp(root, &source.path).unwrap();
                    (
                        source.path.clone(),
                        IncrementalInput {
                            sha256: source.sha256.clone(),
                            size,
                            modified_seconds,
                        },
                    )
                })
                .collect(),
            work: Default::default(),
            driver_current: true,
            direct: None,
        }
    }

    fn set_modified(path: &Path, time: std::time::SystemTime) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
    }

    fn direct_checkpoint(root: &Path, sources: &[SourceRevision]) -> IncrementalCheckpoint {
        let mut proof = checkpoint(root, sources);
        proof.direct = Some(DirectProof {
            recorder: RecorderState {
                inputs: Default::default(),
                outputs: Default::default(),
            },
            dependencies: Default::default(),
        });
        proof
    }

    #[test]
    fn direct_gate_allows_hidden_tex_edits_but_not_dependency_or_profile_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("main.tex"), b"before").unwrap();
        fs::write(root.join("refs.bib"), b"refs").unwrap();
        let time = fs::metadata(root.join("main.tex"))
            .unwrap()
            .modified()
            .unwrap();
        let original = vec![revision(&root, "main.tex"), revision(&root, "refs.bib")];
        let mut proof = direct_checkpoint(&root, &original);
        fs::write(root.join("main.tex"), b"after!").unwrap();
        set_modified(&root.join("main.tex"), time);
        let edited = vec![revision(&root, "main.tex"), revision(&root, "refs.bib")];
        assert!(!incremental_sources_match(&proof, &root, &edited));
        assert!(direct_eligible(&proof, "pdflatex", false, &edited));
        assert!(!direct_eligible(&proof, "xelatex", false, &edited));
        assert!(!direct_eligible(&proof, "lualatex", false, &edited));
        assert!(!direct_eligible(&proof, "pdflatex", true, &edited));
        fs::write(root.join("refs.bib"), b"new refs").unwrap();
        assert!(!direct_eligible(
            &proof,
            "pdflatex",
            false,
            &[revision(&root, "main.tex"), revision(&root, "refs.bib")]
        ));
        assert!(!direct_eligible(&proof, "pdflatex", false, &edited[..1]));
        proof.direct = None;
        assert!(!direct_eligible(&proof, "pdflatex", false, &edited));
    }

    #[test]
    fn direct_fixed_point_requires_all_auxiliary_and_unknown_control_files() {
        let before = [
            "main.aux",
            "main.toc",
            "main.out",
            "main.bcf",
            "main.run.xml",
            "main.bbl",
            "main.fdb_latexmk",
            "figure.pdf",
            "nested/main.log",
            "main.pdf",
            "main.log",
            "main.fls",
            "main.synctex.gz",
        ]
        .into_iter()
        .map(|path| (path.to_string(), "old".to_string()))
        .collect::<std::collections::BTreeMap<_, _>>();
        let mut after = before
            .iter()
            .filter(|(path, _)| !volatile_output(path, "main"))
            .map(|(path, sha)| (path.clone(), sha.clone()))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert!(control_state_matches(&before, &after, "main"));
        for path in [
            "main.aux",
            "main.toc",
            "main.out",
            "main.bcf",
            "main.run.xml",
            "main.bbl",
            "main.fdb_latexmk",
            "figure.pdf",
            "nested/main.log",
        ] {
            after.insert(path.into(), "changed".into());
            assert!(!control_state_matches(&before, &after, "main"), "{path}");
            after.insert(path.into(), "old".into());
            after.remove(path);
            assert!(!control_state_matches(&before, &after, "main"), "{path}");
            after.insert(path.into(), "old".into());
        }
        after.insert("new-control.unknown".into(), "new".into());
        assert!(!control_state_matches(&before, &after, "main"));
    }

    #[test]
    fn source_reversion_after_direct_success_forces_a_dirty_driver() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("main.tex");
        fs::write(&path, b"before").unwrap();
        let time = fs::metadata(&path).unwrap().modified().unwrap();
        let mut proof = direct_checkpoint(&root, &[revision(&root, "main.tex")]);
        // latexmk still remembers A, but a proven direct pass has published B.
        fs::write(&path, b"after!").unwrap();
        proof.inputs.get_mut("main.tex").unwrap().sha256 = hash_file(&path).unwrap();
        proof.driver_current = false;
        fs::write(&path, b"before").unwrap();
        set_modified(&path, time + Duration::from_secs(4));
        let reverted = vec![revision(&root, "main.tex")];
        assert!(incremental_sources_match(&proof, &root, &reverted));
        assert!(direct_eligible(&proof, "pdflatex", false, &reverted));
        assert!(driver_force(Some(&proof), &root, &reverted, 0, false));
        proof.driver_current = true;
        assert!(!driver_force(Some(&proof), &root, &reverted, 0, false));
        assert!(driver_force(Some(&proof), &root, &reverted, 0, true));
        assert!(driver_force(Some(&proof), &root, &reverted, 1, false));
        assert!(driver_force(None, &root, &reverted, 0, false));
    }

    #[test]
    fn direct_proof_tracks_skipped_generator_inputs_and_exact_recorder_dependencies() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let source = root.join("main.tex");
        fs::write(&source, b"source").unwrap();
        fs::write(root.join("refs.bib"), b"refs").unwrap();
        let work = root.join("work");
        fs::create_dir(&work).unwrap();
        fs::write(work.join("main.pdf"), b"%PDF-").unwrap();
        fs::write(work.join("main.aux"), b"stable control").unwrap();
        fs::write(
            work.join("main.log"),
            b"Output written on main.pdf (1 page).\n",
        )
        .unwrap();
        let external = tempfile::tempdir().unwrap();
        let font = external.path().join("font.sty");
        let style = external.path().join("style.bst");
        fs::write(&font, b"font").unwrap();
        fs::write(&style, b"style").unwrap();
        let font = font.canonicalize().unwrap();
        let style = style.canonicalize().unwrap();
        let font_name = tool_path(&font).unwrap();
        let style_name = tool_path(&style).unwrap();
        let recorder = format!(
            "PWD {}\nINPUT main.tex\nINPUT {font_name}\nINPUT work/main.aux\nOUTPUT work/main.pdf\nOUTPUT work/main.aux\nOUTPUT work/main.log\n",
            tool_path(&root).unwrap(),
        );
        fs::write(work.join("main.fls"), &recorder).unwrap();
        fs::write(work.join("main.fdb_latexmk"), format!(
            "# Fdb version 4\n[\"pdflatex\"] 1 \"main.tex\" \"work/main.pdf\" \"main\" 1 0\n  \"main.tex\" 1 6 0 \"\"\n  \"{font_name}\" 1 4 0 \"\"\n[\"bibtex main\"] 1 \"work/main.aux\" \"work/main.bbl\" \"main\" 1 0\n  \"refs.bib\" 1 4 0 \"\"\n  \"{style_name}\" 1 5 0 \"\"\n  \"work/main.aux\" 1 14 0 \"pdflatex\"\n"
        )).unwrap();
        let proof = direct_proof(
            &root,
            &root,
            &source,
            "main",
            &work,
            &[revision(&root, "main.tex"), revision(&root, "refs.bib")],
        )
        .unwrap();
        assert!(proof.dependencies.contains_key(&style));
        assert!(proof.dependencies.contains_key(&root.join("refs.bib")));
        assert!(!proof.dependencies.contains_key(&font));
        fs::write(&style, b"other").unwrap();
        assert_ne!(proof.dependencies[&style], hash_file(&style).unwrap());
        fs::write(root.join("new.tex"), b"new input").unwrap();
        fs::write(work.join("main.fls"), format!("{recorder}INPUT new.tex\n")).unwrap();
        assert!(recorder_state(&work, &root, "main").as_ref() != Some(&proof.recorder));
        fs::write(root.join("outside.aux"), b"outside output").unwrap();
        fs::write(
            work.join("main.fls"),
            format!("{recorder}OUTPUT outside.aux\n"),
        )
        .unwrap();
        assert!(recorder_state(&work, &root, "main").is_none());
        fs::write(
            work.join("main.log"),
            b"LaTeX Warning: Labels may have changed. Rerun to get references right.\n",
        )
        .unwrap();
        assert!(!log_is_converged(&work, "main"));
    }

    #[test]
    fn incremental_guard_detects_same_size_same_time_tex_edits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("main.tex");
        fs::write(&path, b"before").unwrap();
        let time = fs::metadata(&path).unwrap().modified().unwrap();
        let original = vec![revision(&root, "main.tex")];
        let proof = checkpoint(&root, &original);
        assert!(incremental_sources_match(&proof, &root, &original));

        fs::write(&path, b"after!").unwrap();
        set_modified(&path, time);
        let edited = vec![revision(&root, "main.tex")];
        assert!(!incremental_sources_match(&proof, &root, &edited));

        set_modified(&path, time + Duration::from_secs(2));
        assert!(incremental_sources_match(&proof, &root, &edited));
        fs::write(&path, b"longer!").unwrap();
        set_modified(&path, time);
        assert!(incremental_sources_match(
            &proof,
            &root,
            &[revision(&root, "main.tex")]
        ));
        assert!(!incremental_sources_match(&proof, &root, &[]));
    }

    #[test]
    fn bibliography_and_asset_edits_require_all_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for name in ["refs.bib", "figure.pdf", "macros.sty"] {
            fs::write(root.join(name), b"before").unwrap();
            let original = vec![revision(&root, name)];
            let proof = checkpoint(&root, &original);
            fs::write(root.join(name), b"new dependency data").unwrap();
            assert!(!incremental_sources_match(
                &proof,
                &root,
                &[revision(&root, name)]
            ));
        }
    }

    #[test]
    fn database_discovery_proves_bibliography_without_trusting_generated_or_external_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("main.tex"), b"source").unwrap();
        fs::write(root.join("refs one.bib"), b"refs").unwrap();
        let work = root.join(".texypaper/work");
        fs::create_dir_all(&work).unwrap();
        fs::write(root.join(".texypaper/private.bib"), b"private").unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("outside.bib"), b"external").unwrap();
        let outside =
            tool_path(&external.path().join("outside.bib").canonicalize().unwrap()).unwrap();
        let fls = work.join("main.fls");
        fs::write(&fls, "INPUT main.tex\n").unwrap();
        let database = fls.with_extension("fdb_latexmk");
        fs::write(&database, format!(
            "# Fdb version 4\n[\"bibtex main\"] 1 \"main.aux\" \"main.bbl\" \"main\" 1 0\n  \"refs one.bib\" 1.25 4 00000000000000000000000000000000 \"\"\n  \".texypaper/private.bib\" 1 7 0 \"\"\n  \"{outside}\" 1 8 0 \"\"\n  (generated)\n  \"main.bbl\"\n"
        )).unwrap();
        assert_eq!(
            build_inputs(&root, &root, &fls).unwrap(),
            vec!["main.tex", "refs one.bib"]
        );
        let inputs = database_inputs(&database).unwrap();
        assert_eq!(inputs[0].modified_seconds, 1);
        assert_eq!(inputs[0].size, 4);
        fs::write(
            &database,
            "# Fdb version 4\n  \"refs one.bib\" 1 4 broken \"\"\n",
        )
        .unwrap();
        assert!(database_inputs(&database).is_none());
        assert_eq!(build_inputs(&root, &root, &fls).unwrap(), vec!["main.tex"]);
        fs::remove_file(&database).unwrap();
        assert_eq!(build_inputs(&root, &root, &fls).unwrap(), vec!["main.tex"]);
    }

    #[test]
    fn work_proof_detects_preserved_metadata_corruption_and_missing_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path();
        let path = work.join("main.fdb_latexmk");
        fs::write(&path, b"before").unwrap();
        let time = fs::metadata(&path).unwrap().modified().unwrap();
        let proof = work_hashes(work, &[], None).unwrap();
        fs::write(&path, b"after!").unwrap();
        set_modified(&path, time);
        assert_ne!(work_hashes(work, &[], None).unwrap(), proof);
        fs::remove_file(path).unwrap();
        assert_ne!(work_hashes(work, &[], None).unwrap(), proof);
    }

    #[test]
    fn forced_attempt_clears_only_private_final_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "old.pdf",
            "old.fls",
            "old.synctex.gz",
            "old.synctex",
            "main.aux",
            "main.bbl",
            "main.fdb_latexmk",
        ] {
            fs::write(dir.path().join(name), b"cached").unwrap();
        }
        clear_final_artifacts(dir.path()).unwrap();
        for name in ["old.pdf", "old.fls", "old.synctex.gz", "old.synctex"] {
            assert!(!dir.path().join(name).exists());
        }
        for name in ["main.aux", "main.bbl", "main.fdb_latexmk"] {
            assert!(dir.path().join(name).is_file());
        }
    }

    #[test]
    fn failed_build_diagnostics_open_by_project_relative_path_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir(root.join("sections")).unwrap();
        fs::write(root.join("sections/a.tex"), "x").unwrap();
        let external = tempfile::tempdir().unwrap();
        let external_input = external.path().join("included.tex");
        fs::write(&external_input, "x").unwrap();
        let parsed = diagnostics::parse(&format!(
            "./sections/a.tex:3: Undefined control sequence.\n{}:1: Missing $ inserted.\n",
            external_input.display(),
        ));
        let list = project_diagnostics(parsed, &root, &root);
        assert_eq!(list[0].path.as_deref(), Some("sections/a.tex"));
        assert_eq!(list[1].path, None);
        assert!(list[1].inferred);
    }

    #[test]
    fn failed_windows_build_has_one_document_error_not_a_wrapper_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("broken.tex"), "\\undefined").unwrap();
        let parsed = diagnostics::parse(
            "./broken.tex:3: Undefined control sequence.\nLatexmk: Errors, so I did not complete making targets\nCollected error summary (may duplicate other messages):\n  pdflatex: Command for 'pdflatex' gave return code 1\nC:\\texlive\\2026\\bin\\windows\\runscript.tlu:933: command failed with exit code 12:\n",
        );
        let list = project_diagnostics(parsed, &root, &root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path.as_deref(), Some("broken.tex"));
        assert_eq!(list[0].line, Some(3));
    }
}
