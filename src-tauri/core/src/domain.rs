//! Domain types shared by the backend and (through ts-rs) the frontend.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/// Parses an ID received over IPC. Only canonical UUIDs are accepted, which
/// rules out path fragments, SQL, or shell metacharacters by construction.
pub fn parse_id(raw: &str, what: &str) -> AppResult<Uuid> {
    if raw.len() != 36 {
        return Err(AppError::invalid(format!("{what} ID is malformed")));
    }
    Uuid::parse_str(raw).map_err(|_| AppError::invalid(format!("{what} ID is malformed")))
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AccountColor {
    Slate,
    Red,
    Orange,
    Amber,
    Green,
    Teal,
    Sky,
    Blue,
    Violet,
    Pink,
}

impl AccountColor {
    pub const ALL: [AccountColor; 10] = [
        AccountColor::Blue,
        AccountColor::Violet,
        AccountColor::Green,
        AccountColor::Orange,
        AccountColor::Pink,
        AccountColor::Teal,
        AccountColor::Amber,
        AccountColor::Red,
        AccountColor::Sky,
        AccountColor::Slate,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AccountColor::Slate => "slate",
            AccountColor::Red => "red",
            AccountColor::Orange => "orange",
            AccountColor::Amber => "amber",
            AccountColor::Green => "green",
            AccountColor::Teal => "teal",
            AccountColor::Sky => "sky",
            AccountColor::Blue => "blue",
            AccountColor::Violet => "violet",
            AccountColor::Pink => "pink",
        }
    }

    pub fn parse(raw: &str) -> AppResult<Self> {
        Self::ALL
            .into_iter()
            .find(|c| c.as_str() == raw)
            .ok_or_else(|| AppError::DataCorruption(format!("unknown account color {raw:?}")))
    }
}

/// Last observed authentication state of an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthStatus {
    /// Profile exists but has never been signed in.
    NotConfigured,
    /// Was signed in before; Claude Code now reports no credential.
    AuthRequired,
    /// Claude Code reported a signed-in, profile-scoped credential.
    Authenticated,
    /// Status could not be determined (CLI missing, timeout, unreadable output).
    Unknown,
    /// The last login attempt did not succeed.
    Failed,
    /// Signed in, but with a credential that is not scoped to this profile.
    UnsupportedIsolation,
}

