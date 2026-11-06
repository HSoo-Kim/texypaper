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
        } else if let Some(e) = line.strip_prefix("! ") {
            pending = Some(e.into());
            None
        } else if line.contains("Warning:")
            || line.starts_with("Overfull ")
            || line.starts_with("Underfull ")
        {
            warning = Some(line.into());
            None
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
