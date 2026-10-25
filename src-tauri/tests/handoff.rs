//! Continuing a conversation with another account: the transcript is copied
//! into the other profile and resumed there, the source is only read, and
//! nothing runs with an account that cannot be used.

mod support;

use std::fs;

use claude_switch_lib::core::CoreEvent;
use claude_switch_lib::domain::{ContinueConversationInput, SessionKind};
use claude_switch_lib::error::ErrorKind;
use support::*;

const CONVERSATION: &str = "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10";
const TRANSCRIPT: &str = "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n";

fn input(
    project_id: &str,
    from: Option<&str>,
    to: &str,
    message: Option<&str>,
) -> ContinueConversationInput {
    ContinueConversationInput {
        project_id: project_id.into(),
        session_id: CONVERSATION.into(),
        from_account_id: from.map(str::to_string),
        to_account_id: to.into(),
        editor_id: None,
        message: message.map(str::to_string),
        cols: 100,
        rows: 30,
    }
}

#[test]
fn continues_a_conversation_in_another_account() {
    let app = TestApp::new();
    let a = app.signed_in_account("Work");
    let b = app.signed_in_account("Personal");
    let dir = app.project_dir("site");
    let project = app.core.add_project(&dir).unwrap();
    let source = write_transcript(&app.profile_dir(&a), &dir, CONVERSATION, TRANSCRIPT);

    let listed = app.core.list_conversations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].session_id, CONVERSATION);
    assert_eq!(listed[0].project_id, project.id);
    assert_eq!(listed[0].account_id.as_deref(), Some(a.as_str()));
    assert_eq!(listed[0].size_bytes, TRANSCRIPT.len() as u64);

    let result = app
        .core
        .continue_conversation(input(
            &project.id,
            Some(&a),
            &b,
            Some("Continue where you left off."),
        ))
        .unwrap();
    assert!(result.copied);
    let session = result.session.expect("a terminal session");
    assert_eq!(session.account_id, b);
    assert_eq!(session.project_id.as_deref(), Some(project.id.as_str()));

    let cap = Capture::attach(&app.core, &session.id);
    assert_eq!(
        cap.value("CONFIG_DIR"),
        app.profile_dir(&b).display().to_string()
    );
    assert_eq!(cap.value("CWD"), project.directory);
    assert_eq!(
        cap.value("ARGS"),
        format!("--resume {CONVERSATION} Continue where you left off.")
    );

    // B has an identical copy; A's is untouched.
    let copy = app
        .profile_dir(&b)
        .join("projects")
        .join(claude_switch_lib::transcripts::folder_name(&dir).unwrap())
        .join(format!("{CONVERSATION}.jsonl"));
    assert_eq!(fs::read_to_string(&copy).unwrap(), TRANSCRIPT);
    assert_eq!(fs::read_to_string(&source).unwrap(), TRANSCRIPT);

    // Listed once, now from B's (newer) copy.
    fs::write(&copy, format!("{TRANSCRIPT}{{\"type\":\"user\"}}\n")).unwrap();
    let listed = app.core.list_conversations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].account_id.as_deref(), Some(b.as_str()));

    // A restart resumes again but does not resend the message.
    let restarted = app.core.restart_session(&session.id, 100, 30).unwrap();
    let cap = Capture::attach(&app.core, &restarted.id);
    assert_eq!(cap.value("ARGS"), format!("--resume {CONVERSATION}"));
    app.core.stop_all_sessions();
}

#[test]
fn going_back_updates_the_earlier_copy() {
    let app = TestApp::new();
    let a = app.signed_in_account("Work");
    let b = app.signed_in_account("Personal");
    let dir = app.project_dir("site");
    let project = app.core.add_project(&dir).unwrap();
    let in_a = write_transcript(&app.profile_dir(&a), &dir, CONVERSATION, TRANSCRIPT);
    app.core
        .continue_conversation(input(&project.id, Some(&a), &b, None))
        .unwrap();
    app.core.stop_all_sessions();

    // B continued the conversation; hand it back to A.
    let longer = format!("{TRANSCRIPT}{{\"type\":\"user\",\"more\":1}}\n");
    write_transcript(&app.profile_dir(&b), &dir, CONVERSATION, &longer);
    let result = app
        .core
        .continue_conversation(input(&project.id, Some(&b), &a, None))
        .unwrap();
    assert!(result.copied);
    assert_eq!(fs::read_to_string(&in_a).unwrap(), longer);
    let cap = Capture::attach(&app.core, &result.session.unwrap().id);
    assert_eq!(cap.value("ARGS"), format!("--resume {CONVERSATION}"));
    app.core.stop_all_sessions();

    // A diverged copy is never replaced.
    fs::write(&in_a, format!("{TRANSCRIPT}{{\"other\":true}}\n")).unwrap();
    let err = app
        .core
        .continue_conversation(input(&project.id, Some(&b), &a, None))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::Conflict);
}

