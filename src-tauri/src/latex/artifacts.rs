use crate::contracts::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevision {
    pub path: String,
    pub sha256: String,
    pub snapshot_path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildManifest {
    pub version: u8,
    pub build_id: String,
    pub workspace_id: String,
    pub root_tex: String,
    pub engine: String,
    pub cwd: String,
    pub job_name: String,
    pub started_at: String,
    pub finished_at: String,
    pub pdf_sha256: String,
    pub sync_sha256: String,
    pub sources: Vec<SourceRevision>,
    pub mapping_ready: bool,
    pub pdf_length: u64,
    pub pdf_path: String,
    pub sync_path: String,
    #[serde(default)]
    pub mapping_reason: Option<String>,
}
pub fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn hash_file(path: &Path) -> AppResult<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn checked(root: &Path, relative: &str) -> AppResult<PathBuf> {
    if relative.is_empty()
        || relative.contains(['\0', ':', '\\'])
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(AppError::new(
            "PATH_INVALID",
            "작업 공간 상대 경로가 필요합니다",
        ));
    }
    let root = root.canonicalize()?;
    let p = root.join(relative);
    let canonical = if p.exists() {
        p.canonicalize()?
    } else {
        let parent = p
            .parent()
            .ok_or_else(|| AppError::new("PATH_INVALID", "부모 경로 없음"))?
            .canonicalize()?;
        parent.join(
            p.file_name()
                .ok_or_else(|| AppError::new("PATH_INVALID", "파일명 없음"))?,
        )
    };
    if !canonical.starts_with(&root) {
        return Err(AppError::new("PATH_ESCAPE", "작업 공간 밖 경로입니다"));
    }
    Ok(canonical)
}
pub fn relative(root: &Path, path: &Path) -> AppResult<String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| AppError::new("PATH_ESCAPE", "작업 공간 밖 입력"))?
        .to_string_lossy()
        .replace('\\', "/"))
}
/// Keep canonical paths for filesystem authorization, but do not expose Win32
/// verbatim/device namespaces to TeX's kpathsea/latexmk path parsers.
pub fn tool_path(path: &Path) -> AppResult<String> {
    if !path.is_absolute() {
        return Err(AppError::new(
            "TEX_PATH_INVALID",
            "TeX 도구에는 절대 경로가 필요합니다",
        ));
    }
    let text = path.to_str().ok_or_else(|| {
        AppError::new(
            "TEX_PATH_ENCODING",
            "TeX 도구에 전달할 경로를 Unicode로 표현할 수 없습니다",
        )
    })?;
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(format!("//{}", rest.replace('\\', "/")));
        }
        let ordinary = if let Some(rest) = text.strip_prefix(r"\\?\") {
            let bytes = rest.as_bytes();
            if bytes.len() < 3
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || bytes[2] != b'\\'
            {
                return Err(AppError::new(
                    "TEX_PATH_INVALID",
                    "TeX 도구는 Windows 장치 경로를 지원하지 않습니다",
                ));
            }
            rest
        } else {
            if text.starts_with(r"\\.\") {
                return Err(AppError::new(
                    "TEX_PATH_INVALID",
                    "TeX 도구는 Windows 장치 경로를 지원하지 않습니다",
                ));
            }
            text
        };
        Ok(ordinary.replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        Ok(text.to_owned())
    }
}
pub fn manifest(root: &Path, id: &str) -> AppResult<BuildManifest> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(AppError::new("BUILD_UNKNOWN", "잘못된 빌드 식별자"));
    }
    let canonical = root.canonicalize()?;
    let base = root.join(".texypaper/build");
    if base.exists() {
        for entry in fs::read_dir(base)? {
            let candidate = entry?
                .path()
                .join("published")
                .join(id)
                .join("manifest.json");
            if !candidate.is_file() {
                continue;
            }
            if !candidate.canonicalize()?.starts_with(&canonical)
                || fs::metadata(&candidate)?.len() > 8 * 1024 * 1024
            {
                return Err(AppError::new(
                    "MANIFEST_INVALID",
                    "게시 기록 경로 또는 크기가 유효하지 않습니다",
                ));
            }
            let m: BuildManifest = serde_json::from_reader(fs::File::open(candidate)?)?;
            let hash_valid = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
            if m.version != 1
                || m.build_id != id
                || !matches!(m.engine.as_str(), "pdflatex" | "xelatex" | "lualatex")
                || !hash_valid(&m.pdf_sha256)
                || !hash_valid(&m.sync_sha256)
                || m.sources.len() > 20000
                || m.sources.iter().any(|s| !hash_valid(&s.sha256))
            {
                return Err(AppError::new(
                    "MANIFEST_INVALID",
                    "게시 기록의 버전·엔진·해시·식별자가 유효하지 않습니다",
                ));
            }
            let cwd = Path::new(&m.cwd);
            if !cwd.is_absolute()
                || cwd.components().any(|c| matches!(c, Component::ParentDir))
                || !cwd.starts_with(&canonical)
            {
                return Err(AppError::new(
                    "MANIFEST_INVALID",
                    "기록된 컴파일 경로가 작업 공간 밖입니다",
                ));
            }
            return Ok(m);
        }
    }
    Err(AppError::new(
        "BUILD_UNKNOWN",
        "빌드가 보관되어 있지 않습니다",
    ))
}
pub fn snapshot(root: &Path, paths: &[String], dir: &Path) -> AppResult<Vec<SourceRevision>> {
    fs::create_dir_all(dir)?;
    let mut sources = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let source = checked(root, path)?;
        if !source.is_file() {
            continue;
        }
        let dest = dir.join(format!("{i}.source"));
        let mut input = fs::File::open(&source)?;
        let mut output = fs::File::create(&dest)?;
        let mut h = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            h.update(&buffer[..n]);
            output.write_all(&buffer[..n])?
        }
        output.sync_all()?;
        sources.push(SourceRevision {
            path: path.clone(),
            sha256: format!("{:x}", h.finalize()),
            snapshot_path: relative(root, &dest)?,
        });
    }
    Ok(sources)
}
pub fn revisions_match(root: &Path, sources: &[SourceRevision]) -> bool {
    sources.iter().all(|s| {
        checked(root, &s.path)
            .and_then(|p| hash_file(&p))
            .is_ok_and(|h| h == s.sha256)
    })
}
pub fn discover_inputs(root: &Path, cwd: &Path, fls: &Path) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    if fs::metadata(fls)?.len() > 64 * 1024 * 1024 {
        return Err(AppError::new(
            "BUILD_INPUT_LIMIT",
            "입력 기록 파일이 너무 큽니다",
        ));
    }
    for line in std::io::BufRead::lines(std::io::BufReader::new(fs::File::open(fls)?)) {
        let line = line?;
        if let Some(p) = line.strip_prefix("INPUT ") {
            let p = cwd.join(p);
            if let Ok(p) = p.canonicalize()
                && p.is_file()
                && p.starts_with(root)
                && !p.starts_with(root.join(".texypaper"))
                && !p.starts_with(root.join(".paperdock"))
            // Legacy private snapshots are not sources.
            {
                out.push(relative(root, &p)?);
            }
        }
    }
    out.sort();
    out.dedup();
    if out.len() > 20000 {
        return Err(AppError::new(
            "BUILD_INPUT_LIMIT",
            "작업 공간 입력 파일이 20,000개를 초과했습니다",
        ));
    }
    Ok(out)
}
pub fn prune_generations(root: &Path, root_id: &str, keep: &str) -> AppResult<()> {
    let dir = root
        .join(".texypaper/build")
        .join(root_id)
        .join("published");
    let mut entries = fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .collect::<Vec<_>>();
    entries.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    let mut retained_other = false;
    for e in entries {
        if e.file_name() == keep {
            continue;
        }
        if !retained_other {
            retained_other = true;
            continue;
        }
        fs::remove_dir_all(e.path())?
    }
    Ok(())
}
