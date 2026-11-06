use std::{
    fs,
    io::{BufReader, Cursor, Write},
};
use texypaper_lib::latex::{
    artifacts, diagnostics,
    prose_map::{escape_plain, unique_literal},
    synctex, synctex_parser,
};
#[test]
fn parses_all_records_and_windows_colons() {
    let output = "ignored banner\r\nSyncTeX result begin\r\nOutput:C:\\papers\\paper.pdf\r\nInput:C:\\papers\\한글.tex\r\nLine:18\r\nColumn:-1\r\nOffset:0\r\nOutput:C:\\papers\\paper.pdf\r\nInput:C:\\papers\\other.tex\r\nLine:24\r\nColumn:3\r\nVendor:field:with:colons\r\nSyncTeX result end\r\nInput:must-not-parse";
    let value = synctex::parse_output(output).unwrap();
    let records = value["records"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["input"], "C:\\papers\\한글.tex");
    assert!(records[0]["column"].is_null());
    assert_eq!(records[1]["Vendor"], "field:with:colons");
}
#[test]
fn no_match_is_not_success_and_coordinates_are_finite() {
    assert_eq!(
        synctex::parse_output("SyncTeX result begin\nSyncTeX result end")
            .unwrap_err()
            .code,
        "SYNC_NO_MATCH"
    );
    assert_eq!(
        synctex::parse_output(
            "SyncTeX result begin\nOutput:a.pdf\nPage:1\nh:NaN\nSyncTeX result end"
        )
        .unwrap_err()
        .code,
        "SYNC_INVALID"
    );
}
#[test]
fn unique_prose_preserves_real_utf8_interval() {
    let source = "\u{feff}한글 😀 cafe\u{301}\r\nresults remain unchanged.";
    let matches = unique_literal(
        source,
        "한글 😀 café results remain unchanged.",
        "",
        "",
        &[1, 2],
    );
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].start, 3);
    assert_eq!(&source[matches[0].start..matches[0].end], &source[3..]);
}
#[test]
fn rejects_repetition_including_overlapping_matches() {
    assert_eq!(
        unique_literal(
            "Same sentence. Same sentence.",
            "Same sentence.",
            "",
            "",
            &[1]
        )
        .len(),
        2
    );
    assert_eq!(unique_literal("aaaa", "aaa", "", "", &[1]).len(), 2);
    assert_eq!(unique_literal("가가가", "가가", "", "", &[1]).len(), 2);
}
#[test]
fn context_disambiguates_without_altering_punctuation() {
    let source = "Left result. Right result.";
    let matches = unique_literal(source, "result.", "Right ", "", &[1]);
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].start, 19);
    assert!(unique_literal("co-operate", "cooperate", "", "", &[1]).is_empty());
}
#[test]
fn respects_commands_math_tables_comments_and_paragraphs() {
    for (source, quote) in [
        (r"Before \cite{key} after", "Before after"),
        (r"Math $a+b$ end", "a+b"),
        (r"\begin{tabular}{cc}cell & data\end{tabular}", "cell"),
        (r"\custom word", "word"),
        ("A\n \t\nB", "A B"),
        ("Text % hidden\nvisible", "hidden"),
    ] {
        assert!(
            unique_literal(source, quote, "", "", &[]).is_empty(),
            "{source}"
        );
    }
    let source = r"An \emph{eligible literal phrase} here.";
    assert_eq!(
        unique_literal(source, "eligible literal phrase", "", "", &[1]).len(),
        1
    );
    assert!(unique_literal(source, "An eligible literal phrase", "", "", &[1]).is_empty());
}
#[test]
fn ligatures_graphemes_and_hyphens_are_reversible() {
    assert_eq!(unique_literal("oﬃce", "office", "", "", &[1]).len(), 1);
    assert!(unique_literal("oﬃce", "fi", "", "", &[1]).is_empty());
    assert_eq!(
        unique_literal("\u{1100}\u{1161}", "가", "", "", &[1]).len(),
        1
    );
    assert!(unique_literal("👩‍🔬", "👩", "", "", &[1]).is_empty());
    assert!(unique_literal("e\u{301}", "e", "", "", &[1]).is_empty());
    assert_eq!(unique_literal("hyphen", "hy-\nphen", "", "", &[1]).len(), 1);
    assert_eq!(
        unique_literal("hy-phen", "hy-\nphen", "", "", &[1]).len(),
        1
    );
    assert!(unique_literal("hy-\nphen", "hyphen", "", "", &[1, 2]).is_empty());
}
#[test]
fn inverse_lines_cannot_authorize_distant_text_in_same_paragraph() {
    let source = format!("{}target phrase", "other source line\n".repeat(30));
    assert!(unique_literal(&source, "target phrase", "", "", &[2]).is_empty());
}
#[test]
fn replacement_escapes_every_tex_special_character() {
    assert_eq!(
        escape_plain("\\{}$&#%_^~"),
        "\\textbackslash{}\\{\\}\\$\\&\\#\\%\\_\\textasciicircum{}\\textasciitilde{}"
    );
}
fn sync_fixture(input: &str) -> String {
    format!(
        "SyncTeX Version:1\nInput:1:{input}\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:65782\nY Offset:131564\nContent:\n{{1\n(1,10:657818,1315635:1315635,657818,0\nx1,10:657818,1315635\n)\n(1,30:1973453,2631270:657818,657818,0\nx1,30:1973453,2631270\n)\n}}1\nPostamble:\n"
    )
}
#[test]
fn streaming_parser_handles_unicode_gzip_offsets_and_line_edges() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("한글 경로.tex");
    fs::write(&source, "literal").unwrap();
    let body = sync_fixture(source.to_str().unwrap());
    let index =
        synctex_parser::parse(BufReader::with_capacity(7, Cursor::new(body.as_bytes()))).unwrap();
    assert_eq!(index.blocks[0].input.as_ref(), source.to_str().unwrap());
    assert!((index.blocks[0].h - 11.0).abs() < 0.01);
    assert!((index.blocks[0].v - 22.0).abs() < 0.01);
    assert!(
        index
            .forward(&source, temp.path(), 1)
            .iter()
            .all(|b| b.line == 10)
    );
    assert!(
        index
            .forward(&source, temp.path(), 999)
            .iter()
            .all(|b| b.line == 30)
    );
    assert!(!index.inverse(1, 11.0, 20.0).is_empty());
    let compressed = temp.path().join("paper.synctex.gz");
    let mut gzip = flate2::write::GzEncoder::new(
        fs::File::create(&compressed).unwrap(),
        flate2::Compression::default(),
    );
    gzip.write_all(body.as_bytes()).unwrap();
    gzip.finish().unwrap();
    assert_eq!(
        synctex_parser::load(&compressed).unwrap().blocks.len(),
        index.blocks.len()
    );
}
#[test]
fn parser_rejects_unbounded_line_before_allocating_whole_frame() {
    let body = vec![b'a'; 65537];
    assert_eq!(
        synctex_parser::parse(Cursor::new(body)).unwrap_err().code,
        "SYNCTEX_LIMIT"
    );
}

