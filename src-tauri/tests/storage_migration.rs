use serde_json::{Value, json};
use std::{fs, path::Path};
use texypaper_lib::{
    migration,
    workspace::{local, transactions},
};

fn write(root: &Path, path: &str, bytes: &[u8]) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn document(root: &Path, path: &str) -> Value {
    serde_json::from_slice(&fs::read(root.join(path)).unwrap()).unwrap()
}
#[test]
fn default_profile_moves_settings_recovery_and_opaque_credentials_without_copying() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("dev.paperdock.desktop");
    let target = temp.path().join("dev.texypaper.desktop");
    write(
        &old,
        "settings.json",
        br#"{"recents":["C:/papers"],"locale":"en"}"#,
    );
    write(
        &old,
        "providers/opaque-store",
        b"\0\xffunchanged synthetic credential bytes",
    );
    write(
        &old,
        "workspaces/stable-id/recovery/paper.json",
        b"recovery bytes",
    );
    write(&old, "webview/synthetic", b"webview bytes");
    let lock = migration::prepare_profile(&target, false).unwrap();
    assert!(!old.exists());
    assert_eq!(
        document(&target, "settings.json")["recents"],
        json!(["C:/papers"])
    );
    assert_eq!(
        fs::read(target.join("providers/opaque-store")).unwrap(),
        b"\0\xffunchanged synthetic credential bytes"
    );
    assert_eq!(
        fs::read(target.join("workspaces/stable-id/recovery/paper.json")).unwrap(),
        b"recovery bytes"
    );
    assert_eq!(
        fs::read(target.join("webview/synthetic")).unwrap(),
        b"webview bytes"
    );
    assert_eq!(
        migration::prepare_profile(&target, true).unwrap_err().code,
        "PROFILE_IN_USE"
    );
    drop(lock);
}
#[test]
fn explicit_profile_never_migrates_legacy_default_even_when_both_exist() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("dev.paperdock.desktop");
    let target = temp.path().join("dev.texypaper.desktop");
    write(&old, "settings.json", b"legacy");
    write(&target, "settings.json", b"explicit");
    let _lock = migration::prepare_profile(&target, true).unwrap();
    assert_eq!(fs::read(old.join("settings.json")).unwrap(), b"legacy");
    assert_eq!(fs::read(target.join("settings.json")).unwrap(), b"explicit");
}
#[test]
fn default_profile_collision_preserves_both_stores() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("dev.paperdock.desktop");
    let target = temp.path().join("dev.texypaper.desktop");
    write(&old, "settings.json", b"old");
    write(&target, "settings.json", b"new");
    assert_eq!(
        migration::prepare_profile(&target, false).unwrap_err().code,
        "MIGRATION_CONFLICT"
    );
    assert_eq!(fs::read(old.join("settings.json")).unwrap(), b"old");
    assert_eq!(fs::read(target.join("settings.json")).unwrap(), b"new");
}
#[cfg(windows)]
#[test]
fn running_legacy_windows_profile_prevents_migration() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("dev.paperdock.desktop");
    let target = temp.path().join("dev.texypaper.desktop");
    fs::create_dir(&old).unwrap();
    let _old_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(old.join("instance.lock"))
        .unwrap();
    assert_eq!(
        migration::prepare_profile(&target, false).unwrap_err().code,
        "PROFILE_IN_USE"
    );
    assert!(old.is_dir());
    assert!(!target.exists());
}
#[test]
fn project_migration_retains_settings_comments_recovery_trash_and_undo_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let canonical_root = fs::canonicalize(temp.path()).unwrap();
    let root = canonical_root.as_path();
    let old = root.join(".paperdock");
    write(root, "paper.tex", b"after");
    write(
        &old,
        "project.json",
        br#"{"version":1,"rootTex":"paper.tex","engine":"xelatex","autoBuild":false}"#,
    );
    let comments = br#"{"version":1,"threads":[],"note":"Paperdock .paperdock stays user prose"}"#;
    write(&old, "comments.json", comments);
    write(&old, "recovery/paper.json", b"opaque recovery");
    write(&old, "trash/t/content", b"trashed source");
    write(
        &old,
        "trash/t/metadata.json",
        br#"{"path":"removed.tex","status":"trashed"}"#,
    );
    write(&old, "transactions/edit/0.before", b"before");
    write(&old, "transactions/edit/0.after", b"after");
    write(&old, "transactions/edit/journal.json", &serde_json::to_vec(&json!({
        "version":1,"transactionId":"edit","status":"committed","affected":[],
        "records":[{"path":"paper.tex","before":local::hash(b"before"),"after":local::hash(b"after"),"backup":"0.before","stage":"0.after"}]
    })).unwrap());
    migration::migrate_project(root).unwrap();
    assert!(!old.exists());
    assert_eq!(
        document(root, ".texypaper/project.json")["engine"],
        "xelatex"
    );
    assert_eq!(
        fs::read(root.join(".texypaper/comments.json")).unwrap(),
        comments
    );
    assert_eq!(
        fs::read(root.join(".texypaper/recovery/paper.json")).unwrap(),
        b"opaque recovery"
    );
    transactions::undo_transaction(root, "edit").unwrap();
    assert_eq!(fs::read(root.join("paper.tex")).unwrap(), b"before");
    let data = tempfile::tempdir().unwrap();
    local::execute(
        root,
        "stable-id",
        data.path(),
        "restore",
        json!({"transactionId":"t"}),
    )
    .unwrap();
    assert_eq!(
        fs::read(root.join("removed.tex")).unwrap(),
        b"trashed source"
    );
    migration::migrate_project(root).unwrap();
}
#[test]
fn recognized_private_fields_move_but_user_payloads_and_backup_names_do_not() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".paperdock/transactions/t/journal.json", &serde_json::to_vec(&json!({
        "version":1,"records":[{"path":".paperdock/comments.json","backup":"0.before","stage":"0.after"}],
        "affected":[".paperdock/comments.json"],"message":".paperdock/comments.json",
        "files":[{"path":".paperdock/project.json","beforeFile":"0.before"}],
        "result":{"newPath":".paperdock/project.json","revisions":[{"file":{"path":".paperdock/project.json"}}]}
    })).unwrap());
    write(root, ".paperdock/build/latest.json", &serde_json::to_vec(&json!({"manifest":{
        "pdfPath":".paperdock/build/r/published/b/p.pdf","syncPath":".paperdock/build/r/published/b/p.synctex.gz",
        "mappingReady":true,"cwd":"C:/user/.paperdock-named-source","sources":[{"path":"paper.tex","snapshotPath":".paperdock/build/r/published/b/source.tex"}]
    }})).unwrap());
    write(
        root,
        ".paperdock/build/r/work/p.fdb_latexmk",
        b"opaque legacy .paperdock paths",
    );
    migration::migrate_project(root).unwrap();
    let record = document(root, ".texypaper/transactions/t/journal.json");
    assert_eq!(record["records"][0]["path"], ".texypaper/comments.json");
    assert_eq!(record["records"][0]["backup"], "0.before");
    assert_eq!(record["message"], ".paperdock/comments.json");
    assert_eq!(
        record["result"]["revisions"][0]["file"]["path"],
        ".texypaper/project.json"
    );
    let build = document(root, ".texypaper/build/latest.json");
    assert_eq!(
        build["manifest"]["pdfPath"],
        ".texypaper/build/r/published/b/p.pdf"
    );
    assert_eq!(
        build["manifest"]["sources"][0]["snapshotPath"],
        ".texypaper/build/r/published/b/source.tex"
    );
    assert_eq!(build["manifest"]["mappingReady"], false);
    assert_eq!(build["manifest"]["cwd"], "C:/user/.paperdock-named-source");
    assert_eq!(
        fs::read(root.join(".texypaper/build/r/work/p.fdb_latexmk")).unwrap(),
        b"opaque legacy .paperdock paths"
    );
}
#[test]
fn project_collision_and_invalid_records_fail_before_rename() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".paperdock/comments.json", b"legacy");
    write(root, ".texypaper/comments.json", b"new");
    assert_eq!(
        migration::migrate_project(root).unwrap_err().code,
        "MIGRATION_CONFLICT"
    );
    assert_eq!(
        fs::read(root.join(".paperdock/comments.json")).unwrap(),
        b"legacy"
    );
    fs::remove_dir_all(root.join(".texypaper")).unwrap();
    write(root, ".paperdock/transactions/t/journal.json", b"not json");
    assert_eq!(
        migration::migrate_project(root).unwrap_err().code,
        "MIGRATION_INVALID_RECORD"
    );
    assert!(!root.join(".texypaper").exists());
    assert!(!root.join(".paperdock/.texypaper-migration").exists());
}
#[test]
fn interrupted_project_migration_resumes_before_operations() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".texypaper/.texypaper-migration", b"1\n");
    write(
        root,
        ".texypaper/transactions/t/journal.json",
        br#"{"records":[{"path":".paperdock/comments.json"}],"affected":[]}"#,
    );
    migration::migrate_project(root).unwrap();
    assert_eq!(
        document(root, ".texypaper/transactions/t/journal.json")["records"][0]["path"],
        ".texypaper/comments.json"
    );
    assert!(!root.join(".texypaper/.texypaper-migration").exists());
    write(root, ".texypaper/.texypaper-migration", b"unknown");
    assert_eq!(
        migration::migrate_project(root).unwrap_err().code,
        "MIGRATION_INVALID_RECORD"
    );
}
#[cfg(unix)]
#[test]
fn links_and_linked_profile_ancestors_are_refused_without_touching_targets() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "secret", b"unchanged");
    symlink(outside.path(), temp.path().join(".paperdock")).unwrap();
    assert_eq!(
        migration::migrate_project(temp.path()).unwrap_err().code,
        "MIGRATION_UNSAFE_PATH"
    );
    fs::remove_file(temp.path().join(".paperdock")).unwrap();
    write(temp.path(), ".paperdock/comments.json", b"legacy");
    symlink(
        outside.path().join("secret"),
        temp.path().join(".paperdock/linked"),
    )
    .unwrap();
    assert_eq!(
        migration::migrate_project(temp.path()).unwrap_err().code,
        "MIGRATION_UNSAFE_PATH"
    );
    symlink(outside.path(), temp.path().join("profile-parent")).unwrap();
    assert_eq!(
        migration::prepare_profile(
            &temp.path().join("profile-parent/dev.texypaper.desktop"),
            false
        )
        .unwrap_err()
        .code,
        "MIGRATION_UNSAFE_PATH"
    );
    assert_eq!(
        fs::read(outside.path().join("secret")).unwrap(),
        b"unchanged"
    );
}
#[test]
fn both_metadata_names_remain_private_to_agents() {
    for name in [".paperdock", ".texypaper"] {
        for path in [
            name.to_owned(),
            format!("{name}/comments.json"),
            format!("nested/{name}/project.json"),
        ] {
            assert!(local::agent_read_denied(&path));
            assert!(!texypaper_lib::ai::proposals::read_allowed(&path));
            assert!(!texypaper_lib::ai::proposals::write_allowed(&path));
        }
        for private in ["transactions", "trash", "recovery", "agent-history"] {
            let path = format!("{name}/{private}/secret.tex");
            assert!(local::agent_read_denied(&path));
            assert!(!texypaper_lib::ai::proposals::read_allowed(&path));
            assert!(!texypaper_lib::ai::proposals::write_allowed(&path));
        }
    }
}

