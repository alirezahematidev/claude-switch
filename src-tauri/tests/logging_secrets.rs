//! Runs a full login and session with a secret in the inherited environment
//! and verifies nothing sensitive reaches the log file or diagnostics.
//! Kept in its own test binary because the logger is process-global.

mod support;

use std::fs;

use claude_switch_lib::domain::{LoginMethod, StartLoginInput};
use claude_switch_lib::logging;
use support::*;

#[test]
fn secrets_never_reach_logs_or_diagnostics() {
    let app = TestApp::new();
    logging::init(&app.paths.logs_dir);

    let a = app.account("Secretive");
    let login = app
        .core
        .start_login(StartLoginInput {
            account_id: a.clone(),
            method: LoginMethod::Claudeai,
            email: Some("private.person@example.com".into()),
            cols: 80,
            rows: 24,
        })
        .unwrap();
    let out = Capture::attach(&app.core, &login.id);
    out.wait_for("Login successful");
    wait_until("authenticated", || {
        app.core.list_accounts().unwrap()[0]
            .verified_email
            .is_some()
    });
    app.core.close_session(&login.id).unwrap();

    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let out = Capture::attach(&app.core, &s.id);
    out.wait_for("READY");
    app.core
        .write_session(&s.id, "terminal-content-marker\r", false)
        .unwrap();
    out.wait_for("ECHO:terminal-content-marker");
    app.core.close_session(&s.id).unwrap();
    log::logger().flush();

    let log = fs::read_to_string(app.paths.logs_dir.join(logging::LOG_FILE)).unwrap();
    let diagnostics = app.core.diagnostics("test");
    for text in [&log, &diagnostics] {
        assert!(!text.contains("sk-ant-test-secret-value"), "API key leaked");
        assert!(
            !text.contains("private.person@example.com"),
            "login email leaked"
        );
        assert!(!text.contains("user@example.com"), "verified email leaked");
        assert!(
            !text.contains("terminal-content-marker"),
            "terminal content leaked"
        );
        assert!(!text.contains("Secretive"), "account name leaked");
    }
    assert!(
        log.contains("started claude session"),
        "log is being written:\n{log}"
    );
    assert!(
        diagnostics.contains("ANTHROPIC_API_KEY"),
        "conflicting variable names are reported"
    );
}
