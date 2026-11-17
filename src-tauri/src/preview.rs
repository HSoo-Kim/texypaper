//! Read-only, bounded transfer of a published generation; never read live source files.
use crate::{
    contracts::{AppError, AppResult},
    latex::artifacts::{self, BuildManifest},
    workspace::Workspace,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashSet, fs, io::Read, path::Path};

pub const MAX_INPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const CHUNK_BYTES: usize = 384 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Inputs {
    build_id: String,
    root_tex: String,
    engine: String,
    files: Vec<Input>,
}
#[derive(Serialize)]
struct Input {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    sha256: String,
}
fn unavailable(message: impl Into<String>) -> AppError {
    AppError::new("PREVIEW_INPUTS_UNAVAILABLE", message)
}
fn require(condition: bool, message: &str) -> AppResult<()> {
    if condition {
        Ok(())
    } else {
        Err(unavailable(message))
    }
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && !path.contains([':', '\\'])
        && path.split('/').all(|p| !matches!(p, "" | "." | ".."))
        && !path.split('/').next().is_some_and(|p| {
            p.eq_ignore_ascii_case(".texypaper") || p.eq_ignore_ascii_case(".paperdock")
        })
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn known(known_files: Option<&serde_json::Map<String, Value>>, path: &str, hash: &str) -> bool {
    known_files
        .and_then(|files| files.get(path))
        .and_then(Value::as_str)
        == Some(hash)
}
fn header(build_id: &str, root_tex: &str, engine: &str, count: usize) -> AppResult<()> {
    require(
        uuid::Uuid::parse_str(build_id).is_ok(),
        "Invalid published build ID",
    )?;
    require(safe_path(root_tex), "Invalid published root path")?;
    require(
        matches!(engine, "pdflatex" | "xelatex" | "lualatex"),
        "Unsupported published engine",
    )?;
    require(
        (1..=MAX_FILES).contains(&count),
        "Preview requires between 1 and 10,000 recorded inputs",
    )
}
fn local(
    root: &Path,
    workspace_id: &str,
    build_id: &str,
    known_files: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Inputs> {
    let manifest: BuildManifest = artifacts::manifest(root, build_id)?;
    require(
        manifest.workspace_id == workspace_id,
        "Published build belongs to a different workspace",
    )?;
    // Native PDF mapping readiness is independent of input authorization:
    // immutable snapshots are checked below, and the disposable WASM compile
    // creates its own PDF and source mapping.
    header(
        build_id,
        &manifest.root_tex,
        &manifest.engine,
        manifest.sources.len(),
    )?;
    let root = root.canonicalize()?;
    let root_id = artifacts::hash_bytes(manifest.root_tex.as_bytes());
    let prefix = format!(".texypaper/build/{}/published/{build_id}/", &root_id[..24]);
    let generation = artifacts::checked(&root, prefix.trim_end_matches('/'))?;
    // Canonical authorization is stronger than merely being somewhere in the workspace.
    require(
        generation == root.join(prefix.trim_end_matches('/')),
        "Published generation was redirected",
    )?;
    let mut files = Vec::with_capacity(manifest.sources.len());
    let mut seen = HashSet::new();
    let mut total = 0;
    for source in &manifest.sources {
        require(
            safe_path(&source.path) && seen.insert(source.path.clone()),
            "Invalid or duplicate recorded source path",
        )?;
        require(valid_hash(&source.sha256), "Invalid recorded source hash")?;
        let suffix = source
            .snapshot_path
            .strip_prefix(&prefix)
            .ok_or_else(|| unavailable("Snapshot does not belong to this published generation"))?;
        let (directory, _) = suffix
            .split_once('/')
            .ok_or_else(|| unavailable("Invalid snapshot layout"))?;
        require(
            matches!(directory, "sources-0" | "sources-1" | "sources-2"),
            "Invalid snapshot directory",
        )?;
        let path = artifacts::checked(&root, &source.snapshot_path)?;
        require(
            path.starts_with(&generation) && path.is_file(),
            "Snapshot escaped its published generation",
        )?;
        let mut bytes = Vec::new();
        let mut input = fs::File::open(&path)?;
        let length = input.metadata()?.len();
        require(
            length <= (MAX_INPUT_BYTES - total) as u64,
            "Preview inputs exceed 128 MiB",
        )?;
        if known(known_files, &source.path, &source.sha256) {
            total += length as usize;
            files.push(Input {
                path: source.path.clone(),
                data: None,
                sha256: source.sha256.clone(),
            });
            continue;
        }
        bytes.reserve_exact(length as usize);
        input
            .by_ref()
            .take((MAX_INPUT_BYTES - total + 1) as u64)
            .read_to_end(&mut bytes)?;
        require(
            bytes.len() <= MAX_INPUT_BYTES - total,
            "Preview inputs exceed 128 MiB",
        )?;
        require(
            artifacts::hash_bytes(&bytes) == source.sha256,
            "Published snapshot hash changed",
        )?;
        total += bytes.len();
        files.push(Input {
            path: source.path.clone(),
            data: Some(STANDARD.encode(bytes)),
            sha256: source.sha256.clone(),
        });
    }
    require(
        seen.contains(&manifest.root_tex),
        "Published root source is missing",
    )?;
    Ok(Inputs {
        build_id: build_id.into(),
        root_tex: manifest.root_tex,
        engine: manifest.engine,
        files,
    })
}
fn remote(
    workspace: &Workspace,
    build_id: &str,
    known_files: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Inputs> {
    let metadata = workspace.execute("preview_inputs", json!({"buildId":build_id}))?;
    let root_tex = metadata["rootTex"]
        .as_str()
        .ok_or_else(|| unavailable("Missing preview root"))?;
    let engine = metadata["engine"]
        .as_str()
        .ok_or_else(|| unavailable("Missing preview engine"))?;
    let count = metadata["fileCount"]
        .as_u64()
        .filter(|n| *n <= MAX_FILES as u64)
        .ok_or_else(|| unavailable("Invalid preview input count"))? as usize;
    require(
        metadata["buildId"] == build_id,
        "Remote preview build identity changed",
    )?;
    header(build_id, root_tex, engine, count)?;
    let mut files = Vec::with_capacity(count);
    let mut seen = HashSet::new();
    let mut total = 0;
    for index in 0..count {
        workspace.ensure_open()?;
        let record = workspace.execute(
            "preview_inputs",
            json!({"buildId":build_id,"fileIndex":index,"metadataOnly":true}),
        )?;
        require(
            record["buildId"] == build_id && record["fileIndex"].as_u64() == Some(index as u64),
            "Remote preview input identity changed",
        )?;
        let path = record["path"]
            .as_str()
            .filter(|p| safe_path(p))
            .ok_or_else(|| unavailable("Invalid remote recorded path"))?;
        let hash = record["sha256"]
            .as_str()
            .filter(|h| valid_hash(h))
            .ok_or_else(|| unavailable("Invalid remote recorded hash"))?;
        let length = record["length"]
            .as_u64()
            .filter(|n| *n <= (MAX_INPUT_BYTES - total) as u64)
            .ok_or_else(|| unavailable("Preview inputs exceed 128 MiB"))?
            as usize;
        require(
            seen.insert(path.to_owned()),
            "Duplicate remote recorded path",
        )?;
        total += length;
        if known(known_files, path, hash) {
            files.push(Input {
                path: path.into(),
                sha256: hash.into(),
                data: None,
            });
            continue;
        }
        let mut bytes = Vec::with_capacity(length);
        while bytes.len() < length {
            workspace.ensure_open()?;
            let chunk = workspace.execute(
                "preview_inputs",
                json!({"buildId":build_id,"fileIndex":index,"offset":bytes.len()}),
            )?;
            require(
                chunk["buildId"] == build_id
                    && chunk["fileIndex"].as_u64() == Some(index as u64)
                    && chunk["offset"].as_u64() == Some(bytes.len() as u64)
                    && chunk["path"] == path
                    && chunk["sha256"] == hash
                    && chunk["length"].as_u64() == Some(length as u64),
                "Remote snapshot identity changed during transfer",
            )?;
            let encoded = chunk["data"]
                .as_str()
                .filter(|s| s.len() <= CHUNK_BYTES * 4 / 3)
                .ok_or_else(|| unavailable("Invalid remote preview data"))?;
            let data = STANDARD
                .decode(encoded)
                .map_err(|_| unavailable("Invalid remote base64 data"))?;
            require(
                !data.is_empty() && data.len() <= CHUNK_BYTES && bytes.len() + data.len() <= length,
                "Remote preview chunk is truncated or exceeds recorded size",
            )?;
            bytes.extend_from_slice(&data);
        }
        require(
            artifacts::hash_bytes(&bytes) == hash,
            "Remote published snapshot hash changed",
        )?;
        files.push(Input {
            path: path.into(),
            sha256: hash.into(),
            data: Some(STANDARD.encode(bytes)),
        });
    }
    require(
        seen.contains(root_tex),
        "Remote published root source is missing",
    )?;
    Ok(Inputs {
        build_id: build_id.into(),
        root_tex: root_tex.into(),
        engine: engine.into(),
        files,
    })
}

pub fn inputs(workspace: &Workspace, args: &Value) -> AppResult<Value> {
    workspace.ensure_open()?;
    let build_id = args["buildId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| unavailable("A published build ID is required"))?;
    let known_files = match args.get("knownFiles") {
        None => None,
        Some(Value::Object(files))
            if files.len() <= MAX_FILES
                && files.iter().all(|(path, hash)| {
                    safe_path(path) && hash.as_str().is_some_and(valid_hash)
                }) =>
        {
            Some(files)
        }
        _ => {
            return Err(unavailable(
                "knownFiles must contain at most 10,000 normalized paths and SHA-256 hashes",
            ));
        }
    };
    let result = if let Some(root) = workspace.local_root() {
        local(&root, &workspace.reference.id, build_id, known_files)
    } else {
        remote(workspace, build_id, known_files)
    }
    .map_err(|error| unavailable(error.message))?;
    // A workspace switch while reading must not publish an obsolete bundle.
    workspace.ensure_open()?;
    Ok(serde_json::to_value(result)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORDED: [(&str, &str); 3] = [
        ("main.tex", "\\input{body}\\bibliography{refs}"),
        ("body.tex", "recorded body"),
        ("refs.bib", "recorded bibliography"),
    ];

    fn unstable_generation() -> (tempfile::TempDir, BuildManifest) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        for (path, text) in RECORDED {
            fs::write(root.join(path), text).unwrap();
        }
        let build_id = uuid::Uuid::new_v4().to_string();
        let root_id = artifacts::hash_bytes(b"main.tex");
        let prefix = format!(".texypaper/build/{}/published/{build_id}", &root_id[..24]);
        let generation = root.join(&prefix);
        let paths = RECORDED
            .iter()
            .map(|(path, _)| (*path).to_owned())
            .collect::<Vec<_>>();
        let sources = artifacts::snapshot(&root, &paths, &generation.join("sources-0")).unwrap();
        let manifest = BuildManifest {
            version: 1,
            build_id,
            workspace_id: "paper".into(),
            root_tex: "main.tex".into(),
            engine: "pdflatex".into(),
            cwd: root.to_string_lossy().into_owned(),
            job_name: "main".into(),
            started_at: String::new(),
            finished_at: String::new(),
            pdf_sha256: artifacts::hash_bytes(b"native pdf"),
            sync_sha256: artifacts::hash_bytes(b"native synctex"),
            sources,
            mapping_ready: false,
            pdf_length: 10,
            pdf_path: format!("{prefix}/main.pdf"),
            sync_path: format!("{prefix}/main.synctex.gz"),
            mapping_reason: Some("Sources changed during native compilation".into()),
        };
        fs::write(
            generation.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        (directory, manifest)
    }

    #[test]
    fn unstable_native_mapping_serves_verified_immutable_compiler_inputs() {
        let (directory, manifest) = unstable_generation();
        // Resumed typing and later bibliography edits must not replace published bytes.
        fs::write(directory.path().join("body.tex"), "new body").unwrap();
        fs::write(directory.path().join("refs.bib"), "new bibliography").unwrap();
        let inputs = local(directory.path(), "paper", &manifest.build_id, None).unwrap();
        assert_eq!(inputs.build_id, manifest.build_id);
        assert_eq!(inputs.root_tex, "main.tex");
        assert_eq!(inputs.engine, "pdflatex");
        assert_eq!(inputs.files.len(), RECORDED.len());
        for (file, (path, text)) in inputs.files.iter().zip(RECORDED) {
            assert_eq!(file.path, path);
            assert_eq!(file.sha256, artifacts::hash_bytes(text.as_bytes()));
            assert_eq!(
                STANDARD.decode(file.data.as_deref().unwrap()).unwrap(),
                text.as_bytes()
            );
        }
        let known_files: serde_json::Map<String, Value> = manifest
            .sources
            .iter()
            .map(|source| (source.path.clone(), Value::String(source.sha256.clone())))
            .collect();
        let delta = local(
            directory.path(),
            "paper",
            &manifest.build_id,
            Some(&known_files),
        )
        .unwrap();
        assert_eq!(delta.files.len(), RECORDED.len());
        assert!(delta.files.iter().all(|file| file.data.is_none()));
        assert!(
            !artifacts::manifest(directory.path(), &manifest.build_id)
                .unwrap()
                .mapping_ready
        );
    }

    #[test]
    fn unstable_native_mapping_rejects_corrupt_or_missing_input_snapshots() {
        for missing in [false, true] {
            let (directory, manifest) = unstable_generation();
            let snapshot = directory.path().join(&manifest.sources[1].snapshot_path);
            if missing {
                fs::remove_file(snapshot).unwrap();
            } else {
                fs::write(snapshot, "corrupted snapshot").unwrap();
            }
            assert!(local(directory.path(), "paper", &manifest.build_id, None).is_err());
        }
    }

    #[test]
    fn unstable_native_mapping_still_requires_root_and_generation_owned_inputs() {
        for missing_root in [false, true] {
            let (directory, mut manifest) = unstable_generation();
            if missing_root {
                manifest.sources.retain(|source| source.path != "main.tex");
            } else {
                manifest.sources[1].snapshot_path = "body.tex".into();
            }
            let root_id = artifacts::hash_bytes(b"main.tex");
            let path = directory.path().join(format!(
                ".texypaper/build/{}/published/{}/manifest.json",
                &root_id[..24],
                manifest.build_id
            ));
            fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            assert!(local(directory.path(), "paper", &manifest.build_id, None).is_err());
        }
    }

    #[test]
    fn recorded_paths_exclude_traversal_and_private_state() {
        for path in [
            "../main.tex",
            "/main.tex",
            "a//b",
            "a/./b",
            "a\\b",
            "C:main.tex",
            ".TeXyPaper/key",
            "a\n.tex",
        ] {
            assert!(!safe_path(path), "{path}");
        }
        assert!(safe_path("chapters/한글 figure.png"));
    }
}