#[test]
fn migrated_pdf_remains_available_but_synctex_requires_rebuild() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let prefix = format!(".paperdock/build/r/published/{id}");
    write(
        &root,
        &format!("{prefix}/paper.pdf"),
        b"synthetic retained pdf",
    );
    write(
        &root,
        &format!("{prefix}/paper.synctex.gz"),
        b"synthetic retained synctex",
    );
    write(
        &root,
        &format!("{prefix}/manifest.json"),
        &serde_json::to_vec(&json!({
            "version":1,"buildId":id,"workspaceId":"stable-id","rootTex":"paper.tex",
            "engine":"pdflatex","cwd":root.to_string_lossy(),"jobName":"paper",
            "startedAt":"1","finishedAt":"2","pdfSha256":local::hash(b"synthetic retained pdf"),
            "syncSha256":local::hash(b"synthetic retained synctex"),"sources":[],
            "mappingReady":true,"pdfLength":22,"pdfPath":format!("{prefix}/paper.pdf"),
            "syncPath":format!("{prefix}/paper.synctex.gz")
        }))
        .unwrap(),
    );
    migration::migrate_project(&root).unwrap();
    let manifest =
        texypaper_lib::latex::local_execute(&root, "artifact_manifest", json!({"buildId":id}))
            .unwrap();
    assert_eq!(
        fs::read(root.join(manifest["pdfPath"].as_str().unwrap())).unwrap(),
        b"synthetic retained pdf"
    );
    assert_eq!(manifest["mappingReady"], false);
    let error = texypaper_lib::latex::local_execute(
        &root,
        "synctex_view",
        json!({"buildId":id,"file":"paper.tex","line1":1}),
    )
    .unwrap_err();
    assert_eq!(error.code, "SYNC_UNAVAILABLE");
}

