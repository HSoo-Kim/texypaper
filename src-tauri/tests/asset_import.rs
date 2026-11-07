use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use texypaper_lib::{contracts::AppResult, workspace::local};

struct Fixture {
    _root: tempfile::TempDir,
    _data: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        Self {
            root: fs::canonicalize(root.path()).unwrap(),
            data: data.path().into(),
            _root: root,
            _data: data,
        }
    }
    fn call(&self, op: &str, args: Value) -> AppResult<Value> {
        local::execute(&self.root, "asset-tests", &self.data, op, args)
    }
    fn begin(&self, path: &str, data: &[u8]) -> String {
        self.call(
            "asset_import_begin",
            json!({"path":path,"byteLength":data.len(),"sha256":local::hash(data)}),
        )
        .unwrap()["uploadId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn chunk(&self, id: &str, index: usize, data: &[u8]) -> AppResult<Value> {
        self.call(
            "asset_import_chunk",
            json!({"uploadId":id,"index":index,"data":STANDARD.encode(data)}),
        )
    }
    fn temps(&self, directory: &str) -> usize {
        fs::read_dir(self.root.join(directory))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".texypaper-asset-")
            })
            .count()
    }
}
#[test]
fn imports_three_mib_png_and_verifies_hash_with_nested_parents() {
    let fixture = Fixture::new();
    let mut bytes = vec![0u8; 3 * 1024 * 1024];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    for (index, byte) in bytes[8..].iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    let id = fixture.begin("figures/results/plot.png", &bytes);
    for (index, chunk) in bytes.chunks(192 * 1024).enumerate() {
        fixture.chunk(&id, index, chunk).unwrap();
    }
    let result = fixture
        .call("asset_import_commit", json!({"uploadId":id}))
        .unwrap();
    assert_eq!(result["path"], "figures/results/plot.png");
    assert_eq!(result["byteLength"], bytes.len());
    assert_eq!(result["sha256"], local::hash(&bytes));
    assert_eq!(
        fs::read(fixture.root.join("figures/results/plot.png")).unwrap(),
        bytes
    );
    assert_eq!(fixture.temps("figures/results"), 0);
}
#[test]
fn refuses_existing_destination_at_begin_and_racing_commit() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("existing.png"), b"original").unwrap();
    let args = json!({"path":"existing.png","byteLength":1,"sha256":local::hash(b"x")});
    assert_eq!(
        fixture.call("asset_import_begin", args).unwrap_err().code,
        "ALREADY_EXISTS"
    );
    let id = fixture.begin("racing.png", b"ours");
    fixture.chunk(&id, 0, b"ours").unwrap();
    fs::write(fixture.root.join("racing.png"), b"external").unwrap();
    assert_eq!(
        fixture
            .call("asset_import_commit", json!({"uploadId":id}))
            .unwrap_err()
            .code,
        "ALREADY_EXISTS"
    );
    assert_eq!(
        fs::read(fixture.root.join("racing.png")).unwrap(),
        b"external"
    );
    assert_eq!(fixture.temps(""), 0);
}
#[test]
fn refuses_unsafe_paths_extensions_and_size_before_staging() {
    let fixture = Fixture::new();
    for path in [
        "../escape.png",
        "C:/escape.png",
        "plot.png:stream",
        "a/../plot.png",
        ".git/image.png",
        "sub/.texypaper/image.png",
        ".paperdock/image.png",
        "CON.png",
        "LPT1/image.png",
    ] {
        assert!(
            fixture
                .call(
                    "asset_import_begin",
                    json!({"path":path,"byteLength":0,"sha256":local::hash(b"")})
                )
                .is_err(),
            "{path}"
        );
    }
    assert_eq!(
        fixture
            .call(
                "asset_import_begin",
                json!({"path":"bad.exe","byteLength":0,"sha256":local::hash(b"")})
            )
            .unwrap_err()
            .code,
        "ASSET_EXTENSION"
    );
    assert_eq!(
        fixture
            .call(
                "asset_import_begin",
                json!({"path":"large.png","byteLength":20*1024*1024+1,"sha256":local::hash(b"")})
            )
            .unwrap_err()
            .code,
        "ASSET_TOO_LARGE"
    );
    assert_eq!(fixture.temps(""), 0);
}
#[test]
fn failed_hash_sequence_and_incomplete_uploads_clean_their_temps() {
    let fixture = Fixture::new();
    let id = fixture.begin("hash.png", b"expected");
    fixture.chunk(&id, 0, b"modified").unwrap();
    assert_eq!(
        fixture
            .call("asset_import_commit", json!({"uploadId":id}))
            .unwrap_err()
            .code,
        "ASSET_HASH_MISMATCH"
    );
    assert!(!fixture.root.join("hash.png").exists());
    let id = fixture.begin("sequence.png", b"x");
    assert_eq!(
        fixture.chunk(&id, 1, b"x").unwrap_err().code,
        "UPLOAD_SEQUENCE"
    );
    let id = fixture.begin("incomplete.png", b"xy");
    fixture.chunk(&id, 0, b"x").unwrap();
    assert_eq!(
        fixture
            .call("asset_import_commit", json!({"uploadId":id}))
            .unwrap_err()
            .code,
        "UPLOAD_INCOMPLETE"
    );
    assert_eq!(fixture.temps(""), 0);
}
#[test]
fn abort_removes_partial_temp_and_limit_is_two_uploads() {
    let fixture = Fixture::new();
    let first = fixture.begin("one.png", b"xy");
    fixture.chunk(&first, 0, b"x").unwrap();
    let second = fixture.begin("two.png", b"");
    assert_eq!(
        fixture
            .call(
                "asset_import_begin",
                json!({"path":"three.png","byteLength":0,"sha256":local::hash(b"")})
            )
            .unwrap_err()
            .code,
        "UPLOAD_BUSY"
    );
    assert_eq!(fixture.temps(""), 2);
    for id in [first, second] {
        assert_eq!(
            fixture
                .call("asset_import_abort", json!({"uploadId":id}))
                .unwrap()["aborted"],
            true
        );
    }
    assert_eq!(fixture.temps(""), 0);
    assert!(!fixture.root.join("one.png").exists());
}
#[cfg(unix)]
#[test]
fn refuses_symlink_parent_outside_root() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), fixture.root.join("escape")).unwrap();
    assert!(
        fixture
            .call(
                "asset_import_begin",
                json!({"path":"escape/plot.png","byteLength":0,"sha256":local::hash(b"")})
            )
            .is_err()
    );
    assert!(!outside.path().join("plot.png").exists());
}
