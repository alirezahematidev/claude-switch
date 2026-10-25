//! Choosing the account of the Claude Code extension in a VS Code–family
//! editor.
//!
//! The extension starts Claude Code with the variables listed in its
//! `claudeCode.environmentVariables` setting, and a `CLAUDE_CONFIG_DIR` entry
//! there takes precedence over the editor window's own environment. The
//! setting is machine-scoped, so VS Code reads it only from user settings:
//! the account applies to new Claude tabs in every window of that editor.
//! Tabs that are already open keep the account they started with.
//!
//! Only that one entry is ever written. User settings are JSON with
//! comments, so the file is edited through a concrete syntax tree that keeps
//! comments and formatting, a backup is saved first, and the new file
//! replaces the old one atomically.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use jsonc_parser::cst::{CstInputValue, CstNode, CstRootNode};
use jsonc_parser::ParseOptions;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::paths::ensure_private_dir;

pub const SETTING: &str = "claudeCode.environmentVariables";
const VARIABLE: &str = "CLAUDE_CONFIG_DIR";
const BACKUPS_KEPT: usize = 10;

fn unreadable(e: impl std::fmt::Display) -> AppError {
    AppError::invalid(format!("the editor's settings.json could not be read: {e}"))
}

fn parse(text: &str) -> AppResult<CstRootNode> {
    CstRootNode::parse(text, &ParseOptions::default()).map_err(unreadable)
}

/// The `CLAUDE_CONFIG_DIR` the extension would use from these settings, read
/// the way the extension reads it: the last entry with that name whose value
/// is an absolute path.
pub fn read_config_dir(text: &str) -> AppResult<Option<String>> {
    let root = parse(text)?;
    let Some(object) = root.object_value() else {
        return Ok(None);
    };
    let Some(value) = object
        .get(SETTING)
        .and_then(|p| p.value())
        .and_then(|v| v.to_serde_value())
    else {
        return Ok(None);
    };
    let pairs: Vec<(String, String)> = match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?;
                let value = match item.get("value") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Null) | None => String::new(),
                    Some(other) => other.to_string(),
                };
                Some((name.to_string(), value))
            })
            .collect(),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_str().map_or_else(|| v.to_string(), str::to_string),
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    Ok(pairs
        .into_iter()
        .filter(|(name, value)| name == VARIABLE && Path::new(value).is_absolute())
        .map(|(_, value)| value)
        .next_back())
}

fn names_variable(node: &CstNode) -> bool {
    node.as_object()
        .and_then(|o| o.get("name"))
        .and_then(|p| p.value())
        .and_then(|v| v.to_serde_value())
        .is_some_and(|v| v.as_str() == Some(VARIABLE))
}

fn entry(value: &str) -> CstInputValue {
    CstInputValue::Object(vec![
        ("name".into(), CstInputValue::String(VARIABLE.into())),
        ("value".into(), CstInputValue::String(value.into())),
    ])
}

/// Returns `text` with the `CLAUDE_CONFIG_DIR` entry set to `value`, or
/// removed when `value` is `None`. Everything else is left as written.
pub fn with_config_dir(text: &str, value: Option<&str>) -> AppResult<String> {
    let source = if text.trim().is_empty() { "{}\n" } else { text };
    let root = parse(source)?;
    let object = root
        .object_value_or_create()
        .ok_or_else(|| unreadable("it does not contain a settings object"))?;

    match object.get(SETTING) {
        None => {
            if let Some(value) = value {
                object.append(SETTING, CstInputValue::Array(vec![entry(value)]));
            }
        }
        Some(prop) => {
            let current = prop.value();
            if let Some(array) = current.as_ref().and_then(|v| v.as_array()) {
                for element in array.elements() {
                    if names_variable(&element) {
                        element.remove();
                    }
                }
                match value {
                    Some(value) => {
                        array.append(entry(value));
                        array.ensure_multiline();
                    }
                    None if array.elements().is_empty() => prop.remove(),
                    None => {}
                }
            } else if let Some(map) = current.as_ref().and_then(|v| v.as_object()) {
                if let Some(existing) = map.get(VARIABLE) {
                    existing.remove();
                }
                match value {
                    Some(value) => {
                        map.append(VARIABLE, CstInputValue::String(value.into()));
                    }
                    None if map.properties().is_empty() => prop.remove(),
                    None => {}
                }
            } else {
                return Err(unreadable(format!("{SETTING} is not a list")));
            }
        }
    }
    let out = root.to_string();
    // Never write something the extension would read differently.
    if read_config_dir(&out)?.as_deref() != value {
        return Err(unreadable("the change could not be applied safely"));
    }
    Ok(out)
}

