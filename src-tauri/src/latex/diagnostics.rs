use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub path: Option<String>,
    pub line: Option<u32>,
    pub message: String,
    pub severity: String,
    pub inferred: bool,
}

// Latexmk's summaries repeat the engine/bibliography failure, rather than locating its cause.
// Keep them until filtering so a wrapper-only failure still yields one useful error.
fn driver_summary(message: &str) -> bool {
    let message = message.trim();
    message.starts_with("Latexmk: Errors, so I did not complete making targets")
        || message.starts_with("Collected error summary")
        || message.contains("command failed with exit code")
        || message.contains(": Command for '") && message.contains("gave return code")
        || (message.starts_with("bibtex ") || message.starts_with("biber "))
            && (message.contains(": Bibtex errors:") || message.contains(": Biber errors:"))
}

fn driver_path(path: &str, message: &str) -> bool {
    let path = path.replace('\\', "/").to_ascii_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    // Do not classify arbitrary external Lua inputs (e.g. texmf-dist/tex/.../*.lua)
    // as drivers: those can be document/package errors.
    let script = [".tlu", ".lua", ".pl"]
        .iter()
        .any(|ext| name.ends_with(ext));
    matches!(name, "runscript.tlu" | "latexmk" | "latexmk.pl")
        || script
            && (message.contains("command failed with exit code")
                || (path.contains("/texlive/") || path.contains("/texmf-dist/"))
                    && (path.contains("/bin/") || path.contains("/scripts/")))
}

/// Remove redundant distribution-driver errors, never project-owned scripts or input errors.
/// Resolve project membership before clearing external paths. If no real error survives,
/// retain one path-less explanation, even when warnings are present.
pub fn filter_driver_noise(
    list: Vec<Diagnostic>,
    project_path: impl Fn(&str) -> Option<String>,
) -> Vec<Diagnostic> {
    let mut fallback = None;
    let mut out = Vec::with_capacity(list.len());
    for mut diagnostic in list {
        let resolved = diagnostic.path.as_deref().and_then(&project_path);
        let noise = resolved.is_none()
            && diagnostic.path.as_deref().map_or_else(
                || driver_summary(&diagnostic.message),
                |path| driver_path(path, &diagnostic.message),
            );
        if noise {
            if fallback.is_none() && diagnostic.severity == "error" {
                fallback = Some(diagnostic);
            }
        } else {
            if diagnostic.path.is_some() && resolved.is_none() {
                diagnostic.inferred = true;
            }
            diagnostic.path = resolved;
            out.push(diagnostic);
        }
    }
    if !out.iter().any(|d| d.severity == "error")
        && let Some(mut diagnostic) = fallback
    {
        diagnostic.path = None;
        diagnostic.line = None;
        diagnostic.inferred = true;
        diagnostic.message = format!("LaTeX build failed: {}", diagnostic.message.trim());
        out.push(diagnostic);
    }
    out
}
pub fn parse(text: &str) -> Vec<Diagnostic> {
    let re = regex::Regex::new(r"^(.*):([0-9]+):\s?(.*)$").expect("static diagnostic regex");
    let location = regex::Regex::new(r"l\.([0-9]+)\s?(.*)").expect("static line regex");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut pending: Option<String> = None;
    let mut warning: Option<String> = None;
    for line in text.lines() {
        let diag = if let Some(c) = re.captures(line) {
            Some(Diagnostic {
                path: Some(c[1].into()),
                line: c[2].parse().ok(),
                message: c[3].into(),
                severity: if c[3].contains("Warning") {
                    "warning"
                } else {
                    "error"
                }
                .into(),
                inferred: false,
            })
        } else if let Some(c) = location.captures(line) {
            pending.take().map(|message| Diagnostic {
                path: None,
                line: c[1].parse().ok(),
                message: format!("{message} {}", &c[2]),
                severity: "error".into(),
                inferred: true,
            })
        } else if driver_summary(line)
            || line.contains("ERROR -")
            || line.starts_with("I couldn't open database file ")
            || line.starts_with("I couldn't open style file ")
            || line.starts_with("I found no ")
        {
            Some(Diagnostic {
                path: None,
                line: None,
                message: line.trim().into(),
                severity: "error".into(),
                inferred: true,
            })
        } else if let Some(e) = line.strip_prefix("! ") {
            pending = Some(e.into());
            None
        } else if line.contains("Warning:")
            || line.starts_with("Warning--")
            || line.contains("WARN -")
            || line.starts_with("Overfull ")
            || line.starts_with("Underfull ")
        {
            warning.replace(line.into()).map(|message| Diagnostic {
                path: None,
                line: None,
                message,
                severity: "warning".into(),
                inferred: true,
            })
        } else if let Some(w) = warning.as_mut() {
            if line.starts_with('(') || line.starts_with(' ') {
                if w.len() + line.len() < 8192 {
                    w.push(' ');
                    w.push_str(line.trim())
                }
                None
            } else {
                let message = warning.take().unwrap_or_default();
                Some(Diagnostic {
                    path: None,
                    line: None,
                    message,
                    severity: "warning".into(),
                    inferred: true,
                })
            }
        } else {
            None
        };
        if let Some(d) = diag
            && seen.insert((d.path.clone(), d.line, d.message.clone()))
        {
            out.push(d)
        }
    }
    if let Some(message) = pending {
        out.push(Diagnostic {
            path: None,
            line: None,
            message,
            severity: "error".into(),
            inferred: true,
        })
    }
    if let Some(message) = warning
        && seen.insert((None, None, message.clone()))
    {
        out.push(Diagnostic {
            path: None,
            line: None,
            message,
            severity: "warning".into(),
            inferred: true,
        })
    }
    out
}