// Hbox/leaf records reduced from the two successful desktop-release-03
// mapping-pair builds. In particular, the line-4 box contains line-3 leaves,
// and the main-file line-10 box contains included-file line-3 leaves.
fn observed_sync_fixture(main: &str, section: &str) -> String {
    format!(
        concat!(
            "SyncTeX Version:1\nInput:1:{}\nInput:6:{}\n",
            "Output:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n",
            "{{1\n[1,12:8799518,46220574:22609920,40435712,0\n",
            "(1,4:8799518,8865054:22609920,455111,127431\n",
            "h1,3:8799518,8865054:983040,0,0\n",
            "x1,3:10911235,8865054\ng1,3:11129688,8865054\n",
            "x1,3:15398640,8865054\ng1,3:15617093,8865054\n",
            "x1,3:20672475,8865054\ng1,3:20890928,8865054\n",
            "x1,3:28926384,8865054\nk1,4:31409438,8865054:2483054\n",
            "g1,4:31409438,8865054\n)\n",
            "(1,10:8799518,12010782:22609920,455111,127431\n",
            "h6,3:8799518,12010782:983040,0,0\n",
            "x6,3:12099988,12010782\nx6,3:22324515,12010782\n",
            "x6,3:31409438,12010782\nk1,10:31409438,12010782:0\n)\n",
            "(1,12:8799518,46220574:22609920,422343,0\n",
            "(1,12:8799518,46220574:22609920,422343,0\n",
            "k1,12:19940638,46220574:11141120\nx1,12:20268319,46220574\n",
            "k1,12:31409438,46220574:11141119\n)\n)\n]\n}}1\nPostamble:\n"
        ),
        main, section
    )
}