/// Sets (or with `None`, removes) the extension's `CLAUDE_CONFIG_DIR` in a
/// user settings file. Returns false when nothing needed to change.
///
/// A symlinked settings file (common with dotfile repositories) is edited at
/// its target. The previous contents are saved to `backup_dir` first.
pub fn write_config_dir(
    settings_file: &Path,
    backup_dir: &Path,
    backup_name: &str,
    value: Option<&str>,
) -> AppResult<bool> {
    let target = match fs::symlink_metadata(settings_file) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(settings_file)?,
        _ => settings_file.to_path_buf(),
    };
    let dir = target
        .parent()
        .filter(|d| d.is_dir())
        .ok_or_else(|| {
            AppError::NotFound(
                "The editor's settings folder (open the editor once, then try again)".into(),
            )
        })?
        .to_path_buf();
    let (original, mode) = match fs::read_to_string(&target) {
        Ok(text) => (
            Some(text),
            fs::metadata(&target)?.permissions().mode() & 0o777,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, 0o644),
        Err(e) => return Err(unreadable(e)),
    };
    let text = original.clone().unwrap_or_default();
    let next = with_config_dir(&text, value)?;
    if original.is_some() && next == text {
        return Ok(false);
    }
    if value.is_none() && original.is_none() {
        return Ok(false);
    }
    if let Some(original) = &original {
        save_backup(backup_dir, backup_name, original)?;
    }

    let tmp = dir.join(".settings.json.claude-switch-tmp");
    let _ = fs::remove_file(&tmp);
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)?;
        file.write_all(next.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    Ok(true)
}

