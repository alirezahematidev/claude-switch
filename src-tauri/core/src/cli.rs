//! Claude Code CLI integration through documented commands only:
//!
//! * `claude --version`
//! * `claude auth status --json` (exit 0 when signed in, 1 when not)
//! * `claude auth login [--claudeai|--console] [--email <email>]`
//! * `claude auth logout`
//!
//! Commands are spawned directly with an argv vector, never through a shell.
//! Their output is parsed in memory and never logged: `auth status` prints
//! the account email.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::domain::AuthStatus;
use crate::error::{AppError, AppResult};
use crate::store::AuthObservation;

/// The oldest version this release was verified against.
pub const TESTED_MIN_VERSION: (u32, u32, u32) = (2, 1, 0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CliSource {
    Configured,
    Detected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliExecutable {
    /// Path as found (may be a symlink, e.g. Homebrew's).
    pub path: PathBuf,
    pub source: CliSource,
}

impl CliExecutable {
    /// Directory to prepend to PATH. For symlinked npm installs this is the
    /// directory holding the link, which also holds `node`.
    pub fn bin_dir(&self) -> Option<&Path> {
        self.path.parent()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CliState {
    Found,
    NotFound,
    InvalidConfigured,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CliStatus {
    pub state: CliState,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<CliSource>,
    pub message: Option<String>,
    /// Locations checked during auto-detection.
    pub searched: Vec<String>,
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Validates a user-configured executable path.
pub fn validate_configured(path: &str) -> AppResult<CliExecutable> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::ExecutableNotFound(format!(
            "{path} is not an absolute path"
        )));
    }
    match std::fs::metadata(&p) {
        Err(_) => Err(AppError::ExecutableNotFound(format!(
            "{path} does not exist"
        ))),
        Ok(m) if m.is_dir() => Err(AppError::ExecutableNotFound(format!(
            "{path} is a directory"
        ))),
        Ok(_) if !is_executable_file(&p) => Err(AppError::ExecutableNotFound(format!(
            "{path} is not executable"
        ))),
        Ok(_) => Ok(CliExecutable {
            path: p,
            source: CliSource::Configured,
        }),
    }
}

/// Ordered candidate locations. GUI apps do not inherit the interactive
/// shell's PATH, so well-known install locations are probed explicitly.
pub fn candidate_paths(home: &Path, process_path: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    push(home.join(".local/bin/claude"));
    push(home.join(".claude/local/claude"));
    push(PathBuf::from("/opt/homebrew/bin/claude"));
    push(PathBuf::from("/usr/local/bin/claude"));
    if let Some(path) = process_path {
        for dir in path.split(':').filter(|d| d.starts_with('/')) {
            push(Path::new(dir).join("claude"));
        }
    }
    for rel in [
        ".npm-global/bin/claude",
        ".volta/bin/claude",
        ".bun/bin/claude",
        ".yarn/bin/claude",
        "Library/pnpm/claude",
        ".asdf/shims/claude",
        ".local/share/mise/shims/claude",
    ] {
        push(home.join(rel));
    }
    // nvm: newest Node version first.
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<(Vec<u32>, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let nums = name
                    .trim_start_matches('v')
                    .split('.')
                    .map(|n| n.parse().ok())
                    .collect::<Option<Vec<u32>>>()?;
                Some((nums, e.path().join("bin/claude")))
            })
            .collect();
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, p) in versions {
            push(p);
        }
    }
    out
}

pub fn discover(home: &Path, process_path: Option<&str>) -> Option<CliExecutable> {
    candidate_paths(home, process_path)
        .into_iter()
        .find(|p| is_executable_file(p))
        .map(|path| CliExecutable {
            path,
            source: CliSource::Detected,
        })
}

/// Resolves the executable: the configured path if set (no silent fallback
/// when it is invalid), otherwise auto-detection.
pub fn resolve(
    configured: Option<&str>,
    home: &Path,
    process_path: Option<&str>,
) -> AppResult<CliExecutable> {
    match configured {
        Some(path) => validate_configured(path),
        None => discover(home, process_path).ok_or(AppError::ClaudeNotInstalled),
    }
}

// ---------------------------------------------------------------------------
// Running CLI commands
// ---------------------------------------------------------------------------

pub struct CommandOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs the CLI with an exact environment, no stdin, bounded output and a
/// timeout. Output is returned to the caller and never logged here.
pub fn run(
    exe: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    cwd: &Path,
    timeout: Duration,
) -> AppResult<CommandOutput> {
    const MAX_OUTPUT: u64 = 256 * 1024;
    let mut child = Command::new(exe)
        .args(args)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::ProcessStart(format!("{}: {e}", exe.display())))?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let read_all = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stream.take(MAX_OUTPUT).read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out_handle = read_all(Box::new(stdout));
    let err_handle = read_all(Box::new(stderr));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::ProcessStart(format!(
                    "`claude {}` did not finish within {}s",
                    args.first().copied().unwrap_or_default(),
                    timeout.as_secs()
                )));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    Ok(CommandOutput {
        status: status.code(),
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

/// Extracts `X.Y.Z` from `claude --version` output such as
/// `2.1.236 (Claude Code)`.
pub fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|tok| {
        let tok = tok.trim_start_matches('v');
        let parts: Vec<&str> = tok.split('.').collect();
        (parts.len() >= 3
            && parts
                .iter()
                .take(3)
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())))
        .then(|| parts[..3].join("."))
    })
}

