use super::{
    artifacts::{self, BuildManifest},
    synctex_parser,
};
use crate::{
    contracts::{AppError, AppResult},
    process::OwnedChild,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
pub fn parse_output(text: &str) -> AppResult<Value> {
    let mut records = Vec::new();
    let mut current = BTreeMap::<String, Value>::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line == "SyncTeX result begin" {
            inside = true;
            continue;
        }
        if line == "SyncTeX result end" {
            if !current.is_empty() {
                records.push(std::mem::take(&mut current));
            }
            inside = false;
            continue;
        }
        if !inside {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key == "Output" && !current.is_empty() {
            records.push(std::mem::take(&mut current));
        }
        let field = match key {
            "Input" => "input",
            "Output" => "output",
            "Page" => "page",
            "Line" => "line",
            "Column" => "column",
            s => s,
        };
        let val = if matches!(key, "Page" | "Line" | "Column") {
            match value.trim().parse::<i64>() {
                Ok(n) => {
                    if key == "Column" && n <= 0 {
                        Value::Null
                    } else {
                        json!(n)
                    }
                }
                Err(_) => continue,
            }
        } else if matches!(key, "h" | "v" | "W" | "H" | "x" | "y") {
            match value.trim().parse::<f64>() {
                Ok(n) if n.is_finite() => json!(n),
                _ => {
                    return Err(AppError::new(
                        "SYNC_INVALID",
                        "SyncTeX가 유한하지 않은 좌표를 반환했습니다",
                    ));
                }
            }
        } else {
            json!(value)
        };
        current.insert(field.into(), val);
    }
    records.retain(|r| {
        r.get("page").and_then(Value::as_u64).is_some_and(|n| n > 0)
            || r.get("input")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                && r.get("line").and_then(Value::as_u64).is_some_and(|n| n > 0)
    });
    if records.is_empty() {
        return Err(AppError::new(
            "SYNC_NO_MATCH",
            "대응하는 원문 위치가 없습니다",
        ));
    }
    Ok(json!({"records":records,"method":"native"}))
}
fn bounded_cli(cmd: &mut Command) -> AppResult<String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(cmd)?;
    let out = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| AppError::new("SYNC_IO", "출력 파이프 없음"))?;
    let err = child
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| AppError::new("SYNC_IO", "오류 파이프 없음"))?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let data = output.clone();
    let a = thread::spawn(move || {
        let mut reader = out.take(1024 * 1024 + 1);
        let mut b = Vec::new();
        let _ = reader.read_to_end(&mut b);
        *data.lock().unwrap_or_else(|e| e.into_inner()) = b;
    });
    let b = thread::spawn(move || {
        let mut sink = std::io::sink();
        let _ = std::io::copy(&mut err.take(65536), &mut sink);
    });
    let start = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(15) {
            child.cancel()?;
            let _ = child.wait();
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = a.join();
    let _ = b.join();
    let mut output = output.lock().unwrap_or_else(|e| e.into_inner());
    if output.len() > 1024 * 1024 {
        return Err(AppError::new("SYNC_LIMIT", "SyncTeX 출력 제한 초과"));
    }
    let bytes = std::mem::take(&mut *output);
    drop(output);
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(error) => synctex_parser::decode_text(error.as_bytes()).map(|text| text.into_owned()),
    }
}
type ParserIndexCache = Option<(String, Arc<synctex_parser::Index>)>;
static PARSER_INDEX: std::sync::LazyLock<Mutex<ParserIndexCache>> =
    std::sync::LazyLock::new(Default::default);