#[test]
fn forward_uses_observed_enclosing_hbox_corners_but_keeps_leaf_identity() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main.tex");
    let section = temp.path().join("section.tex");
    fs::write(&main, "main source").unwrap();
    fs::write(&section, "included source").unwrap();
    let body = observed_sync_fixture(main.to_str().unwrap(), section.to_str().unwrap());
    let index = synctex_parser::parse(BufReader::with_capacity(5, Cursor::new(body))).unwrap();
    let blocks = index.forward(&main, temp.path(), 3);
    assert!(!blocks.is_empty());
    for block in &blocks {
        assert_eq!(block.line, 3); // Not the enclosing hbox's line 4.
        assert_eq!(block.input.as_ref(), main.to_str().unwrap());
        assert_eq!(block.page, 1);
        let corners = [block.h, block.v - block.height, block.h + block.w, block.v];
        // Native `synctex view` observed h=133.768356, v=136.701797,
        // W=343.711060, H=8.855677 (baseline + positive depth).
        for (actual, native) in corners
            .into_iter()
            .zip([133.768356, 127.846120, 477.479416, 136.701797])
        {
            assert!((actual - native).abs() < 0.00005, "{actual} != {native}");
        }
    }
    // Source identity is interned across leaves, not copied per glyph.
    assert!(std::sync::Arc::ptr_eq(&blocks[0].input, &blocks[1].input));
    let before = index.forward(&main, temp.path(), 1);
    assert!(!before.is_empty());
    assert!(before.iter().all(|block| block.line == 3));
    let after = index.forward(&main, temp.path(), 999);
    assert!(!after.is_empty());
    assert!(after.iter().all(|block| block.line == 12));
    assert!(after.iter().all(|block| {
        (block.v - 46220574.0 / 65781.76).abs() < 0.000001
            && (block.height - 422343.0 / 65781.76).abs() < 0.000001
    }));
    let included = index.forward(&section, temp.path(), 3);
    assert!(!included.is_empty());
    assert!(included.iter().all(|block| {
        block.input.as_ref() == section.to_str().unwrap()
            && (block.v - (12010782.0 + 127431.0) / 65781.76).abs() < 0.000001
    }));
}

#[test]
fn inverse_uses_leaf_spans_and_depth_without_structural_source_candidates() {
    let body = observed_sync_fixture("main.tex", "included/section.tex");
    let index = synctex_parser::parse(Cursor::new(body)).unwrap();
    let x = (8799518.0 + 22609920.0 * 0.5) / 65781.76;
    // Below the baseline, but inside the observed positive-depth hbox.
    let first = index.inverse(1, x, (8865054.0 + 63715.0) / 65781.76);
    assert!(!first.is_empty());
    assert!(
        first
            .iter()
            .all(|block| block.input.as_ref() == "main.tex" && block.line == 3)
    );
    let included = index.inverse(1, x, (12010782.0 + 63715.0) / 65781.76);
    assert!(!included.is_empty());
    assert!(
        included
            .iter()
            .all(|block| { block.input.as_ref() == "included/section.tex" && block.line == 3 })
    );
    // The same hbox's far-right, zero-width kern really belongs to main:10.
    let edge = index.inverse(1, 31409438.0 / 65781.76, 12010782.0 / 65781.76);
    assert!(
        edge.iter()
            .any(|block| block.input.as_ref() == "main.tex" && block.line == 10)
    );
    assert!(index.inverse(2, x, 180.0).is_empty());
}

