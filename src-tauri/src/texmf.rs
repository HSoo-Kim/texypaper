//! Offline WasmTex package mirror. Only canonical, installed TeX Live 2026 trees
//! are readable; project/home search paths and on-demand generators are excluded.
use crate::{latex::artifacts, process::OwnedChild};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, LazyLock, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::http::{Method, Request, Response};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LOOKUPS: usize = 10_000;
const MAX_DATABASE_BYTES: u64 = 32 * 1024 * 1024;
static DISTRIBUTION: LazyLock<Option<Distribution>> = LazyLock::new(discover);
static LOOKUPS: LazyLock<Mutex<HashMap<(u8, String), Lookup>>> = LazyLock::new(Default::default);
pub static SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(8)));
struct Distribution {
    executable: PathBuf,
    install: PathBuf,
    roots: Vec<PathBuf>,
    index: Mutex<Option<FilenameIndex>>,
}
struct Lookup {
    path: Option<PathBuf>,
    expires: Instant,
}
struct FilenameIndex {
    checked: Instant,
    databases: Option<Vec<String>>,
}
#[derive(Debug, PartialEq)]
enum IndexedLookup {
    Found(PathBuf),
    Missing,
    Fallback,
}

// These formats have fixed installed-tree search domains. Other formats and
// ambiguous names still go through kpathsea, preserving its ordering rules.
fn indexed_format(format: u8) -> Option<(&'static str, &'static [&'static str])> {
    Some(match format {
        3 => ("fonts/tfm/", &[".tfm"]),
        11 => ("fonts/map/", &[".map"]),
        25 | 26 => ("tex/", &[".tex"]),
        32 => ("fonts/type1/", &[".pfb", ".pfa"]),
        33 => ("fonts/vf/", &[".vf"]),
        44 => ("fonts/enc/", &[".enc"]),
        _ => return None,
    })
}

fn load_databases(roots: &[PathBuf]) -> Option<Vec<String>> {
    let mut remaining = MAX_DATABASE_BYTES;
    let mut databases = Vec::with_capacity(roots.len());
    for root in roots {
        // Alias databases require kpathsea's own substitution rules.
        if root.join("aliases").try_exists().ok()? {
            return None;
        }
        let file = match fs::File::open(root.join("ls-R")) {
            Ok(file) => file,
            // resolve() uses !! roots: an absent database is not a disk search.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                databases.push(String::new());
                continue;
            }
            Err(_) => return None,
        };
        let length = file.metadata().ok()?.len();
        if length > remaining {
            return None;
        }
        let mut text = String::with_capacity(length as usize);
        file.take(remaining + 1).read_to_string(&mut text).ok()?;
        if text.len() as u64 > remaining || !text.starts_with("% ls-R ") {
            return None;
        }
        remaining -= text.len() as u64;
        databases.push(text);
    }
    Some(databases)
}

fn database_lookup(
    roots: &[PathBuf],
    databases: &[String],
    format: u8,
    name: &str,
) -> IndexedLookup {
    let Some((domain, suffixes)) = indexed_format(format) else {
        return IndexedLookup::Fallback;
    };
    // Check the literal name before format suffixes, just as kpathsea does.
    let lookup = |suffix: &str| {
        let wanted = if suffix.is_empty() {
            std::borrow::Cow::Borrowed(name)
        } else {
            std::borrow::Cow::Owned(format!("{name}{suffix}"))
        };
        let basename = wanted.rsplit('/').next().unwrap_or("");
        let mut found = None;
        for (root, database) in roots.iter().zip(databases) {
            let mut directory = "";
            for line in database.lines() {
                if let Some(header) = line.strip_suffix(':') {
                    directory = header.strip_prefix("./").unwrap_or(header);
                    continue;
                }
                if line != basename
                    || !(directory.starts_with(domain) || directory == domain.trim_end_matches('/'))
                {
                    continue;
                }
                if directory.split('/').any(|part| {
                    part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':'])
                }) {
                    return IndexedLookup::Fallback;
                }
                let mut candidate = PathBuf::with_capacity(
                    root.as_os_str().len() + directory.len() + basename.len() + 2,
                );
                candidate.push(root);
                candidate.push(directory);
                candidate.push(basename);
                if !candidate.ends_with(wanted.as_ref()) {
                    continue;
                }
                if found.is_some() {
                    return IndexedLookup::Fallback;
                }
                found = Some(candidate);
            }
        }
        found.map_or(IndexedLookup::Missing, IndexedLookup::Found)
    };
    let exact = lookup("");
    if exact != IndexedLookup::Missing {
        return exact;
    }
    let mut found = None;
    for suffix in suffixes {
        if name.ends_with(suffix) {
            continue;
        }
        match lookup(suffix) {
            IndexedLookup::Found(path) if found.is_none() => found = Some(path),
            IndexedLookup::Missing => {}
            _ => return IndexedLookup::Fallback,
        }
    }
    found.map_or(IndexedLookup::Missing, IndexedLookup::Found)
}

