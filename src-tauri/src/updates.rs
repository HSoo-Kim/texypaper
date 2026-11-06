use crate::{
    contracts::*,
    state::{AppState, atomic_json},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CURRENT: &str = env!("CARGO_PKG_VERSION");
const MAX_RESPONSE: u64 = 65536;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub kind: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl UpdateStatus {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            current_version: CURRENT.into(),
            latest_version: None,
            release_url: None,
            notes: None,
            checked_at: None,
            error: None,
        }
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn validate_url(input: &str) -> AppResult<reqwest::Url> {
    let url = reqwest::Url::parse(input).map_err(|_| {
        AppError::new(
            "UPDATE_URL_INVALID",
            "Use an HTTPS release feed or GitHub repository URL",
        )
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new(
            "UPDATE_URL_INVALID",
            "Update URLs must use HTTPS without credentials, query or fragment",
        ));
    }
    Ok(url)
}
pub fn validate_settings(settings: &Value) -> AppResult<()> {
    if let Some(updates) = settings.get("updates") {
        let value = updates
            .as_object()
            .ok_or_else(|| AppError::new("INVALID_SETTINGS", "updates must be an object"))?;
        if value.get("enabled").is_some_and(|v| !v.is_boolean()) {
            return Err(AppError::new(
                "INVALID_SETTINGS",
                "updates.enabled must be boolean",
            ));
        }
        if let Some(feed) = value.get("feedUrl") {
            let feed = feed
                .as_str()
                .ok_or_else(|| AppError::new("UPDATE_URL_INVALID", "feedUrl must be a string"))?;
            if !feed.trim().is_empty() {
                validate_url(feed.trim())?;
            }
        }
    }
    Ok(())
}
fn configuration(state: &AppState) -> AppResult<(bool, String)> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("STATE_ERROR", "Settings lock poisoned"))?;
    let enabled = settings
        .pointer("/updates/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let feed = settings
        .pointer("/updates/feedUrl")
        .and_then(Value::as_str)
        .unwrap_or(option_env!("TEXYPAPER_UPDATE_FEED_URL").unwrap_or(""))
        .trim()
        .to_owned();
    Ok((enabled, feed))
}
fn cached(state: &AppState, feed: &str) -> AppResult<Option<UpdateStatus>> {
    match fs::read(state.data_dir.join("updates.json")) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)?;
            if value.get("feedUrl").and_then(Value::as_str) != Some(feed) {
                return Ok(None);
            }
            let mut status: UpdateStatus =
                serde_json::from_value(value.get("status").cloned().ok_or_else(|| {
                    AppError::new("UPDATE_CACHE_INVALID", "Missing update status")
                })?)?;
            status.current_version = CURRENT.into();
            if status
                .latest_version
                .as_deref()
                .is_some_and(|v| !is_newer(v, CURRENT))
            {
                status.kind = "current".into();
            }
            Ok(Some(status))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
