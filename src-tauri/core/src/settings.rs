//! Application settings, stored as one JSON document in SQLite.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::env;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CloseBehavior {
    /// Closing the window hides it; sessions keep running in the background
    /// and the app stays in the menu bar.
    KeepRunning,
    /// Closing the window quits the app (after confirmation if sessions run).
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AppSettings {
    /// Explicit Claude Code executable. `None` means auto-detect.
    pub claude_executable_path: Option<String>,
    pub close_behavior: CloseBehavior,
    pub confirm_quit_with_running_sessions: bool,
    /// Accelerator such as `CommandOrControl+Shift+K`; `None` disables it.
    pub global_shortcut: Option<String>,
    pub launch_at_login: bool,
    pub check_auth_on_startup: bool,
    pub notify_on_session_exit: bool,
    pub theme: ThemePreference,
    pub terminal_font_size: u16,
    pub terminal_font_family: String,
    pub terminal_scrollback: u32,
    pub terminal_option_as_meta: bool,
    /// Additional absolute directories prepended to child `PATH`.
    pub extra_path_entries: Vec<String>,
    /// Additional non-secret environment variables for child processes.
    pub custom_env: Vec<EnvVar>,
    pub onboarding_completed: bool,
    /// Editor used last for "Open in editor" (an `EditorInfo` ID).
    pub preferred_editor: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            claude_executable_path: None,
            close_behavior: CloseBehavior::KeepRunning,
            confirm_quit_with_running_sessions: true,
            global_shortcut: None,
            launch_at_login: false,
            check_auth_on_startup: true,
            notify_on_session_exit: true,
            theme: ThemePreference::System,
            terminal_font_size: 13,
            terminal_font_family: String::new(),
            terminal_scrollback: 10_000,
            terminal_option_as_meta: false,
            extra_path_entries: Vec::new(),
            custom_env: Vec::new(),
            onboarding_completed: false,
            preferred_editor: None,
        }
    }
}

/// Partial update. Absent fields are left unchanged. For nullable settings,
/// an empty string clears the value.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsPatch {
    #[ts(optional)]
    pub claude_executable_path: Option<String>,
    #[ts(optional)]
    pub close_behavior: Option<CloseBehavior>,
    #[ts(optional)]
    pub confirm_quit_with_running_sessions: Option<bool>,
    #[ts(optional)]
    pub global_shortcut: Option<String>,
    #[ts(optional)]
    pub launch_at_login: Option<bool>,
    #[ts(optional)]
    pub check_auth_on_startup: Option<bool>,
    #[ts(optional)]
    pub notify_on_session_exit: Option<bool>,
    #[ts(optional)]
    pub theme: Option<ThemePreference>,
    #[ts(optional)]
    pub terminal_font_size: Option<u16>,
    #[ts(optional)]
    pub terminal_font_family: Option<String>,
    #[ts(optional)]
    pub terminal_scrollback: Option<u32>,
    #[ts(optional)]
    pub terminal_option_as_meta: Option<bool>,
    #[ts(optional)]
    pub extra_path_entries: Option<Vec<String>>,
    #[ts(optional)]
    pub custom_env: Option<Vec<EnvVar>>,
    #[ts(optional)]
    pub onboarding_completed: Option<bool>,
    #[ts(optional)]
    pub preferred_editor: Option<String>,
}

impl AppSettings {
    /// Applies a patch, validating every changed field. The shortcut string is
    /// validated by the caller, which owns the shortcut parser.
    pub fn apply(&self, patch: SettingsPatch) -> AppResult<AppSettings> {
        let mut next = self.clone();
        if let Some(path) = patch.claude_executable_path {
            next.claude_executable_path = validate_executable_setting(&path)?;
        }
        if let Some(v) = patch.close_behavior {
            next.close_behavior = v;
        }
        if let Some(v) = patch.confirm_quit_with_running_sessions {
            next.confirm_quit_with_running_sessions = v;
        }
        if let Some(v) = patch.global_shortcut {
            let v = v.trim();
            next.global_shortcut = (!v.is_empty()).then(|| v.to_string());
        }
        if let Some(v) = patch.launch_at_login {
            next.launch_at_login = v;
        }
        if let Some(v) = patch.check_auth_on_startup {
            next.check_auth_on_startup = v;
        }
        if let Some(v) = patch.notify_on_session_exit {
            next.notify_on_session_exit = v;
        }
        if let Some(v) = patch.theme {
            next.theme = v;
        }
        if let Some(v) = patch.terminal_font_size {
            if !(9..=32).contains(&v) {
                return Err(AppError::invalid("Font size must be between 9 and 32"));
            }
            next.terminal_font_size = v;
        }
        if let Some(v) = patch.terminal_font_family {
            let v = v.trim();
            if v.len() > 200
                || v.chars()
                    .any(|c| c.is_control() || matches!(c, ';' | '{' | '}'))
            {
                return Err(AppError::invalid(
                    "Font family contains unsupported characters",
                ));
            }
            next.terminal_font_family = v.to_string();
        }
        if let Some(v) = patch.terminal_scrollback {
            if !(1_000..=100_000).contains(&v) {
                return Err(AppError::invalid(
                    "Scrollback must be between 1,000 and 100,000 lines",
                ));
            }
            next.terminal_scrollback = v;
        }
        if let Some(v) = patch.terminal_option_as_meta {
            next.terminal_option_as_meta = v;
        }
        if let Some(entries) = patch.extra_path_entries {
            next.extra_path_entries = validate_path_entries(&entries)?;
        }
        if let Some(vars) = patch.custom_env {
            next.custom_env = validate_custom_env(&vars)?;
        }
        if let Some(v) = patch.onboarding_completed {
            next.onboarding_completed = v;
        }
        if let Some(v) = patch.preferred_editor {
            let v = v.trim();
            if v.len() > 64 || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(AppError::invalid("Unknown editor"));
            }
            next.preferred_editor = (!v.is_empty()).then(|| v.to_string());
        }
        Ok(next)
    }
}