fn fallback(root: &Path, m: &BuildManifest, args: &Value, forward: bool) -> AppResult<Value> {
    let index = {
        let mut cache = PARSER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        if cache
            .as_ref()
            .is_none_or(|(hash, _)| hash != &m.sync_sha256)
        {
            *cache = Some((
                m.sync_sha256.clone(),
                Arc::new(synctex_parser::load(&artifacts::checked(
                    root,
                    &m.sync_path,
                )?)?),
            ));
        }
        cache
            .as_ref()
            .ok_or_else(|| AppError::new("SYNC_NO_MATCH", "색인 없음"))?
            .1
            .clone()
    };
    let cwd = Path::new(&m.cwd);
    let blocks = if forward {
        let path = artifacts::checked(
            root,
            args["file"]
                .as_str()
                .or(args["path"].as_str())
                .ok_or_else(|| AppError::new("SYNC_INPUT", "원문 경로 없음"))?,
        )?;
        index.forward(&path, cwd, args["line1"].as_u64().unwrap_or(1) as u32)
    } else {
        index.inverse(
            args["page1"].as_u64().unwrap_or(1) as u32,
            args["xPt"].as_f64().unwrap_or(0.0),
            args["yPt"].as_f64().unwrap_or(0.0),
        )
    };
    if blocks.is_empty() {
        return Err(AppError::new("SYNC_NO_MATCH", "대응 위치 없음"));
    }
    let records=blocks.into_iter().take(256).map(|b|json!({"input":b.input.as_ref(),"line":b.line,"column":null,"page":b.page,"h":b.h,"v":b.v,"W":b.w,"H":b.height})).collect::<Vec<_>>();
    Ok(json!({"records":records,"method":"unicodeFallback","editGrade":fallback_verified(m)}))
}
#[derive(Clone)]
struct FileSignature {
    length: u64,
    modified: std::time::SystemTime,
    hash: String,
}
static SIGNATURES: std::sync::LazyLock<
    Mutex<std::collections::HashMap<std::path::PathBuf, FileSignature>>,