#[test]
fn the_default_claude_folder_is_only_read() {
    let app = TestApp::new();
    let b = app.signed_in_account("Personal");
    let dir = app.project_dir("site");
    let project = app.core.add_project(&dir).unwrap();
    let global = app.paths.home.join(".claude");
    let source = write_transcript(&global, &dir, CONVERSATION, TRANSCRIPT);
    let before = fs::metadata(&source).unwrap().modified().unwrap();

    let listed = app.core.list_conversations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].account_id, None);

    let result = app
        .core
        .continue_conversation(input(&project.id, None, &b, None))
        .unwrap();
    let cap = Capture::attach(&app.core, &result.session.unwrap().id);
    assert_eq!(
        cap.value("CONFIG_DIR"),
        app.profile_dir(&b).display().to_string()
    );
    app.core.stop_all_sessions();

    assert_eq!(fs::read_to_string(&source).unwrap(), TRANSCRIPT);
    assert_eq!(fs::metadata(&source).unwrap().modified().unwrap(), before);
    let mut entries: Vec<_> = walk(&global);
    entries.sort();
    assert_eq!(entries.len(), 3, "nothing added to ~/.claude: {entries:?}");
}

fn walk(dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap().flatten() {
        out.push(entry.path().display().to_string());
        if entry.file_type().unwrap().is_dir() {
            out.extend(walk(&entry.path()));
        }
    }
    out
}

#[test]
fn refuses_unusable_targets_and_bad_input_without_copying() {
    let app = TestApp::new();
    let a = app.signed_in_account("Work");
    let signed_out = app.account("New");
    let dir = app.project_dir("site");
    let project = app.core.add_project(&dir).unwrap();
    write_transcript(&app.profile_dir(&a), &dir, CONVERSATION, TRANSCRIPT);
    let projects_in = |id: &str| app.profile_dir(id).join("projects");

    let err = app
        .core
        .continue_conversation(input(&project.id, Some(&a), &signed_out, None))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::AuthRequired);
    assert!(!projects_in(&signed_out).exists());

    let err = app
        .core
        .continue_conversation(input(&project.id, Some(&a), &a, None))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidInput);

    let b = app.signed_in_account("Personal");
    for message in ["--dangerously-skip-permissions", "-p hi", "bad\u{1b}[2J"] {
        let err = app
            .core
            .continue_conversation(input(&project.id, Some(&a), &b, Some(message)))
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{message}");
    }

    let mut unknown = input(&project.id, Some(&a), &b, None);
    unknown.session_id = "0e0b8f8e-4b7e-4a3c-9d55-8f8f8f8f8f8f".into();
    assert_eq!(
        app.core.continue_conversation(unknown).unwrap_err().kind(),
        ErrorKind::NotFound
    );
    let mut bad = input(&project.id, Some(&a), &b, None);
    bad.session_id = "../../etc/passwd".into();
    assert_eq!(
        app.core.continue_conversation(bad).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );
    assert!(!projects_in(&b).exists(), "nothing was copied");
    assert!(app.core.tracked_sessions().unwrap().is_empty());
}

#[test]
fn a_usage_limit_message_flags_the_session() {
    let app = TestApp::new();
    let a = app.account("Work");
    let session = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    assert!(!session.usage_limit_reached);
    let cap = Capture::attach(&app.core, &session.id);
    cap.wait_for("READY");
    app.core
        .write_session(&session.id, "hello\r", false)
        .unwrap();
    cap.wait_for("ECHO:hello");
    assert!(!app.core.tracked_sessions().unwrap()[0].usage_limit_reached);

    app.core
        .write_session(&session.id, "limit\r", false)
        .unwrap();
    wait_until("the session to be flagged", || {
        app.core.tracked_sessions().unwrap()[0].usage_limit_reached
    });
    let events = app.bridge.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(
        e,
        CoreEvent::SessionUpdated(s) if s.id == session.id && s.usage_limit_reached
    )));
    drop(events);

    // Shells are not watched.
    let mut shell = TestApp::claude_input(&a, None);
    shell.kind = SessionKind::Shell;
    let shell = app.core.start_session(shell).unwrap();
    assert!(!shell.usage_limit_reached);

    app.core.close_session(&session.id).unwrap();
    app.core.stop_all_sessions();
}
