use super::artifacts::{self, BuildManifest};
use crate::{
    contracts::{AppError, AppResult},
    workspace::Workspace,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;
#[derive(Debug, Clone)]
pub struct Interval {
    pub start: usize,
    pub end: usize,
}
struct Projection {
    text: String,
    boundaries: Vec<Option<usize>>,
}
fn project(text: &str, base: usize, hyphen_mode: u8) -> Projection {
    use std::borrow::Cow;
    let mut result = Projection {
        text: String::new(),
        boundaries: vec![Some(base)],
    };
    let mut graphemes = text.grapheme_indices(true).peekable();
    while let Some((start, g)) = graphemes.next() {
        let mut stop = start + g.len();
        let value = if g == "-"
            && hyphen_mode > 0
            && graphemes
                .peek()
                .is_some_and(|(_, s)| matches!(*s, "\n" | "\r" | "\r\n"))
        {
            while let Some((offset, space)) = graphemes.peek().copied() {
                if !space.chars().all(char::is_whitespace) {
                    break;
                }
                stop = offset + space.len();
                graphemes.next();
            }
            if hyphen_mode == 1 {
                if let Some(last) = result.boundaries.last_mut() {
                    *last = Some(base + stop)
                }
                continue;
            }
            Cow::Borrowed("-")
        } else if g.chars().all(char::is_whitespace) {
            while let Some((offset, space)) = graphemes.peek().copied() {
                if !space.chars().all(char::is_whitespace) {
                    break;
                }
                stop = offset + space.len();
                graphemes.next();
            }
            Cow::Borrowed(" ")
        } else {
            match g {
                "ﬀ" => Cow::Borrowed("ff"),
                "ﬁ" => Cow::Borrowed("fi"),
                "ﬂ" => Cow::Borrowed("fl"),
                "ﬃ" => Cow::Borrowed("ffi"),
                "ﬄ" => Cow::Borrowed("ffl"),
                _ if unicode_normalization::is_nfc(g) => Cow::Borrowed(g),
                _ => Cow::Owned(g.nfc().collect::<String>()),
            }
        };
        result.text.push_str(&value);
        result
            .boundaries
            .resize(result.boundaries.len() + value.len(), None);
        if let Some(last) = result.boundaries.last_mut() {
            *last = Some(base + stop)
        }
    }
    result
}
fn runs(source: &str) -> Vec<Interval> {
    let mut out = Vec::new();
    let mut start = None;
    let mut i = 0;
    let bytes = source.as_bytes();
    let mut formatting: Vec<bool> = Vec::new();
    let mut math = false;
    let mut opaque = 0usize;
    let mut environments = Vec::<String>::new();
    let mut unknown_command = false;
    while i < bytes.len() {
        let b = bytes[i];
        let mut paragraph_end = i;
        if matches!(b, b'\r' | b'\n') {
            paragraph_end = i + 1;
            if b == b'\r' && bytes.get(paragraph_end) == Some(&b'\n') {
                paragraph_end += 1
            }
            while bytes
                .get(paragraph_end)
                .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r'))
            {
                paragraph_end += 1
            }
        }
        let paragraph = paragraph_end > i && bytes.get(paragraph_end) == Some(&b'\n');
        if (paragraph
            || matches!(
                b,
                b'\\' | b'%' | b'$' | b'{' | b'}' | b'&' | b'#' | b'^' | b'_' | b'~'
            ))
            && let Some(s) = start.take()
            && s < i
        {
            out.push(Interval { start: s, end: i })
        }
        if paragraph {
            i = paragraph_end + 1;
            unknown_command = false;
            continue;
        }
        match b {
            b'%' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1
                }
                continue;
            }
            b'$' => {
                math = !math;
                i += 1;
                continue;
            }
            b'\\' => {
                let begin = i;
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                    i += 1
                }
                if i == begin + 1 && i < bytes.len() {
                    if matches!(bytes[i], b'(' | b'[') {
                        math = true
                    } else if matches!(bytes[i], b')' | b']') {
                        math = false
                    }
                    i += 1;
                    continue;
                }
                let command = &source[begin + 1..i];
                if matches!(command, "begin" | "end")
                    && bytes.get(i) == Some(&b'{')
                    && let Some(end) = source[i + 1..].find('}')
                {
                    let env = &source[i + 1..i + 1 + end];
                    if env == "document" {
                        unknown_command = false;
                    }
                    if !matches!(
                        env,
                        "document"
                            | "abstract"
                            | "quote"
                            | "quotation"
                            | "center"
                            | "flushleft"
                            | "flushright"
                            | "itemize"
                            | "enumerate"
                            | "description"
                    ) {
                        if command == "begin" {
                            environments.push(env.into());
                        } else if environments.last().is_some_and(|s| s == env) {
                            environments.pop();
                        }
                    }
                    i += end + 2;
                    continue;
                }
                if command == "verb" {
                    if let Some(&delimiter) = bytes.get(i) {
                        i += 1;
                        while i < bytes.len() && bytes[i] != delimiter {
                            i += 1
                        }
                        i = (i + 1).min(bytes.len());
                    }
                    continue;
                }
                let known = matches!(
                    command,
                    "emph" | "textbf" | "textit" | "textrm" | "textsf" | "texttt" | "underline"
                );
                if known && bytes.get(i) == Some(&b'{') {
                    formatting.push(true);
                    i += 1;
                    continue;
                }
                if !known
                    && !matches!(
                        command,
                        "cite"
                            | "citep"
                            | "citet"
                            | "autocite"
                            | "parencite"
                            | "textcite"
                            | "ref"
                            | "eqref"
                            | "autoref"
                            | "pageref"
                            | "label"
                            | "include"
                            | "input"
                            | "bibliography"
                            | "bibliographystyle"
                            | "documentclass"
                            | "usepackage"
                            | "title"
                            | "author"
                            | "date"
                            | "section"
                            | "subsection"
                            | "subsubsection"
                            | "paragraph"
                            | "caption"
                            | "url"
                            | "href"
                            | "maketitle"
                            | "item"
                            | "LaTeX"
                            | "TeX"
                            | "ldots"
                            | "dots"
                            | "par"
                            | "noindent"
                            | "clearpage"
                            | "newpage"
                    )
                {
                    unknown_command = true;
                }
                while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
                    i += 1
                }
                if bytes.get(i) == Some(&b'[') {
                    let mut depth = 1;
                    i += 1;
                    while i < bytes.len() && depth > 0 {
                        if bytes[i] == b'[' {
                            depth += 1
                        } else if bytes[i] == b']' {
                            depth -= 1
                        }
                        i += 1
                    }
                }
                if bytes.get(i) == Some(&b'{') {
                    formatting.push(false);
                    opaque += 1;
                    i += 1;
                }
                continue;
            }
            b'{' => {
                formatting.push(false);
                opaque += 1;
                i += 1;
                continue;
            }
            b'}' => {
                if formatting.pop() == Some(false) {
                    opaque = opaque.saturating_sub(1)
                }
                i += 1;
                continue;
            }
            b'&' | b'#' | b'^' | b'_' | b'~' => {
                i += 1;
                continue;
            }
            _ => {}
        }
        if !math && opaque == 0 && environments.is_empty() && !unknown_command {
            start.get_or_insert(i);
        }
        i += source[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    if let Some(s) = start {
        out.push(Interval {
            start: s,
            end: source.len(),
        })
    }
    out
}
pub fn unique_literal(
    source: &str,
    quote: &str,
    before: &str,
    after: &str,
    lines: &[u32],
) -> Vec<Interval> {
    let mut out = Vec::new();
    for run in runs(source) {
        let line_start = source[..run.start].bytes().filter(|b| *b == b'\n').count() as u32 + 1;
        let line_end = line_start
            + source[run.start..run.end]
                .bytes()
                .filter(|b| *b == b'\n')
                .count() as u32;
        if !lines.is_empty()
            && !lines
                .iter()
                .all(|l| l.saturating_add(2) >= line_start && *l <= line_end.saturating_add(2))
        {
            continue;
        }
        for source_mode in [0, 2] {
            let p = project(&source[run.start..run.end], run.start, source_mode);
            let before = project(before, 0, 0).text;
            let after = project(after, 0, 0).text;
            for quote_mode in [0, 1, 2] {
                let q = project(quote, 0, quote_mode).text;
                if q.trim().is_empty() {
                    continue;
                }
                let mut cursor = 0;
                while let Some(found) = p.text[cursor..].find(&q) {
                    let offset = cursor + found;
                    cursor = offset
                        + p.text[offset..]
                            .chars()
                            .next()
                            .map(char::len_utf8)
                            .unwrap_or(1);
                    let end = offset + q.len();
                    let (Some(start), Some(end_byte)) = (p.boundaries[offset], p.boundaries[end])
                    else {
                        continue;
                    };
                    let candidate_start =
                        source[..start].bytes().filter(|b| *b == b'\n').count() as u32 + 1;
                    let candidate_end = candidate_start
                        + source[start..end_byte]
                            .bytes()
                            .filter(|b| *b == b'\n')
                            .count() as u32;
                    if !lines.iter().all(|line| {
                        line.saturating_add(2) >= candidate_start
                            && *line <= candidate_end.saturating_add(2)
                    }) {
                        continue;
                    }
                    if !p.text[..offset]
                        .chars()
                        .rev()
                        .zip(before.chars().rev())
                        .all(|(actual, expected)| actual == expected)
                    {
                        continue;
                    }
                    if !p.text[end..]
                        .chars()
                        .zip(after.chars())
                        .all(|(actual, expected)| actual == expected)
                    {
                        continue;
                    }
                    if !out
                        .iter()
                        .any(|r: &Interval| r.start == start && r.end == end_byte)
                    {
                        out.push(Interval {
                            start,
                            end: end_byte,
                        });
                        if out.len() > 1 {
                            return out;
                        }
                    }
                }
            }
        }
    }
    out
}
#[derive(Clone)]
struct Proof {
    workspace: String,
    epoch: u64,
    manifest: BuildManifest,
    file: String,
    start: usize,
    end: usize,
    base: String,
    expires: Instant,
}
static PROOFS: LazyLock<Mutex<HashMap<String, Proof>>> = LazyLock::new(Default::default);
fn unavailable(code: &str, reason: &str) -> Value {
    json!({"kind":"unavailable","code":code,"reason":reason})
}
fn document(workspace: &Workspace, path: &str) -> AppResult<(String, String)> {
    let mut bytes = Vec::new();
    loop {
        let chunk = workspace.read_bytes(
            path,
            bytes.len() as u64,
            (4 * 1024 * 1024 + 1 - bytes.len()).min(65536),
        )?;
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(AppError::new(
                "SOURCE_TOO_LARGE",
                "자동 편집 대상은 4 MiB 이하 원문이어야 합니다",
            ));
        }
        let done = chunk.len() < 65536;
        bytes.extend_from_slice(&chunk);
        if done {
            break;
        }
    }
    let hash = artifacts::hash_bytes(&bytes);
    let source = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            "ENCODING_UNSUPPORTED",
            "UTF-8 원문만 자동 편집할 수 있습니다",
        )
    })?;
    Ok((source, hash))
}
fn verify(workspace: &Workspace, m: &BuildManifest) -> AppResult<bool> {
    if let Some(root) = workspace.local_root() {
        return Ok(artifacts::revisions_match(&root, &m.sources));
    }
    let result = workspace.execute("build_validate", json!({"buildId":m.build_id}))?;
    result["valid"].as_bool().ok_or_else(|| {
        AppError::new(
            "WORKER_PROTOCOL_ERROR",
            "원격 빌드 검증 결과가 유효하지 않습니다",
        )
    })
}
fn host_relative(m: &BuildManifest, input: &str, workspace: &Workspace) -> AppResult<String> {
    if let Some(root) = workspace.local_root() {
        let path = Path::new(&m.cwd).join(input).canonicalize()?;
        artifacts::relative(&root.canonicalize()?, &path)
    } else {
        let full = if input.starts_with('/') {
            input.to_string()
        } else {
            format!("{}/{}", m.cwd, input)
        };
        let mut parts = Vec::new();
        for p in full.split('/') {
            match p {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(p),
            }
        }
        let full = format!("/{}", parts.join("/"));
        let root = workspace.reference.root.trim_end_matches('/');
        full.strip_prefix(&format!("{root}/"))
            .map(str::to_string)
            .ok_or_else(|| AppError::new("PATH_ESCAPE", "SyncTeX가 작업 공간 밖 원문을 가리킵니다"))
    }
}
pub fn map_selection(workspace: &Workspace, args: Value) -> AppResult<Value> {
    let m = super::get_manifest(workspace, args["buildId"].as_str().unwrap_or_default())?;
    if args["pdfSha256"].as_str() != Some(&m.pdf_sha256) {
        return Ok(unavailable(
            "PDF_STALE",
            "선택한 PDF와 빌드가 다릅니다. 다시 빌드하고 선택하세요",
        ));
    }
    if !m.mapping_ready || !verify(workspace, &m)? {
        return Ok(unavailable(
            "PDF_STALE",
            "컴파일된 원문과 현재 원문이 다릅니다. 다시 빌드하고 선택하세요",
        ));
    }
    let quote = args["quote"].as_str().unwrap_or_default();
    if quote.is_empty() || quote.len() > 65536 {
        return Ok(unavailable(
            "PDF_SELECTION_LIMIT",
            "자동 편집할 선택은 64 KiB 이하여야 합니다",
        ));
    }
    let pages = args["pageSelections"]
        .as_array()
        .ok_or_else(|| AppError::new("PDF_SELECTION_INVALID", "선택 영역 없음"))?;
    if pages.is_empty() || pages.len() > 8 {
        return Ok(unavailable(
            "PDF_GEOMETRY_UNSUPPORTED",
            "선택 페이지 범위가 지원되지 않습니다",
        ));
    }
    let mut samples = Vec::<(String, u32, u32, [f64; 4])>::new();
    for page in pages {
        let number = page["page"].as_u64().unwrap_or(0);
        let rects = page["rects"]
            .as_array()
            .ok_or_else(|| AppError::new("PDF_SELECTION_INVALID", "선택 줄 사각형 없음"))?;
        if number == 0 || rects.is_empty() || rects.len() > 256 {
            return Ok(unavailable(
                "PDF_GEOMETRY_UNSUPPORTED",
                "선택 줄 기하 정보가 유효하지 않습니다",
            ));
        }
        let mut parsed = Vec::<[f64; 4]>::new();
        for rect in rects {
            let mut r = [0.0; 4];
            for (i, item) in r.iter_mut().enumerate() {
                *item = rect[i].as_f64().filter(|n| n.is_finite()).ok_or_else(|| {
                    AppError::new("PDF_GEOMETRY_UNSUPPORTED", "유효하지 않은 PDF 좌표")
                })?
            }
            if r[2] <= 0.0 || r[3] <= 0.0 {
                return Ok(unavailable("PDF_GEOMETRY_UNSUPPORTED", "빈 선택 줄"));
            }
            parsed.push(r);
        }
        for (i, a) in parsed.iter().enumerate() {
            for b in parsed.iter().skip(i + 1) {
                let overlap = a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
                let gap = (b[0] - a[0] - a[2]).max(a[0] - b[0] - b[2]);
                if overlap && gap > 24.0 {
                    return Ok(unavailable(
                        "PDF_NONCONTIGUOUS",
                        "여러 열의 비연속 선택은 원문에서 명시적으로 편집하세요",
                    ));
                }
            }
        }
        for (index, r) in parsed.iter().enumerate() {
            let fractions: &[f64] = if index == 0 || index + 1 == parsed.len() {
                &[0.15, 0.85]
            } else {
                &[0.5]
            };
            for fraction in fractions {
                let result = super::sync(
                    workspace,
                    json!({"buildId":m.build_id,"page1":number,"xPt":r[0]+r[2]*fraction,"yPt":r[1]+r[3]*0.5}),
                    false,
                )?;
                if result["method"].as_str() == Some("unicodeFallback")
                    && result["editGrade"] != true
                {
                    return Ok(unavailable(
                        "SYNCTEX_FALLBACK_UNVERIFIED",
                        "Unicode 보조 매핑의 기하 검증을 먼저 실행하거나 원문에서 범위를 직접 선택하세요",
                    ));
                }
                let records = result["records"]
                    .as_array()
                    .ok_or_else(|| AppError::new("SYNC_NO_MATCH", "원문 매핑 없음"))?;
                let mut candidates = HashSet::new();
                for record in records {
                    if let (Some(input), Some(line)) =
                        (record["input"].as_str(), record["line"].as_u64())
                        && let Ok(path) = host_relative(&m, input, workspace)
                    {
                        candidates.insert((path, line as u32));
                    }
                }
                if candidates.len() != 1 {
                    return Ok(
                        json!({"kind":"ambiguous","candidates":candidates.into_iter().map(|(path,line)|json!({"path":path,"line1":line})).collect::<Vec<_>>(),"reason":"한 선택 줄이 여러 원문 위치에 대응합니다"}),
                    );
                }
                let (path, line) = candidates
                    .into_iter()
                    .next()
                    .ok_or_else(|| AppError::new("SYNC_NO_MATCH", "원문 후보 없음"))?;
                samples.push((path, line, number as u32, *r));
            }
        }
    }
    let files = samples.iter().map(|s| s.0.as_str()).collect::<HashSet<_>>();
    if files.len() != 1 {
        return Ok(unavailable(
            "PDF_NONCONTIGUOUS",
            "여러 원문 파일에 걸친 선택은 자동 변경하지 않습니다",
        ));
    }
    let file = samples[0].0.clone();
    let (source, hash) = document(workspace, &file)?;
    if !m.sources.iter().any(|s| s.path == file && s.sha256 == hash) {
        return Ok(unavailable(
            "PDF_STALE",
            "현재 원문이 빌드 스냅샷과 다릅니다",
        ));
    }
    let before = args["before"].as_str().unwrap_or_default();
    let after = args["after"].as_str().unwrap_or_default();
    let lines = samples.iter().map(|s| s.1).collect::<Vec<_>>();
    let intervals = unique_literal(&source, quote, before, after, &lines);
    if intervals.len() != 1 {
        return Ok(
            json!({"kind":"ambiguous","candidates":[{"path":file,"line1":samples[0].1}],"reason":if intervals.is_empty(){"수식·명령·문단 경계를 넘지 않는 리터럴 원문을 증명할 수 없습니다"}else{"같은 문구가 여러 번 나타납니다"}}),
        );
    }
    let interval = &intervals[0];
    let start_line = source[..interval.start]
        .bytes()
        .filter(|b| *b == b'\n')
        .count() as u32
        + 1;
    let end_line = start_line
        + source[interval.start..interval.end]
            .bytes()
            .filter(|b| *b == b'\n')
            .count() as u32;
    let mut forward_cache = HashMap::<u32, Value>::new();
    for sample in &samples {
        let line = sample.1.clamp(start_line, end_line);
        if let std::collections::hash_map::Entry::Vacant(entry) = forward_cache.entry(line) {
            entry.insert(super::sync(
                workspace,
                json!({"buildId":m.build_id,"file":file,"line1":line}),
                true,
            )?);
        }
        let forward = &forward_cache[&line];
        if forward["method"].as_str() == Some("unicodeFallback") && forward["editGrade"] != true {
            return Ok(unavailable(
                "SYNCTEX_FALLBACK_UNVERIFIED",
                "기하 검증되지 않은 보조 매핑입니다",
            ));
        }
        let agrees = forward["records"].as_array().is_some_and(|records| {
            records.iter().any(|r| {
                let (Some(page), Some(h), Some(v), Some(w), Some(height)) = (
                    r["page"].as_u64(),
                    r["h"].as_f64(),
                    r["v"].as_f64(),
                    r["W"].as_f64(),
                    r["H"].as_f64(),
                ) else {
                    return false;
                };
                page == sample.2 as u64
                    && h <= sample.3[0] + sample.3[2] + 48.0
                    && h + w + 48.0 >= sample.3[0]
                    && v - height <= sample.3[1] + sample.3[3] + 48.0
                    && v + 48.0 >= sample.3[1]
            })
        });
        if !agrees {
            return Ok(unavailable(
                "SYNC_GEOMETRY_DISAGREEMENT",
                "원문과 PDF 줄 위치가 일치하지 않습니다",
            ));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let proof = Proof {
        workspace: workspace.reference.id.clone(),
        epoch: workspace.reference.epoch,
        manifest: m,
        file: file.clone(),
        start: interval.start,
        end: interval.end,
        base: hash.clone(),
        expires: Instant::now() + Duration::from_secs(300),
    };
    let mut proofs = PROOFS.lock().unwrap_or_else(|e| e.into_inner());
    proofs.retain(|_, p| p.expires > Instant::now());
    if proofs.len() >= 32 {
        proofs.clear()
    }
    proofs.insert(id.clone(), proof);
    Ok(
        json!({"kind":"exact","file":{"workspaceId":workspace.reference.id,"path":file},"line1":start_line,"startByte":interval.start,"endByte":interval.end,"baseSha256":hash,"sourceText":&source[interval.start..interval.end],"proofId":id}),
    )
}
pub fn escape_plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '$' | '&' | '#' | '%' | '_' => {
                out.push('\\');
                out.push(c)
            }
            '^' => out.push_str("\\textasciicircum{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            _ => out.push(c),
        }
    }
    out
}
pub fn apply_proven_edit(workspace: &Workspace, args: Value) -> AppResult<Value> {
    let id = args["proofId"]
        .as_str()
        .ok_or_else(|| AppError::new("PROOF_INVALID", "편집 증명 없음"))?;
    let proof = PROOFS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::new("PDF_STALE", "편집 증명이 만료되었습니다"))?;
    if proof.workspace != workspace.reference.id
        || proof.epoch != workspace.reference.epoch
        || proof.expires < Instant::now()
        || !verify(workspace, &proof.manifest)?
    {
        return Err(AppError::new(
            "PDF_STALE",
            "원문이 변경되었거나 선택이 만료되었습니다",
        ));
    }
    let (source, hash) = document(workspace, &proof.file)?;
    if hash != proof.base {
        return Err(AppError::new(
            "FILE_CONFLICT",
            "선택 후 원문이 변경되었습니다",
        ));
    }
    let text = args["text"]
        .as_str()
        .ok_or_else(|| AppError::new("EDIT_INVALID", "대체 텍스트 없음"))?;
    if text.len() > 1024 * 1024 {
        return Err(AppError::new("EDIT_LIMIT", "대체 텍스트 크기 제한 초과"));
    }
    let crlf = source.contains("\r\n") && !source.replace("\r\n", "").contains('\n');
    let text = if crlf {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    let mut updated = source[..proof.start].to_string();
    updated.push_str(&escape_plain(&text));
    updated.push_str(&source[proof.end..]);
    let transaction = uuid::Uuid::new_v4().to_string();
    let logical = updated.strip_prefix('\u{feff}').unwrap_or(&updated);
    let result=workspace.execute("save_text",json!({"path":proof.file,"expectedSha256":proof.base,"text":logical,"transactionId":transaction}))?;
    PROOFS.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    Ok(
        json!({"status":"applied","path":proof.file,"line1":source[..proof.start].bytes().filter(|b|*b==b'\n').count()+1,"transactionId":transaction,"revision":result,"rootTex":proof.manifest.root_tex,"engine":proof.manifest.engine}),
    )
}
