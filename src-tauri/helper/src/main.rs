//! Claude Switch's core for the VS Code extension.
//!
//! The extension starts one helper per editor window and talks to it over
//! stdin and stdout, one JSON message per line:
//!
//! * request  `{"id": 1, "method": "listAccounts", "params": {…}}`
//! * response `{"id": 1, "result": …}` or `{"id": 1, "error": {"kind", "message"}}`
//! * event    `{"event": "changed", "data": "accounts"}` (no `id`)
//!
//! It runs the same core as the desktop app, on the same database and
//! profiles, so both show the same accounts and projects. Terminal sessions
//! it starts belong to it and stop when stdin closes (the window is gone).
//!
//! Only the methods in [`dispatch`] exist; like the app's IPC, there is no
//! generic "run a program" or "read a file" method.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use claude_switch_core::cli;
use claude_switch_core::core::{AppCore, CoreEvent, UiBridge};
use claude_switch_core::db::Database;
use claude_switch_core::domain::*;
use claude_switch_core::editor_bridge::{self, BridgeUi};
use claude_switch_core::env;
use claude_switch_core::error::{AppError, AppResult};
use claude_switch_core::logging;
use claude_switch_core::paths::AppPaths;
use claude_switch_core::settings::SettingsPatch;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

/// Bumped when a method or event changes incompatibly.
const PROTOCOL: u32 = 1;
const LOG_FILE: &str = "claude-switch-helper.log";
/// Methods answered by the editor bridge, shared with the app's socket.
const BRIDGE_METHODS: &[&str] = &["status", "accounts", "conversations", "open", "continue"];

/// Writes whole lines to stdout. The extension reads them in order.
struct Out(Mutex<std::io::Stdout>);

impl Out {
    fn send(&self, value: &Value) -> bool {
        let mut out = self.0.lock().unwrap_or_else(|p| p.into_inner());
        writeln!(out, "{value}").and_then(|()| out.flush()).is_ok()
    }

    fn event(&self, name: &str, data: Value) -> bool {
        self.send(&json!({ "event": name, "data": data }))
    }
}

/// Core events, forwarded to the extension.
struct Events(Arc<Out>);

impl UiBridge for Events {
    fn emit(&self, event: CoreEvent) {
        let (name, data) = match event {
            CoreEvent::Changed(scope) => ("changed", serde_json::to_value(scope)),
            CoreEvent::SessionUpdated(session) => ("sessionUpdated", serde_json::to_value(session)),
            CoreEvent::SessionFinished {
                session,
                account_name,
            } => (
                "sessionFinished",
                serde_json::to_value(session)
                    .map(|s| json!({ "session": s, "accountName": account_name })),
            ),
            CoreEvent::LoginCompleted { account } => {
                ("loginCompleted", serde_json::to_value(account))
            }
            CoreEvent::LoginProgress(progress) => ("loginProgress", serde_json::to_value(progress)),
        };
        if let Ok(data) = data {
            self.0.event(name, data);
        }
    }
}

impl BridgeUi for Events {
    /// The extension shows its own view instead of the app's window.
    fn show(&self, account_id: Option<String>) {
        self.0.event("show", json!({ "accountId": account_id }));
    }
}

fn params<T: DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value).map_err(|e| AppError::invalid(format!("Invalid parameters: {e}")))
}

