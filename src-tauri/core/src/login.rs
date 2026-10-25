//! Follows the output of `claude auth login` so the UI can show a proper
//! sign-in screen (an "Open sign-in page" button and a code field) instead of
//! a raw terminal.
//!
//! Observed output (Claude Code 2.1.236):
//!
//! ```text
//! Opening browser to sign in…
//! If the browser didn't open, visit: ESC]8;;<url>BEL ESC[94m<url>ESC[39m ESC]8;;BEL
//! Paste code here if prompted >
//! Login successful.            (or)  Login failed: <reason>
//! ```
//!
//! The format is not a documented API, so everything here is best effort:
//! anything unrecognized leaves the raw terminal available in the UI. The
//! URL is kept in memory only and never logged.

use serde::Serialize;
use ts_rs::TS;

const MAX_BUFFER: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LoginPhase {
    /// Claude Code is starting.
    Starting,
    /// The sign-in page is open in the browser; waiting for the user.
    Waiting,
    /// A code was submitted; Claude Code is exchanging it.
    Verifying,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginProgress {
    pub session_id: String,
    pub account_id: String,
    pub phase: LoginPhase,
    /// The sign-in page Claude Code printed (https only).
    pub url: Option<String>,
    /// Host of `url`, shown so the user can see where the link goes.
    pub url_host: Option<String>,
    /// Claude Code is ready to accept a pasted authorization code.
    pub awaiting_code: bool,
    /// Human-readable status or failure reason.
    pub message: Option<String>,
}

impl LoginProgress {
    pub fn new(session_id: &str, account_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            account_id: account_id.to_string(),
            phase: LoginPhase::Starting,
            url: None,
            url_host: None,
            awaiting_code: false,
            message: None,
        }
    }

    pub fn is_finished(&self) -> bool {
        matches!(self.phase, LoginPhase::Succeeded | LoginPhase::Failed)
    }
}

/// Incremental parser. Output is small, so each chunk re-scans the bounded
/// buffer, which keeps escape sequences split across chunks simple.
#[derive(Debug)]
pub struct LoginParser {
    raw: Vec<u8>,
    progress: LoginProgress,
}

impl LoginParser {
    pub fn new(session_id: &str, account_id: &str) -> Self {
        Self {
            raw: Vec::new(),
            progress: LoginProgress::new(session_id, account_id),
        }
    }

    /// A parser frozen at a final state (after the process exited).
    pub fn finished(progress: LoginProgress) -> Self {
        Self {
            raw: Vec::new(),
            progress,
        }
    }

    pub fn progress(&self) -> &LoginProgress {
        &self.progress
    }

    /// Marks that a code was sent to Claude Code.
    pub fn code_submitted(&mut self) -> LoginProgress {
        if !self.progress.is_finished() {
            self.progress.phase = LoginPhase::Verifying;
            self.progress.message = None;
        }
        // Only output after the code counts toward its result.
        self.raw.clear();
        self.progress.clone()
    }

    /// Feeds terminal output. Returns the new state if anything changed.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<LoginProgress> {
        self.raw.extend_from_slice(bytes);
        if self.raw.len() > MAX_BUFFER {
            let cut = self.raw.len() - MAX_BUFFER;
            self.raw.drain(..cut);
        }
        let before = self.progress.clone();
        let text = String::from_utf8_lossy(&self.raw).into_owned();

        if self.progress.url.is_none() {
            if let Some(url) = hyperlink_target(&text).or_else(|| plain_url(&strip_ansi(&text))) {
                self.progress.url_host = url_host(&url);
                self.progress.url = Some(url);
            }
        }
        let plain = strip_ansi(&text);
        if plain.contains("Paste code here") {
            self.progress.awaiting_code = true;
        }
        if self.progress.phase == LoginPhase::Starting && self.progress.url.is_some() {
            self.progress.phase = LoginPhase::Waiting;
        }
        if let Some(line) = plain.lines().find(|l| l.contains("Login failed")) {
            self.progress.phase = LoginPhase::Failed;
            self.progress.awaiting_code = false;
            self.progress.message = Some(describe_failure(line));
        } else if plain.contains("Login successful") {
            self.progress.phase = LoginPhase::Succeeded;
            self.progress.awaiting_code = false;
            self.progress.message = None;
        }
        (self.progress != before).then(|| self.progress.clone())
    }
}

/// A friendlier message for known failures; otherwise Claude Code's own text.
fn describe_failure(line: &str) -> String {
    let reason = line
        .split_once("Login failed")
        .map(|(_, rest)| rest.trim_start_matches([':', ' ']).trim())
        .unwrap_or("")
        .trim_end_matches(['.', '>'])
        .trim();
    if reason.contains("status code 400") || reason.contains("invalid_grant") {
        return "Claude Code didn't accept that code. Copy the whole code from the browser page and try again.".into();
    }
    if reason.is_empty() {
        "Claude Code reported that sign-in failed.".into()
    } else {
        format!("Claude Code reported: {reason}")
    }
}

