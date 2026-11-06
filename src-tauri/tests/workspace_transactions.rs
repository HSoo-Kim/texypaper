use serde_json::json;
use std::fs;
use texypaper_lib::contracts::Environment;
use texypaper_lib::workspace::{
    WorkspaceManager, local,
    transactions::{self, Change},
};

fn root() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}
fn change(path: &str, base: &[u8], content: &str) -> Change {
    Change {
        path: path.into(),
        base_sha256: Some(local::hash(base)),
        content: content.into(),
        action: "edit".into(),
    }
}
#[test]
fn traversal_and_windows_streams_are_rejected() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    for path in [
        "../secret",
        "a/../b",
        "C:/secret",
        "//server/share",
        "a:b",
        "a\\b",
        "/etc/passwd",
        "a/./b",
        "a//b",
        "\0",
    ] {
        assert!(local::resolve(&root, path, true).is_err(), "{path}");
    }
}
#[cfg(windows)]
#[test]
fn save_waits_for_a_reader_that_briefly_denies_delete_sharing() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = root();
    let target = dir.path().join("paper.tex");
    fs::write(&target, b"before").unwrap();
    // Like a running TeX engine: readable by others, but not deletable/replaceable.
    let reader = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&target)
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        drop(reader);
    });
    transactions::atomic_write(&target, b"after").unwrap();
    release.join().unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"after");
    let leftovers = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0, "temporary replacement file leaked");
}
#[test]
fn same_length_external_write_conflicts() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("a.tex"), b"old").unwrap();
    let expected = local::hash(b"old");
    fs::write(root.join("a.tex"), b"new").unwrap();
    let error = transactions::save_text(&root, "a.tex", &expected, "our", "conflict").unwrap_err();
    assert_eq!(error.code, "FILE_CONFLICT");
    assert_eq!(fs::read(root.join("a.tex")).unwrap(), b"new");
}
#[test]
fn all_bases_are_checked_before_any_replacement() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("a.tex"), b"aaa").unwrap();
    fs::write(root.join("b.tex"), b"bbb").unwrap();
    let error = transactions::apply_proposal(
        &root,
        "multi",
        vec![
            change("a.tex", b"aaa", "changed"),
            change("b.tex", b"stale", "changed"),
        ],
    )
    .unwrap_err();
    assert_eq!(error.code, "FILE_CONFLICT");
    assert_eq!(fs::read(root.join("a.tex")).unwrap(), b"aaa");
    assert_eq!(fs::read(root.join("b.tex")).unwrap(), b"bbb");
}
#[test]
fn undo_does_not_overwrite_a_later_human_edit() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("a.tex"), b"before").unwrap();
    transactions::apply_proposal(&root, "edit", vec![change("a.tex", b"before", "after")]).unwrap();
    fs::write(root.join("a.tex"), b"human").unwrap();
    assert_eq!(
        transactions::undo_transaction(&root, "edit")
            .unwrap_err()
            .code,
        "FILE_CONFLICT"
    );
    assert_eq!(fs::read(root.join("a.tex")).unwrap(), b"human");
}
#[test]
fn utf8_bom_crlf_and_unaffected_bytes_survive_save_and_undo() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    let before = "\u{feff}한글 😀 e\u{301}\r\n두번째\r\n".as_bytes();
    fs::write(root.join("a.tex"), before).unwrap();
    let document = local::read_text(&root, "w", "a.tex", false).unwrap();
    assert_eq!(document["encoding"], "utf8Bom");
    assert_eq!(document["newline"], "crlf");
    let text = document["text"].as_str().unwrap().replace("두번째", "수정");
    transactions::save_text(&root, "a.tex", &local::hash(before), &text, "unicode").unwrap();
    assert_eq!(
        fs::read(root.join("a.tex")).unwrap(),
        "\u{feff}한글 😀 e\u{301}\r\n수정\r\n".as_bytes()
    );
    transactions::undo_transaction(&root, "unicode").unwrap();
    assert_eq!(fs::read(root.join("a.tex")).unwrap(), before);
}
#[test]
fn undecodable_source_is_read_only_and_cannot_be_overwritten() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("legacy.tex"), [0xff, 0xfe, 0x40]).unwrap();
    let value = local::read_text(&root, "w", "legacy.tex", false).unwrap();
    assert_eq!(value["readOnly"], true);
    assert_eq!(value["warning"]["code"], "ENCODING_UNSUPPORTED");
    assert_eq!(
        transactions::save_text(
            &root,
            "legacy.tex",
            &local::hash(&[0xff, 0xfe, 0x40]),
            "copy",
            "legacy"
        )
        .unwrap_err()
        .code,
        "ENCODING_UNSUPPORTED"
    );
}
#[test]
fn transaction_status_is_idempotent_evidence_not_write_replay() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("a.tex"), b"old").unwrap();
    transactions::apply_proposal(&root, "once", vec![change("a.tex", b"old", "new")]).unwrap();
    let value = transactions::status(&root, "once").unwrap();
    assert_eq!(value["status"], "committed");
    assert_eq!(value["files"][0]["matchesResult"], true);
    assert_eq!(
        transactions::apply_proposal(&root, "once", vec![change("a.tex", b"new", "twice")])
            .unwrap_err()
            .code,
        "TRANSACTION_EXISTS"
    );
    assert_eq!(fs::read(root.join("a.tex")).unwrap(), b"new");
}
#[test]
fn old_epoch_cannot_access_a_new_workspace() {
    let dir = root();
    let data = root();
    let env = Environment {
        id: "local".into(),
        label: "Local".into(),
        kind: "local".into(),
        host_alias: None,
        hostname: None,
        user: None,
        port: None,
        identity_file: None,
        ssh_config_file: None,
    };
    let mut manager = WorkspaceManager::new(data.path().into());
    let first = manager
        .open(env.clone(), dir.path().to_string_lossy().into())
        .unwrap();
    let old = manager.active(&first.id, first.epoch).unwrap();
    manager.close().unwrap();
    let second = manager
        .open(env, dir.path().to_string_lossy().into())
        .unwrap();
    assert!(second.epoch > first.epoch);
    assert!(manager.active(&first.id, first.epoch).is_err());
    assert_eq!(
        old.execute("ping", json!({})).unwrap_err().code,
        "WORKSPACE_STALE"
    );
}
#[cfg(unix)]
#[test]
fn symlink_parent_escape_is_rejected() {
    use std::os::unix::fs::symlink;
    let dir = root();
    let outside = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    symlink(outside.path(), root.join("escape")).unwrap();
    assert_eq!(
        local::resolve(&root, "escape/new.tex", true)
            .unwrap_err()
            .code,
        "PATH_OUTSIDE_WORKSPACE"
    );
}
#[cfg(windows)]
#[test]
fn later_replacement_failure_rolls_back_only_its_own_result() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("a.tex"), b"first").unwrap();
    fs::write(root.join("b.tex"), b"second").unwrap();
    let original_permissions = fs::metadata(root.join("b.tex")).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(root.join("b.tex"), permissions).unwrap();
    let result = transactions::apply_proposal(
        &root,
        "rollback",
        vec![
            change("a.tex", b"first", "changed"),
            change("b.tex", b"second", "changed"),
        ],
    );
    fs::set_permissions(root.join("b.tex"), original_permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(root.join("a.tex")).unwrap(), b"first");
    assert_eq!(fs::read(root.join("b.tex")).unwrap(), b"second");
    let status = transactions::status(&root, "rollback").unwrap();
    assert_eq!(status["status"], "rolledBack");
    assert_eq!(status["files"][0]["matchesOriginal"], true);
}
#[test]
fn paper_discovery_is_filename_based_persistent_and_not_pdf_classification() {
    let dir = root();
    let data = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir_all(root.join("ancestor/deep/paper")).unwrap();
    fs::create_dir(root.join("pdf-only")).unwrap();
    fs::write(root.join("ancestor/deep/paper/main.tex"), [0xff, 0xfe]).unwrap();
    fs::write(root.join("pdf-only/reference.pdf"), b"%PDF-1.7").unwrap();
    let initial = local::execute(&root, "w", data.path(), "list_dir", json!({"path":""})).unwrap();
    assert_eq!(
        initial["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "pdf-only")
            .unwrap()["paper"],
        "unknown"
    );
    for _ in 0..20 {
        let result =
            local::execute(&root, "w", data.path(), "scan_step", json!({"limit":1})).unwrap();
        assert!(result["entries"].as_array().unwrap().len() <= 1);
        if result["complete"] == true {
            break;
        }
    }
    let listed = local::execute(
        &root,
        "reopened",
        data.path(),
        "list_dir",
        json!({"path":""}),
    )
    .unwrap();
    let entries = listed["entries"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry["name"] == "ancestor")
            .unwrap()["paper"],
        "descendant"
    );
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry["name"] == "pdf-only")
            .unwrap()["paper"],
        "none"
    );
    let direct = local::execute(
        &root,
        "w",
        data.path(),
        "list_dir",
        json!({"path":"ancestor/deep"}),
    )
    .unwrap();
    assert_eq!(direct["entries"][0]["paper"], "direct");
    assert_eq!(direct["entries"][0]["evidence"][0], "main.tex");
}
#[cfg(unix)]
#[test]
fn agent_read_policy_checks_canonical_target_not_symlink_alias() {
    use std::os::unix::fs::symlink;
    let dir = root();
    let data = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join(".env"), b"SECRET=private").unwrap();
    symlink(".env", root.join("ordinary.txt")).unwrap();
    let result = local::execute(
        &root,
        "w",
        data.path(),
        "read_text",
        json!({"path":"ordinary.txt","_agentPolicy":true}),
    );
    assert_eq!(result.unwrap_err().code, "AGENT_READ_DENIED");
    let result = local::execute(
        &root,
        "w",
        data.path(),
        "search_text",
        json!({"query":"private","_agentPolicy":true}),
    )
    .unwrap();
    assert!(result["matches"].as_array().unwrap().is_empty());
}
#[test]
fn transaction_status_unknown_does_not_create_project_files() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    assert_eq!(
        transactions::status(&root, "missing").unwrap()["status"],
        "unknown"
    );
    assert!(!root.join(".texypaper").exists());
}
#[test]
fn large_file_requires_explicit_full_edit_permission() {
    let dir = root();
    let root = fs::canonicalize(dir.path()).unwrap();
    let source = "x".repeat(5 * 1024 * 1024);
    fs::write(root.join("large.tex"), source.as_bytes()).unwrap();
    let preview = local::read_text(&root, "w", "large.tex", false).unwrap();
    assert_eq!(preview["readOnly"], true);
    assert_eq!(preview["truncated"], true);
    assert!(preview["text"].as_str().unwrap().len() <= 1024 * 1024);
    let editable = local::read_text(&root, "w", "large.tex", true).unwrap();
    assert_eq!(editable["readOnly"], false);
    assert_eq!(editable["text"].as_str().unwrap().len(), source.len());
    assert_eq!(
        editable["revision"]["sha256"],
        local::hash(source.as_bytes())
    );
}