pub fn version_tuple(version: &str) -> Option<(u32, u32, u32)> {
    let mut it = version.split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

pub fn query_version(exe: &Path, env: &BTreeMap<String, String>, cwd: &Path) -> AppResult<String> {
    let out = run(exe, &["--version"], env, cwd, Duration::from_secs(15))?;
    parse_version(&out.stdout)
        .or_else(|| parse_version(&out.stderr))
        .ok_or_else(|| {
            AppError::ExecutableNotFound(format!(
                "{} did not report a Claude Code version",
                exe.display()
            ))
        })
}

// ---------------------------------------------------------------------------
// Authentication status
// ---------------------------------------------------------------------------

/// Fields of `claude auth status --json` that Claude Switch reads.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusReport {
    pub logged_in: bool,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub api_provider: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
    /// Reported by Claude Code 2.1.268 and later.
    #[serde(default)]
    pub config_directory: Option<String>,
}

pub fn parse_auth_status(stdout: &str) -> AppResult<AuthStatusReport> {
    // Tolerate banners or warnings before the JSON object.
    let start = stdout.find('{').ok_or_else(|| {
        AppError::UnsupportedCliVersion(
            "`claude auth status --json` did not return JSON. Update Claude Code with `claude update`."
                .into(),
        )
    })?;
    let end = stdout.rfind('}').unwrap_or(stdout.len() - 1);
    serde_json::from_str(&stdout[start..=end]).map_err(|_| {
        AppError::UnsupportedCliVersion(
            "`claude auth status --json` returned output Claude Switch does not understand.".into(),
        )
    })
}