#[test]
fn inverse_distinguishes_adjacent_source_spans_inside_one_hbox() {
    let body = concat!(
        "SyncTeX Version:1\nInput:1:main.tex\nInput:6:section.tex\n",
        "Magnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n",
        "(1,10:8799518,12010782:22609920,455111,127431\n",
        "h6,3:8799518,12010782:983040,0,0\n",
        "x6,3:12099988,12010782\n",
        "x1,9:22324515,12010782\n",
        "x6,4:31409438,12010782\n)\n}1\n"
    );
    let index = synctex_parser::parse(Cursor::new(body)).unwrap();
    let y = (12010782.0 + 63715.0) / 65781.76;
    for (x, path, line) in [
        (11000000.0, "section.tex", 3),
        (20000000.0, "main.tex", 9),
        (24000000.0, "section.tex", 4),
    ] {
        let hits = index.inverse(1, x / 65781.76, y);
        assert!(!hits.is_empty());
        assert!(
            hits.iter()
                .all(|block| block.input.as_ref() == path && block.line == line)
        );
    }
    assert!(index.blocks.iter().all(|block| block.line != 10));
}

#[test]
fn equivalent_ascii_unicode_gzip_fixtures_have_identical_forward_and_inverse_geometry() {
    let temp = tempfile::tempdir().unwrap();
    let mut indices = Vec::new();
    let mut roots = Vec::new();
    for folder in ["paper-ASCII", "한국 논문"] {
        let root = temp.path().join(folder);
        fs::create_dir(&root).unwrap();
        let main = root.join("main.tex");
        let section = root.join("section.tex");
        fs::write(&main, "same source").unwrap();
        fs::write(&section, "same included source").unwrap();
        let body = observed_sync_fixture(main.to_str().unwrap(), section.to_str().unwrap());
        let compressed = root.join("main.synctex.gz");
        let mut gzip = flate2::write::GzEncoder::new(
            fs::File::create(&compressed).unwrap(),
            flate2::Compression::default(),
        );
        gzip.write_all(body.as_bytes()).unwrap();
        gzip.finish().unwrap();
        indices.push(synctex_parser::load(&compressed).unwrap());
        roots.push(root);
    }
    for line in [1, 3, 10, 12, 13] {
        let geometry = |i: usize| {
            indices[i]
                .forward(&roots[i].join("main.tex"), &roots[i], line)
                .into_iter()
                .map(|block| {
                    (
                        block.line,
                        block.page,
                        block.h,
                        block.v,
                        block.w,
                        block.height,
                    )
                })
                .collect::<Vec<_>>()
        };
        let ascii = geometry(0);
        assert!(!ascii.is_empty());
        assert_eq!(ascii, geometry(1));
    }
    let x = (8799518.0 + 22609920.0 * 0.5) / 65781.76;
    for baseline in [8865054.0, 12010782.0, 46220574.0] {
        let geometry = |i: usize| {
            indices[i]
                .inverse(1, x, baseline / 65781.76)
                .into_iter()
                .map(|block| {
                    let relative = std::path::Path::new(block.input.as_ref())
                        .strip_prefix(&roots[i])
                        .unwrap();
                    (
                        relative.to_owned(),
                        block.line,
                        block.page,
                        block.h,
                        block.v,
                        block.w,
                        block.height,
                    )
                })
                .collect::<Vec<_>>()
        };
        let ascii = geometry(0);
        assert!(!ascii.is_empty());
        assert_eq!(ascii, geometry(1));
    }
}

