//! The editor extension's socket: only its own methods, only for the current
//! user, and only copies into signed-in accounts.

mod support;

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use claude_switch_lib::editor_bridge::{BridgeUi, EditorBridge, PROTOCOL};
use serde_json::{json, Value};
use support::*;

const CONVERSATION: &str = "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10";

#[derive(Default)]
struct RecordingUi(Mutex<Vec<Option<String>>>);

impl BridgeUi for RecordingUi {
    fn show(&self, account_id: Option<String>) {
        self.0.lock().unwrap().push(account_id);
    }
}

/// Socket paths are limited to 104 bytes, so tests use a short folder.
fn socket_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("csb")
        .tempdir_in("/tmp")
        .unwrap()
}

fn start(app: &TestApp, dir: &Path) -> (EditorBridge, Arc<RecordingUi>) {
    let ui = Arc::new(RecordingUi::default());
    let bridge = EditorBridge::start(
        app.core.clone(),
        ui.clone(),
        dir.join("s.sock"),
        "9.9.9".into(),
    )
    .unwrap();
    (bridge, ui)
}

fn call(path: &Path, request: &str) -> Value {
    let mut stream = UnixStream::connect(path).unwrap();
    // The server may answer and close before reading an oversized request.
    let _ = writeln!(stream, "{request}");
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn method(path: &Path, method: &str, params: Value) -> Value {
    call(
        path,
        &json!({ "id": 7, "method": method, "params": params }).to_string(),
    )
}

fn error_kind(response: &Value) -> &str {
    response["error"]["kind"].as_str().unwrap_or("none")
}

#[test]
fn lists_accounts_and_hands_a_conversation_over() {
    let app = TestApp::new();
    let a = app.signed_in_account("Work");
    let b = app.signed_in_account("Personal");
    let project = app.project_dir("not-registered");
    let source = write_transcript(&app.profile_dir(&a), &project, CONVERSATION, "{}\n");
    let sockets = socket_dir();
    let (bridge, _) = start(&app, sockets.path());

    let status = method(bridge.path(), "status", json!({}));
    assert_eq!(status["id"], 7);
    assert_eq!(
        status["result"],
        json!({ "appVersion": "9.9.9", "protocol": PROTOCOL })
    );

    let accounts = method(bridge.path(), "accounts", json!({}));
    let list = accounts["result"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["name"], "Work");
    assert_eq!(list[0]["signedIn"], true);
    assert_eq!(list[0]["status"], "Signed in");
    assert_eq!(list[0]["detail"], "user@example.com");
    assert_eq!(
        list[0]["configDir"],
        app.profile_dir(&a).display().to_string()
    );

    // Any folder works, registered as a project or not.
    let dir = project.display().to_string();
    let conversations = method(bridge.path(), "conversations", json!({ "directory": dir }));
    assert_eq!(
        conversations["result"][0]["sessionId"], CONVERSATION,
        "{conversations}"
    );
    assert_eq!(conversations["result"][0]["accountId"], a.as_str());

    let handed = method(
        bridge.path(),
        "continue",
        json!({ "directory": dir, "sessionId": CONVERSATION, "fromAccountId": a, "toAccountId": b }),
    );
    assert_eq!(handed["result"], json!({ "copied": true }), "{handed}");
    let copy = app
        .profile_dir(&b)
        .join("projects")
        .join(claude_switch_lib::transcripts::folder_name(&project).unwrap())
        .join(format!("{CONVERSATION}.jsonl"));
    assert_eq!(fs::read_to_string(copy).unwrap(), "{}\n");
    assert_eq!(fs::read_to_string(source).unwrap(), "{}\n");

    let again = method(
        bridge.path(),
        "continue",
        json!({ "directory": dir, "sessionId": CONVERSATION, "fromAccountId": a, "toAccountId": b }),
    );
    assert_eq!(again["result"], json!({ "copied": false }));
    bridge.close();
}

#[test]
fn refuses_anything_else() {
    let app = TestApp::new();
    let a = app.signed_in_account("Work");
    let signed_out = app.account("New");
    let project = app.project_dir("site");
    write_transcript(&app.profile_dir(&a), &project, CONVERSATION, "{}\n");
    let sockets = socket_dir();
    let (bridge, ui) = start(&app, sockets.path());
    let path = bridge.path();
    let dir = project.display().to_string();

    assert_eq!(error_kind(&call(path, "not json")), "invalidInput");
    assert_eq!(
        error_kind(&method(path, "run", json!({ "cmd": "ls" }))),
        "invalidInput"
    );
    assert_eq!(
        error_kind(&method(
            path,
            "conversations",
            json!({ "directory": dir, "extra": 1 })
        )),
        "invalidInput"
    );
    assert_eq!(
        error_kind(&method(
            path,
            "conversations",
            json!({ "directory": "relative/path" })
        )),
        "invalidInput"
    );
    assert_eq!(
        error_kind(&method(
            path,
            "conversations",
            json!({ "directory": "/nonexistent/x" })
        )),
        "projectDirMissing"
    );
    // Claude Switch's own folders are off limits.
    let managed = app.paths.profiles_root.display().to_string();
    assert_eq!(
        error_kind(&method(
            path,
            "conversations",
            json!({ "directory": managed })
        )),
        "permissionDenied"
    );
    assert_eq!(
        error_kind(&method(path, "conversations", json!({ "directory": "/" }))),
        "permissionDenied"
    );

    // Never into an account that is not signed in, never with a bad ID.
    let to_signed_out = method(
        path,
        "continue",
        json!({ "directory": dir, "sessionId": CONVERSATION, "fromAccountId": a, "toAccountId": signed_out }),
    );
    assert_eq!(error_kind(&to_signed_out), "authRequired");
    assert!(!app.profile_dir(&signed_out).join("projects").exists());
    let bad_id = method(
        path,
        "continue",
        json!({ "directory": dir, "sessionId": "../../x", "fromAccountId": a, "toAccountId": a }),
    );
    assert_eq!(error_kind(&bad_id), "invalidInput");

    // Oversized requests are rejected without being parsed.
    let huge = format!(
        "{{\"method\":\"status\",\"pad\":\"{}\"}}",
        "x".repeat(70_000)
    );
    assert_eq!(error_kind(&call(path, &huge)), "invalidInput");

    assert_eq!(
        error_kind(&method(path, "show", json!({ "accountId": "nope" }))),
        "invalidInput"
    );
    assert!(method(path, "show", json!({ "accountId": a }))["error"].is_null());
    assert!(method(path, "show", json!({}))["error"].is_null());
    assert_eq!(*ui.0.lock().unwrap(), vec![Some(a), None]);
}

#[test]
fn the_socket_is_private_and_replaces_only_stale_sockets() {
    let app = TestApp::new();
    let sockets = socket_dir();
    let path: PathBuf = sockets.path().join("s.sock");

    // A stale socket from a crashed run is replaced.
    drop(UnixListener::bind(&path).unwrap());
    let (bridge, _) = start(&app, sockets.path());
    let meta = fs::symlink_metadata(&path).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);

    // A live one is not.
    let second = EditorBridge::start(
        app.core.clone(),
        Arc::new(RecordingUi::default()),
        path.clone(),
        "x".into(),
    );
    assert!(second.is_err());
    assert_eq!(
        method(&path, "status", json!({}))["result"]["appVersion"],
        "9.9.9"
    );

    bridge.close();
    assert!(!path.exists());

    // Anything that is not a socket is left alone.
    fs::write(&path, "important").unwrap();
    assert!(EditorBridge::start(
        app.core.clone(),
        Arc::new(RecordingUi::default()),
        path.clone(),
        "x".into(),
    )
    .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "important");
}