/// The target of the first complete OSC 8 hyperlink
/// (`ESC ] 8 ; params ; URL ST`). An unterminated one may still be arriving.
fn hyperlink_target(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(start) = rest.find("\u{1b}]8;") {
        let after = &rest[start + 4..];
        let (_, link) = after.split_once(';')?;
        let end = link.find(['\u{7}', '\u{1b}'])?;
        let url = &link[..end];
        if is_https_url(url) {
            return Some(url.to_string());
        }
        rest = &link[end..];
    }
    None
}

/// The first complete https URL in plain text. A URL at the very end of the
/// buffer is ignored until whitespace follows it.
fn plain_url(text: &str) -> Option<String> {
    let complete = if text.ends_with(char::is_whitespace) {
        text
    } else {
        &text[..text.rfind(char::is_whitespace)?]
    };
    complete
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| matches!(c, '"' | '\'' | '<' | '>' | '(' | ')')))
        .find(|w| is_https_url(w))
        .map(str::to_string)
}

fn is_https_url(url: &str) -> bool {
    url.len() <= 4096
        && url.starts_with("https://")
        && url_host(url).is_some()
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty() && host.contains('.')).then(|| host.to_ascii_lowercase())
}

/// Removes CSI, OSC and other escape sequences.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // CSI: parameters, then a final byte in @..~
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: until BEL or ST (ESC \)
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz";

    fn sample() -> String {
        format!(
            "Opening browser to sign in\u{2026}\r\nIf the browser didn't open, visit: \u{1b}]8;;{URL}\u{7}\u{1b}[94m{URL}\u{1b}[39m\u{1b}]8;;\u{7}\r\nPaste code here if prompted > "
        )
    }

    #[test]
    fn extracts_url_and_code_prompt_from_real_output() {
        let mut p = LoginParser::new("s", "a");
        let state = p.feed(sample().as_bytes()).unwrap();
        assert_eq!(state.phase, LoginPhase::Waiting);
        assert_eq!(state.url.as_deref(), Some(URL));
        assert_eq!(state.url_host.as_deref(), Some("claude.com"));
        assert!(state.awaiting_code);
    }

    #[test]
    fn handles_output_split_mid_sequence() {
        let mut p = LoginParser::new("s", "a");
        let bytes = sample().into_bytes();
        for chunk in bytes.chunks(7) {
            p.feed(chunk);
        }
        assert_eq!(p.progress().url.as_deref(), Some(URL));
        assert!(p.progress().awaiting_code);
    }

    #[test]
    fn falls_back_to_plain_urls() {
        let mut p = LoginParser::new("s", "a");
        p.feed(format!("Browser didn't open? Visit: {URL}\r\n").as_bytes());
        assert_eq!(p.progress().url.as_deref(), Some(URL));
    }

    #[test]
    fn waits_for_a_complete_url() {
        let mut p = LoginParser::new("s", "a");
        p.feed(&format!("visit: \u{1b}]8;;{}", &URL[..30]).into_bytes());
        assert_eq!(p.progress().url, None);
        p.feed(b"Browser didn't open? Visit: https://claude.com/cai/oau");
        assert_eq!(p.progress().url, None, "plain URL still arriving");
    }

    #[test]
    fn ignores_non_https_links() {
        let mut p = LoginParser::new("s", "a");
        p.feed(b"visit: http://evil.example/login and javascript:alert(1)\r\n");
        assert_eq!(p.progress().url, None);
        assert_eq!(p.progress().phase, LoginPhase::Starting);
    }

    #[test]
    fn recognizes_success() {
        let mut p = LoginParser::new("s", "a");
        p.feed(sample().as_bytes());
        p.code_submitted();
        assert_eq!(p.progress().phase, LoginPhase::Verifying);
        let state = p
            .feed(b"\r\nLogin successful. Press Enter to continue\r\n")
            .unwrap();
        assert_eq!(state.phase, LoginPhase::Succeeded);
        assert!(!state.awaiting_code);
    }

    #[test]
    fn explains_a_rejected_code() {
        let mut p = LoginParser::new("s", "a");
        p.feed(sample().as_bytes());
        p.code_submitted();
        let state = p
            .feed(b"Login failed: Request failed with status code 400\r\n\x1b[?25h")
            .unwrap();
        assert_eq!(state.phase, LoginPhase::Failed);
        assert!(state.message.unwrap().contains("didn't accept that code"));
    }

    #[test]
    fn passes_through_unknown_failures() {
        let mut p = LoginParser::new("s", "a");
        p.feed(b"Login failed: network unreachable\r\n");
        assert_eq!(
            p.progress().message.as_deref(),
            Some("Claude Code reported: network unreachable")
        );
    }

    #[test]
    fn reports_no_change_for_irrelevant_output() {
        let mut p = LoginParser::new("s", "a");
        assert!(p.feed(b"\x1b[?25l").is_none());
    }

    #[test]
    fn strips_escape_sequences() {
        assert_eq!(
            strip_ansi("\u{1b}[1mbold\u{1b}[0m \u{1b}]8;;https://x.y\u{7}link\u{1b}]8;;\u{1b}\\"),
            "bold link"
        );
    }

    #[test]
    fn url_host_drops_userinfo_and_port() {
        assert_eq!(
            url_host("https://u:p@Claude.ai:443/x").as_deref(),
            Some("claude.ai")
        );
        assert_eq!(url_host("https://localhost/x"), None);
    }
}
