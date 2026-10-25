//! Local socket for the Claude Switch editor extension.
//!
//! The VS Code–family extension uses it to list accounts and to hand a
//! conversation to another account; the extension then chooses the account
//! in the editor's settings and reopens the conversation itself.
//!
//! * A Unix domain socket at `~/.claude-switch/claude-switch.sock` (mode
//!   0600, inside the 0700 managed folder). Every connection's peer must be
//!   the current user.
//! * One JSON request per connection, one line each way:
//!   `{"id": 1, "method": "accounts", "params": {}}` →
//!   `{"id": 1, "result": …}` or `{"id": 1, "error": {"kind", "message"}}`.
//! * Only the methods below exist. Nothing runs a program, and the only
//!   write is the conversation copy into a signed-in account's profile.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::clock;
use crate::core::AppCore;
use crate::domain::{parse_id, Account, AuthStatus};
use crate::error::{AppError, AppResult};
use crate::transcripts::CopyOutcome;

/// Bumped when a method changes incompatibly.
pub const PROTOCOL: u32 = 1;
const MAX_REQUEST: u64 = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// What the desktop layer does for the extension.
pub trait BridgeUi: Send + Sync + 'static {
    /// Brings Claude Switch forward, on an account's page if given.
    fn show(&self, account_id: Option<String>);
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../vscode-extension/src/bindings/")]
pub struct BridgeStatus {
    pub app_version: String,
    pub protocol: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../vscode-extension/src/bindings/")]
pub struct BridgeAccount {
    pub id: String,
    pub name: String,
    /// One of the account colors (`blue`, `violet`, …).
    pub color: String,
    /// Verified email, or the user's label.
    pub detail: Option<String>,
    /// The profile folder (`CLAUDE_CONFIG_DIR`).
    pub config_dir: String,
    pub signed_in: bool,
    /// Human-readable sign-in status.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../vscode-extension/src/bindings/")]
pub struct BridgeConversation {
    pub session_id: String,
    /// The profile holding the newest copy; `null` for `~/.claude`.
    pub account_id: Option<String>,
    pub modified_at: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../vscode-extension/src/bindings/")]
pub struct BridgeHandOver {
    /// False when the account already had this exact conversation.
    pub copied: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryParams {
    directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinueParams {
    directory: String,
    session_id: String,
    #[serde(default)]
    from_account_id: Option<String>,
    to_account_id: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShowParams {
    #[serde(default)]
    account_id: Option<String>,
}

fn status_label(status: AuthStatus) -> &'static str {
    match status {
        AuthStatus::NotConfigured => "Not signed in",
        AuthStatus::AuthRequired => "Sign-in required",
        AuthStatus::Authenticated => "Signed in",
        AuthStatus::Unknown => "Status unknown",
        AuthStatus::Failed => "Sign-in failed",
        AuthStatus::UnsupportedIsolation => "Limited isolation",
    }
}

impl From<&Account> for BridgeAccount {
    fn from(a: &Account) -> Self {
        Self {
            id: a.id.clone(),
            name: a.name.clone(),
            color: a.color.as_str().to_string(),
            detail: a.verified_email.clone().or_else(|| a.label.clone()),
            config_dir: a.config_dir.clone(),
            signed_in: a.auth_status == AuthStatus::Authenticated,
            status: status_label(a.auth_status).to_string(),
        }
    }
}

/// A running socket. The listening thread lives as long as the process;
/// [`EditorBridge::close`] removes the socket file.
pub struct EditorBridge {
    path: PathBuf,
}

impl EditorBridge {
    pub fn start(
        core: Arc<AppCore>,
        ui: Arc<dyn BridgeUi>,
        path: PathBuf,
        app_version: String,
    ) -> AppResult<Self> {
        let listener = bind(&path)?;
        std::thread::Builder::new()
            .name("editor-bridge".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    let (core, ui, version) = (core.clone(), ui.clone(), app_version.clone());
                    std::thread::spawn(move || serve(&core, ui.as_ref(), &version, stream));
                }
            })?;
        log::info!("editor extension socket ready");
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Removes the socket so the extension knows the app is gone.
    pub fn close(&self) {
        if is_socket(&self.path) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn is_socket(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket())
}

/// Binds the socket, replacing a stale one left by a crash. Refuses to touch
/// anything at that path that is not a socket.
fn bind(path: &Path) -> AppResult<UnixListener> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.file_type().is_socket() {
            return Err(AppError::InvalidConfigDir(format!(
                "{} exists and is not a socket; refusing to replace it",
                path.display()
            )));
        }
        if UnixStream::connect(path).is_ok() {
            return Err(AppError::Conflict(
                "Another Claude Switch is already serving the editor extension".into(),
            ));
        }
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// True if the connected process runs as the current user.
fn same_user(stream: &UnixStream) -> bool {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: the descriptor is a live socket and the out-pointers are valid.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    // SAFETY: getuid has no preconditions.
    rc == 0 && uid == unsafe { libc::getuid() }
}

fn serve(core: &AppCore, ui: &dyn BridgeUi, version: &str, mut stream: UnixStream) {
    if !same_user(&stream) {
        log::warn!("editor extension socket: refused a connection from another user");
        return;
    }
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut line = String::new();
    let read = BufReader::new((&stream).take(MAX_REQUEST + 1)).read_line(&mut line);
    let response = match read {
        Err(_) => return,
        Ok(_) if line.len() as u64 > MAX_REQUEST => reply(
            Value::Null,
            Err(AppError::invalid("The request is too large")),
        ),
        Ok(_) => respond(core, ui, version, &line),
    };
    let _ = writeln!(stream, "{response}");
}

fn reply(id: Value, result: AppResult<Value>) -> Value {
    match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(e) => json!({ "id": id, "error": e.payload() }),
    }
}

/// Handles one request line. Public for tests.
pub fn respond(core: &AppCore, ui: &dyn BridgeUi, version: &str, line: &str) -> Value {
    let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
        return reply(
            Value::Null,
            Err(AppError::invalid("The request is not JSON")),
        );
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = dispatch(core, ui, version, method, params);
    if let Err(e) = &result {
        log::info!("editor extension: {method} failed ({:?})", e.kind());
    }
    reply(id, result)
}

fn params<T: for<'de> Deserialize<'de>>(value: Value) -> AppResult<T> {
    serde_json::from_value(value).map_err(|e| AppError::invalid(format!("Invalid parameters: {e}")))
}

fn dispatch(
    core: &AppCore,
    ui: &dyn BridgeUi,
    version: &str,
    method: &str,
    params_value: Value,
) -> AppResult<Value> {
    let value = match method {
        "status" => serde_json::to_value(BridgeStatus {
            app_version: version.to_string(),
            protocol: PROTOCOL,
        }),
        "accounts" => {
            let accounts: Vec<BridgeAccount> = core
                .list_accounts()?
                .iter()
                .map(BridgeAccount::from)
                .collect();
            serde_json::to_value(accounts)
        }
        "conversations" => {
            let p: DirectoryParams = params(params_value)?;
            let dir = core.validate_working_dir(&p.directory)?;
            let list: Vec<BridgeConversation> = core
                .conversations_in_dir(&dir)?
                .into_iter()
                .map(|(account_id, t)| BridgeConversation {
                    session_id: t.session_id.hyphenated().to_string(),
                    account_id,
                    modified_at: clock::format(t.modified),
                    size_bytes: t.size,
                })
                .collect();
            serde_json::to_value(list)
        }
        "continue" => {
            let p: ContinueParams = params(params_value)?;
            let dir = core.validate_working_dir(&p.directory)?;
            let outcome = core.hand_over(
                &dir,
                &p.session_id,
                p.from_account_id.as_deref(),
                &p.to_account_id,
            )?;
            serde_json::to_value(BridgeHandOver {
                copied: outcome != CopyOutcome::Unchanged,
            })
        }
        "show" => {
            let p: ShowParams = params(params_value)?;
            let account = p
                .account_id
                .as_deref()
                .map(|a| parse_id(a, "Account").map(|u| u.hyphenated().to_string()))
                .transpose()?;
            ui.show(account);
            Ok(Value::Null)
        }
        _ => return Err(AppError::invalid("Unknown method")),
    };
    value.map_err(|e| AppError::Io(format!("could not encode the response: {e}")))
}