fn encode<T: serde::Serialize>(value: AppResult<T>) -> AppResult<Value> {
    value.and_then(|v| {
        serde_json::to_value(v)
            .map_err(|e| AppError::Io(format!("could not encode the response: {e}")))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input<T> {
    input: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ids {
    ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Directory {
    directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Executable {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginSession {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginCode {
    session_id: String,
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionWrite {
    id: String,
    data: String,
    #[serde(default)]
    binary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Size {
    id: String,
    cols: u16,
    rows: u16,
}

/// Base64 (standard alphabet, padded) for terminal output, which is raw bytes
/// that may split a UTF-8 character between chunks.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

struct Helper {
    core: AppResult<Arc<AppCore>>,
    out: Arc<Out>,
    events: Arc<Events>,
    version: String,
}

impl Helper {
    fn core(&self) -> AppResult<&AppCore> {
        self.core.as_deref().map_err(Clone::clone)
    }

    /// Answers one request line.
    fn respond(&self, line: &str) -> Value {
        let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
            return reply(
                Value::Null,
                Err(AppError::invalid("The request is not JSON")),
            );
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if BRIDGE_METHODS.contains(&method) {
            return match self.core() {
                Ok(core) => editor_bridge::respond(core, self.events.as_ref(), &self.version, line),
                Err(e) => reply(id, Err(e)),
            };
        }
        let params_value = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = self.dispatch(method, params_value);
        if let Err(e) = &result {
            log::info!("helper: {method} failed ({:?})", e.kind());
        }
        reply(id, result)
    }

    fn dispatch(&self, method: &str, p: Value) -> AppResult<Value> {
        if method == "hello" {
            return Ok(json!({ "protocol": PROTOCOL, "version": self.version }));
        }
        let core = self.core()?;
        match method {
            // System
            "systemInfo" => encode(Ok(core.system_info(&self.version))),
            "diagnostics" => encode(Ok(core.diagnostics(&self.version))),
            "refreshCli" => encode(Ok(core.refresh_cli())),
            "sync" => encode(Ok(core.sync_external_changes())),
            "settings" => encode(Ok(core.settings())),
            "setClaudeExecutable" => {
                let p: Executable = params(p)?;
                cli::validate_configured(&p.path)?;
                core.update_settings(SettingsPatch {
                    claude_executable_path: Some(p.path),
                    ..Default::default()
                })?;
                encode(Ok(core.cli_status()))
            }
            // Accounts
            "listAccounts" => encode(core.list_accounts()),
            "createAccount" => encode(core.create_account(params::<Input<_>>(p)?.input)),
            "updateAccount" => encode(core.update_account(params::<Input<_>>(p)?.input)),
            "reorderAccounts" => {
                let p: Ids = params(p)?;
                if p.ids.len() > 1000 {
                    return Err(AppError::invalid("Too many accounts"));
                }
                encode(core.reorder_accounts(p.ids))
            }
            "deleteAccount" => encode(core.delete_account(params::<Input<_>>(p)?.input)),
            "refreshAuthStatus" => encode(core.refresh_auth_status(&params::<Id>(p)?.id)),
            "startLogin" => encode(core.start_login(params::<Input<_>>(p)?.input)),
            "loginProgress" => encode(core.login_progress(&params::<LoginSession>(p)?.session_id)),
            "submitLoginCode" => {
                let p: LoginCode = params(p)?;
                encode(core.submit_login_code(&p.session_id, &p.code))
            }
            // Projects
            "listProjects" => encode(core.list_projects()),
            "addProject" => {
                let p: Directory = params(p)?;
                let dir = PathBuf::from(&p.directory);
                if !dir.is_absolute() {
                    return Err(AppError::invalid("The folder must be an absolute path"));
                }
                encode(core.add_project(&dir))
            }
            "updateProject" => encode(core.update_project(params::<Input<_>>(p)?.input)),
            "removeProject" => encode(core.remove_project(&params::<Id>(p)?.id)),
            "openInEditor" => encode(core.open_in_editor(params::<Input<_>>(p)?.input)),
            // Sessions
            "listSessions" => {
                encode(core.list_sessions(params::<Input<ListSessionsInput>>(p)?.input))
            }
            "openSessions" => encode(core.tracked_sessions()),
            "startSession" => encode(core.start_session(params::<Input<_>>(p)?.input)),
            "attachSession" => {
                let id = params::<Id>(p)?.id;
                let out = self.out.clone();
                let session = id.clone();
                encode(core.attach_session(
                    &id,
                    Box::new(move |bytes: &[u8]| {
                        out.event("output", json!({ "id": session, "data": base64(bytes) }))
                    }),
                ))
            }
            "writeSession" => {
                let p: SessionWrite = params(p)?;
                encode(core.write_session(&p.id, &p.data, p.binary))
            }
            "resizeSession" => {
                let p: Size = params(p)?;
                encode(core.resize_session(&p.id, p.cols, p.rows))
            }
            "stopSession" => encode(core.stop_session(&params::<Id>(p)?.id)),
            "restartSession" => {
                let p: Size = params(p)?;
                encode(core.restart_session(&p.id, p.cols, p.rows))
            }
            "closeSession" => encode(core.close_session(&params::<Id>(p)?.id)),
            // Conversations
            "listConversations" => encode(core.list_conversations()),
            "continueConversation" => {
                encode(core.continue_conversation(params::<Input<_>>(p)?.input))
            }
            _ => Err(AppError::invalid("Unknown method")),
        }
    }
}

fn reply(id: Value, result: AppResult<Value>) -> Value {
    match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(e) => json!({ "id": id, "error": e.payload() }),
    }
}

fn start_core(events: Arc<Events>) -> AppResult<Arc<AppCore>> {
    let paths = AppPaths::resolve()?;
    paths.ensure()?;
    logging::init_as(&paths.logs_dir, LOG_FILE);
    let db = Database::open(&paths.db_path)?;
    AppCore::new(
        paths,
        db,
        events,
        env::inherited_env(),
        env::system_path_entries(),
    )
}

/// `--app-version <version>`: the extension's version, shown in diagnostics.
fn app_version() -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == "--app-version")
        .and_then(|i| args.get(i + 1))
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .cloned()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn main() {
    let out = Arc::new(Out(Mutex::new(std::io::stdout())));
    let events = Arc::new(Events(out.clone()));
    let core = start_core(events.clone());
    match &core {
        Ok(core) => {
            log::info!("helper started (extension {})", app_version());
            let core = core.clone();
            std::thread::spawn(move || {
                core.prepare();
            });
        }
        Err(e) => eprintln!("Claude Switch helper failed to start: {e}"),
    }
    let helper = Arc::new(Helper {
        core,
        out,
        events,
        version: app_version(),
    });

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let helper = helper.clone();
        // Sign-in checks and copies take a while; answer the rest meanwhile.
        std::thread::spawn(move || {
            let response = helper.respond(&line);
            if !helper.out.send(&response) {
                std::process::exit(0);
            }
        });
    }
    // The window is gone: stop what it started.
    if let Ok(core) = &helper.core {
        core.stop_all_sessions();
    }
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }
}
