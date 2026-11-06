use serde_json::{Value, json};
use std::{
    fs,
    io::{Cursor, Read},
    net::TcpStream,
    sync::Arc,
    time::Duration,
};
use texypaper_lib::{
    ai::{
        broker::{BROKER_DOMAIN, Broker, read_frame, write_frame},
        events::{Events, read_bounded_line},
        proposals::{
            ProposalStore, Replacement, apply_replacements, digest, read_allowed, write_allowed,
        },
        tools::TexyPaperTools,
    },
    contracts::Environment,
    workspace::{Workspace, WorkspaceManager},
};
fn fixture() -> (tempfile::TempDir, WorkspaceManager, Workspace) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("paper");
    fs::create_dir(&root).unwrap();
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\r\n\\begin{document}\r\n한국어 result 42.\r\n\\end{document}\r\n",
    )
    .unwrap();
    fs::write(root.join(".env"), "SECRET=do-not-send").unwrap();
    let mut manager = WorkspaceManager::new(temp.path().join("app-data"));
    let environment: Environment =
        serde_json::from_value(json!({"id":"local","label":"Local","kind":"local"})).unwrap();
    let reference = manager
        .open(environment, root.to_string_lossy().into_owned())
        .unwrap();
    let workspace = manager.active(&reference.id, reference.epoch).unwrap();
    (temp, manager, workspace)
}
fn tools(temp: &tempfile::TempDir, workspace: &Workspace) -> Arc<TexyPaperTools> {
    Arc::new(TexyPaperTools::new(
        workspace.clone(),
        temp.path().join("app-data"),
        Arc::new(ProposalStore::default()),
        Events::new(
            workspace.reference.clone(),
            Arc::new(|_| {}),
            &temp.path().join("app-data"),
        ),
        "codex".into(),
        "task-1".into(),
    ))
}
fn proposal(workspace: &Workspace) -> Value {
    let doc = workspace
        .execute("read_text", json!({"path":"main.tex"}))
        .unwrap();
    json!({"summary":"Revise the result","files":[{"action":"edit","path":"main.tex","baseSha256":doc["revision"]["sha256"],"replacements":[{"oldText":"한국어 result 42.","newText":"한국어 result 43."}]}],"evidence":[]})
}
#[test]
fn proposals_are_immutable_until_explicit_user_approval() {
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    let path = workspace.local_root().unwrap().join("main.tex");
    let original = fs::read(&path).unwrap();
    assert_eq!(
        tools
            .call("propose_changes", proposal(&workspace))
            .unwrap_err()
            .code,
        "PROPOSAL_UNREAD"
    );
    tools.call("read_text", json!({"path":"main.tex"})).unwrap();
    let staged = tools.call("propose_changes", proposal(&workspace)).unwrap();
    assert_eq!(staged["filesUnchanged"], true);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(
        tools
            .call(
                "proposal_decide",
                json!({"id":staged["proposalId"],"decision":"apply"})
            )
            .unwrap_err()
            .code,
        "AGENT_TOOL_DENIED"
    );
    tools
        .proposals
        .decide(
            &workspace,
            &tools.data,
            &json!({"id":staged["proposalId"],"decision":"apply"}),
            &tools.events,
        )
        .unwrap();
    let changed = fs::read_to_string(&path).unwrap();
    assert!(changed.contains("한국어 result 43."));
    assert!(changed.contains("\r\n"));
}
#[test]
fn rejection_and_stale_hash_never_write() {
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    let path = workspace.local_root().unwrap().join("main.tex");
    tools.call("read_text", json!({"path":"main.tex"})).unwrap();
    let staged = tools.call("propose_changes", proposal(&workspace)).unwrap();
    let original = fs::read(&path).unwrap();
    tools
        .proposals
        .decide(
            &workspace,
            &tools.data,
            &json!({"id":staged["proposalId"],"decision":"reject"}),
            &tools.events,
        )
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    let staged = tools.call("propose_changes", proposal(&workspace)).unwrap();
    fs::write(
        &path,
        String::from_utf8(original).unwrap().replace("42.", "44."),
    )
    .unwrap();
    let external = fs::read(&path).unwrap();
    assert_eq!(
        tools
            .proposals
            .decide(
                &workspace,
                &tools.data,
                &json!({"id":staged["proposalId"],"decision":"apply"}),
                &tools.events
            )
            .unwrap_err()
            .code,
        "FILE_CONFLICT"
    );
    assert_eq!(fs::read(path).unwrap(), external);
    assert_eq!(
        tools.proposals.list(&workspace, &tools.data).unwrap()["proposals"][0]["status"],
        "conflicted"
    );
}
#[test]
fn credentials_and_non_tex_writes_are_denied() {
    for path in [
        ".env",
        "nested/.env.production",
        ".ssh/id_ed25519",
        "nested/private.pem",
        ".git/config",
        ".texypaper/transactions/a/original",
        "../outside.tex",
        "C:/paper/main.tex",
        "x\\y",
    ] {
        assert!(!read_allowed(path), "{path}");
    }
    for path in [
        "analysis.py",
        "results.csv",
        ".texypaper/settings.tex",
        "main.tex.exe",
        "private.key",
    ] {
        assert!(!write_allowed(path), "{path}");
    }
    assert!(write_allowed("논문/초안.tex"));
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    assert_eq!(
        tools
            .call("read_text", json!({"path":".env"}))
            .unwrap_err()
            .code,
        "AGENT_READ_DENIED"
    );
}

