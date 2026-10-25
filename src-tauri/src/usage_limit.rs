//! Recognizes Claude Code's usage-limit messages in terminal output, so the
//! UI can offer to continue the conversation with another account.
//!
//! The wording is not a documented API; these are the messages printed by
//! Claude Code 2.1.236 ("You've hit your session limit · resets 5pm", "Usage
//! limit reached", "You're out of usage credits", …). Missing a message only
//! means the shortcut is not offered. Nothing about the limit itself (plan,
//! remaining usage, reset time) is derived from it.

use crate::login::strip_ansi;

/// Enough output to hold a message split across reads.
const TAIL_BYTES: usize = 512;

#[derive(Debug, Default)]
pub struct UsageLimitDetector {
    raw: Vec<u8>,
}

impl UsageLimitDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds terminal output. True if a usage-limit message is visible in
    /// the recent output.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        self.raw.extend_from_slice(bytes);
        let hit = mentions_usage_limit(&strip_ansi(&String::from_utf8_lossy(&self.raw)));
        if self.raw.len() > TAIL_BYTES {
            let cut = self.raw.len() - TAIL_BYTES;
            self.raw.drain(..cut);
        }
        hit
    }
}

/// True if `text` (without escape sequences) contains a usage-limit message.
pub fn mentions_usage_limit(text: &str) -> bool {
    let text = normalize(text);
    for lead in ["you've hit your ", "you've reached your "] {
        for (at, _) in text.match_indices(lead) {
            // "session limit", "weekly limit", "Opus limit", "monthly spend
            // limit", … but not fast mode's own cooldown.
            let rest: String = text[at + lead.len()..].chars().take(40).collect();
            if let Some(end) = rest.find("limit") {
                if !rest[..end].trim_end().ends_with("fast") {
                    return true;
                }
            }
        }
    }
    [
        "usage limit reached",
        "you're out of usage credits",
        "you're out of extra usage",
        "-hour limit reached",
        "weekly limit reached",
    ]
    .iter()
    .any(|p| text.contains(p))
}

/// Lowercase, straight apostrophes, single spaces.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        let c = if c == '\u{2019}' { '\'' } else { c };
        out.extend(c.to_lowercase());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_claude_code_limit_messages() {
        for msg in [
            "You've hit your session limit · resets 5pm (Europe/Berlin)",
            "You've hit your weekly limit · resets Mon 9am",
            "You've hit your Opus limit · resets 3am",
            "You\u{2019}ve hit your session limit",
            "You've hit your monthly spend limit. /model to switch models.",
            "You've hit your org's monthly spend limit · ask your admin",
            "You've reached your Fable 5 limit.",
            "Usage limit reached · continuing automatically when it resets · esc to cancel",
            "You're out of usage credits · resets 5pm",
            "Claude AI usage limit reached|1760000000",
            "5-hour limit reached ∙ resets 3am",
        ] {
            assert!(mentions_usage_limit(msg), "{msg}");
        }
    }

    #[test]
    fn ignores_other_text() {
        for msg in [
            "You've hit your fast limit · resets in 4m",
            "Context limit reached",
            "Rate limit handling in this file",
            "You've hit your stride",
            "",
        ] {
            assert!(!mentions_usage_limit(msg), "{msg}");
        }
    }

    #[test]
    fn handles_colors_split_reads_and_wrapping() {
        let mut d = UsageLimitDetector::new();
        assert!(!d.feed(b"\x1b[31mYou've hit "));
        assert!(!d.feed(b"\x1b[0m"));
        assert!(d.feed(b"your  session\r\n limit\x1b[39m \xc2\xb7 resets 5pm"));

        let mut d = UsageLimitDetector::new();
        assert!(!d.feed("x".repeat(10_000).as_bytes()));
        assert!(d.feed(b"Usage limit reached"));
    }
}