#[test]
fn mapped_transaction_path_collisions_fail_before_mutation() {
    let temp = tempfile::tempdir().unwrap();
    write(
        temp.path(),
        ".paperdock/transactions/t/journal.json",
        br#"{"records":[{"path":".paperdock/comments.json"},{"path":".texypaper/comments.json"}]}"#,
    );
    assert_eq!(
        migration::migrate_project(temp.path()).unwrap_err().code,
        "MIGRATION_INVALID_RECORD"
    );
    assert!(temp.path().join(".paperdock").is_dir());
    assert!(!temp.path().join(".texypaper").exists());
}

#[test]
fn only_exact_reconstructible_remote_fingerprints_are_updated() {
    let temp = tempfile::tempdir().unwrap();
    let original = br#"[{"path":".paperdock/comments.json","baseSha256":null,"action":"create","resultSha256":"hash"}]"#;
    let expected = br#"[{"path":".texypaper/comments.json","baseSha256":null,"action":"create","resultSha256":"hash"}]"#;
    let mut journal = json!({
        "files":[{"path":".paperdock/comments.json","beforeSha256":null,"action":"create","afterSha256":"hash"}],
        "fingerprint":local::hash(original)
    });
    write(
        temp.path(),
        ".paperdock/transactions/exact/journal.json",
        &serde_json::to_vec(&journal).unwrap(),
    );
    journal["fingerprint"] = json!("fingerprint excludes appended comment record");
    write(
        temp.path(),
        ".paperdock/transactions/appended/journal.json",
        &serde_json::to_vec(&journal).unwrap(),
    );
    migration::migrate_project(temp.path()).unwrap();
    assert_eq!(
        document(temp.path(), ".texypaper/transactions/exact/journal.json")["fingerprint"],
        local::hash(expected)
    );
    assert_eq!(
        document(temp.path(), ".texypaper/transactions/appended/journal.json")["fingerprint"],
        "fingerprint excludes appended comment record"
    );
}