> = std::sync::LazyLock::new(Default::default);
fn verify_artifact(path: &Path, expected: &str) -> AppResult<()> {
    let meta = std::fs::metadata(path)?;
    let modified = meta.modified()?;
    {
        let signatures = SIGNATURES.lock().unwrap_or_else(|e| e.into_inner());
        if signatures
            .get(path)
            .is_some_and(|s| s.length == meta.len() && s.modified == modified && s.hash == expected)
        {
            return Ok(());
        }
    }
    if artifacts::hash_file(path)? != expected {
        return Err(AppError::new(
            "ARTIFACT_CHANGED",
            "게시된 산출물이 변경되었습니다",
        ));
    }
    let mut signatures = SIGNATURES.lock().unwrap_or_else(|e| e.into_inner());
    if signatures.len() >= 8 {
        signatures.clear()
    }
    signatures.insert(
        path.to_path_buf(),
        FileSignature {
            length: meta.len(),
            modified,
            hash: expected.into(),
        },
    );
    Ok(())
}
pub fn local(root: &Path, args: &Value, forward: bool) -> AppResult<Value> {
    let id = args["buildId"]
        .as_str()
        .ok_or_else(|| AppError::new("BUILD_UNKNOWN", "빌드 ID 없음"))?;
    let m = artifacts::manifest(root, id)?;
    if !m.mapping_ready {
        return Err(AppError::new(
            "SYNC_UNAVAILABLE",
            m.mapping_reason
                .as_deref()
                .unwrap_or("Rebuild to restore source mapping"),
        ));
    }
    let pdf = artifacts::checked(root, &m.pdf_path)?;
    let sync = artifacts::checked(root, &m.sync_path)?;
    verify_artifact(&pdf, &m.pdf_sha256)?;
    verify_artifact(&sync, &m.sync_sha256)?;
    let mut cmd = Command::new("synctex");
    cmd.current_dir(artifacts::tool_path(Path::new(&m.cwd))?);
    if forward {
        let path = artifacts::checked(
            root,
            args["file"]
                .as_str()
                .or(args["path"].as_str())
                .ok_or_else(|| AppError::new("SYNC_INPUT", "원문 경로 없음"))?,
        )?;
        let line = args["line1"].as_u64().unwrap_or(1);
        let column = args["column1"].as_u64().unwrap_or(0);
        cmd.arg("view")
            .arg("-i")
            .arg(format!("{line}:{column}:{}", artifacts::tool_path(&path)?))
            .arg("-o")
            .arg(artifacts::tool_path(&pdf)?);
    } else {
        let page = args["page1"].as_u64().unwrap_or(1);
        let x = args["xPt"]
            .as_f64()
            .ok_or_else(|| AppError::new("SYNC_INPUT", "x 좌표 없음"))?;
        let y = args["yPt"]
            .as_f64()
            .ok_or_else(|| AppError::new("SYNC_INPUT", "y 좌표 없음"))?;
        if page == 0 || !x.is_finite() || !y.is_finite() {
            return Err(AppError::new("SYNC_INPUT", "잘못된 좌표"));
        }
        cmd.arg("edit")
            .arg("-o")
            .arg(format!("{page}:{x}:{y}:{}", artifacts::tool_path(&pdf)?));
    }
    match bounded_cli(&mut cmd).and_then(|s| parse_output(&s)) {
        Ok(v) => Ok(v),
        Err(_) => fallback(root, &m, args, forward),
    }
}
const PARSER_VALIDATION_VERSION: u8 = 2;
static VALIDATED: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);
static NATIVE_VERSION: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(Default::default);
fn native_version() -> AppResult<String> {
    let mut saved = NATIVE_VERSION.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(version) = saved.as_ref() {
        return Ok(version.clone());
    }
    let output = bounded_cli(Command::new("synctex").arg("--version"))?;
    let version = output.lines().take(4).collect::<Vec<_>>().join("\n");
    if version.is_empty() {
        return Err(AppError::new(
            "SYNCTEX_VERSION_UNKNOWN",
            "SyncTeX 버전을 확인할 수 없습니다",
        ));
    }
    *saved = Some(version.clone());
    Ok(version)
}
pub fn fallback_verified(manifest: &BuildManifest) -> bool {
    let verified = VALIDATED.lock().unwrap_or_else(|e| e.into_inner());
    verified.contains(&manifest.sync_sha256)
        || verified.contains(&format!("engine:{}", manifest.engine))
}
pub fn restore_validation(workspace: &crate::workspace::Workspace, manifest: &BuildManifest) {
    if fallback_verified(manifest)
        || !matches!(
            manifest.engine.as_str(),
            "pdflatex" | "xelatex" | "lualatex"
        )
    {
        return;
    }
    let path = workspace
        .data_dir()
        .join("synctex-verified")
        .join(format!("engine-{}.json", manifest.engine));
    if let Ok(bytes) = std::fs::read(path)
        && let Ok(record) = serde_json::from_slice::<Value>(&bytes)
        && record["parserVersion"] == PARSER_VALIDATION_VERSION
        && record["engine"] == manifest.engine
        && native_version().is_ok_and(|v| record["nativeVersion"] == v)
    {
        VALIDATED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(format!("engine:{}", manifest.engine));
    }
}
fn native_query(
    manifest: &BuildManifest,
    pdf: &Path,
    source: &Path,
    line: u32,
    inverse: Option<(u32, f64, f64)>,
) -> AppResult<Value> {
    let mut cmd = Command::new("synctex");
    cmd.current_dir(artifacts::tool_path(Path::new(&manifest.cwd))?);
    if let Some((page, x, y)) = inverse {
        cmd.arg("edit")
            .arg("-o")
            .arg(format!("{page}:{x}:{y}:{}", artifacts::tool_path(pdf)?));
    } else {
        cmd.arg("view")
            .arg("-i")
            .arg(format!("{line}:0:{}", artifacts::tool_path(source)?))
            .arg("-o")
            .arg(artifacts::tool_path(pdf)?);
    }
    parse_output(&bounded_cli(&mut cmd)?)
}
fn corners(block: &synctex_parser::Block) -> [f64; 4] {
    [block.h, block.v - block.height, block.h + block.w, block.v]
}
fn record_corners(record: &Value) -> Option<[f64; 4]> {
    let (h, v, w, height) = (
        record["h"].as_f64()?,
        record["v"].as_f64()?,
        record["W"].as_f64()?,
        record["H"].as_f64()?,
    );
    Some([h, v - height, h + w, v])
}
fn fixture_source_identity(
    root: &Path,
    manifest: &BuildManifest,
    input: &str,
) -> AppResult<String> {
    let path = Path::new(&manifest.cwd).join(input).canonicalize()?;
    let relative = artifacts::relative(root, &path)?;
    if !manifest
        .sources
        .iter()
        .any(|source| source.path == relative)
    {
        return Err(AppError::new(
            "SYNCTEX_FIXTURE_INVALID",
            "역방향 결과가 기록된 입력 파일이 아닙니다",
        ));
    }
    let prefix = manifest
        .root_tex
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/"))
        .unwrap_or_default();
    Ok(match relative.strip_prefix(&prefix) {
        Some(local) => local.to_owned(),
        None => format!("@workspace/{relative}"),
    })
}
pub fn validate_pair(workspace: &crate::workspace::Workspace, args: Value) -> AppResult<Value> {
    let root = workspace.local_root().ok_or_else(|| {
        AppError::new(
            "SYNCTEX_FALLBACK_LOCAL_ONLY",
            "보조 파서 검증은 Windows 로컬 빌드에만 필요합니다",
        )
    })?;
    let ascii = super::get_manifest(workspace, args["asciiBuildId"].as_str().unwrap_or_default())?;
    let unicode = super::get_manifest(
        workspace,
        args["unicodeBuildId"].as_str().unwrap_or_default(),
    )?;
    let a_source = artifacts::checked(&root, &ascii.root_tex)?;
    let u_source = artifacts::checked(&root, &unicode.root_tex)?;
    if !a_source.to_string_lossy().is_ascii() || u_source.to_string_lossy().is_ascii() {
        return Err(AppError::new(
            "SYNCTEX_FIXTURE_INVALID",
            "ASCII 경로와 비ASCII 경로의 동등한 빌드가 필요합니다",
        ));
    }
    let identities = |manifest: &BuildManifest| {
        let prefix = manifest
            .root_tex
            .rsplit_once('/')
            .map(|(p, _)| format!("{p}/"))
            .unwrap_or_default();
        let mut rows = manifest
            .sources
            .iter()
            .map(|s| {
                (
                    s.path.strip_prefix(&prefix).unwrap_or(&s.path).to_string(),
                    s.sha256.clone(),
                )
            })
            .collect::<Vec<_>>();
        rows.sort();
        rows
    };
    if ascii.engine != unicode.engine
        || identities(&ascii) != identities(&unicode)
        || !ascii.mapping_ready
        || !unicode.mapping_ready
    {
        return Err(AppError::new(
            "SYNCTEX_FIXTURE_MISMATCH",
            "두 빌드는 동일한 엔진과 상대 입력 경로·바이트를 사용하고 안정화되어야 합니다",
        ));
    }
    let a_pdf = artifacts::checked(&root, &ascii.pdf_path)?;
    let u_pdf = artifacts::checked(&root, &unicode.pdf_path)?;
    let a_sync = artifacts::checked(&root, &ascii.sync_path)?;
    let u_sync = artifacts::checked(&root, &unicode.sync_path)?;
    for (path, expected) in [
        (&a_pdf, &ascii.pdf_sha256),
        (&u_pdf, &unicode.pdf_sha256),
        (&a_sync, &ascii.sync_sha256),
        (&u_sync, &unicode.sync_sha256),
    ] {
        if artifacts::hash_file(path)? != *expected {
            return Err(AppError::new(
                "ARTIFACT_CHANGED",
                "검증할 산출물이 변경되었습니다",
            ));
        }
    }
    let a_index = synctex_parser::load(&a_sync)?;
    let u_index = synctex_parser::load(&u_sync)?;
    let mut file_matches = std::collections::HashMap::new();
    let mut lines = Vec::new();
    for block in &a_index.blocks {
        let matched = *file_matches.entry(block.input.clone()).or_insert_with(|| {
            Path::new(&ascii.cwd)
                .join(block.input.as_ref())
                .canonicalize()
                .is_ok_and(|p| p == a_source)
        });
        if matched {
            lines.push(block.line)
        }
    }
    lines.sort();
    lines.dedup();
    if lines.is_empty() {
        return Err(AppError::new(
            "SYNC_NO_MATCH",
            "검증할 ASCII 원문 줄이 없습니다",
        ));
    }
    let first = lines[0];
    let last = *lines.last().unwrap_or(&first);
    let mut requested = vec![
        first.saturating_sub(1).max(1),
        first,
        lines[lines.len() / 2],
        last,
        last.saturating_add(1),
    ];
    requested.sort();
    requested.dedup();
    let mut verified = Vec::new();
    for line in requested {
        let native = native_query(&ascii, &a_pdf, &a_source, line, None)?;
        let records = native["records"]
            .as_array()
            .ok_or_else(|| AppError::new("SYNC_NO_MATCH", "원본 SyncTeX 결과 없음"))?;
        let a_blocks = a_index.forward(&a_source, Path::new(&ascii.cwd), line);
        let u_blocks = u_index.forward(&u_source, Path::new(&unicode.cwd), line);
        let mut match_block = None;
        for record in records {
            let Some(rect) = record_corners(record) else {
                continue;
            };
            for block in &a_blocks {
                let other = corners(block);
                if record["page"].as_u64() == Some(block.page as u64)
                    && rect.iter().zip(other).all(|(a, b)| (a - b).abs() <= 3.0)
                    && u_blocks.iter().any(|u| {
                        u.page == block.page
                            && corners(u)
                                .iter()
                                .zip(other)
                                .all(|(a, b)| (a - b).abs() <= 0.5)
                    })
                {
                    match_block = Some(*block);
                    break;
                }
            }
            if match_block.is_some() {
                break;
            }
        }
        let block = match_block.ok_or_else(|| {
            let summarize = |blocks: &[&synctex_parser::Block]| blocks.iter().take(16)
                .map(|candidate| json!({"input":candidate.input.as_ref(),"line":candidate.line,"page":candidate.page,"rect":corners(candidate)}))
                .collect::<Vec<_>>();
            let mut error = AppError::new(
                "SYNCTEX_GEOMETRY_MISMATCH",
                format!("줄 {line}: 원본·ASCII·Unicode 기하가 일치하지 않습니다"),
            );
            error.details = Some(json!({"requestedLine":line,"native":records.iter().take(16).collect::<Vec<_>>(),"ascii":summarize(&a_blocks),"unicode":summarize(&u_blocks)}));
            error
        })?;
        let (x, y) = (block.h + block.w * 0.5, block.v - block.height * 0.5);
        let inverse = native_query(&ascii, &a_pdf, &a_source, 0, Some((block.page, x, y)))?;
        let native_records = inverse["records"]
            .as_array()
            .ok_or_else(|| AppError::new("SYNC_NO_MATCH", "원본 역방향 결과 없음"))?;
        let mut native_locations = Vec::new();
        for record in native_records {
            let input = record["input"]
                .as_str()
                .ok_or_else(|| AppError::new("SYNC_INVALID", "원본 역방향 파일 경로 없음"))?;
            let source_line = record["line"]
                .as_u64()
                .and_then(|line| u32::try_from(line).ok())
                .filter(|line| *line > 0)
                .ok_or_else(|| {
                    AppError::new("SYNC_INVALID", "원본 역방향 원문 줄이 유효하지 않습니다")
                })?;
            native_locations.push((fixture_source_identity(&root, &ascii, input)?, source_line));
        }
        native_locations.sort();
        native_locations.dedup();
        let inverse_locations = |index: &synctex_parser::Index,
                                 manifest: &BuildManifest|
         -> AppResult<Vec<(String, u32)>> {
            let mut locations = Vec::new();
            for candidate in index.inverse(block.page, x, y) {
                locations.push((
                    fixture_source_identity(&root, manifest, candidate.input.as_ref())?,
                    candidate.line,
                ));
            }
            locations.sort();
            locations.dedup();
            Ok(locations)
        };
        let ascii_locations = inverse_locations(&a_index, &ascii)?;
        let unicode_locations = inverse_locations(&u_index, &unicode)?;
        // A line box can contain text from an included file. Compare the actual
        // native inverse identity at this point, not the forward root's label.
        let matches = !native_locations.is_empty()
            && ascii_locations == unicode_locations
            && native_locations.iter().all(|(path, line)| {
                ascii_locations.iter().any(|(candidate, candidate_line)| {
                    candidate == path && candidate_line.abs_diff(*line) <= 2
                })
            });
        if !matches {
            let mut error = AppError::new(
                "SYNCTEX_GEOMETRY_MISMATCH",
                format!("줄 {line}: 역방향 원문 매핑이 일치하지 않습니다"),
            );
            error.details = Some(
                json!({"requestedLine":line,"point":{"page":block.page,"x":x,"y":y},"native":native_locations,"ascii":ascii_locations,"unicode":unicode_locations}),
            );
            return Err(error);
        }
        verified.push(json!({"requestedLine":line,"sourceLine":block.line,"page":block.page,"rect":corners(block),"inverse":native_locations}));
    }
    let record = json!({"parserVersion":PARSER_VALIDATION_VERSION,"nativeVersion":native_version()?,"engine":unicode.engine,"syncSha256":unicode.sync_sha256,"asciiBuildId":ascii.build_id,"unicodeBuildId":unicode.build_id,"verifiedAt":artifacts::now(),"samples":verified});
    let dir = workspace.data_dir().join("synctex-verified");
    std::fs::create_dir_all(&dir)?;
    crate::workspace::transactions::atomic_write(
        &dir.join(format!("engine-{}.json", unicode.engine)),
        &serde_json::to_vec(&record)?,
    )?;
    let mut validated = VALIDATED.lock().unwrap_or_else(|e| e.into_inner());
    validated.insert(unicode.sync_sha256.clone());
    validated.insert(format!("engine:{}", unicode.engine));
    Ok(json!({"status":"passed","editGrade":true,"evidence":record}))
}