fn validate_executable_setting(raw: &str) -> AppResult<Option<String>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if !raw.starts_with('/') || raw.contains('\0') || raw.split('/').any(|seg| seg == "..") {
        return Err(AppError::invalid(
            "The Claude Code path must be an absolute path without '..' segments",
        ));
    }
    Ok(Some(raw.to_string()))
}

fn validate_path_entries(entries: &[String]) -> AppResult<Vec<String>> {
    if entries.len() > 32 {
        return Err(AppError::invalid("Too many PATH entries (max 32)"));
    }
    let mut out = Vec::new();
    for raw in entries {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        if !entry.starts_with('/')
            || entry.contains(':')
            || entry.contains('\0')
            || entry.len() > 1024
            || entry.split('/').any(|seg| seg == "..")
        {
            return Err(AppError::invalid(format!(
                "PATH entry must be an absolute directory without ':' or '..': {entry}"
            )));
        }
        if !out.iter().any(|e| e == entry) {
            out.push(entry.to_string());
        }
    }
    Ok(out)
}

fn validate_custom_env(vars: &[EnvVar]) -> AppResult<Vec<EnvVar>> {
    if vars.len() > 64 {
        return Err(AppError::invalid("Too many environment variables (max 64)"));
    }
    let mut out: Vec<EnvVar> = Vec::new();
    for var in vars {
        let name = var.name.trim();
        if name.is_empty() {
            continue;
        }
        env::validate_custom_var_name(name)?;
        if var.value.len() > 4096 || var.value.chars().any(|c| c.is_control()) {
            return Err(AppError::invalid(format!(
                "The value of {name} is too long or contains control characters"
            )));
        }
        if out.iter().any(|v| v.name == name) {
            return Err(AppError::invalid(format!(
                "{name} is defined more than once"
            )));
        }
        out.push(EnvVar {
            name: name.to_string(),
            value: var.value.clone(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_conservative() {
        let s = AppSettings::default();
        assert!(!s.launch_at_login);
        assert!(s.global_shortcut.is_none());
        assert_eq!(s.close_behavior, CloseBehavior::KeepRunning);
        assert!(s.confirm_quit_with_running_sessions);
    }

    #[test]
    fn unknown_and_missing_fields_fall_back_to_defaults() {
        let s: AppSettings =
            serde_json::from_str(r#"{"terminalFontSize": 15, "someFutureField": true}"#).unwrap();
        assert_eq!(s.terminal_font_size, 15);
        assert_eq!(s.terminal_scrollback, 10_000);
    }

    #[test]
    fn rejects_auth_and_secret_custom_env() {
        let s = AppSettings::default();
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "GITHUB_TOKEN",
            "DB_PASSWORD",
            "MY_SECRET",
            "PATH",
            "HOME",
            "1BAD",
            "BAD-NAME",
            "BAD NAME",
        ] {
            let patch = SettingsPatch {
                custom_env: Some(vec![EnvVar {
                    name: name.into(),
                    value: "x".into(),
                }]),
                ..Default::default()
            };
            assert!(s.apply(patch).is_err(), "accepted {name}");
        }
    }

    #[test]
    fn accepts_plain_custom_env() {
        let patch = SettingsPatch {
            custom_env: Some(vec![EnvVar {
                name: "NODE_OPTIONS".into(),
                value: "--max-old-space-size=4096".into(),
            }]),
            ..Default::default()
        };
        let s = AppSettings::default().apply(patch).unwrap();
        assert_eq!(s.custom_env.len(), 1);
    }

    #[test]
    fn validates_path_entries() {
        let ok = SettingsPatch {
            extra_path_entries: Some(vec!["/opt/tools/bin".into(), "/opt/tools/bin".into()]),
            ..Default::default()
        };
        assert_eq!(
            AppSettings::default().apply(ok).unwrap().extra_path_entries,
            vec!["/opt/tools/bin"]
        );
        for bad in ["relative/bin", "/a:/b", "/a/../b"] {
            let patch = SettingsPatch {
                extra_path_entries: Some(vec![bad.into()]),
                ..Default::default()
            };
            assert!(
                AppSettings::default().apply(patch).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn executable_path_must_be_absolute() {
        let bad = SettingsPatch {
            claude_executable_path: Some("claude".into()),
            ..Default::default()
        };
        assert!(AppSettings::default().apply(bad).is_err());
        let clear = SettingsPatch {
            claude_executable_path: Some("".into()),
            ..Default::default()
        };
        assert_eq!(
            AppSettings::default()
                .apply(clear)
                .unwrap()
                .claude_executable_path,
            None
        );
    }
}