#[cfg(windows)]
#[test]
fn windows_junction_metadata_and_profile_locations_are_refused() {
    use std::os::windows::process::CommandExt;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "retained", b"outside bytes");
    let junction = temp.path().join(".paperdock");
    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(outside.path())
        .creation_flags(0x08000000) // Test fixture creation never opens a console window.
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        migration::migrate_project(temp.path()).unwrap_err().code,
        "MIGRATION_UNSAFE_PATH"
    );
    fs::remove_dir(&junction).unwrap();
    let old_profile = temp.path().join("dev.paperdock.desktop");
    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&old_profile)
        .arg(outside.path())
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        migration::prepare_profile(&temp.path().join("dev.texypaper.desktop"), false)
            .unwrap_err()
            .code,
        "MIGRATION_UNSAFE_PATH"
    );
    fs::remove_dir(old_profile).unwrap();
    assert_eq!(
        fs::read(outside.path().join("retained")).unwrap(),
        b"outside bytes"
    );
}

fn assert_invalid_record_preserves_legacy(relative: &str, value: Value) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let original = serde_json::to_vec_pretty(&value).unwrap();
    let path = format!(".paperdock/{relative}");
    write(root, &path, &original);
    write(
        root,
        ".paperdock/comments.json",
        b"opaque retained comment bytes",
    );
    let error = migration::migrate_project(root).unwrap_err();
    assert_eq!(
        error.code, "MIGRATION_INVALID_RECORD",
        "{relative}: {value}"
    );
    assert_eq!(fs::read(root.join(path)).unwrap(), original);
    assert_eq!(
        fs::read(root.join(".paperdock/comments.json")).unwrap(),
        b"opaque retained comment bytes"
    );
    assert!(!root.join(".texypaper").exists());
    assert!(!root.join(".paperdock/.texypaper-migration").exists());
}

