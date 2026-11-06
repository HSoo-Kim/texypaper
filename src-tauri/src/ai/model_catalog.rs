use crate::contracts::{AppError, AppResult};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

// CLI picker metadata is not an exhaustive list of requestable model IDs.
// Keep the newest GPT release per family and only Opus/Sonnet/Haiku 5.5.
// Supplement missing series with published IDs, not account entitlement claims.
// Reviewed 2026-11-06:
// https://developers.openai.com/api/docs/guides/latest-model
// https://platform.claude.com/docs/en/models/overview
const CODEX_MODELS: &[(&str, &str)] = &[
    ("gpt-6-astra", "GPT-6 Astra"),
    ("gpt-6.1-sol", "GPT-6.1 Sol"),
    ("gpt-6.1-terra", "GPT-6.1 Terra"),
    ("gpt-6-luna", "GPT-6 Luna"),
];
const CLAUDE_MODELS: &[&str] = &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
fn version(value: &str, separator: char) -> Option<Vec<u32>> {
    let mut release = Vec::with_capacity(3);
    for part in value.split(separator) {
        if release.len() == 3
            || part.is_empty()
            || part.len() > 3
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        release.push(part.parse().ok()?);
    }
    Some(release)
}

fn claude_identity(id: &str) -> Option<(&str, Vec<u32>)> {
    let rest = id.strip_prefix("claude-")?;
    let (family, release) = rest.split_once('-')?;
    if family.is_empty() || !family.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    // Dated snapshots have the same release as the corresponding versioned ID.
    let release = release
        .rsplit_once('-')
        .filter(|(_, tail)| tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()))
        .map_or(release, |(release, _)| release);
    Some((family, version(release, '-')?))
}