pub fn status(state: &AppState) -> AppResult<UpdateStatus> {
    let (enabled, feed) = configuration(state)?;
    if !enabled {
        return Ok(UpdateStatus::new("disabled"));
    }
    if feed.is_empty() {
        return Ok(UpdateStatus::new("unconfigured"));
    }
    Ok(cached(state, &feed)?.unwrap_or_else(|| UpdateStatus::new("idle")))
}
fn endpoint(feed: &str) -> AppResult<(reqwest::Url, bool)> {
    let mut url = validate_url(feed)?;
    if url.host_str() == Some("github.com") {
        let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
            })
        {
            return Err(AppError::new(
                "UPDATE_URL_INVALID",
                "Use https://github.com/owner/repository",
            ));
        }
        url = reqwest::Url::parse(&format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            parts[0], parts[1]
        ))
        .map_err(|e| AppError::new("UPDATE_URL_INVALID", e.to_string()))?;
        return Ok((url, true));
    }
    let github =
        url.host_str() == Some("api.github.com") && url.path().ends_with("/releases/latest");
    Ok((url, github))
}
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (
        semver::Version::parse(latest.trim_start_matches('v')),
        semver::Version::parse(current),
    ) {
        (Ok(latest), Ok(current)) => latest.pre.is_empty() && latest > current,
        _ => false,
    }
}
fn decode_release(value: Value, github: bool) -> AppResult<UpdateStatus> {
    if github
        && (value.get("draft").and_then(Value::as_bool) == Some(true)
            || value.get("prerelease").and_then(Value::as_bool) == Some(true))
    {
        return Err(AppError::new(
            "UPDATE_RELEASE_INVALID",
            "Only stable published releases are accepted",
        ));
    }
    let version = value
        .get(if github { "tag_name" } else { "version" })
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("UPDATE_RELEASE_INVALID", "Release version missing"))?
        .trim_start_matches('v');
    semver::Version::parse(version).map_err(|_| {
        AppError::new(
            "UPDATE_RELEASE_INVALID",
            "Release version is not semantic versioning",
        )
    })?;
    let url = value
        .get(if github { "html_url" } else { "url" })
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("UPDATE_RELEASE_INVALID", "Release page URL missing"))?;
    validate_url(url)?;
    let notes = value
        .get(if github { "body" } else { "notes" })
        .and_then(Value::as_str)
        .map(|text| text.chars().take(2000).collect());
    Ok(UpdateStatus {
        kind: if is_newer(version, CURRENT) {
            "available"
        } else {
            "current"
        }
        .into(),
        current_version: CURRENT.into(),
        latest_version: Some(version.to_owned()),
        release_url: Some(url.to_owned()),
        notes,
        checked_at: Some(now()),
        error: None,
    })
}
pub fn check(state: &AppState, force: bool) -> AppResult<UpdateStatus> {
    let _guard = state
        .update_lock
        .try_lock()
        .map_err(|_| AppError::new("UPDATE_BUSY", "An update check is already running"))?;
    let (enabled, feed) = configuration(state)?;
    if !enabled {
        return Ok(UpdateStatus::new("disabled"));
    }
    if feed.is_empty() {
        return Ok(UpdateStatus::new("unconfigured"));
    }
    let previous = cached(state, &feed)?;
    if !force
        && let Some(status) = &previous
        && status
            .checked_at
            .is_some_and(|time| now().saturating_sub(time) < 86400)
    {
        return Ok(status.clone());
    }
    let attempt = (|| {
        let (url, github) = endpoint(&feed)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("TexyPaper/{CURRENT}"))
            .build()
            .map_err(|e| AppError::new("UPDATE_NETWORK", e.to_string()))?;
        let response = client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .map_err(|e| AppError::new("UPDATE_NETWORK", e.to_string()))?;
        if !response.status().is_success() {
            return Err(AppError::new(
                "UPDATE_HTTP",
                format!("Release service returned HTTP {}", response.status()),
            ));
        }
        if response.content_length().is_some_and(|n| n > MAX_RESPONSE) {
            return Err(AppError::new(
                "UPDATE_RESPONSE_TOO_LARGE",
                "Release response exceeds 64 KiB",
            ));
        }
        let mut bytes = Vec::new();
        response.take(MAX_RESPONSE + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err(AppError::new(
                "UPDATE_RESPONSE_TOO_LARGE",
                "Release response exceeds 64 KiB",
            ));
        }
        decode_release(serde_json::from_slice(&bytes)?, github)
    })();
    let result = match attempt {
        Ok(status) => status,
        Err(error) => {
            let mut status = previous
                .filter(|s| s.kind == "available")
                .unwrap_or_else(|| UpdateStatus::new("error"));
            status.error = Some(format!("{}: {}", error.code, error.message));
            status.checked_at = Some(now());
            status
        }
    };
    atomic_json(
        &state.data_dir.join("updates.json"),
        &json!({"version":1,"feedUrl":feed,"status":result}),
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_order_does_not_offer_prereleases_or_older_versions() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
        assert!(!is_newer("1.0.0-beta.1", "0.1.0"));
        assert!(!is_newer("latest", "0.1.0"));
    }
    #[test]
    fn release_links_reject_active_schemes_and_embedded_credentials() {
        for url in [
            "javascript:alert(1)",
            "http://example.com/latest.json",
            "https://user:secret@example.com/latest.json",
            "https://example.com/feed?token=secret",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(validate_url("https://example.com/releases/0.2.0").is_ok());
    }
    #[test]
    fn release_metadata_requires_published_stable_identity() {
        assert!(
            decode_release(
                json!({"tag_name":"v1.0.0","html_url":"https://example.com/release","draft":true}),
                true
            )
            .is_err()
        );
        assert!(decode_release(json!({"tag_name":"v1.0.0-beta.1","html_url":"https://example.com/release","prerelease":true}),true).is_err());
        assert!(
            decode_release(
                json!({"version":"latest","url":"https://example.com/release"}),
                false
            )
            .is_err()
        );
        assert!(decode_release(json!({"version":"1.0.0"}), false).is_err());
    }
}