#[cfg(windows)]
#[test]
fn observed_cp949_input_paths_decode_strictly_on_cp949_windows() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetACP() -> u32;
    }
    // This is the actual TeX path encoding on the failed release workstation.
    // Other ANSI code pages cannot represent these same byte identities.
    if unsafe { GetACP() } != 949 {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("한국 논문");
    fs::create_dir(&root).unwrap();
    let main = root.join("main.tex");
    let section = root.join("section.tex");
    fs::write(&main, "same source").unwrap();
    fs::write(&section, "same included source").unwrap();
    let body = observed_sync_fixture("한국 논문/main.tex", "한국 논문/section.tex");
    // Encode only the known directory component; no source bytes are changed.
    let mut encoded = Vec::new();
    for (i, part) in body.split("한국 논문").enumerate() {
        if i > 0 {
            encoded.extend_from_slice(b"\xc7\xd1\xb1\xb9 \xb3\xed\xb9\xae");
        }
        encoded.extend_from_slice(part.as_bytes());
    }
    let index = synctex_parser::parse(BufReader::with_capacity(3, Cursor::new(encoded))).unwrap();
    let blocks = index.forward(&main, temp.path(), 3);
    assert!(!blocks.is_empty());
    assert!(blocks.iter().all(|block| {
        block.input.as_ref() == "한국 논문/main.tex" && (block.v - 136.701797).abs() < 0.00005
    }));
    let inverse = index.inverse(1, 300.0, 183.0);
    assert!(!inverse.is_empty());
    assert!(
        inverse
            .iter()
            .all(|block| block.input.as_ref() == "한국 논문/section.tex")
    );
    let malformed = b"SyncTeX Version:1\nInput:1:C:/\x81\n";
    assert_eq!(
        synctex_parser::parse(Cursor::new(malformed))
            .unwrap_err()
            .code,
        "SYNC_PATH_ENCODING"
    );
}
#[test]
fn snapshots_detect_same_size_changes_and_include_figures() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::write(root.join("main.tex"), "old prose").unwrap();
    fs::write(root.join("figure.png"), [1, 2, 3, 4]).unwrap();
    fs::create_dir(root.join("snapshots")).unwrap();
    let snapshots = artifacts::snapshot(
        &root,
        &["main.tex".into(), "figure.png".into()],
        &root.join("snapshots"),
    )
    .unwrap();
    assert!(artifacts::revisions_match(&root, &snapshots));
    fs::write(root.join("main.tex"), "new prose").unwrap();
    assert!(!artifacts::revisions_match(&root, &snapshots));
    assert_eq!(
        fs::read(root.join(&snapshots[0].snapshot_path)).unwrap(),
        b"old prose"
    );
    fs::write(root.join("main.fls"), "INPUT main.tex\nINPUT figure.png\n").unwrap();
    assert_eq!(
        artifacts::discover_inputs(&root, &root, &root.join("main.fls")).unwrap(),
        vec!["figure.png", "main.tex"]
    );
}
#[test]
fn diagnostics_preserve_drive_paths_and_deduplicate_passes() {
    let text = "C:\\papers\\main.tex:12: Undefined control sequence.\nC:\\papers\\main.tex:12: Undefined control sequence.\n! Missing $ inserted.\nl.17 example\nLaTeX Warning: Citation `key' undefined\n\nOverfull \\hbox (4.0pt too wide)\n";
    let diagnostics = diagnostics::parse(text);
    assert_eq!(
        diagnostics
            .iter()
            .filter(|d| d.path.as_deref() == Some("C:\\papers\\main.tex"))
            .count(),
        1
    );
    assert!(diagnostics.iter().any(|d| d.line == Some(17) && d.inferred));
    assert!(diagnostics.iter().any(|d| d.message.contains("Citation")));
}

#[cfg(windows)]
#[test]
fn tex_tool_paths_remove_only_win32_namespaces_preserving_identity_text() {
    use std::path::Path;
    assert_eq!(
        artifacts::tool_path(Path::new(r"\\?\C:\papers\한글 space\.texypaper\build\work")).unwrap(),
        "C:/papers/한글 space/.texypaper/build/work"
    );
    assert_eq!(
        artifacts::tool_path(Path::new(r"\\?\UNC\server\share\한글 space\paper.pdf")).unwrap(),
        "//server/share/한글 space/paper.pdf"
    );
    assert_eq!(
        artifacts::tool_path(Path::new(r"C:\papers\paper.pdf")).unwrap(),
        "C:/papers/paper.pdf"
    );
    assert!(artifacts::tool_path(Path::new(r"\\?\GLOBALROOT\Device\HarddiskVolume1")).is_err());
    assert!(artifacts::tool_path(Path::new(r"\\.\PhysicalDrive0")).is_err());
    assert!(artifacts::tool_path(Path::new("relative/main.tex")).is_err());
}