type ClaudeReleases<'a> =
    BTreeMap<(&'a str, std::cmp::Reverse<Vec<u32>>), (&'a str, Option<&'a Value>)>;

pub fn claude(rows: &Value) -> AppResult<Value> {
    let rows = rows.as_array().ok_or_else(|| {
        AppError::new(
            "PROVIDER_PROTOCOL_ERROR",
            "Claude initialize omitted its model catalog",
        )
    })?;
    // Keep one advertised ID per supported 5.5 family, preferring canonical
    // IDs over dated snapshots and aliases.
    let mut releases: ClaudeReleases<'_> = BTreeMap::new();
    for row in rows {
        let Some(id) = row["resolvedModel"]
            .as_str()
            .or_else(|| row["value"].as_str())
        else {
            continue;
        };
        let Some((family, release)) = claude_identity(id) else {
            continue;
        };
        if release.as_slice() != [5, 5] || !matches!(family, "opus" | "sonnet" | "haiku") {
            continue;
        }
        let key = (family, std::cmp::Reverse(release));
        if releases
            .get(&key)
            .is_none_or(|(current, _)| id.len() < current.len())
        {
            releases.insert(key, (id, Some(row)));
        }
    }
    for &id in CLAUDE_MODELS {
        let (family, release) = claude_identity(id).expect("published Claude versioned ID");
        releases
            .entry((family, std::cmp::Reverse(release)))
            .or_insert((id, None));
    }
    let models = releases
        .into_iter()
        .map(|((family, std::cmp::Reverse(release)), (id, row))| {
            let name = format!("{}{}", family[..1].to_uppercase(), &family[1..]);
            let release = release
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(".");
            let label = format!("Claude {name} {release}");
            match row {
                Some(row) => {
                    let efforts = row["supportedEffortLevels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|_| row["supportsEffort"] != false)
                        .filter_map(Value::as_str);
                    normalized_model(id, &label, efforts, None)
                }
                None => documented_model(id, &label),
            }
        })
        .collect::<Vec<_>>();
    Ok(json!({"models":models,"allowCustom":false}))
}

fn gpt_identity(id: &str) -> Option<(&str, [u32; 3])> {
    let rest = id.strip_prefix("gpt-")?;
    let (release, family) = rest.split_once('-').unwrap_or((rest, ""));
    let mut version = [0; 3];
    for (index, part) in release.split('.').enumerate() {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *version.get_mut(index)? = part.parse().ok()?;
    }
    Some((family, version))
}

pub fn codex(mut catalog: Value) -> AppResult<Value> {
    let rows = catalog["data"].as_array().ok_or_else(|| {
        AppError::new(
            "PROVIDER_PROTOCOL_ERROR",
            "Codex model catalog omitted data",
        )
    })?;
    let mut seen = HashSet::new();
    let candidates = rows
        .iter()
        .filter_map(|row| {
            let id = row["model"].as_str()?;
            let (family, release) = gpt_identity(id)?;
            (release[0] >= 6
                && row["inputModalities"]
                    .as_array()
                    .is_none_or(|modes| modes.iter().any(|mode| mode == "text"))
                && seen.insert(id))
            .then_some((row, family, release))
        })
        .collect::<Vec<_>>();
    let mut latest = BTreeMap::new();
    for (family, release) in candidates
        .iter()
        .map(|(_, family, release)| (*family, *release))
        .chain(
            CODEX_MODELS
                .iter()
                .map(|(id, _)| gpt_identity(id).expect("published GPT versioned ID")),
        )
    {
        latest
            .entry(family)
            .and_modify(|current| *current = std::cmp::max(*current, release))
            .or_insert(release);
    }
    let mut selected = candidates
        .into_iter()
        .filter(|(_, family, release)| latest.get(family) == Some(release))
        .map(|(row, _, _)| row.clone())
        .collect::<Vec<_>>();
    // Compare releases within the full family suffix, not globally or by
    // `upgrade`: a newer Sol must not hide Astra, Luna, or a distinct variant.
    selected.sort_by_key(|row| !row["isDefault"].as_bool().unwrap_or(false));
    for row in &mut selected {
        let id = row["model"].as_str().unwrap_or("");
        let label = row["displayName"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase();
        if gpt_identity(&label).map(|(_, release)| release)
            != gpt_identity(id).map(|(_, release)| release)
        {
            row["displayName"] = json!(id);
        }
    }
    let mut models = selected
        .iter()
        .map(|row| {
            let efforts = row["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| entry["reasoningEffort"].as_str());
            normalized_model(
                row["model"].as_str().unwrap_or(""),
                row["displayName"].as_str().unwrap_or(""),
                efforts,
                row["defaultReasoningEffort"].as_str(),
            )
        })
        .collect::<Vec<_>>();
    for &(id, label) in CODEX_MODELS {
        let (family, release) = gpt_identity(id).expect("published GPT versioned ID");
        if latest.get(family) == Some(&release) && !models.iter().any(|model| model["id"] == id) {
            models.push(documented_model(id, label));
        }
    }
    catalog["data"] = json!(selected);
    catalog["nextCursor"] = Value::Null;
    Ok(json!({"models":models,"catalog":catalog,"allowCustom":false}))
}

fn documented_model(id: &str, label: &str) -> Value {
    // No guessed CLI reasoning capabilities: use the provider default until
    // its own metadata advertises supported effort values for this exact ID.
    let mut model = normalized_model(id, label, std::iter::empty(), None);
    model["catalogSource"] = json!("official");
    model
}

fn normalized_model<'a>(
    id: &str,
    label: &str,
    efforts: impl Iterator<Item = &'a str>,
    default: Option<&str>,
) -> Value {
    let mut seen = HashSet::new();
    let efforts = efforts
        .filter(|effort| !effort.is_empty() && seen.insert(*effort))
        .map(|effort| json!({"value":effort,"label":effort}))
        .collect::<Vec<_>>();
    let mut model = json!({"id":id,"label":label,"reasoningEfforts":efforts});
    if let Some(default) = default
        && efforts.iter().any(|effort| effort["value"] == default)
    {
        model["defaultReasoningEffort"] = json!(default);
    }
    model
}

pub fn requested_effort(args: &Value) -> AppResult<Option<&str>> {
    match args.get("reasoningEffort") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) if value.len() <= 256 => Ok(Some(value)),
        _ => Err(AppError::new(
            "PROVIDER_REASONING_INVALID",
            "Reasoning effort must be an advertised value of at most 256 bytes, or empty for the provider default",
        )),
    }
}

pub fn validate_selection(catalog: &Value, model: &str, effort: Option<&str>) -> AppResult<()> {
    let selected = catalog["models"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == model));
    if selected.is_none() && catalog["allowCustom"] != true {
        return Err(AppError::new(
            "PROVIDER_MODEL_UNAVAILABLE",
            format!("Model {model} is not in the current CLI or documented official model catalog"),
        ));
    }
    if let Some(effort) = effort
        && !selected.is_some_and(|selected| {
            selected["reasoningEfforts"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value["value"] == effort))
        })
    {
        return Err(AppError::new(
            "PROVIDER_REASONING_UNSUPPORTED",
            format!(
                "Reasoning effort {effort} is not advertised for model {model}. Choose a supported effort or the provider default."
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(catalog: &Value) -> Vec<&str> {
        catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn limited_codex_picker_does_not_reduce_the_series_to_astra() {
        let catalog = codex(json!({"data":[
            {"model":"gpt-6-astra","supportedReasoningEfforts":[{"reasoningEffort":"high"}]},
            {"model":"gpt-5.6-sol"},
            {"model":"gpt-6-sol","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"}]}
        ]}))
        .unwrap();
        let selected: HashSet<_> = ids(&catalog).into_iter().collect();
        assert_eq!(
            selected,
            HashSet::from(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"])
        );
        assert!(validate_selection(&catalog, "gpt-6-astra", Some("high")).is_ok());
        assert_eq!(
            validate_selection(&catalog, "gpt-6-sol", None)
                .unwrap_err()
                .code,
            "PROVIDER_MODEL_UNAVAILABLE"
        );
        assert_eq!(catalog["catalog"]["data"].as_array().unwrap().len(), 1);
        for model in catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|model| model["id"] != "gpt-6-astra")
        {
            let id = model["id"].as_str().unwrap();
            assert!(validate_selection(&catalog, id, None).is_ok());
            assert_eq!(model["catalogSource"], "official");
            assert_eq!(
                validate_selection(&catalog, id, Some("high"))
                    .unwrap_err()
                    .code,
                "PROVIDER_REASONING_UNSUPPORTED"
            );
        }
    }

    #[test]
    fn codex_keeps_latest_per_family_without_guessing_capabilities() {
        let catalog = codex(json!({"data":[
            {"model":"gpt-6-sol","upgrade":"gpt-6.1-sol","supportedReasoningEfforts":[{"reasoningEffort":"low"}]},
            {"model":"gpt-6.1-sol","supportedReasoningEfforts":[{"reasoningEffort":"high"}]},
            {"model":"gpt-6.1-sol"},
            {"model":"gpt-6-luna","hidden":true,"upgrade":"gpt-6.1-terra"},
            {"model":"gpt-6-sol-mini"},
            {"model":"gpt-6.1-astra"},
            {"model":"gpt-7.9"},
            {"model":"gpt-7.10"},
            {"model":"gpt-6-audio","inputModalities":["audio"]},
            {"model":"gpt-latest"}
        ]})).unwrap();
        let selected = ids(&catalog);
        for id in [
            "gpt-6.1-sol",
            "gpt-6-luna",
            "gpt-7.10",
            "gpt-6-sol-mini",
            "gpt-6.1-astra",
        ] {
            assert!(selected.contains(&id));
        }
        assert_eq!(
            selected.iter().filter(|id| **id == "gpt-6.1-sol").count(),
            1
        );
        assert!(!selected.contains(&"gpt-6-audio"));
        assert!(!selected.contains(&"gpt-latest"));
        assert!(!selected.contains(&"gpt-6-sol"));
        assert!(!selected.contains(&"gpt-6-astra"));
        assert!(!selected.contains(&"gpt-7.9"));
        assert!(
            catalog["catalog"]["data"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| { row["model"] != "gpt-6-sol" && row["model"] != "gpt-7.9" })
        );
        assert!(validate_selection(&catalog, "gpt-6.1-sol", Some("high")).is_ok());
        assert!(validate_selection(&catalog, "gpt-6.1-sol", Some("low")).is_err());
    }

    #[test]
    fn claude_keeps_only_supported_five_five_families_and_deduplicates_aliases() {
        let catalog = claude(&json!([
            {"value":"default","resolvedModel":"claude-sonnet-5-5"},
            {"value":"sonnet","resolvedModel":"claude-sonnet-5-5"},
            {"value":"claude-sonnet-5-5-20261101"},
            {"value":"claude-sonnet-5"},
            {"value":"opus","resolvedModel":"claude-opus-5-5"},
            {"value":"claude-opus-5"},
            {"value":"claude-fable-5-1"},
            {"value":"claude-fable-5-5"},
            {"value":"claude-sonnet-6"}
        ]))
        .unwrap();
        let selected: HashSet<_> = ids(&catalog).into_iter().collect();
        assert_eq!(
            selected,
            HashSet::from(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",])
        );
        assert_eq!(ids(&catalog).len(), selected.len());
        for id in selected {
            assert!(validate_selection(&catalog, id, None).is_ok());
        }
        for id in [
            "claude-opus-5",
            "claude-fable-5-1",
            "claude-fable-5-5",
            "claude-sonnet-6",
        ] {
            assert_eq!(
                validate_selection(&catalog, id, None).unwrap_err().code,
                "PROVIDER_MODEL_UNAVAILABLE"
            );
        }
    }

    #[test]
    fn supplementing_series_does_not_reintroduce_excluded_generations() {
        let codex = codex(json!({"data":[
            {"model":"gpt-5.6-sol"}, {"model":"gpt-5.6-terra"}, {"model":"gpt-5.6-luna"}
        ]}))
        .unwrap();
        assert!(ids(&codex).iter().all(|id| !id.starts_with("gpt-5")));
        let claude = claude(&json!([
            {"resolvedModel":"claude-opus-4-8"},
            {"resolvedModel":"claude-haiku-4-5-20251001"}
        ]))
        .unwrap();
        assert!(!ids(&claude).contains(&"claude-opus-4-8"));
        assert!(!ids(&claude).contains(&"claude-haiku-4-5-20251001"));
    }

    #[test]
    fn real_capabilities_are_model_specific_and_unknown_defaults_are_not_invented() {
        let claude = claude(&json!([
            {"resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"resolvedModel":"claude-sonnet-5-5"},
            {"resolvedModel":"claude-haiku-5-5","supportsEffort":false,"supportedEffortLevels":["high"]}
        ])).unwrap();
        assert!(validate_selection(&claude, "claude-opus-5-5", Some("max")).is_ok());
        assert!(validate_selection(&claude, "claude-sonnet-5-5", Some("high")).is_err());
        assert!(validate_selection(&claude, "claude-haiku-5-5", Some("high")).is_err());
        assert!(
            claude["models"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row.get("defaultReasoningEffort").is_none())
        );

        let codex = codex(json!({"data":[
            {"model":"gpt-6-astra","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"max"},{"reasoningEffort":"ultra"}],"defaultReasoningEffort":"medium"},
            {"model":"gpt-6-luna","supportedReasoningEfforts":[{"reasoningEffort":"medium"}],"defaultReasoningEffort":"medium"}
        ]})).unwrap();
        assert_eq!(codex["models"][0]["defaultReasoningEffort"], "medium");
        assert!(validate_selection(&codex, "gpt-6-astra", Some("ultra")).is_ok());
        assert_eq!(
            validate_selection(&codex, "gpt-6-luna", Some("ultra"))
                .unwrap_err()
                .code,
            "PROVIDER_REASONING_UNSUPPORTED"
        );
    }

    #[test]
    fn unsupported_efforts_never_fall_back_or_enable_custom_model_controls() {
        let catalog = claude(&json!([
            {"resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","high"]}
        ])).unwrap();
        for effort in ["medium", "HIGH", " high", "high ", "ultracode", ""] {
            assert_eq!(
                validate_selection(&catalog, "claude-opus-5-5", Some(effort))
                    .unwrap_err()
                    .code,
                "PROVIDER_REASONING_UNSUPPORTED"
            );
        }
        assert_eq!(
            validate_selection(&catalog, "custom-deployment", None)
                .unwrap_err()
                .code,
            "PROVIDER_MODEL_UNAVAILABLE"
        );
        assert_eq!(
            validate_selection(&catalog, "custom-deployment", Some("high"))
                .unwrap_err()
                .code,
            "PROVIDER_MODEL_UNAVAILABLE"
        );
        let catalog = codex(json!({"data":[{"model":"gpt-6-astra"}]})).unwrap();
        assert_eq!(
            validate_selection(&catalog, "gpt-6-unavailable", None)
                .unwrap_err()
                .code,
            "PROVIDER_MODEL_UNAVAILABLE"
        );
        assert!(validate_selection(&catalog, "gpt-6-astra", None).is_ok());
        assert!(validate_selection(&catalog, "gpt-6-astra", Some("high")).is_err());
    }

    #[test]
    fn optional_effort_enforces_type_and_byte_boundaries_without_normalizing_values() {
        for args in [
            json!({}),
            json!({"reasoningEffort":null}),
            json!({"reasoningEffort":""}),
        ] {
            assert_eq!(requested_effort(&args).unwrap(), None);
        }
        for value in [
            json!(true),
            json!(3),
            json!([]),
            json!({}),
            json!("a".repeat(257)),
            json!("한".repeat(86)),
        ] {
            assert_eq!(
                requested_effort(&json!({"reasoningEffort":value}))
                    .unwrap_err()
                    .code,
                "PROVIDER_REASONING_INVALID"
            );
        }
        let boundary = json!({"reasoningEffort":"a".repeat(256)});
        assert_eq!(requested_effort(&boundary).unwrap().unwrap().len(), 256);
        let value = json!({"reasoningEffort":" high "});
        assert_eq!(requested_effort(&value).unwrap(), Some(" high "));
    }

    #[test]
    fn documented_series_support_empty_pickers_but_not_malformed_protocol_data() {
        let empty = codex(json!({"data":[],"nextCursor":null})).unwrap();
        assert!(ids(&empty).contains(&"gpt-6.1-sol"));
        let aliases = claude(&json!([{"value":"opus","displayName":"Opus"}])).unwrap();
        assert!(ids(&aliases).contains(&"claude-opus-5-5"));
        assert!(!ids(&aliases).contains(&"opus"));
        assert!(codex(json!({"data":null})).is_err());
        assert!(claude(&json!({"models":[]})).is_err());
    }
}
