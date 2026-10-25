//! Drives the real IPC command handlers through Tauri's invoke pipeline with
//! the app's real `tauri.conf.json` and capability files (mock runtime).
//! This checks argument names and shapes as the frontend sends them, error
//! serialization, and that the capability model allows exactly the app's
//! own commands.

mod support;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

use claude_switch_lib::commands::AppState;
use support::TestApp;

fn app_with(
    test: &TestApp,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = mock_builder()
        .invoke_handler(claude_switch_lib::invoke_handler())
        .build(tauri::generate_context!())
        .expect("build mock app");
    app.manage(AppState {
        core: Ok(test.core.clone()),
    });
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");
    (app, webview)
}

fn invoke(
    webview: &WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

#[test]
fn frontend_calls_round_trip_through_ipc() {
    let test = TestApp::new();
    let (_app, webview) = app_with(&test);

    assert_eq!(
        invoke(&webview, "list_accounts", json!({})).unwrap(),
        json!([])
    );

    let account = invoke(
        &webview,
        "create_account",
        json!({ "input": { "name": "Work", "color": "violet", "label": "me@work.example" } }),
    )
    .unwrap();
    assert_eq!(account["name"], "Work");
    assert_eq!(account["color"], "violet");
    assert_eq!(account["authStatus"], "not_configured");
    let id = account["id"].as_str().unwrap().to_string();

    let renamed = invoke(
        &webview,
        "update_account",
        json!({ "input": { "id": id, "name": "Day job" } }),
    )
    .unwrap();
    assert_eq!(renamed["configDir"], account["configDir"]);

    let status = invoke(&webview, "refresh_auth_status", json!({ "id": id })).unwrap();
    assert_eq!(status["authStatus"], "not_configured");

    let session = invoke(
        &webview,
        "start_session",
        json!({ "input": { "accountId": id, "kind": "claude", "cols": 100, "rows": 30 } }),
    )
    .unwrap();
    assert_eq!(session["status"], "running");
    let sid = session["id"].as_str().unwrap().to_string();

    invoke(
        &webview,
        "resize_session",
        json!({ "id": sid, "cols": 120, "rows": 40 }),
    )
    .unwrap();
    invoke(
        &webview,
        "write_session",
        json!({ "id": sid, "data": "hello\r", "binary": false }),
    )
    .unwrap();
    let open = invoke(&webview, "list_open_sessions", json!({})).unwrap();
    assert_eq!(open.as_array().unwrap().len(), 1);
    invoke(&webview, "close_session", json!({ "id": sid })).unwrap();

    let settings = invoke(&webview, "get_settings", json!({})).unwrap();
    assert_eq!(settings["closeBehavior"], "keep_running");
    let info = invoke(&webview, "get_system_info", json!({})).unwrap();
    assert_eq!(info["cli"]["state"], "found");
    assert_eq!(info["cli"]["version"], "2.1.999");

    invoke(
        &webview,
        "delete_account",
        json!({ "input": { "id": id, "deleteProfileData": false, "signOutFirst": false, "confirmation": "" } }),
    )
    .unwrap();
    assert_eq!(
        invoke(&webview, "list_accounts", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn errors_arrive_as_kind_and_message() {
    let test = TestApp::new();
    let (_app, webview) = app_with(&test);
    let err = invoke(
        &webview,
        "refresh_auth_status",
        json!({ "id": "../../etc" }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "invalidInput");
    assert!(err["message"].as_str().unwrap().contains("malformed"));

    let err = invoke(
        &webview,
        "submit_login_code",
        json!({ "sessionId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "code": "abc" }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "notFound");

    let err = invoke(
        &webview,
        "open_in_editor",
        json!({ "input": { "projectId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "accountId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "editorId": "vscode" } }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "notFound");

    let err = invoke(
        &webview,
        "start_session",
        json!({ "input": { "accountId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "kind": "claude", "cols": 80, "rows": 24 } }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "notFound");

    assert_eq!(
        invoke(&webview, "list_conversations", json!({})).unwrap(),
        json!([])
    );
    let id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    let err = invoke(
        &webview,
        "continue_conversation",
        json!({ "input": { "projectId": id, "sessionId": id, "toAccountId": id, "message": "Continue.", "cols": 80, "rows": 24 } }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "notFound");
    let err = invoke(
        &webview,
        "continue_conversation",
        json!({ "input": { "projectId": id, "sessionId": "x/../y", "toAccountId": id, "cols": 80, "rows": 24 } }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "invalidInput");
    let err = invoke(
        &webview,
        "set_editor_account",
        json!({ "input": { "editorId": "/bin/sh" } }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "notFound");
}

#[test]
fn unknown_commands_and_core_plugins_are_denied() {
    let test = TestApp::new();
    let (_app, webview) = app_with(&test);
    for cmd in [
        "run_shell",
        "exec",
        "plugin:shell|execute",
        "plugin:fs|read_file",
        "plugin:opener|open_url",
        "plugin:dialog|open",
        "plugin:window|close",
    ] {
        assert!(
            invoke(&webview, cmd, json!({})).is_err(),
            "{cmd} should be rejected"
        );
    }
}

#[test]
fn malformed_arguments_are_rejected() {
    let test = TestApp::new();
    let (_app, webview) = app_with(&test);
    // Wrong types and unknown enum values fail deserialization before any
    // handler runs.
    assert!(invoke(
        &webview,
        "create_account",
        json!({ "input": { "name": "X", "color": "chartreuse" } })
    )
    .is_err());
    assert!(invoke(
        &webview,
        "resize_session",
        json!({ "id": "x", "cols": -1, "rows": 10 })
    )
    .is_err());
    assert!(invoke(
        &webview,
        "start_session",
        json!({ "input": { "accountId": "x", "kind": "root", "cols": 80, "rows": 24 } })
    )
    .is_err());
}
