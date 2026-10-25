//! Child-process environment construction.
//!
//! Children never inherit the app's environment wholesale. They get:
//!
//! 1. a short allowlist of inherited variables (identity, locale, proxies),
//! 2. a deterministic `PATH`,
//! 3. the user's validated custom variables,
//! 4. terminal variables for PTY sessions,
//! 5. `CLAUDE_CONFIG_DIR` for the selected account, always last.
//!
//! Inherited variables that can change how Claude Code authenticates (API
//! keys, provider switches, base URLs, a foreign `CLAUDE_CONFIG_DIR`, ...)
//! are dropped and reported by *name only* so the UI can explain them.
//!
//! `USER` is required: Claude Code uses it as the macOS Keychain account
//! name, and without it every profile reads as signed out.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use ts_rs::TS;

use crate::error::{AppError, AppResult};
use crate::settings::EnvVar;

/// Inherited variables passed through unchanged.
const INHERIT_ALLOWLIST: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_COLLATE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "__CF_USER_TEXT_ENCODING",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "EDITOR",
    "VISUAL",
];

/// Names set by this module; users cannot override them.
const RESERVED: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TERM",
    "COLORTERM",
    "CLAUDE_CONFIG_DIR",
];

const SYSTEM_PATH_TAIL: &[&str] = &["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EnvConflictKind {
    /// Supplies a credential that outranks the profile's login.
    Credential,
    /// Switches the API provider or endpoint.
    Provider,
    /// Points Claude Code at a different configuration directory.
    ConfigDir,
    /// Marks the process as running inside another Claude Code session.
    NestedSession,
    /// Other Claude Code behavior settings.
    ClaudeSetting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvConflict {
    pub name: String,
    pub kind: EnvConflictKind,
}

/// Classifies variables that affect Claude Code's account or provider.
pub fn classify_auth_affecting(name: &str) -> Option<EnvConflictKind> {
    use EnvConflictKind::*;
    const CREDENTIALS: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_PROFILE",
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_WORKSPACE_ID",
        "ANTHROPIC_IDENTITY_TOKEN_FILE",
        "ANTHROPIC_IDENTITY_TOKEN",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
        "ANTHROPIC_AWS_API_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "CLAUDE_CODE_OAUTH_SCOPES",
        "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
        "CLAUDE_CODE_CLIENT_CERT",
        "CLAUDE_CODE_CLIENT_KEY",
        "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    ];
    const NESTED: &[&str] = &[
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_SSE_PORT",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_PID",
    ];
    if CREDENTIALS.contains(&name) {
        return Some(Credential);
    }
    if name == "CLAUDE_CONFIG_DIR" || name == "CLAUDE_CODE_PROJECT_DIR_NAME" {
        return Some(ConfigDir);
    }
    if NESTED.contains(&name) {
        return Some(NestedSession);
    }
    if name.starts_with("CLAUDE_CODE_USE_")
        || name.starts_with("CLAUDE_CODE_SKIP_") && name.ends_with("_AUTH")
        || name == "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"
        || name == "CLAUDE_CODE_SIMPLE"
        || name.starts_with("ANTHROPIC_")
        || name == "CLOUD_ML_REGION"
    {
        return Some(Provider);
    }
    if name.starts_with("CLAUDE_CODE_") || name.starts_with("CLAUDE_") {
        return Some(ClaudeSetting);
    }
    None
}

/// Names that look like they carry secrets. Such variables are never stored
/// in settings.
fn looks_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "COOKIE",
        "AUTH",
        "SESSION",
        "PRIVATE",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

pub fn validate_custom_var_name(name: &str) -> AppResult<()> {
    let valid_shape = name.len() <= 128
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid_shape {
        return Err(AppError::invalid(format!(
            "{name:?} is not a valid environment variable name"
        )));
    }
    if RESERVED.contains(&name) {
        return Err(AppError::invalid(format!(
            "{name} is managed by Claude Switch and cannot be overridden"
        )));
    }
    if classify_auth_affecting(name).is_some() {
        return Err(AppError::invalid(format!(
            "{name} changes how Claude Code authenticates or which provider it uses, so it cannot be set here"
        )));
    }
    if looks_secret(name) {
        return Err(AppError::invalid(format!(
            "{name} looks like a secret. Claude Switch does not store secrets; set it in your shell profile instead"
        )));
    }
    Ok(())
}

/// Inherited variables that would be dropped because they affect auth.
pub fn detect_conflicts<'a>(
    inherited: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<EnvConflict> {
    let mut out: Vec<EnvConflict> = inherited
        .into_iter()
        .filter_map(|(name, _value)| {
            classify_auth_affecting(name).map(|kind| EnvConflict {
                name: name.to_string(),
                kind,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup();
    out
}

/// Inputs for [`build`]. Everything is explicit so tests can construct it.
#[derive(Debug, Clone)]
pub struct EnvInput<'a> {
    pub inherited: &'a [(String, String)],
    pub home: &'a Path,
    pub config_dir: &'a str,
    /// Directory of the Claude Code executable, if known. Prepended to PATH
    /// so npm-style installs can find their `node`.
    pub executable_dir: Option<&'a Path>,
    pub extra_path_entries: &'a [String],
    pub system_path_entries: &'a [String],
    pub custom: &'a [EnvVar],
    pub terminal: bool,
}

pub fn build(input: &EnvInput<'_>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    for (name, value) in input.inherited {
        if INHERIT_ALLOWLIST.contains(&name.as_str()) && !value.contains('\0') {
            env.insert(name.clone(), value.clone());
        }
    }
    env.entry("HOME".into())
        .or_insert_with(|| input.home.to_string_lossy().into_owned());
    if !env.contains_key("USER") {
        if let Some(user) = current_username() {
            env.insert("USER".into(), user.clone());
            env.entry("LOGNAME".into()).or_insert(user);
        }
    }

    env.insert("PATH".into(), build_path(input));

    for var in input.custom {
        // Settings validation already rejects these; re-check defensively.
        if validate_custom_var_name(&var.name).is_ok() {
            env.insert(var.name.clone(), var.value.clone());
        }
    }

    if input.terminal {
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("TERM_PROGRAM".into(), "ClaudeSwitch".into());
    }
    let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| env.get(*k).is_some_and(|v| !v.is_empty()));
    if !has_locale {
        // GUI apps often start without a locale; UTF-8 is required for
        // correct Unicode (including Persian) in Claude Code and shells.
        env.insert("LANG".into(), "en_US.UTF-8".into());
    }

    env.insert("CLAUDE_CONFIG_DIR".into(), input.config_dir.to_string());
    env
}

fn build_path(input: &EnvInput<'_>) -> String {
    let mut entries: Vec<String> = Vec::new();
    let mut push = |entry: String| {
        if !entry.is_empty() && !entry.contains(':') && !entries.contains(&entry) {
            entries.push(entry);
        }
    };
    if let Some(dir) = input.executable_dir {
        push(dir.to_string_lossy().into_owned());
    }
    for entry in input.extra_path_entries {
        push(entry.clone());
    }
    push(input.home.join(".local/bin").to_string_lossy().into_owned());
    for entry in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
        push(entry.to_string());
    }
    for entry in input.system_path_entries {
        push(entry.clone());
    }
    for entry in SYSTEM_PATH_TAIL {
        push((*entry).to_string());
    }
    entries.join(":")
}

/// Entries from `/etc/paths` and `/etc/paths.d/*`, the same sources macOS
/// `path_helper` uses for login shells.
pub fn system_path_entries() -> Vec<String> {
    let mut files = vec![std::path::PathBuf::from("/etc/paths")];
    if let Ok(dir) = fs::read_dir("/etc/paths.d") {
        let mut extra: Vec<_> = dir.flatten().map(|e| e.path()).collect();
        extra.sort();
        files.extend(extra);
    }
    let mut out = Vec::new();
    for file in files {
        let Ok(contents) = fs::read_to_string(&file) else {
            continue;
        };
        for line in contents.lines() {
            let line = line.trim();
            if line.starts_with('/') && !line.contains(':') && !out.iter().any(|e| e == line) {
                out.push(line.to_string());
            }
        }
    }
    out
}

pub fn inherited_env() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

fn current_username() -> Option<String> {
    use std::ffi::CStr;
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: all pointers reference live, correctly sized buffers.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
        return None;
    }
    // SAFETY: pw_name is a NUL-terminated string inside `buf`.
    let name = unsafe { CStr::from_ptr(pwd.pw_name) };
    name.to_str().ok().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn inherited() -> Vec<(String, String)> {
        [
            ("HOME", "/Users/me"),
            ("USER", "me"),
            ("SHELL", "/bin/zsh"),
            ("PATH", "/evil/bin:/usr/bin"),
            ("ANTHROPIC_API_KEY", "sk-ant-secret"),
            ("ANTHROPIC_BASE_URL", "https://proxy.example"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("CLAUDE_CONFIG_DIR", "/Users/me/.claude"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "oauth-secret"),
            ("AWS_PROFILE", "prod"),
            ("RANDOM_VAR", "x"),
            ("HTTPS_PROXY", "http://proxy:8080"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn build_with(custom: &[EnvVar], terminal: bool) -> BTreeMap<String, String> {
        let inherited = inherited();
        let home = PathBuf::from("/Users/me");
        build(&EnvInput {
            inherited: &inherited,
            home: &home,
            config_dir: "/Users/me/.claude-switch/profiles/abc",
            executable_dir: Some(Path::new("/opt/homebrew/bin")),
            extra_path_entries: &["/opt/tools/bin".to_string()],
            system_path_entries: &[
                "/usr/local/bin".to_string(),
                "/Library/Apple/usr/bin".to_string(),
            ],
            custom,
            terminal,
        })
    }

    #[test]
    fn sets_selected_config_dir_and_drops_inherited_one() {
        let env = build_with(&[], false);
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").unwrap(),
            "/Users/me/.claude-switch/profiles/abc"
        );
    }

    #[test]
    fn drops_auth_affecting_and_unknown_variables() {
        let env = build_with(&[], true);
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDECODE",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "AWS_PROFILE",
            "RANDOM_VAR",
        ] {
            assert!(!env.contains_key(name), "{name} leaked into child env");
        }
        let joined: String = env.values().cloned().collect::<Vec<_>>().join("\n");
        assert!(!joined.contains("sk-ant-secret"));
        assert!(!joined.contains("oauth-secret"));
    }

    #[test]
    fn keeps_identity_locale_and_proxy() {
        let env = build_with(&[], false);
        assert_eq!(env.get("USER").unwrap(), "me");
        assert_eq!(env.get("HOME").unwrap(), "/Users/me");
        assert_eq!(env.get("HTTPS_PROXY").unwrap(), "http://proxy:8080");
        assert_eq!(env.get("LANG").unwrap(), "en_US.UTF-8");
    }

    #[test]
    fn path_is_deterministic_and_ignores_inherited_path() {
        let env = build_with(&[], false);
        let path = env.get("PATH").unwrap();
        assert!(!path.contains("/evil/bin"));
        let parts: Vec<&str> = path.split(':').collect();
        assert_eq!(parts[0], "/opt/homebrew/bin");
        assert_eq!(parts[1], "/opt/tools/bin");
        assert!(parts.contains(&"/Users/me/.local/bin"));
        assert!(parts.contains(&"/Library/Apple/usr/bin"));
        assert_eq!(parts.iter().filter(|p| **p == "/usr/local/bin").count(), 1);
        assert!(path.ends_with("/usr/bin:/bin:/usr/sbin:/sbin"));
    }

    #[test]
    fn terminal_vars_only_for_pty() {
        assert!(!build_with(&[], false).contains_key("TERM"));
        let env = build_with(&[], true);
        assert_eq!(env.get("TERM").unwrap(), "xterm-256color");
        assert_eq!(env.get("COLORTERM").unwrap(), "truecolor");
    }

    #[test]
    fn custom_vars_cannot_override_reserved_or_auth() {
        let custom = vec![
            EnvVar {
                name: "NODE_OPTIONS".into(),
                value: "--x".into(),
            },
            EnvVar {
                name: "CLAUDE_CONFIG_DIR".into(),
                value: "/tmp/other".into(),
            },
            EnvVar {
                name: "ANTHROPIC_API_KEY".into(),
                value: "sk".into(),
            },
            EnvVar {
                name: "PATH".into(),
                value: "/tmp".into(),
            },
        ];
        let env = build_with(&custom, false);
        assert_eq!(env.get("NODE_OPTIONS").unwrap(), "--x");
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").unwrap(),
            "/Users/me/.claude-switch/profiles/abc"
        );
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.get("PATH").unwrap().starts_with("/tmp"));
    }

    #[test]
    fn detects_conflicts_by_name_only() {
        let inherited = inherited();
        let conflicts = detect_conflicts(inherited.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        let names: Vec<&str> = conflicts.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"ANTHROPIC_API_KEY"));
        assert!(names.contains(&"CLAUDE_CODE_USE_BEDROCK"));
        assert!(names.contains(&"CLAUDE_CONFIG_DIR"));
        assert!(names.contains(&"CLAUDECODE"));
        assert!(!names.contains(&"AWS_PROFILE"));
        assert!(!names.contains(&"HOME"));
        let serialized = serde_json::to_string(&conflicts).unwrap();
        assert!(!serialized.contains("sk-ant-secret"));
        let kind = |n: &str| conflicts.iter().find(|c| c.name == n).unwrap().kind;
        assert_eq!(kind("ANTHROPIC_API_KEY"), EnvConflictKind::Credential);
        assert_eq!(kind("ANTHROPIC_BASE_URL"), EnvConflictKind::Provider);
        assert_eq!(kind("CLAUDE_CONFIG_DIR"), EnvConflictKind::ConfigDir);
        assert_eq!(kind("CLAUDECODE"), EnvConflictKind::NestedSession);
    }
}