fn save_backup(backup_dir: &Path, name: &str, contents: &str) -> AppResult<PathBuf> {
    ensure_private_dir(backup_dir)?;
    let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let path = backup_dir.join(format!("{name}-settings-{stamp}.json"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(contents.as_bytes())?;

    // Keep the newest few backups of this editor's settings.
    let prefix = format!("{name}-settings-");
    let mut old: Vec<PathBuf> = fs::read_dir(backup_dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".json"))
        })
        .collect();
    old.sort();
    let excess = old.len().saturating_sub(BACKUPS_KEPT);
    for stale in old.into_iter().take(excess) {
        let _ = fs::remove_file(stale);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "/Users/me/.claude-switch/profiles/b";

    #[test]
    fn reads_the_entry_like_the_extension() {
        assert_eq!(read_config_dir("").unwrap(), None);
        assert_eq!(read_config_dir("{}").unwrap(), None);
        let text = r#"{
            // comment
            "claudeCode.environmentVariables": [
                { "name": "FOO", "value": "1" },
                { "name": "CLAUDE_CONFIG_DIR", "value": "relative/ignored" },
                { "name": "CLAUDE_CONFIG_DIR", "value": "/first" },
                { "name": "CLAUDE_CONFIG_DIR", "value": "/second" },
            ],
        }"#;
        assert_eq!(read_config_dir(text).unwrap().as_deref(), Some("/second"));
        let object_form = r#"{ "claudeCode.environmentVariables": { "CLAUDE_CONFIG_DIR": "/x" } }"#;
        assert_eq!(read_config_dir(object_form).unwrap().as_deref(), Some("/x"));
        assert!(read_config_dir("{ not json").is_err());
    }

    #[test]
    fn adds_the_entry_and_keeps_everything_else() {
        let text = "{\n  // keep me\n  \"editor.fontSize\": 13, /* and me */\n  \"files.autoSave\": \"off\"\n}\n";
        let out = with_config_dir(text, Some(DIR)).unwrap();
        assert!(out.contains("// keep me"));
        assert!(out.contains("/* and me */"));
        assert!(out.contains("\"editor.fontSize\": 13"));
        assert!(out.ends_with("}\n"));
        assert_eq!(read_config_dir(&out).unwrap().as_deref(), Some(DIR));
        // Back to the original once removed.
        let removed = with_config_dir(&out, None).unwrap();
        assert_eq!(read_config_dir(&removed).unwrap(), None);
        assert!(!removed.contains(SETTING));
        assert!(removed.contains("// keep me"));
    }

    #[test]
    fn replaces_only_its_own_variable() {
        let text = r#"{
  "claudeCode.environmentVariables": [
    { "name": "HTTPS_PROXY", "value": "http://proxy:8080" }, // proxy
    { "name": "CLAUDE_CONFIG_DIR", "value": "/old" }
  ]
}"#;
        let out = with_config_dir(text, Some(DIR)).unwrap();
        assert_eq!(read_config_dir(&out).unwrap().as_deref(), Some(DIR));
        assert!(out.contains("HTTPS_PROXY"));
        assert!(out.contains("// proxy"));
        assert!(!out.contains("/old"));
        assert_eq!(out.matches("CLAUDE_CONFIG_DIR").count(), 1);

        let removed = with_config_dir(&out, None).unwrap();
        assert!(removed.contains("HTTPS_PROXY"));
        assert!(removed.contains(SETTING));
        assert_eq!(read_config_dir(&removed).unwrap(), None);
    }

    #[test]
    fn handles_empty_files_trailing_commas_and_bad_values() {
        let out = with_config_dir("", Some(DIR)).unwrap();
        assert_eq!(read_config_dir(&out).unwrap().as_deref(), Some(DIR));
        let out = with_config_dir("{\n  \"a\": 1,\n}\n", Some(DIR)).unwrap();
        assert_eq!(read_config_dir(&out).unwrap().as_deref(), Some(DIR));
        assert!(out.contains("\"a\": 1"));
        assert!(with_config_dir(r#"{ "claudeCode.environmentVariables": 3 }"#, Some(DIR)).is_err());
        assert!(with_config_dir("[1, 2]", Some(DIR)).is_err());
        assert!(with_config_dir("{ broken", Some(DIR)).is_err());
        // Paths with characters that need escaping survive.
        let odd = "/Users/me/a \"quoted\" \\ path";
        let out = with_config_dir("{}", Some(odd)).unwrap();
        assert_eq!(read_config_dir(&out).unwrap().as_deref(), Some(odd));
    }

    #[test]
    fn writes_atomically_with_a_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("User");
        fs::create_dir(&user).unwrap();
        let file = user.join("settings.json");
        fs::write(&file, "{ \"a\": 1 }\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        let backups = tmp.path().join("backups");

        assert!(write_config_dir(&file, &backups, "vscode", Some(DIR)).unwrap());
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(read_config_dir(&text).unwrap().as_deref(), Some(DIR));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let saved: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            fs::read_to_string(saved[0].path()).unwrap(),
            "{ \"a\": 1 }\n"
        );
        assert_eq!(
            fs::metadata(saved[0].path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // No change, no write, no backup.
        assert!(!write_config_dir(&file, &backups, "vscode", Some(DIR)).unwrap());
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&user).unwrap().count(), 1);

        assert!(write_config_dir(&file, &backups, "vscode", None).unwrap());
        assert_eq!(
            read_config_dir(&fs::read_to_string(&file).unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn creates_missing_files_and_follows_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("backups");
        let user = tmp.path().join("User");
        fs::create_dir(&user).unwrap();
        let file = user.join("settings.json");
        assert!(!write_config_dir(&file, &backups, "vscode", None).unwrap());
        assert!(!file.exists());
        assert!(write_config_dir(&file, &backups, "vscode", Some(DIR)).unwrap());
        assert!(file.is_file());

        let dotfiles = tmp.path().join("dotfiles");
        fs::create_dir(&dotfiles).unwrap();
        let real = dotfiles.join("settings.json");
        fs::write(&real, "{}\n").unwrap();
        let linked = tmp.path().join("Linked");
        fs::create_dir(&linked).unwrap();
        std::os::unix::fs::symlink(&real, linked.join("settings.json")).unwrap();
        write_config_dir(&linked.join("settings.json"), &backups, "cursor", Some(DIR)).unwrap();
        assert!(fs::symlink_metadata(linked.join("settings.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            read_config_dir(&fs::read_to_string(&real).unwrap())
                .unwrap()
                .as_deref(),
            Some(DIR)
        );

        let missing = tmp.path().join("NoEditor/User/settings.json");
        assert!(matches!(
            write_config_dir(&missing, &backups, "windsurf", Some(DIR)).unwrap_err(),
            AppError::NotFound(_)
        ));
    }

    #[test]
    fn keeps_a_bounded_number_of_backups() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..(BACKUPS_KEPT + 3) {
            save_backup(tmp.path(), "vscode", &i.to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        save_backup(tmp.path(), "cursor", "c").unwrap();
        let names: Vec<String> = fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            names.iter().filter(|n| n.starts_with("vscode-")).count(),
            BACKUPS_KEPT
        );
        assert_eq!(names.iter().filter(|n| n.starts_with("cursor-")).count(), 1);
    }
}