#[test]
fn command_tools_stage_only_and_cannot_grant_their_own_permission() {
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    let marker = workspace.local_root().unwrap().join("must-not-exist");
    for name in [
        "command_permission",
        "command_decide",
        "command_cancel",
        "execute",
    ] {
        assert_eq!(
            tools
                .call(
                    name,
                    json!({"permission":"session","acknowledged":true,"decision":"approve"})
                )
                .unwrap_err()
                .code,
            "AGENT_TOOL_DENIED"
        );
    }
    let staged = tools.call("propose_command", json!({
        "summary":"User approval is required", "cwd":"",
        "argv":["python","-c","from pathlib import Path; Path('must-not-exist').write_text('not approved')"],
        "timeoutSeconds":30
    })).unwrap();
    assert_eq!(staged["status"], "pending");
    assert_eq!(staged["provider"], "codex");
    assert_eq!(staged["taskId"], "task-1");
    assert!(!marker.exists());
    let status = tools
        .call("get_command_status", json!({"id":staged["id"]}))
        .unwrap();
    assert_eq!(status["status"], "pending");
    assert!(status["exitCode"].is_null());
    assert!(!marker.exists());
    assert!(
        tools
            .call(
                "propose_command",
                json!({
                    "summary":"Forged grant", "cwd":"", "argv":["python","-V"],
                    "permission":"session", "_provider":"forged", "_taskId":"forged"
                })
            )
            .is_err()
    );
    assert!(
        tools
            .call(
                "get_command_status",
                json!({"id":staged["id"],"decision":"approve"})
            )
            .is_err()
    );
    let other = fixture();
    let foreign = TexyPaperTools::new(
        other.2.clone(),
        other.0.path().join("app-data"),
        Arc::new(ProposalStore::default()),
        Events::new(
            other.2.reference.clone(),
            Arc::new(|_| {}),
            &other.0.path().join("app-data"),
        ),
        "claude".into(),
        "foreign-task".into(),
    );
    assert!(
        foreign
            .call("get_command_status", json!({"id":staged["id"]}))
            .is_err()
    );
}
#[test]
fn replacements_require_unique_nonoverlapping_unicode_intervals() {
    let r = |old: &str, new: &str| Replacement {
        old_text: old.into(),
        new_text: new.into(),
    };
    assert_eq!(
        apply_replacements("한국어 😀 e\u{301} 42", &[r("😀", "🙂")]).unwrap(),
        "한국어 🙂 e\u{301} 42"
    );
    assert_eq!(
        apply_replacements("same same", &[r("same", "new")])
            .unwrap_err()
            .code,
        "PROPOSAL_AMBIGUOUS"
    );
    assert_eq!(
        apply_replacements("abcdef", &[r("abc", "x"), r("bcd", "y")])
            .unwrap_err()
            .code,
        "PROPOSAL_OVERLAP"
    );
    assert_ne!(digest(b"same-size-A"), digest(b"same-size-B"));
}
struct Fragmented {
    bytes: Cursor<Vec<u8>>,
}
impl Read for Fragmented {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let length = buf.len().min(1);
        self.bytes.read(&mut buf[..length])
    }
}
#[test]
fn broker_frames_bound_allocation_and_accept_fragmentation() {
    let mut bytes = Vec::new();
    write_frame(
        &mut bytes,
        &json!({"tool":"read_text","args":{"path":"논문.tex"}}),
    )
    .unwrap();
    let value = read_frame(&mut Fragmented {
        bytes: Cursor::new(bytes),
    })
    .unwrap();
    assert_eq!(value["args"]["path"], "논문.tex");
    let mut oversized = Cursor::new((1024 * 1024u32 + 1).to_be_bytes());
    assert_eq!(
        read_frame(&mut oversized).unwrap_err().code,
        "BROKER_FRAME_LIMIT"
    );
    let mut line = Cursor::new(vec![b'x'; 129]);
    assert_eq!(
        read_bounded_line(&mut line, 128).unwrap_err().code,
        "PROVIDER_PROTOCOL_ERROR"
    );
}
#[test]
fn broker_requires_domain_capability_and_strict_sequence() {
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    let broker = Broker::start(tools, "task-1".into()).unwrap();
    let mut socket = TcpStream::connect(&broker.environment.address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write_frame(
        &mut socket,
        &json!({"domain":BROKER_DOMAIN,"taskId":"task-1","capability":"wrong"}),
    )
    .unwrap();
    assert!(read_frame(&mut socket).is_err());
    let mut socket = TcpStream::connect(&broker.environment.address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write_frame(&mut socket,&json!({"domain":BROKER_DOMAIN,"taskId":"task-1","capability":broker.environment.capability})).unwrap();
    assert_eq!(read_frame(&mut socket).unwrap()["ok"], true);
    write_frame(
        &mut socket,
        &json!({"sequence":1,"tool":"read_text","args":{"path":"main.tex"}}),
    )
    .unwrap();
    assert_eq!(read_frame(&mut socket).unwrap()["ok"], true);
    write_frame(
        &mut socket,
        &json!({"sequence":1,"tool":"read_text","args":{"path":"main.tex"}}),
    )
    .unwrap();
    assert!(read_frame(&mut socket).is_err());
}
#[test]
fn read_chunks_bound_json_escaping_and_continue_at_actual_lines() {
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    let content = "\\\\quoted \"한국어\" 😀\r\n".repeat(12000);
    fs::write(
        workspace.local_root().unwrap().join("escaped.tex"),
        &content,
    )
    .unwrap();
    let first = tools
        .call("read_text", json!({"path":"escaped.tex"}))
        .unwrap();
    assert!(serde_json::to_vec(&first).unwrap().len() <= 65536);
    assert_eq!(first["truncated"], true);
    let next = first["continuation"]["startLine"].as_u64().unwrap();
    assert_eq!(next, first["endLine"].as_u64().unwrap() + 1);
    let second = tools
        .call("read_text", json!({"path":"escaped.tex","startLine":next}))
        .unwrap();
    assert_eq!(second["startLine"], next);
    assert!(serde_json::to_vec(&second).unwrap().len() <= 65536);
}
#[test]
fn bom_is_preserved_and_undo_does_not_replace_later_human_edits() {
    let (temp, _manager, workspace) = fixture();
    let path = workspace.local_root().unwrap().join("main.tex");
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(&fs::read(&path).unwrap());
    fs::write(&path, &bytes).unwrap();
    let tools = tools(&temp, &workspace);
    tools.call("read_text", json!({"path":"main.tex"})).unwrap();
    let staged = tools.call("propose_changes", proposal(&workspace)).unwrap();
    let applied = tools
        .proposals
        .decide(
            &workspace,
            &tools.data,
            &json!({"id":staged["proposalId"],"decision":"apply"}),
            &tools.events,
        )
        .unwrap();
    assert!(fs::read(&path).unwrap().starts_with(&[0xef, 0xbb, 0xbf]));
    fs::write(&path, "A later human revision").unwrap();
    assert_eq!(
        workspace
            .execute(
                "undo_transaction",
                json!({"transactionId":applied["transactionId"]})
            )
            .unwrap_err()
            .code,
        "FILE_CONFLICT"
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "A later human revision");
}
#[test]
fn invented_evidence_cannot_be_cited_without_reading_its_actual_range() {
    let (temp, _manager, workspace) = fixture();
    let tools = tools(&temp, &workspace);
    tools
        .call(
            "read_text",
            json!({"path":"main.tex","startLine":1,"endLine":1}),
        )
        .unwrap();
    let mut input = proposal(&workspace);
    let sha = input["files"][0]["baseSha256"].clone();
    input["evidence"] = json!([{"path":"main.tex","sha256":sha,"startLine":2,"endLine":3}]);
    assert_eq!(
        tools.call("propose_changes", input).unwrap_err().code,
        "EVIDENCE_UNREAD"
    );
}