impl AuthStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthStatus::NotConfigured => "not_configured",
            AuthStatus::AuthRequired => "auth_required",
            AuthStatus::Authenticated => "authenticated",
            AuthStatus::Unknown => "unknown",
            AuthStatus::Failed => "failed",
            AuthStatus::UnsupportedIsolation => "unsupported_isolation",
        }
    }

    pub fn parse(raw: &str) -> AppResult<Self> {
        Ok(match raw {
            "not_configured" => AuthStatus::NotConfigured,
            "auth_required" => AuthStatus::AuthRequired,
            "authenticated" => AuthStatus::Authenticated,
            "unknown" => AuthStatus::Unknown,
            "failed" => AuthStatus::Failed,
            "unsupported_isolation" => AuthStatus::UnsupportedIsolation,
            other => {
                return Err(AppError::DataCorruption(format!(
                    "unknown auth status {other:?}"
                )))
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionKind {
    /// Interactive Claude Code.
    Claude,
    /// `claude auth login` for an account.
    Login,
    /// The user's login shell, with the account's environment.
    Shell,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Claude => "claude",
            SessionKind::Login => "login",
            SessionKind::Shell => "shell",
        }
    }

    pub fn parse(raw: &str) -> AppResult<Self> {
        Ok(match raw {
            "claude" => SessionKind::Claude,
            "login" => SessionKind::Login,
            "shell" => SessionKind::Shell,
            other => {
                return Err(AppError::DataCorruption(format!(
                    "unknown session kind {other:?}"
                )))
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionStatus {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
    /// The app quit or crashed while the session was running.
    Interrupted,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Starting => "starting",
            SessionStatus::Running => "running",
            SessionStatus::Stopping => "stopping",
            SessionStatus::Exited => "exited",
            SessionStatus::Failed => "failed",
            SessionStatus::Interrupted => "interrupted",
        }
    }

    pub fn parse(raw: &str) -> AppResult<Self> {
        Ok(match raw {
            "starting" => SessionStatus::Starting,
            "running" => SessionStatus::Running,
            "stopping" => SessionStatus::Stopping,
            "exited" => SessionStatus::Exited,
            "failed" => SessionStatus::Failed,
            "interrupted" => SessionStatus::Interrupted,
            other => {
                return Err(AppError::DataCorruption(format!(
                    "unknown session status {other:?}"
                )))
            }
        })
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            SessionStatus::Starting | SessionStatus::Running | SessionStatus::Stopping
        )
    }

    /// The session lifecycle state machine.
    pub fn can_transition_to(self, next: SessionStatus) -> bool {
        use SessionStatus::*;
        matches!(
            (self, next),
            (Starting, Running)
                | (Starting, Failed)
                | (Starting, Exited)
                | (Running, Stopping)
                | (Running, Exited)
                | (Stopping, Exited)
                | (Starting | Running | Stopping, Interrupted)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LoginMethod {
    /// Claude subscription (Pro, Max, Team, Enterprise). Default.
    Claudeai,
    /// Anthropic Console (API billing).
    Console,
}

// ---------------------------------------------------------------------------
// Records returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Account {
    pub id: String,
    pub name: String,
    /// User-entered email or label.
    pub label: Option<String>,
    /// Email reported by `claude auth status`.
    pub verified_email: Option<String>,
    /// Organization reported by `claude auth status`.
    pub org_name: Option<String>,
    pub config_dir: String,
    pub color: AccountColor,
    pub notes: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub auth_status: AuthStatus,
    /// `authMethod` from `claude auth status` (`claude.ai`, `api_key`, ...).
    pub auth_method: Option<String>,
    pub auth_status_checked_at: Option<String>,
    /// Last time the account was observed as authenticated.
    pub auth_verified_at: Option<String>,
    /// Short, non-sensitive explanation of the status.
    pub auth_detail: Option<String>,
    pub running_sessions: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub favorite: bool,
    pub default_account_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    /// Whether the directory currently exists.
    pub exists: bool,
    pub running_sessions: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionInfo {
    pub id: String,
    pub account_id: String,
    pub project_id: Option<String>,
    pub kind: SessionKind,
    pub title: String,
    pub working_dir: String,
    pub process_id: Option<u32>,
    pub status: SessionStatus,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub error: Option<String>,
    /// True while the PTY is held in memory (running, or exited but its tab
    /// is still open).
    pub attached: bool,
    /// Claude Code printed a usage-limit message in this session (kept in
    /// memory only).
    pub usage_limit_reached: bool,
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateAccountInput {
    pub name: String,
    pub color: AccountColor,
    #[ts(optional)]
    pub label: Option<String>,
    #[ts(optional)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateAccountInput {
    pub id: String,
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(optional)]
    pub color: Option<AccountColor>,
    /// `Some("")` clears the label.
    #[ts(optional)]
    pub label: Option<String>,
    /// `Some("")` clears the notes.
    #[ts(optional)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeleteAccountInput {
    pub id: String,
    pub delete_profile_data: bool,
    /// Runs `claude auth logout` for the profile before deleting its data.
    pub sign_out_first: bool,
    /// Must equal the account name when `delete_profile_data` is true.
    pub confirmation: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StartLoginInput {
    pub account_id: String,
    pub method: LoginMethod,
    #[ts(optional)]
    pub email: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StartSessionInput {
    pub account_id: String,
    #[ts(optional)]
    pub project_id: Option<String>,
    pub kind: SessionKind,
    /// Pass `--continue` to resume the most recent conversation.
    #[serde(default)]
    #[ts(optional)]
    pub continue_last: Option<bool>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenInEditorInput {
    pub project_id: String,
    pub account_id: String,
    /// One of the IDs reported in `SystemInfo.editors`.
    pub editor_id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenInEditorResult {
    /// The editor's settings named an account for every window, and were
    /// changed to this one.
    pub editor_account_changed: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetEditorAccountInput {
    pub editor_id: String,
    /// `None` removes the setting, so each window uses the environment it
    /// was opened with.
    #[ts(optional)]
    pub account_id: Option<String>,
}

/// A Claude Code conversation recorded for a registered project.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Conversation {
    /// Claude Code's session ID (the transcript's name).
    pub session_id: String,
    pub project_id: String,
    /// The profile with the most recent copy; `None` for Claude Code's own
    /// default folder (`~/.claude`).
    pub account_id: Option<String>,
    pub modified_at: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContinueConversationInput {
    pub project_id: String,
    pub session_id: String,
    /// Where the conversation is now; `None` for `~/.claude`.
    #[ts(optional)]
    pub from_account_id: Option<String>,
    pub to_account_id: String,
    /// Continue in this editor instead of a Claude Switch terminal.
    #[ts(optional)]
    pub editor_id: Option<String>,
    /// Sent as the next prompt in a terminal; placed in the message box in
    /// an editor.
    #[ts(optional)]
    pub message: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContinueConversationResult {
    /// The new terminal session, when continuing in Claude Switch.
    pub session: Option<SessionInfo>,
    /// Whether the conversation was copied (or brought up to date) in the
    /// target profile.
    pub copied: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateProjectInput {
    pub id: String,
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(optional)]
    pub favorite: Option<bool>,
    /// `Some("")` clears the default account.
    #[ts(optional)]
    pub default_account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ListSessionsInput {
    #[ts(optional)]
    pub account_id: Option<String>,
    #[ts(optional)]
    pub project_id: Option<String>,
    #[ts(optional)]
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn has_disallowed_control(s: &str, allow_newlines: bool) -> bool {
    s.chars().any(|c| {
        c.is_control() && !(allow_newlines && (c == '\n' || c == '\t'))
            || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
    })
}

/// Display names: trimmed, 1–64 characters, no control or bidi-override
/// characters. Names never reach the filesystem or a shell.
pub fn validate_name(raw: &str, what: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::invalid(format!("{what} name cannot be empty")));
    }
    if name.chars().count() > 64 {
        return Err(AppError::invalid(format!(
            "{what} name must be 64 characters or fewer"
        )));
    }
    if has_disallowed_control(name, false) {
        return Err(AppError::invalid(format!(
            "{what} name contains unsupported characters"
        )));
    }
    Ok(name.to_string())
}

/// Optional single-line text. Empty input becomes `None`.
pub fn validate_optional_line(
    raw: Option<&str>,
    max: usize,
    what: &str,
) -> AppResult<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > max {
        return Err(AppError::invalid(format!(
            "{what} must be {max} characters or fewer"
        )));
    }
    if has_disallowed_control(value, false) {
        return Err(AppError::invalid(format!(
            "{what} contains unsupported characters"
        )));
    }
    Ok(Some(value.to_string()))
}

pub fn validate_notes(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 2000 {
        return Err(AppError::invalid("Notes must be 2000 characters or fewer"));
    }
    if has_disallowed_control(value, true) {
        return Err(AppError::invalid("Notes contain unsupported characters"));
    }
    Ok(Some(value.to_string()))
}

/// The message sent when a conversation continues in another account. It
/// becomes one argv entry after `--resume <id>` (or a URL parameter), so it
/// may not look like a flag.
pub fn validate_continue_message(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > 2000 {
        return Err(AppError::invalid(
            "The message must be 2000 characters or fewer",
        ));
    }
    if value.starts_with('-') {
        return Err(AppError::invalid("The message cannot start with \"-\""));
    }
    if has_disallowed_control(value, true) {
        return Err(AppError::invalid(
            "The message contains unsupported characters",
        ));
    }
    Ok(Some(value.to_string()))
}

/// Email passed to `claude auth login --email`. It becomes a separate argv
/// entry (never a shell string); we still reject anything that could be
/// parsed as a flag or that is clearly not an address.
pub fn validate_login_email(raw: &str) -> AppResult<String> {
    let email = raw.trim();
    let valid = email.len() <= 254
        && !email.starts_with('-')
        && email.chars().filter(|&c| c == '@').count() == 1
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
        && matches!(email.split_once('@'), Some((local, domain)) if !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if !valid {
        return Err(AppError::invalid("Enter a valid email address"));
    }
    Ok(email.to_string())
}

pub fn validate_terminal_size(cols: u16, rows: u16) -> AppResult<(u16, u16)> {
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err(AppError::invalid("Terminal size is out of range"));
    }
    Ok((cols, rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_id_accepts_uuid_and_rejects_everything_else() {
        let id = Uuid::new_v4();
        assert_eq!(parse_id(&id.to_string(), "Account").unwrap(), id);
        for bad in [
            "",
            "../../etc/passwd",
            "1; DROP TABLE accounts",
            "$(rm -rf ~)",
            &format!("{id}/.."),
            &format!(" {id}"),
            "00000000000000000000000000000000",
        ] {
            assert!(parse_id(bad, "Account").is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(validate_name("  Work  ", "Account").unwrap(), "Work");
        assert!(validate_name("   ", "Account").is_err());
        assert!(validate_name(&"x".repeat(65), "Account").is_err());
        assert!(validate_name("bad\u{0007}name", "Account").is_err());
        assert!(validate_name("evil\u{202E}txt", "Account").is_err());
        // Shell metacharacters are fine in names: they are only ever data.
        assert_eq!(
            validate_name("$(whoami); `id`", "Account").unwrap(),
            "$(whoami); `id`"
        );
        assert_eq!(validate_name("کار شخصی", "Account").unwrap(), "کار شخصی");
    }

    #[test]
    fn optional_line_clears_on_empty() {
        assert_eq!(
            validate_optional_line(Some("  "), 10, "Label").unwrap(),
            None
        );
        assert_eq!(validate_optional_line(None, 10, "Label").unwrap(), None);
        assert!(validate_optional_line(Some("a\nb"), 10, "Label").is_err());
    }

    #[test]
    fn login_email_validation() {
        assert!(validate_login_email("me@example.com").is_ok());
        for bad in [
            "--console",
            "-x@example.com",
            "me example@x.com",
            "me@",
            "@example.com",
            "me@example",
            "a@b@c.com",
            "me@.com",
        ] {
            assert!(validate_login_email(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn session_state_machine() {
        use SessionStatus::*;
        assert!(Starting.can_transition_to(Running));
        assert!(Starting.can_transition_to(Failed));
        assert!(Running.can_transition_to(Stopping));
        assert!(Running.can_transition_to(Exited));
        assert!(Stopping.can_transition_to(Exited));
        assert!(Running.can_transition_to(Interrupted));
        assert!(!Exited.can_transition_to(Running));
        assert!(!Failed.can_transition_to(Running));
        assert!(!Exited.can_transition_to(Stopping));
        assert!(!Interrupted.can_transition_to(Running));
        assert!(!Stopping.can_transition_to(Running));
    }

    #[test]
    fn enum_round_trips() {
        for c in AccountColor::ALL {
            assert_eq!(AccountColor::parse(c.as_str()).unwrap(), c);
        }
        for s in [
            AuthStatus::NotConfigured,
            AuthStatus::AuthRequired,
            AuthStatus::Authenticated,
            AuthStatus::Unknown,
            AuthStatus::Failed,
            AuthStatus::UnsupportedIsolation,
        ] {
            assert_eq!(AuthStatus::parse(s.as_str()).unwrap(), s);
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
        }
        assert!(AuthStatus::parse("bogus").is_err());
    }

    #[test]
    fn terminal_size_bounds() {
        assert!(validate_terminal_size(80, 24).is_ok());
        assert!(validate_terminal_size(0, 24).is_err());
        assert!(validate_terminal_size(80, 0).is_err());
        assert!(validate_terminal_size(5000, 24).is_err());
    }

    #[test]
    fn continue_message_validation() {
        assert_eq!(validate_continue_message(None).unwrap(), None);
        assert_eq!(validate_continue_message(Some("  ")).unwrap(), None);
        assert_eq!(
            validate_continue_message(Some(" Continue.\nThanks "))
                .unwrap()
                .as_deref(),
            Some("Continue.\nThanks")
        );
        assert!(validate_continue_message(Some("--dangerously-skip-permissions")).is_err());
        assert!(validate_continue_message(Some("-p")).is_err());
        assert!(validate_continue_message(Some("a\u{1b}[2J")).is_err());
        assert!(validate_continue_message(Some(&"x".repeat(2001))).is_err());
    }
}
