// Streaming Rust adaptation of parseSyncTex/block navigation, pinned to
// LaTeX-Workshop 2f5a60a11a99f33013c1235f0499546cc831cfcb.
// MIT License
//
// Copyright (c) 2018 Thomas Durieux
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
use crate::contracts::{AppError, AppResult};
use std::{
    borrow::Cow,
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
    sync::Arc,
};
#[derive(Debug, Clone)]
pub struct Block {
    pub input: Arc<str>,
    pub line: u32,
    pub page: u32,
    pub h: f64,
    pub v: f64,
    pub w: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Copy, Default)]
struct Geometry {
    h: f64,
    v: f64,
    w: f64,
    height: f64,
}
impl Geometry {
    fn new(h: f64, baseline: f64, width: f64, height: f64, depth: f64) -> Self {
        Self {
            h: h.min(h + width),
            v: baseline + depth,
            w: width.abs(),
            height: height + depth,
        }
    }
    fn finite(self) -> bool {
        [self.h, self.v, self.w, self.height]
            .iter()
            .all(|v| v.is_finite())
    }
    fn distance(self, x: f64, y: f64) -> f64 {
        let dx = (self.h - x).max(0.0).max(x - (self.h + self.w));
        let dy = (self.v - self.height - y).max(0.0).max(y - self.v);
        dx * dx + dy * dy
    }
}
struct Frame {
    geometry: Geometry,
    enclosing_hbox: Option<Geometry>,
    cursor: f64,
}
#[derive(Debug, Default)]
pub struct Index {
    // Source identity belongs to leaves; these public rectangles are their
    // enclosing hboxes, as returned by a native forward query.
    pub blocks: Vec<Block>,
    // Aligned with blocks, but never expanded to the enclosing hbox width.
    hits: Vec<Geometry>,
}
pub(super) fn decode_text(bytes: &[u8]) -> AppResult<Cow<'_, str>> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(Cow::Borrowed(text));
    }
    // Windows TeX writes Input names in the active ANSI code page, not
    // necessarily UTF-8. Reject invalid sequences instead of changing identity.
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MultiByteToWideChar(
                code_page: u32,
                flags: u32,
                input: *const u8,
                input_len: i32,
                output: *mut u16,
                output_len: i32,
            ) -> i32;
        }
        if let Ok(len) = i32::try_from(bytes.len()) {
            let needed =
                unsafe { MultiByteToWideChar(0, 8, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
            if needed > 0 {
                let mut wide = vec![0u16; needed as usize];
                let written = unsafe {
                    MultiByteToWideChar(0, 8, bytes.as_ptr(), len, wide.as_mut_ptr(), needed)
                };
                if written == needed
                    && let Ok(text) = String::from_utf16(&wide)
                {
                    return Ok(Cow::Owned(text));
                }
            }
        }
    }
    Err(AppError::new(
        "SYNC_PATH_ENCODING",
        "SyncTeX 경로를 정확히 해독할 수 없습니다",
    ))
}
fn next_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> AppResult<usize> {
    line.clear();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(line.len());
        }
        let end = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(buffer.len());
        if line.len() + end > 65536 {
            return Err(AppError::new("SYNCTEX_LIMIT", "SyncTeX 줄 길이 제한 초과"));
        }
        line.extend_from_slice(&buffer[..end]);
        let complete = buffer[end - 1] == b'\n';
        reader.consume(end);
        if complete {
            return Ok(line.len());
        }
    }
}
pub fn parse(mut reader: impl BufRead) -> AppResult<Index> {
    let mut index = Index::default();
    let mut files = HashMap::<u32, Arc<str>>::new();
    let mut path_bytes = 0usize;
    let mut page = 0;
    let (mut unit, mut mag, mut xoff, mut yoff): (f64, f64, f64, f64) = (1.0, 1000.0, 0.0, 0.0);
    let mut stack: Vec<Frame> = Vec::new();
    let mut line = Vec::new();
    let mut total = 0usize;
    loop {
        let n = next_line(&mut reader, &mut line)?;
        if n == 0 {
            break;
        }
        total += n;
        if total > 128 * 1024 * 1024 {
            return Err(AppError::new(
                "SYNCTEX_LIMIT",
                "SyncTeX 파일 크기 제한 초과",
            ));
        }
        let text = decode_text(&line)?;
        let line = text.trim_end();
        if let Some(s) = line.strip_prefix("Input:") {
            if let Some((id, path)) = s.split_once(':')
                && let Ok(id) = id.parse()
            {
                path_bytes += path.len();
                if files.len() >= 20000 || path_bytes > 8 * 1024 * 1024 {
                    return Err(AppError::new(
                        "SYNCTEX_LIMIT",
                        "SyncTeX 입력 경로 색인 제한 초과",
                    ));
                }
                files.insert(id, path.into());
            }
            continue;
        }
        for (prefix, value) in [
            ("Unit:", &mut unit),
            ("Magnification:", &mut mag),
            ("X Offset:", &mut xoff),
            ("Y Offset:", &mut yoff),
        ] {
            if let Some(s) = line.strip_prefix(prefix) {
                *value = s
                    .parse()
                    .map_err(|_| AppError::new("SYNCTEX_INVALID", "잘못된 SyncTeX 좌표 헤더"))?;
            }
        }
        if let Some(s) = line.strip_prefix('{') {
            page = s.parse().unwrap_or(0);
            stack.clear();
            continue;
        }
        if line.starts_with('}') {
            page = 0;
            continue;
        }
        if page == 0 {
            continue;
        }
        if line == ")" || line == "]" {
            if let Some(frame) = stack.pop()
                && let Some(parent) = stack.last_mut()
            {
                parent.cursor = frame.geometry.h + frame.geometry.w;
            }
            continue;
        }
        let Some(kind) = line.chars().next() else {
            continue;
        };
        if !matches!(kind, '[' | '(' | 'h' | 'v' | 'k' | 'g' | 'x' | 'r' | '$') {
            continue;
        }
        let mut a = [0.0; 7];
        let mut count = 0;
        for number in line[1..].split([',', ':']) {
            let Ok(value) = number.parse::<f64>() else {
                count = 0;
                break;
            };
            if count == a.len() {
                break;
            }
            a[count] = value;
            count += 1;
        }
        if count < 4 {
            continue;
        }
        let factor = unit * mag / 1000.0 / 65781.76;
        if !factor.is_finite() || factor <= 0.0 {
            return Err(AppError::new(
                "SYNCTEX_INVALID",
                "지원하지 않는 SyncTeX 단위",
            ));
        }
        let h = (a[2] + xoff) * factor;
        let baseline = (a[3] + yoff) * factor;
        let width = a[4] * factor;
        let height = a[5] * factor;
        let depth = a[6] * factor;
        let own = Geometry::new(h, baseline, width, height, depth);
        let enclosing = stack.last().and_then(|frame| frame.enclosing_hbox);
        if matches!(kind, '[' | '(') {
            if stack.len() >= 1024 {
                return Err(AppError::new("SYNCTEX_LIMIT", "SyncTeX 중첩 제한"));
            }
            stack.push(Frame {
                geometry: own,
                enclosing_hbox: if kind == '(' { Some(own) } else { enclosing },
                cursor: h,
            });
            continue;
        }
        let mut hit = match kind {
            // A kern's coordinate is its right edge, unlike a void box.
            'k' => Geometry::new(h - width.max(0.0), baseline, width.abs(), height, depth),
            'h' | 'v' | 'r' => own,
            // Character/glue records give the end of the preceding span.
            _ => {
                let start = stack.last().map_or(h, |frame| frame.cursor);
                Geometry::new(start, baseline, h - start, 0.0, 0.0)
            }
        };
        if hit.height == 0.0
            && let Some(box_geometry) = enclosing
        {
            hit.v = box_geometry.v;
            hit.height = box_geometry.height;
        }
        if let Some(frame) = stack.last_mut() {
            frame.cursor = match kind {
                'h' | 'v' | 'r' => h + width,
                _ => h,
            };
        }
        let forward = enclosing.unwrap_or(hit);
        if hit.finite()
            && forward.finite()
            && let Some(input) = files.get(&(a[0] as u32))
        {
            index.blocks.push(Block {
                input: input.clone(),
                line: a[1] as u32,
                page,
                h: forward.h,
                v: forward.v,
                w: forward.w,
                height: forward.height,
            });
            index.hits.push(hit);
        }
        if index.blocks.len() > 200000 {
            return Err(AppError::new(
                "SYNCTEX_LIMIT",
                "SyncTeX 블록 색인 제한 초과",
            ));
        }
    }
    Ok(index)
}
pub fn load(path: &Path) -> AppResult<Index> {
    let f = File::open(path)?;
    if path.extension().is_some_and(|s| s == "gz") {
        parse(BufReader::new(flate2::read::GzDecoder::new(f)))
    } else {
        parse(BufReader::new(f))
    }
}
impl Index {
    pub fn forward(&self, input: &Path, cwd: &Path, line: u32) -> Vec<&Block> {
        let canonical = input.canonicalize().ok();
        let mut identities = HashMap::<&str, bool>::new();
        let mut blocks = Vec::new();
        for b in &self.blocks {
            let matches = *identities.entry(b.input.as_ref()).or_insert_with(|| {
                canonical.as_ref().is_some_and(|p| {
                    cwd.join(b.input.as_ref()).canonicalize().ok().as_ref() == Some(p)
                })
            });
            if matches {
                blocks.push(b)
            }
        }
        let closest = blocks.iter().map(|b| b.line.abs_diff(line)).min();
        blocks.retain(|b| Some(b.line.abs_diff(line)) == closest);
        blocks
    }
    pub fn inverse(&self, page: u32, x: f64, y: f64) -> Vec<&Block> {
        let best = self
            .blocks
            .iter()
            .zip(&self.hits)
            .filter(|(block, _)| block.page == page)
            .map(|(_, hit)| hit.distance(x, y))
            .fold(f64::INFINITY, f64::min);
        self.blocks
            .iter()
            .zip(&self.hits)
            .filter(|(block, hit)| block.page == page && hit.distance(x, y) <= best + 0.01)
            .map(|(block, _)| block)
            .take(64)
            .collect()
    }
}