#[cfg(test)]
mod fixture_identity_tests {
    use super::*;

    fn manifest(root: &Path, folder: &str) -> BuildManifest {
        let sources = ["main.tex", "sections/shared.tex", "other/shared.tex"]
            .into_iter()
            .map(|name| {
                let path = format!("{folder}/{name}");
                artifacts::SourceRevision {
                    sha256: artifacts::hash_file(&root.join(&path)).unwrap(),
                    path,
                    snapshot_path: String::new(),
                }
            })
            .collect();
        BuildManifest {
            version: 1,
            build_id: uuid::Uuid::new_v4().to_string(),
            workspace_id: "identity-fixture".into(),
            root_tex: format!("{folder}/main.tex"),
            engine: "pdflatex".into(),
            cwd: root.join(folder).to_str().unwrap().into(),
            job_name: "main".into(),
            started_at: "0".into(),
            finished_at: "0".into(),
            pdf_sha256: String::new(),
            sync_sha256: String::new(),
            sources,
            mapping_ready: true,
            pdf_length: 0,
            pdf_path: String::new(),
            sync_path: String::new(),
            mapping_reason: None,
        }
    }

    #[test]
    fn inverse_fixture_identity_preserves_included_paths_without_basename_matching() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for folder in ["ascii", "한국 논문"] {
            for path in ["main.tex", "sections/shared.tex", "other/shared.tex"] {
                let target = root.join(folder).join(path);
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(target, "same literal source").unwrap();
            }
        }
        let ascii = manifest(&root, "ascii");
        let unicode = manifest(&root, "한국 논문");
        let a = fixture_source_identity(&root, &ascii, "sections/shared.tex").unwrap();
        let u = fixture_source_identity(&root, &unicode, "sections/shared.tex").unwrap();
        assert_eq!(a, "sections/shared.tex");
        assert_eq!(a, u);
        assert_ne!(
            a,
            fixture_source_identity(&root, &unicode, "other/shared.tex").unwrap()
        );
        std::fs::write(root.join("ascii/unrecorded.tex"), "not a compiled input").unwrap();
        assert_eq!(
            fixture_source_identity(&root, &ascii, "unrecorded.tex")
                .unwrap_err()
                .code,
            "SYNCTEX_FIXTURE_INVALID"
        );
    }
}
