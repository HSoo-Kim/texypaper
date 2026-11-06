use crate::contracts::{AppError, AppResult, Environment};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

const MAX_FILES: usize = 128;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 8;

pub fn home_dir() -> AppResult<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| {
            AppError::new(
                "SSH_CONFIG_UNAVAILABLE",
                "The user home directory is unavailable",
            )
        })
}
pub fn import_aliases() -> AppResult<Vec<String>> {
    import_aliases_from(&home_dir()?.join(".ssh/config"))
}
pub fn environments() -> AppResult<Vec<Environment>> {
    Ok(import_aliases()?
        .into_iter()
        .map(|alias| Environment {
            id: format!("ssh:{alias}"),
            label: alias.clone(),
            kind: "ssh".into(),
            host_alias: Some(alias),
            hostname: None,
            user: None,
            port: None,
            identity_file: None,
            ssh_config_file: None,
        })
        .collect())
}
pub fn import_aliases_from(config: &Path) -> AppResult<Vec<String>> {
    let mut importer = Importer {
        visited: HashSet::new(),
        aliases: Vec::new(),
        names: HashSet::new(),
        bytes: 0,
        home: home_dir()?,
    };
    importer.file(config, 0)?;
    Ok(importer.aliases)
}
struct Importer {
    visited: HashSet<PathBuf>,
    aliases: Vec<String>,
    names: HashSet<String>,
    bytes: usize,
    home: PathBuf,
}
impl Importer {
    fn file(&mut self, path: &Path, depth: usize) -> AppResult<()> {
        if depth > MAX_DEPTH {
            return Err(limit("Include nesting exceeds eight levels"));
        }
        let canonical = match fs::canonicalize(path) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if self.visited.contains(&canonical) {
            return Ok(());
        }
        if self.visited.len() >= MAX_FILES {
            return Err(limit("SSH configuration includes more than 128 files"));
        }
        let length = fs::metadata(&canonical)?.len();
        if length > 256 * 1024 || self.bytes.saturating_add(length as usize) > MAX_BYTES {
            return Err(limit("SSH configuration exceeds its bounded import size"));
        }
        self.visited.insert(canonical.clone());
        // Limit the actual read too: metadata can race another writer.
        use std::io::Read;
        let mut text = String::new();
        fs::File::open(canonical)?
            .take(256 * 1024 + 1)
            .read_to_string(&mut text)?;
        if text.len() > 256 * 1024 || self.bytes + text.len() > MAX_BYTES {
            return Err(limit("SSH configuration grew beyond its import limit"));
        }
        self.bytes += text.len();
        for line in text.lines() {
            let words = split_line(line)?;
            if words.is_empty() {
                continue;
            }
            if words[0].eq_ignore_ascii_case("host") {
                for alias in &words[1..] {
                    if !alias.is_empty()
                        && !alias.contains(['*', '?', '[', ']', '!', '%', '\0'])
                        && !alias.starts_with('-')
                        && self.names.insert(alias.to_ascii_lowercase())
                    {
                        self.aliases.push(alias.clone());
                    }
                }
            } else if words[0].eq_ignore_ascii_case("include") {
                for pattern in &words[1..] {
                    if pattern.contains('%') {
                        continue;
                    } // Do not evaluate runtime SSH tokens or Match exec.
                    let expanded = if pattern == "~" {
                        self.home.clone()
                    } else if let Some(rest) = pattern
                        .strip_prefix("~/")
                        .or_else(|| pattern.strip_prefix("~\\"))
                    {
                        self.home.join(rest)
                    } else if pattern.starts_with('~') {
                        continue;
                    } else {
                        let p = PathBuf::from(pattern);
                        if p.is_absolute() {
                            p
                        } else {
                            self.home.join(".ssh").join(p)
                        }
                    };
                    for included in expand_glob(&expanded)? {
                        self.file(&included, depth + 1)?;
                    }
                }
            }
        }
        Ok(())
    }
}
fn limit(message: &str) -> AppError {
    AppError::new("SSH_CONFIG_LIMIT", message)
}
fn split_line(line: &str) -> AppResult<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = false;
    let mut escape = false;
    for character in line.chars() {
        if escape {
            if !matches!(character, '\\' | '"' | '#' | ' ' | '\t') {
                word.push('\\');
            }
            word.push(character);
            escape = false;
            continue;
        }
        if character == '\\' {
            escape = true;
            continue;
        }
        if character == '"' {
            quote = !quote;
            continue;
        }
        if character == '#' && !quote {
            break;
        }
        if !quote && (character.is_whitespace() || (character == '=' && words.is_empty())) {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(character);
        }
    }
    if escape {
        word.push('\\');
    }
    if quote {
        return Err(AppError::new(
            "SSH_CONFIG_INVALID",
            "Unclosed quote in SSH configuration",
        ));
    }
    if !word.is_empty() {
        words.push(word);
    }
    Ok(words)
}
fn expand_glob(pattern: &Path) -> AppResult<Vec<PathBuf>> {
    let mut paths = vec![PathBuf::new()];
    for component in pattern.components() {
        let name = component.as_os_str().to_string_lossy();
        if matches!(component, Component::Normal(_)) && name.contains(['*', '?']) {
            let mut next = Vec::new();
            for directory in paths {
                let entries = match fs::read_dir(&directory) {
                    Ok(entries) => entries,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                for (index, entry) in entries.enumerate() {
                    if index >= 4096 {
                        return Err(limit(
                            "Include wildcard directory has more than 4096 entries",
                        ));
                    }
                    let entry = entry?;
                    if wildcard(&name, &entry.file_name().to_string_lossy()) {
                        next.push(entry.path());
                    }
                    if next.len() > MAX_FILES {
                        return Err(limit("Include pattern matches more than 128 files"));
                    }
                }
            }
            paths = next;
        } else {
            for path in &mut paths {
                path.push(component.as_os_str());
            }
        }
    }
    paths.sort();
    Ok(paths)
}
fn wildcard(pattern: &str, value: &str) -> bool {
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && (p[i] == b'?' || p[i] == v[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(at) = star {
            retry += 1;
            j = retry;
            i = at + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_quoted_native_includes_without_executing_config() {
        assert_eq!(
            split_line("Include=\"C:\\Users\\me\\my config\" # note").unwrap(),
            vec!["Include", "C:\\Users\\me\\my config"]
        );
        assert_eq!(
            split_line("Host paper !denied *.example").unwrap(),
            vec!["Host", "paper", "!denied", "*.example"]
        );
        assert!(split_line("Include \"unfinished").is_err());
    }
    #[test]
    fn include_wildcards_are_bounded_component_matchers() {
        assert!(wildcard("*.conf", "paper.conf"));
        assert!(wildcard("host-?", "host-a"));
        assert!(!wildcard("host-?", "host-long"));
    }
}
