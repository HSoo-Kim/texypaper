use serde_json::{Value, json};
use std::fs;
use texypaper_lib::{
    contracts::Environment,
    workspace::{Workspace, WorkspaceManager, local},
};

fn fixture() -> (tempfile::TempDir, WorkspaceManager, Workspace) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("paper");
    fs::create_dir(&root).unwrap();
    let mut manager = WorkspaceManager::new(temp.path().join("app-data"));
    let environment: Environment =
        serde_json::from_value(json!({"id":"local","label":"Local","kind":"local"})).unwrap();
    let reference = manager
        .open(environment, root.to_string_lossy().into_owned())
        .unwrap();
    let workspace = manager.active(&reference.id, reference.epoch).unwrap();
    (temp, manager, workspace)
}
fn edit(path: &str, original: &[u8], content: &str) -> Value {
    json!({"path":path,"action":"edit","baseSha256":local::hash(original),"content":content})
}

#[test]
fn user_replacement_allows_nonpaper_utf8_and_preserves_exact_bytes_and_undo() {
    let (_temp, _manager, workspace) = fixture();
    let root = workspace.local_root().unwrap();
    let before = "\u{feff}cat\r\nuntouched\ncat\rending\r\n".as_bytes();
    fs::write(root.join("notes.txt"), before).unwrap();
    let document = workspace
        .execute("read_text", json!({"path":"notes.txt"}))
        .unwrap();
    assert_eq!(document["encoding"], "utf8Bom");
    let content = document["text"].as_str().unwrap().replace("cat", "dog");
    let result = workspace.execute("apply_proposal", json!({"transactionId":"user-replace","summary":"project replace","files":[edit("notes.txt", before, &content)]})).unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(
        fs::read(root.join("notes.txt")).unwrap(),
        "\u{feff}dog\r\nuntouched\ndog\rending\r\n".as_bytes()
    );
    workspace
        .execute("undo_transaction", json!({"transactionId":"user-replace"}))
        .unwrap();
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), before);
}

#[test]
fn agent_proposals_still_refuse_nonpaper_files() {
    let (_temp, _manager, workspace) = fixture();
    let root = workspace.local_root().unwrap();
    fs::write(root.join("notes.txt"), b"cat").unwrap();
    let failure = workspace.execute("apply_proposal", json!({"transactionId":"agent-replace","_agentPolicy":true,"files":[edit("notes.txt", b"cat", "dog")]})).unwrap_err();
    assert_eq!(failure.code, "AGENT_WRITE_DENIED");
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"cat");
}

#[test]
fn private_metadata_and_large_or_invalid_utf8_are_never_replaced() {
    let (_temp, _manager, workspace) = fixture();
    let root = workspace.local_root().unwrap();
    for directory in [".git", "nested/.texypaper", "nested/.paperdock"] {
        fs::create_dir_all(root.join(directory)).unwrap();
        let path = format!("{directory}/data.txt");
        fs::write(root.join(&path), b"cat").unwrap();
        assert_eq!(
            workspace
                .execute(
                    "apply_proposal",
                    json!({"transactionId":"private","files":[edit(&path, b"cat", "dog")]})
                )
                .unwrap_err()
                .code,
            "PATH_RESERVED"
        );
        assert_eq!(fs::read(root.join(path)).unwrap(), b"cat");
    }
    let invalid = [0xff, 0xfe, 0x40];
    fs::write(root.join("legacy.txt"), invalid).unwrap();
    assert_eq!(
        workspace
            .execute(
                "apply_proposal",
                json!({"transactionId":"encoding","files":[edit("legacy.txt", &invalid, "dog")]})
            )
            .unwrap_err()
            .code,
        "ENCODING_UNSUPPORTED"
    );
    let large = vec![b'x'; 4 * 1024 * 1024 + 1];
    fs::write(root.join("large.txt"), &large).unwrap();
    assert_eq!(
        workspace
            .execute(
                "apply_proposal",
                json!({"transactionId":"large","files":[edit("large.txt", &large, "dog")]})
            )
            .unwrap_err()
            .code,
        "LARGE_FILE"
    );
}

#[test]
fn every_user_replacement_base_is_checked_before_any_write() {
    let (_temp, _manager, workspace) = fixture();
    let root = workspace.local_root().unwrap();
    fs::write(root.join("a.txt"), b"cat").unwrap();
    fs::write(root.join("b.txt"), b"new").unwrap();
    let failure = workspace.execute("apply_proposal", json!({"transactionId":"conflict","files":[edit("a.txt", b"cat", "dog"),edit("b.txt", b"cat", "dog")]})).unwrap_err();
    assert_eq!(failure.code, "FILE_CONFLICT");
    assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"cat");
}

#[test]
fn literal_search_honors_unicode_case_and_cursor_options() {
    let (_temp, _manager, workspace) = fixture();
    let root = workspace.local_root().unwrap();
    fs::write(root.join("main.tex"), "Cat cat CAT\n한글\nK k K\na.* axx\n").unwrap();
    let sensitive = workspace
        .execute("search_text", json!({"query":"CAT","caseSensitive":true}))
        .unwrap();
    assert_eq!(sensitive["matches"].as_array().unwrap().len(), 1);
    assert_eq!(
        workspace
            .execute("search_text", json!({"query":"cAt","caseSensitive":true}))
            .unwrap()["matches"],
        json!([])
    );
    assert_eq!(
        workspace
            .execute("search_text", json!({"query":"cAt","caseSensitive":false}))
            .unwrap()["matches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        workspace
            .execute("search_text", json!({"query":"k","caseSensitive":false}))
            .unwrap()["matches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        workspace
            .execute("search_text", json!({"query":"a.*"}))
            .unwrap()["matches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::write(root.join("paged.txt"), "needle\n".repeat(450)).unwrap();
    let mut page = workspace
        .execute(
            "search_text",
            json!({"query":"needle","caseSensitive":true}),
        )
        .unwrap();
    let cursor = page["nextCursor"].as_str().unwrap().to_owned();
    assert_eq!(
        workspace
            .execute(
                "search_text",
                json!({"query":"needle","caseSensitive":false,"cursor":cursor})
            )
            .unwrap_err()
            .code,
        "CURSOR_INVALID"
    );
    assert_eq!(
        workspace
            .execute(
                "search_text",
                json!({"query":"needle","caseSensitive":true,"_agentPolicy":true,"cursor":cursor})
            )
            .unwrap_err()
            .code,
        "CURSOR_INVALID"
    );
    let mut lines = Vec::new();
    loop {
        lines.extend(
            page["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["line"].as_u64().unwrap()),
        );
        let Some(cursor) = page["nextCursor"].as_str() else {
            break;
        };
        page = workspace
            .execute(
                "search_text",
                json!({"query":"needle","caseSensitive":true,"cursor":cursor}),
            )
            .unwrap();
    }
    assert_eq!(lines, (1..=450).collect::<Vec<u64>>());
}

#[test]
fn search_discovers_matches_past_the_excerpt_limit() {
    let (_temp, _manager, workspace) = fixture();
    let root = workspace.local_root().unwrap();
    fs::write(
        root.join("long.txt"),
        format!("{}needle\n", "x".repeat(70000)),
    )
    .unwrap();
    let page = workspace
        .execute("search_text", json!({"query":"needle"}))
        .unwrap();
    assert_eq!(page["matches"].as_array().unwrap().len(), 1);
    assert_eq!(page["matches"][0]["text"].as_str().unwrap().len(), 2000);
}
