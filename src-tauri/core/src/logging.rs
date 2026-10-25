//! File logger with mandatory redaction.
//!
//! Code paths never log environment values, command output, or terminal
//! content. As a second line of defence every line passes through
//! [`redact`], which strips URLs down to scheme and host and removes
//! token-like strings and email addresses.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use log::{Level, LevelFilter, Log, Metadata, Record};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
pub const LOG_FILE: &str = "claude-switch.log";
/// The file this process logs to (each program has its own).
static LOG_NAME: OnceLock<&'static str> = OnceLock::new();

fn log_name() -> &'static str {
    LOG_NAME.get().copied().unwrap_or(LOG_FILE)
}

struct FileLogger {
    path: PathBuf,
    file: Mutex<Option<File>>,
    level: LevelFilter,
}

fn open_log(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
}

impl FileLogger {
    fn rotate_if_needed(&self, file: &mut Option<File>) {
        let too_big = fs::metadata(&self.path)
            .map(|m| m.len() > MAX_LOG_BYTES)
            .unwrap_or(false);
        if too_big {
            *file = None;
            let _ = fs::rename(&self.path, self.path.with_extension("log.1"));
            *file = open_log(&self.path).ok();
        }
    }
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // Dependencies can be chatty; keep only warnings from them.
        let ours = record.target().starts_with("claude_switch");
        if !ours && record.level() > Level::Warn {
            return;
        }
        let line = format!(
            "{} {:<5} {}: {}\n",
            crate::clock::now(),
            record.level(),
            record.target(),
            redact(&record.args().to_string())
        );
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        let mut guard = self.file.lock().unwrap_or_else(|p| p.into_inner());
        self.rotate_if_needed(&mut guard);
        if guard.is_none() {
            *guard = open_log(&self.path).ok();
        }
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {
        if let Some(file) = self.file.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            let _ = file.flush();
        }
    }
}

pub fn init(logs_dir: &Path) {
    init_as(logs_dir, LOG_FILE);
}

/// Like [`init`], logging to `name` in `logs_dir`.
pub fn init_as(logs_dir: &Path, name: &'static str) {
    let _ = LOG_NAME.set(name);
    let path = logs_dir.join(log_name());
    let logger = FileLogger {
        file: Mutex::new(open_log(&path).ok()),
        path,
        level: if cfg!(debug_assertions) {
            LevelFilter::Debug
        } else {
            LevelFilter::Info
        },
    };
    let level = logger.level;
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(level);
    }
}

/// Last `max_lines` lines of the log, already redacted when written.
pub fn tail(logs_dir: &Path, max_lines: usize) -> Vec<String> {
    let Ok(contents) = fs::read_to_string(logs_dir.join(log_name())) else {
        return Vec::new();
    };
    let lines: Vec<&str> = contents.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..]
        .iter()
        .map(|l| redact(l))
        .collect()
}

fn is_tokenish(s: &str) -> bool {
    s.len() >= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '+' | '/'))
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

fn redact_word(word: &str) -> String {
    let trimmed = word
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | ',' | '<' | '>' | '[' | ']'));
    if let Some(idx) = trimmed.find("://") {
        let (scheme, rest) = trimmed.split_at(idx + 3);
        let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let host = &rest[..host_end];
        // Drop userinfo (proxy credentials).
        let host = host.rsplit('@').next().unwrap_or(host);
        let suffix = if host_end < rest.len() {
            "/<redacted>"
        } else {
            ""
        };
        return word.replacen(trimmed, &format!("{scheme}{host}{suffix}"), 1);
    }
    if trimmed.starts_with("sk-") || trimmed.starts_with("sk_") {
        return word.replacen(trimmed, "<redacted-key>", 1);
    }
    if let Some((local, domain)) = trimmed.split_once('@') {
        if !local.is_empty() && domain.contains('.') && !domain.contains('@') {
            return word.replacen(trimmed, "<email>", 1);
        }
    }
    if let Some((key, value)) = trimmed.split_once('=') {
        let upper = key.to_ascii_uppercase();
        if ["KEY", "TOKEN", "SECRET", "PASSWORD", "CODE", "STATE"]
            .iter()
            .any(|n| upper.contains(n))
            && !value.is_empty()
        {
            return word.replacen(trimmed, &format!("{key}=<redacted>"), 1);
        }
    }
    // Absolute paths are useful in diagnostics and are not secrets.
    if is_tokenish(trimmed) && !trimmed.starts_with('/') {
        return word.replacen(trimmed, "<redacted>", 1);
    }
    word.to_string()
}

/// Removes secrets and personal data from a log line.
pub fn redact(line: &str) -> String {
    line.split(' ')
        .map(redact_word)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_url_paths_and_queries() {
        let out = redact("open https://claude.ai/oauth/authorize?code=true&state=abc123 now");
        assert_eq!(out, "open https://claude.ai/<redacted> now");
        assert!(!out.contains("state"));
    }

    #[test]
    fn strips_proxy_credentials() {
        let out = redact("proxy http://user:hunter2@proxy.corp:8080");
        assert_eq!(out, "proxy http://proxy.corp:8080");
    }

    #[test]
    fn strips_keys_tokens_and_emails() {
        let out = redact("key sk-ant-api03-abcdefghijklmnop for me@example.com token=xyz");
        assert!(!out.contains("sk-ant"));
        assert!(!out.contains("me@example.com"));
        assert!(!out.contains("xyz"));
        let out = redact("bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123");
        assert!(out.ends_with("<redacted>"));
    }

    #[test]
    fn keeps_paths() {
        let line = "data: /Users/me/.claude-switch/profiles/1b4e28ba-2fa1-11d2-883f-0016d3cca427";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn keeps_ordinary_text() {
        let line = "session 1b4e28ba started for account 7c9e6679 (kind=claude)";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn writes_redacted_lines_to_file() {
        let tmp = tempfile::tempdir().unwrap();
        let logger = FileLogger {
            path: tmp.path().join(LOG_FILE),
            file: Mutex::new(None),
            level: LevelFilter::Info,
        };
        logger.log(
            &Record::builder()
                .level(Level::Info)
                .target("claude_switch_lib::test")
                .args(format_args!(
                    "login url https://claude.ai/oauth?code=SECRET123 for a@b.co"
                ))
                .build(),
        );
        let contents = fs::read_to_string(tmp.path().join(LOG_FILE)).unwrap();
        assert!(contents.contains("https://claude.ai/<redacted>"));
        assert!(!contents.contains("SECRET123"));
        assert!(!contents.contains("a@b.co"));
    }
}