fn indexed_lookup(distribution: &Distribution, format: u8, name: &str) -> IndexedLookup {
    if indexed_format(format).is_none() {
        return IndexedLookup::Fallback;
    }
    let Ok(mut cache) = distribution.index.lock() else {
        return IndexedLookup::Fallback;
    };
    if cache
        .as_ref()
        .is_none_or(|index| index.checked.elapsed() >= Duration::from_secs(30))
    {
        *cache = Some(FilenameIndex {
            checked: Instant::now(),
            databases: load_databases(&distribution.roots),
        });
    }
    match cache.as_ref().and_then(|index| index.databases.as_ref()) {
        Some(databases) => database_lookup(&distribution.roots, databases, format, name),
        None => IndexedLookup::Fallback,
    }
}

// Numeric IDs are the pinned engine's kpse_file_format_type, not CLI format names.
// Native .fmt/.base/.mem images are ABI-incompatible with the WASM engine: never
// return them as substitutes for the separately verified engine asset formats.
fn format_name(format: u8) -> Option<&'static str> {
    Some(match format {
        0 => "gf",
        1 => "pk",
        2 => "bitmapfont",
        3 => "tfm",
        4 => "afm",
        6 => "bib",
        7 => "bst",
        8 => "cnf",
        9 => "ls-R",
        11 => "map",
        13 => "mf",
        14 => "mfpool",
        15 => "mft",
        16 => "mp",
        17 => "mppool",
        18 => "mpsupport",
        19 => "ocp",
        20 => "ofm",
        21 => "opl",
        22 => "otp",
        23 => "ovf",
        24 => "ovp",
        25 => "graphic/figure",
        26 => "tex",
        27 => "doc",
        28 => "texpool",
        29 => "source",
        30 => "psheader",
        31 => "trofffont",
        32 => "type1",
        33 => "vf",
        34 => "dvipsconfig",
        35 => "ist",
        36 => "truetype",
        37 => "type42",
        38 => "web2c",
        39 => "othertext",
        40 => "otherbin",
        41 => "miscfont",
        42 => "web",
        43 => "cweb",
        44 => "enc",
        45 => "cmap",
        46 => "sfd",
        47 => "opentype",
        48 => "pdftexconfig",
        49 => "lig",
        50 => "texmfscripts",
        51 => "lua",
        52 => "fea",
        53 => "cidmap",
        54 => "mlbib",
        55 => "mlbst",
        56 => "clua",
        57 => "ris",
        58 => "bltxml",
        _ => return None,
    })
}
fn decode_component(value: &str) -> Option<String> {
    let mut output = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let hi = (bytes.next()? as char).to_digit(16)?;
            let lo = (bytes.next()? as char).to_digit(16)?;
            output.push((hi * 16 + lo) as u8);
        } else {
            output.push(byte);
        }
    }
    String::from_utf8(output).ok()
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 512
        && !name.chars().any(char::is_control)
        && !name.contains(['\\', ':', '%', '?', '#', '{', '}', '$', '~'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with(['.', '-']))
}
fn lookup_request(path: &str) -> Option<(u8, String)> {
    let (id, encoded) = path.strip_prefix("/2026/pdftex/")?.split_once('/')?;
    let format = id.parse::<u8>().ok()?;
    if id != format.to_string() || format_name(format).is_none() {
        return None;
    }
    let name = decode_component(encoded)?;
    if !safe_name(&name) {
        return None;
    }
    Some((format, name))
}
fn clean_command(executable: &Path, cwd: &Path) -> Option<Command> {
    let mut command = Command::new(artifacts::tool_path(executable).ok()?);
    command
        .current_dir(artifacts::tool_path(cwd).ok()?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("TEX")
            || upper.starts_with("KPSE")
            || upper.starts_with("MKTEX")
            || upper.starts_with("MAKETEX")
            || upper.ends_with("FONTS")
            || upper.ends_with("INPUTS")
            || matches!(
                upper.as_str(),
                "OSFONTDIR" | "WEB2C" | "VARTEXFONTS" | "INDEXSTYLE" | "PSHEADERS"
            )
        {
            command.env_remove(key);
        }
    }
    Some(command)
}
fn output(command: &mut Command) -> Option<String> {
    let mut child = OwnedChild::spawn(command).ok()?;
    let stdout = child.child_mut().stdout.take()?;
    // Drain even oversized output so a malicious/broken tool cannot block its pipe.
    let reader = thread::spawn(move || {
        let mut result = Vec::new();
        let mut input = stdout;
        let mut buffer = [0u8; 8192];
        let mut oversized = false;
        loop {
            let count = input.read(&mut buffer).ok()?;
            if count == 0 {
                break;
            }
            if result.len() + count <= 1024 * 1024 {
                result.extend_from_slice(&buffer[..count]);
            } else {
                oversized = true;
            }
        }
        if oversized {
            None
        } else {
            String::from_utf8(result).ok()
        }
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.cancel();
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
        }
    }
    reader.join().ok().flatten()
}
fn discover() -> Option<Distribution> {
    for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
        let executable = directory.join(if cfg!(windows) {
            "kpsewhich.exe"
        } else {
            "kpsewhich"
        });
        let Ok(executable) = executable.canonicalize() else {
            continue;
        };
        let Some(bin) = executable.parent() else {
            continue;
        };
        let Some(mut command) = clean_command(&executable, bin) else {
            continue;
        };
        let Some(dist) = output(command.arg("--var-value=TEXMFDIST")) else {
            continue;
        };
        let Ok(dist) = Path::new(dist.trim()).canonicalize() else {
            continue;
        };
        if dist.file_name().is_none_or(|name| name != "texmf-dist") {
            continue;
        }
        let Some(install) = dist.parent() else {
            continue;
        };
        let Ok(release) = fs::File::open(install.join("release-texlive.txt")) else {
            continue;
        };
        let mut version = String::new();
        if release.take(4096).read_to_string(&mut version).is_err()
            || version.lines().next() != Some("TeX Live (https://tug.org/texlive) version 2026")
        {
            continue;
        }
        let Ok(owned_bin) = install.join("bin").canonicalize() else {
            continue;
        };
        if !executable.starts_with(&owned_bin) {
            continue;
        }
        let mut roots = Vec::new();
        for name in ["texmf-config", "texmf-var", "texmf-dist"] {
            if let Ok(root) = install.join(name).canonicalize()
                && root.parent() == Some(install)
                && root.is_dir()
            {
                roots.push(root);
            }
        }
        return Some(Distribution {
            executable,
            install: install.to_path_buf(),
            roots,
            index: Mutex::new(None),
        });
    }
    None
}
fn resolve(distribution: &Distribution, format: u8, name: &str) -> Option<PathBuf> {
    match indexed_lookup(distribution, format, name) {
        IndexedLookup::Found(path) => return Some(path),
        IndexedLookup::Missing => return None,
        IndexedLookup::Fallback => {}
    }
    let mut command = clean_command(&distribution.executable, &distribution.install)?;
    // These are process-local overrides, not global TeX configuration changes.
    // Only installed distribution and generated system maps participate in search.
    let roots = distribution
        .roots
        .iter()
        .filter_map(|root| artifacts::tool_path(root).ok())
        .map(|root| format!("!!{root}"))
        .collect::<Vec<_>>()
        .join(",");
    let roots = format!("{{{roots}}}");
    let install = artifacts::tool_path(&distribution.install).ok()?;
    command
        .env("TEXMF", &roots)
        .env("TEXMFDBS", &roots)
        .env("TEXMFDOTDIR", install)
        .env("OSFONTDIR", "")
        .env("TEXINPUTS", format!("{roots}/tex//"))
        .env("LUAINPUTS", format!("{roots}/{{tex,scripts}}//"))
        .args([
            "--no-mktex=pk",
            "--no-mktex=mf",
            "--no-mktex=tex",
            "--no-mktex=tfm",
            "--all",
            "--must-exist",
            "--progname=pdflatex",
        ])
        .arg(format!("--format={}", format_name(format)?))
        .arg(name);
    let found = output(&mut command)?;
    found
        .lines()
        .filter_map(|line| Path::new(line.trim()).canonicalize().ok())
        .find(|path| path.is_file() && distribution.roots.iter().any(|root| path.starts_with(root)))
}
fn package(format: u8, name: String) -> Option<Vec<u8>> {
    let distribution = DISTRIBUTION.as_ref()?;
    let key = (format, name);
    let now = Instant::now();
    let cached = LOOKUPS
        .lock()
        .ok()?
        .get(&key)
        .filter(|entry| now < entry.expires)
        .map(|entry| entry.path.clone());
    let path = if let Some(cached) = cached {
        cached
    } else {
        let path = resolve(distribution, format, &key.1);
        let mut cache = LOOKUPS.lock().ok()?;
        if cache.len() >= MAX_LOOKUPS {
            cache.retain(|_, entry| now < entry.expires);
        }
        if cache.len() >= MAX_LOOKUPS {
            cache.clear();
        }
        cache.insert(
            key,
            Lookup {
                path: path.clone(),
                expires: now + Duration::from_secs(30),
            },
        );
        path
    }?;
    // Re-authorize cached paths every time, including symlink changes after lookup.
    let path = path.canonicalize().ok()?;
    if !distribution.roots.iter().any(|root| path.starts_with(root)) {
        return None;
    }
    if !path.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let info = file.metadata().ok()?;
    if !info.is_file() || info.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(info.len() as usize);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    Some(bytes)
}