#[test]
fn valid_json_with_unsafe_private_paths_fails_preflight_without_renaming() {
    for path in [
        ".paperdock/../../outside",
        ".texypaper/../outside",
        ".paperdock/back\\slash",
        ".texypaper/x:stream",
        ".paperdock/\0secret",
        ".paperdock//double",
        ".texypaper/./file",
        ".paperdock\\escape",
    ] {
        for value in [
            json!({"records":[{"path":path}]}),
            json!({"files":[{"path":path}]}),
            json!({"path":path}),
            json!({"source":path}),
            json!({"destination":path}),
            json!({"affected":[path]}),
            json!({"affectedPaths":[path]}),
            json!({"paths":[path]}),
            json!({"result":{"path":path}}),
            json!({"result":{"newPath":path}}),
            json!({"result":{"paths":[path]}}),
            json!({"result":{"revisions":[{"path":path}]}}),
            json!({"result":{"revisions":[{"file":{"path":path}}]}}),
            json!({"result":{"changed":[{"file":{"path":path}}]}}),
        ] {
            assert_invalid_record_preserves_legacy("transactions/t/journal.json", value);
        }
        for manifest in [
            json!({"pdfPath":path}),
            json!({"syncPath":path}),
            json!({"sources":[{"snapshotPath":path}]}),
        ] {
            assert_invalid_record_preserves_legacy(
                "build/latest.json",
                json!({"manifest":manifest.clone()}),
            );
            assert_invalid_record_preserves_legacy(
                "build/status.json",
                json!({"manifest":manifest.clone()}),
            );
            assert_invalid_record_preserves_legacy("build/r/latest.json", manifest.clone());
            assert_invalid_record_preserves_legacy("build/r/published/b/manifest.json", manifest);
        }
    }
}

#[test]
fn malformed_recognized_containers_fail_preflight_without_renaming() {
    for value in [
        json!({"records":{}}),
        json!({"files":"invalid"}),
        json!({"records":[null]}),
        json!({"files":[[]]}),
        json!({"affected":false}),
        json!({"affectedPaths":null}),
        json!({"paths":{}}),
        json!({"result":[]}),
        json!({"result":{"paths":{}}}),
        json!({"result":{"revisions":{}}}),
        json!({"result":{"changed":false}}),
        json!({"result":{"revisions":[null]}}),
        json!({"result":{"changed":[[]]}}),
        json!({"result":{"revisions":[{"file":[]} ]}}),
    ] {
        assert_invalid_record_preserves_legacy("transactions/t/journal.json", value);
    }
    for value in [
        json!({"manifest":[]}),
        json!({"manifest":"invalid"}),
        json!({"manifest":{"sources":{}}}),
        json!({"manifest":{"sources":[null]}}),
    ] {
        assert_invalid_record_preserves_legacy("build/latest.json", value);
    }
    for value in [
        json!({"sources":null}),
        json!({"sources":{}}),
        json!({"sources":[[]]}),
    ] {
        assert_invalid_record_preserves_legacy("build/r/published/b/manifest.json", value);
    }
}

#[test]
fn unsafe_current_private_path_on_resume_preserves_marker_and_original_record() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let original = br#"{"records":[{"path":".texypaper/../../outside"}]}"#;
    write(root, ".texypaper/.texypaper-migration", b"1\n");
    write(root, ".texypaper/transactions/t/journal.json", original);
    assert_eq!(
        migration::migrate_project(root).unwrap_err().code,
        "MIGRATION_INVALID_RECORD"
    );
    assert_eq!(
        fs::read(root.join(".texypaper/transactions/t/journal.json")).unwrap(),
        original
    );
    assert_eq!(
        fs::read(root.join(".texypaper/.texypaper-migration")).unwrap(),
        b"1\n"
    );
    assert!(!root.join(".paperdock").exists());
}

#[test]
fn unrecognized_payloads_are_opaque_and_absent_build_manifests_remain_valid() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let value = json!({
        "records":[],
        "message":".paperdock/../../user prose",
        "content":".texypaper/unsafe\\user text",
        "note":{"path":".paperdock/../../not a recognized record"}
    });
    write(
        root,
        ".paperdock/transactions/t/journal.json",
        &serde_json::to_vec(&value).unwrap(),
    );
    write(
        root,
        ".paperdock/build/latest.json",
        br#"{"status":"idle","manifest":null}"#,
    );
    migration::migrate_project(root).unwrap();
    assert_eq!(
        document(root, ".texypaper/transactions/t/journal.json"),
        value
    );
    assert_eq!(
        document(root, ".texypaper/build/latest.json"),
        json!({"status":"idle","manifest":null})
    );
}
