use serde_json::json;
use std::fs;
use texypaper_lib::{
    comments,
    workspace::{local, transactions},
};
fn thread(base: &[u8]) -> serde_json::Value {
    json!({"id":"thread","status":"open","source":{"path":"paper.tex","startByte":7,"endByte":12,"baseSha256":local::hash(base),"quote":"quote","before":"before ","after":" after"},"messages":[{"id":"message","author":"me","text":"Comment <script> is plain data","createdAt":"2026-11-05T00:00:00Z","updatedAt":"2026-11-05T00:00:00Z"}]})
}
#[test]
fn external_reattachment_requires_unique_context() {
    assert_eq!(
        comments::find_unique_anchor(
            "prefix before quote after suffix",
            "quote",
            "before ",
            " after"
        ),
        Some((14, 19))
    );
    assert_eq!(
        comments::find_unique_anchor(
            "before quote after; before quote after",
            "quote",
            "before ",
            " after"
        ),
        None
    );
    assert_eq!(
        comments::find_unique_anchor("before missing after", "quote", "before ", " after"),
        None
    );
}
#[test]
fn comments_survive_reload_and_conflict_on_external_sidecar_edit() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let bytes = b"before quote after";
    fs::write(root.join("paper.tex"), bytes).unwrap();
    let saved = comments::update(
        &root,
        &json!({"expectedRevision":"","threads":[thread(bytes)],"transactionId":"comment"}),
    )
    .unwrap();
    let reloaded = comments::read(&root).unwrap();
    assert_eq!(reloaded["threads"], saved["threads"]);
    let sidecar = root.join(".texypaper/comments.json");
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(&sidecar).unwrap()).unwrap();
    changed["threads"][0]["messages"][0]["text"] = json!("external");
    fs::write(sidecar, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(comments::update(&root,&json!({"expectedRevision":saved["revision"],"threads":saved["threads"],"transactionId":"conflicted"})).unwrap_err().code,"FILE_CONFLICT");
}
#[test]
fn owned_insert_maps_bytes_and_deleted_quote_becomes_orphaned() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let before = b"before quote after";
    fs::write(root.join("paper.tex"), before).unwrap();
    comments::update(
        &root,
        &json!({"expectedRevision":"","threads":[thread(before)],"transactionId":"comment"}),
    )
    .unwrap();
    transactions::save_text(
        &root,
        "paper.tex",
        &local::hash(before),
        "한글 before quote after",
        "source",
    )
    .unwrap();
    let mapped = comments::read(&root).unwrap();
    assert_eq!(mapped["threads"][0]["source"]["startByte"], 14);
    assert_eq!(mapped["threads"][0]["status"], "open");
    fs::write(root.join("paper.tex"), b"before deleted after").unwrap();
    let orphaned = comments::read(&root).unwrap();
    assert_eq!(orphaned["threads"][0]["status"], "orphaned");
}
#[test]
fn duplicate_quote_without_context_is_not_guessed() {
    assert_eq!(
        comments::find_unique_anchor("문장 😀; 문장 😀", "문장 😀", "", ""),
        None
    );
    assert_eq!(
        comments::find_unique_anchor("a e\u{301} b", "e\u{301}", "a ", " b"),
        Some((2, 5))
    );
}
#[test]
fn overlapping_occurrences_are_ambiguous() {
    assert_eq!(comments::find_unique_anchor("aaaa", "aaa", "", ""), None);
    assert_eq!(comments::find_unique_anchor("😀😀😀", "😀😀", "", ""), None);
}