/// Runs `claude auth status --json` for one profile.
pub fn probe_auth_status(
    exe: &Path,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> AppResult<AuthStatusReport> {
    let out = run(
        exe,
        &["auth", "status", "--json"],
        env,
        cwd,
        Duration::from_secs(20),
    )?;
    match parse_auth_status(&out.stdout) {
        Ok(report) => Ok(report),
        Err(err) => {
            let stderr = out.stderr.to_ascii_lowercase();
            if stderr.contains("unknown command") || stderr.contains("unknown option") {
                Err(AppError::UnsupportedCliVersion(
                    "this Claude Code version does not support `claude auth status`. Update it with `claude update`.".into(),
                ))
            } else {
                Err(err)
            }
        }
    }
}

/// Auth methods whose credential Claude Code stores per configuration
/// directory (documented: "Each directory has its own settings, session
/// history, and claude.ai login or API key").
const PROFILE_SCOPED_METHODS: &[&str] = &["claude.ai", "api_key"];

/// Turns a status report into what gets recorded for the account.
pub fn interpret(
    report: &AuthStatusReport,
    expected_config_dir: &str,
    was_ever_verified: bool,
) -> AuthObservation {
    let method = report.auth_method.clone().filter(|m| !m.is_empty());
    let mut obs = AuthObservation {
        status: AuthStatus::Unknown,
        method: method.clone(),
        email: report.email.clone().filter(|e| !e.is_empty()),
        org_name: report.org_name.clone().filter(|o| !o.is_empty()),
        detail: None,
    };

    if let Some(reported) = report.config_directory.as_deref() {
        if Path::new(reported) != Path::new(expected_config_dir) {
            obs.status = AuthStatus::UnsupportedIsolation;
            obs.detail = Some(format!(
                "Claude Code reported using {reported} instead of this profile's directory. A managed setting may be overriding CLAUDE_CONFIG_DIR."
            ));
            return obs;
        }
    }

    if !report.logged_in {
        obs.status = if was_ever_verified {
            AuthStatus::AuthRequired
        } else {
            AuthStatus::NotConfigured
        };
        obs.email = None;
        obs.org_name = None;
        return obs;
    }

    match method.as_deref() {
        Some(m) if PROFILE_SCOPED_METHODS.contains(&m) => {
            obs.status = AuthStatus::Authenticated;
        }
        Some("third_party") => {
            obs.status = AuthStatus::UnsupportedIsolation;
            obs.detail = Some(
                "Claude Code is using a cloud provider (Bedrock, Vertex AI, or Foundry). Those credentials come from outside this profile, so accounts are not isolated.".into(),
            );
        }
        Some("api_key_helper") => {
            obs.status = AuthStatus::UnsupportedIsolation;
            obs.detail = Some(
                "Claude Code is using an apiKeyHelper script. Its credential may be shared by every profile.".into(),
            );
        }
        Some("oauth_token") => {
            obs.status = AuthStatus::UnsupportedIsolation;
            obs.detail = Some(
                "Claude Code is using an OAuth token from an environment or settings source, or an Anthropic profile, which may be shared by every profile.".into(),
            );
        }
        other => {
            obs.status = AuthStatus::UnsupportedIsolation;
            obs.detail = Some(format!(
                "Claude Code reported the authentication method {:?}, which Claude Switch cannot confirm is scoped to this profile.",
                other.unwrap_or("unknown")
            ));
        }
    }
    obs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(json: &str) -> AuthStatusReport {
        parse_auth_status(json).unwrap()
    }

    #[test]
    fn parses_version_strings() {
        assert_eq!(
            parse_version("2.1.236 (Claude Code)\n").as_deref(),
            Some("2.1.236")
        );
        assert_eq!(parse_version("claude v1.0.3").as_deref(), Some("1.0.3"));
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(version_tuple("2.1.236"), Some((2, 1, 236)));
    }

    #[test]
    fn parses_logged_out_report() {
        let r = report(r#"{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}"#);
        assert!(!r.logged_in);
        assert_eq!(r.auth_method.as_deref(), Some("none"));
    }

    #[test]
    fn tolerates_leading_noise() {
        let r = report("warning: something\n{\"loggedIn\": true, \"authMethod\": \"claude.ai\"}\n");
        assert!(r.logged_in);
    }

    #[test]
    fn rejects_non_json() {
        assert!(matches!(
            parse_auth_status("Not logged in").unwrap_err(),
            AppError::UnsupportedCliVersion(_)
        ));
    }

    #[test]
    fn subscription_login_is_isolated() {
        let r = report(
            r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "me@x.com", "orgName": "Org"}"#,
        );
        let obs = interpret(&r, "/p/a", false);
        assert_eq!(obs.status, AuthStatus::Authenticated);
        assert_eq!(obs.email.as_deref(), Some("me@x.com"));
    }

    #[test]
    fn console_api_key_is_isolated() {
        let r = report(r#"{"loggedIn": true, "authMethod": "api_key"}"#);
        assert_eq!(
            interpret(&r, "/p/a", false).status,
            AuthStatus::Authenticated
        );
    }

    #[test]
    fn shared_credentials_are_flagged() {
        for method in [
            "third_party",
            "api_key_helper",
            "oauth_token",
            "something_new",
        ] {
            let r = report(&format!(
                r#"{{"loggedIn": true, "authMethod": "{method}"}}"#
            ));
            let obs = interpret(&r, "/p/a", true);
            assert_eq!(obs.status, AuthStatus::UnsupportedIsolation, "{method}");
            assert!(obs.detail.is_some());
        }
    }

    #[test]
    fn logged_out_distinguishes_new_from_expired() {
        let r = report(r#"{"loggedIn": false, "authMethod": "none"}"#);
        assert_eq!(
            interpret(&r, "/p/a", false).status,
            AuthStatus::NotConfigured
        );
        assert_eq!(interpret(&r, "/p/a", true).status, AuthStatus::AuthRequired);
    }

    #[test]
    fn config_dir_mismatch_is_unsupported_isolation() {
        let r = report(
            r#"{"loggedIn": true, "authMethod": "claude.ai", "configDirectory": "/Users/me/.claude"}"#,
        );
        let obs = interpret(&r, "/p/a", true);
        assert_eq!(obs.status, AuthStatus::UnsupportedIsolation);
        let r =
            report(r#"{"loggedIn": true, "authMethod": "claude.ai", "configDirectory": "/p/a"}"#);
        assert_eq!(
            interpret(&r, "/p/a", true).status,
            AuthStatus::Authenticated
        );
    }

    #[test]
    fn configured_path_is_validated_without_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert!(matches!(
            resolve(Some(missing.to_str().unwrap()), tmp.path(), None).unwrap_err(),
            AppError::ExecutableNotFound(_)
        ));
        assert!(matches!(
            resolve(Some(tmp.path().to_str().unwrap()), tmp.path(), None).unwrap_err(),
            AppError::ExecutableNotFound(_)
        ));
        assert!(matches!(
            resolve(Some("relative/claude"), tmp.path(), None).unwrap_err(),
            AppError::ExecutableNotFound(_)
        ));
    }

    #[test]
    fn missing_cli_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        // An empty home and PATH: nothing to find (unless the machine has a
        // system-wide install, which we cannot rule out here).
        let found = discover(tmp.path(), Some(tmp.path().to_str().unwrap()));
        if let Some(found) = found {
            assert!(found.path.is_absolute());
        }
    }

    #[test]
    fn candidates_prefer_newest_nvm_version() {
        let tmp = tempfile::tempdir().unwrap();
        for v in ["v18.0.0", "v22.3.0", "v20.11.1"] {
            std::fs::create_dir_all(tmp.path().join(".nvm/versions/node").join(v).join("bin"))
                .unwrap();
        }
        let c = candidate_paths(tmp.path(), None);
        let nvm: Vec<_> = c
            .iter()
            .filter(|p| p.to_string_lossy().contains(".nvm"))
            .collect();
        assert!(nvm[0].to_string_lossy().contains("v22.3.0"));
        assert!(nvm[2].to_string_lossy().contains("v18.0.0"));
    }
}
