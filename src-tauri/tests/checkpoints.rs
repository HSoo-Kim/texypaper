use serde_json::{Value, json};
use std::fs;
use texypaper_lib::{checkpoints::execute, workspace::local::hash};

fn record(id: &str, timestamp: &str) -> Value {
    json!({"id":id,"name":"A checkpoint","createdAt":timestamp,"files":[{"path":"main.tex","sha256":hash(b"one\r\ntwo"),"text":"one\r\ntwo"}]})
}
fn id(index: usize) -> String {
    format!("00000000-0000-4000-8000-{index:012x}")
}
fn call(
    dir: &tempfile::TempDir,
    op: &str,
    args: &Value,
) -> Result<Value, texypaper_lib::contracts::AppError> {
    execute(dir.path(), "workspace-1", op, args)
}
#[test]
fn round_trip_delete_and_workspace_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let data = record(&id(1), "2026-11-07T01:00:00.000Z");
    assert_eq!(call(&dir, "checkpoint_put", &data).unwrap()["saved"], true);
    assert_eq!(
        call(&dir, "checkpoint_get", &json!({"id":id(1)})).unwrap(),
        data
    );
    let rows = call(&dir, "checkpoint_list", &json!({})).unwrap();
    assert_eq!(rows[0]["fileCount"], 1);
    assert_eq!(rows[0]["byteLength"], 8);
    assert_eq!(
        execute(dir.path(), "workspace-2", "checkpoint_list", &json!({})).unwrap(),
        json!([])
    );
    call(&dir, "checkpoint_delete", &json!({"id":id(1)})).unwrap();
    assert_eq!(
        call(&dir, "checkpoint_list", &json!({})).unwrap(),
        json!([])
    );
}
#[test]
fn validates_ids_hashes_paths_and_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let data = record(&id(1), "2026-11-07T01:00:00.000Z");
    call(&dir, "checkpoint_put", &data).unwrap();
    let mut changed = data.clone();
    changed["name"] = json!("Different");
    assert_eq!(
        call(&dir, "checkpoint_put", &changed).unwrap_err().code,
        "CHECKPOINT_EXISTS"
    );
    assert_eq!(
        call(&dir, "checkpoint_get", &json!({"id":id(1)})).unwrap(),
        data
    );
    for invalid in [
        "../escape",
        "C:/a",
        "00000000/0000-4000-8000-000000000001",
        "not-an-id",
    ] {
        assert_eq!(
            call(&dir, "checkpoint_get", &json!({"id":invalid}))
                .unwrap_err()
                .code,
            "CHECKPOINT_ID"
        );
    }
    let mut bad = record(&id(2), "2026-11-07T01:00:00.000Z");
    bad["files"][0]["sha256"] = json!("bad");
    assert_eq!(
        call(&dir, "checkpoint_put", &bad).unwrap_err().code,
        "CHECKPOINT_HASH"
    );
    for path in [
        "../escape.tex",
        ".git/config",
        "sub/.texypaper/state.json",
        "node_modules/x.tex",
    ] {
        let mut bad = record(&id(2), "2026-11-07T01:00:00.000Z");
        bad["files"][0]["path"] = json!(path);
        assert!(call(&dir, "checkpoint_put", &bad).is_err());
    }
    assert_eq!(
        fs::read_dir(dir.path().join("workspaces/workspace-1/checkpoints"))
            .unwrap()
            .count(),
        1
    );
}
#[test]
fn rejects_every_limit_and_accepts_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let mut data = record(&id(1), "2026-11-07T01:00:00.000Z");
    data["name"] = json!("한".repeat(121));
    assert_eq!(
        call(&dir, "checkpoint_put", &data).unwrap_err().code,
        "CHECKPOINT_LIMIT"
    );
    data["name"] = json!("한".repeat(120));
    data["files"] = json!(
        (0..401)
            .map(|i| json!({"path":format!("{i}.tex"),"text":"","sha256":hash(b"")}))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        call(&dir, "checkpoint_put", &data).unwrap_err().code,
        "CHECKPOINT_LIMIT"
    );
    let text = "a".repeat(1024 * 1024 + 1);
    data["files"] = json!([{"path":"a.tex","sha256":hash(text.as_bytes()),"text":text}]);
    assert_eq!(
        call(&dir, "checkpoint_put", &data).unwrap_err().code,
        "CHECKPOINT_LIMIT"
    );
    let text = "a".repeat(1024 * 1024);
    data["files"] = json!(
        (0..9)
            .map(|i| json!({"path":format!("{i}.tex"),"text":text,"sha256":hash(text.as_bytes())}))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        call(&dir, "checkpoint_put", &data).unwrap_err().code,
        "CHECKPOINT_LIMIT"
    );
    data["files"].as_array_mut().unwrap().pop();
    call(&dir, "checkpoint_put", &data).unwrap();
    assert_eq!(
        call(&dir, "checkpoint_list", &json!({})).unwrap()[0]["byteLength"],
        8 * 1024 * 1024
    );
}
#[test]
fn prunes_only_when_creating_over_cap_and_reports_oldest() {
    let dir = tempfile::tempdir().unwrap();
    for index in 1..=50 {
        let result = call(
            &dir,
            "checkpoint_put",
            &record(&id(index), &format!("2026-11-07T01:00:{index:02}.000Z")),
        )
        .unwrap();
        assert_eq!(result["pruned"], json!([]));
    }
    assert_eq!(
        call(&dir, "checkpoint_list", &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        50
    );
    let result = call(
        &dir,
        "checkpoint_put",
        &record(&id(51), "2026-11-07T01:01:00.000Z"),
    )
    .unwrap();
    assert_eq!(result["pruned"], json!([id(1)]));
    let rows = call(&dir, "checkpoint_list", &json!({})).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 50);
    assert_eq!(rows[0]["id"], id(51));
    assert!(call(&dir, "checkpoint_get", &json!({"id":id(1)})).is_err());
}
#[test]
fn corrupt_records_are_reported_without_loading_them_as_checkpoints() {
    let dir = tempfile::tempdir().unwrap();
    call(
        &dir,
        "checkpoint_put",
        &record(&id(1), "2026-11-07T01:00:00.000Z"),
    )
    .unwrap();
    let folder = dir.path().join("workspaces/workspace-1/checkpoints");
    fs::write(folder.join(format!("{}.json", id(2))), "{broken").unwrap();
    fs::write(folder.join(".ignored.tmp"), "unfinished").unwrap();
    let rows = call(&dir, "checkpoint_list", &json!({})).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert_eq!(rows[0]["id"], id(1));
    assert_eq!(rows[1]["corrupt"], true);
    assert_eq!(
        call(&dir, "checkpoint_get", &json!({"id":id(2)}))
            .unwrap_err()
            .code,
        "CHECKPOINT_CORRUPT"
    );
    call(&dir, "checkpoint_delete", &json!({"id":id(2)})).unwrap();
    assert_eq!(
        call(&dir, "checkpoint_list", &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