pub fn response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get("Origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("http://tauri.localhost");
    let allowed = matches!(
        origin,
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
    ) || (cfg!(debug_assertions) && origin == "http://127.0.0.1:1420");
    let (status, bytes) = if !allowed {
        (403, Vec::new())
    } else if request.method() == Method::OPTIONS {
        (204, Vec::new())
    } else if request.method() != Method::GET
        || !request.body().is_empty()
        || request.uri().query().is_some()
    {
        (404, Vec::new())
    } else if let Some((format, name)) = lookup_request(request.uri().path()) {
        if let Some(bytes) = package(format, name) {
            (200, bytes)
        } else {
            (404, Vec::new())
        }
    } else {
        // Optional bloom, completion, fontconfig and ICU assets are not fabricated.
        // A 404 lets pinned workers use ordinary package lookup/native fallback.
        (404, Vec::new())
    };
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Vary", "Origin");
    if allowed {
        builder = builder
            .header("Access-Control-Allow-Origin", origin)
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Headers", "Content-Type");
    }
    builder.body(bytes).expect("static texmf response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_lookup_protocol_allows_relative_assets_but_rejects_escapes_and_native_formats() {
        assert_eq!(
            lookup_request("/2026/pdftex/26/article.cls"),
            Some((26, "article.cls".into()))
        );
        assert_eq!(
            lookup_request("/2026/pdftex/33/ptmb7t"),
            Some((33, "ptmb7t".into()))
        );
        assert_eq!(
            lookup_request("/2026/pdftex/26/thumbnails%2Fcas-email.jpeg"),
            Some((26, "thumbnails/cas-email.jpeg".into()))
        );
        assert_eq!(
            lookup_request("/2026/pdftex/26/thumbnails/cas-email.jpeg"),
            Some((26, "thumbnails/cas-email.jpeg".into()))
        );
        for path in [
            "/2025/pdftex/26/article.cls",
            "/2026/pdftex/26/../secret",
            "/2026/pdftex/26/%2e%2e",
            "/2026/pdftex/26/a%2f..%2fb",
            "/2026/pdftex/26/a//b",
            "/2026/pdftex/26/%2fsecret",
            "/2026/pdftex/26/a%5cb",
            "/2026/pdftex/26/C%3Asecret",
            "/2026/pdftex/26/--help",
            "/2026/pdftex/10/pdflatex.fmt",
            "/2026/pdftex/026/article.cls",
        ] {
            assert!(lookup_request(path).is_none(), "{path}");
        }
    }
    #[test]
    fn filename_database_resolves_resources_without_confusing_domains_or_duplicates() {
        let roots = [PathBuf::from("installed")];
        let databases = ["% ls-R -- filename database for kpathsea\n./tex/latex/cas/thumbnails:\ncas-email.jpeg\n\n./fonts/tfm/public/stix:\nt1-stixgeneral.tfm\n\n./tex/latex/base:\narticle.cls\n\n./doc/examples:\narticle.cls\n".into()];
        assert_eq!(
            database_lookup(&roots, &databases, 26, "thumbnails/cas-email.jpeg"),
            IndexedLookup::Found(roots[0].join("tex/latex/cas/thumbnails/cas-email.jpeg"))
        );
        assert_eq!(
            database_lookup(&roots, &databases, 3, "t1-stixgeneral"),
            IndexedLookup::Found(roots[0].join("fonts/tfm/public/stix/t1-stixgeneral.tfm"))
        );
        assert_eq!(
            database_lookup(&roots, &databases, 26, "article.cls"),
            IndexedLookup::Found(roots[0].join("tex/latex/base/article.cls"))
        );
        assert_eq!(
            database_lookup(&roots, &databases, 3, "article.cls"),
            IndexedLookup::Missing
        );
        assert_eq!(
            database_lookup(&roots, &databases, 26, "absent.cfg"),
            IndexedLookup::Missing
        );
        let duplicates = ["% ls-R -- filename database for kpathsea\n./tex/latex/one:\na.sty\n\n./tex/latex/two:\na.sty\n".into()];
        assert_eq!(
            database_lookup(&roots, &duplicates, 26, "a.sty"),
            IndexedLookup::Fallback
        );
        assert_eq!(
            database_lookup(&roots, &duplicates, 26, "two/a.sty"),
            IndexedLookup::Found(roots[0].join("tex/latex/two/a.sty"))
        );
        assert_eq!(
            database_lookup(&roots, &databases, 8, "texmf.cnf"),
            IndexedLookup::Fallback
        );
    }
}
