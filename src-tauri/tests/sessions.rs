//! End-to-end tests of account isolation, process management, and lifecycle,
//! driven through `AppCore` with a mock Claude Code executable and real PTYs.

mod support;

use std::fs;

use claude_switch_lib::core::CoreEvent;
use claude_switch_lib::domain::*;
use claude_switch_lib::error::{AppError, ErrorKind};
use claude_switch_lib::settings::SettingsPatch;
use support::*;

#[test]
fn two_accounts_get_two_distinct_profile_directories() {
    let app = TestApp::new();
    let a = app.account("Work");
    let b = app.account("Personal");
    let accounts = app.core.list_accounts().unwrap();
    let dir_a = &accounts.iter().find(|x| x.id == a).unwrap().config_dir;
    let dir_b = &accounts.iter().find(|x| x.id == b).unwrap().config_dir;
    assert_ne!(dir_a, dir_b);
    assert!(fs::metadata(dir_a).unwrap().is_dir());
    assert!(fs::metadata(dir_b).unwrap().is_dir());
    assert!(dir_a.ends_with(&a) && dir_b.ends_with(&b));
}

#[test]
fn renaming_keeps_the_profile_directory() {
    let app = TestApp::new();
    let id = app.account("Work");
    let before = app.core.list_accounts().unwrap()[0].config_dir.clone();
    let after = app
        .core
        .update_account(UpdateAccountInput {
            id: id.clone(),
            name: Some("Day job".into()),
            color: Some(AccountColor::Pink),
            label: Some("me@work.example".into()),
            notes: None,
        })
        .unwrap();
    assert_eq!(after.name, "Day job");
    assert_eq!(after.config_dir, before);
}

#[test]
fn session_receives_its_own_config_dir_and_a_clean_environment() {
    let app = TestApp::new();
    let id = app.account("Work");
    let session = app
        .core
        .start_session(TestApp::claude_input(&id, None))
        .unwrap();
    assert_eq!(session.status, SessionStatus::Running);
    let out = Capture::attach(&app.core, &session.id);
    assert_eq!(
        out.value("CONFIG_DIR"),
        app.profile_dir(&id).display().to_string()
    );
    assert_eq!(
        out.value("API_KEY"),
        "unset",
        "ANTHROPIC_API_KEY must not reach the child"
    );
    assert_eq!(
        out.value("NESTED"),
        "unset",
        "CLAUDECODE must not reach the child"
    );
    assert_eq!(out.value("TERM"), "xterm-256color");
    assert_eq!(out.value("CWD"), app.paths.home.display().to_string());
    app.core.close_session(&session.id).unwrap();
}

#[test]
fn concurrent_sessions_stay_bound_to_their_accounts_and_projects() {
    let app = TestApp::new();
    let a = app.account("A");
    let b = app.account("B");
    let pa = app.core.add_project(&app.project_dir("alpha")).unwrap();
    let pb = app.core.add_project(&app.project_dir("beta")).unwrap();

    let sa = app
        .core
        .start_session(TestApp::claude_input(&a, Some(&pa.id)))
        .unwrap();
    let sb = app
        .core
        .start_session(TestApp::claude_input(&b, Some(&pb.id)))
        .unwrap();
    let sa2 = app
        .core
        .start_session(TestApp::claude_input(&a, Some(&pb.id)))
        .unwrap();
    let (oa, ob, oa2) = (
        Capture::attach(&app.core, &sa.id),
        Capture::attach(&app.core, &sb.id),
        Capture::attach(&app.core, &sa2.id),
    );

    assert_eq!(
        oa.value("CONFIG_DIR"),
        app.profile_dir(&a).display().to_string()
    );
    assert_eq!(
        ob.value("CONFIG_DIR"),
        app.profile_dir(&b).display().to_string()
    );
    assert_eq!(
        oa2.value("CONFIG_DIR"),
        app.profile_dir(&a).display().to_string()
    );
    assert_eq!(oa.value("CWD"), pa.directory);
    assert_eq!(ob.value("CWD"), pb.directory);
    assert_eq!(oa2.value("CWD"), pb.directory);

    let accounts = app.core.list_accounts().unwrap();
    let count = |id: &str| {
        accounts
            .iter()
            .find(|x| x.id == id)
            .unwrap()
            .running_sessions
    };
    assert_eq!(count(&a), 2);
    assert_eq!(count(&b), 1);

    for s in [&sa, &sb, &sa2] {
        app.core.close_session(&s.id).unwrap();
    }
}

#[test]
fn input_reaches_the_right_session() {
    let app = TestApp::new();
    let a = app.account("A");
    let s1 = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let s2 = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let o1 = Capture::attach(&app.core, &s1.id);
    let o2 = Capture::attach(&app.core, &s2.id);
    o1.wait_for("READY");
    o2.wait_for("READY");
    app.core
        .write_session(&s1.id, "hello-one\r", false)
        .unwrap();
    o1.wait_for("ECHO:hello-one");
    assert!(!o2.text().contains("hello-one"));
    app.core.close_session(&s1.id).unwrap();
    app.core.close_session(&s2.id).unwrap();
}

#[test]
fn stopping_one_session_does_not_affect_another() {
    let app = TestApp::new();
    let a = app.account("A");
    let s1 = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let s2 = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let o1 = Capture::attach(&app.core, &s1.id);
    let o2 = Capture::attach(&app.core, &s2.id);
    o1.wait_for("READY");
    o2.wait_for("READY");

    app.core.stop_session(&s1.id).unwrap();
    wait_until("s1 recorded as exited", || {
        app.core
            .list_sessions(ListSessionsInput {
                account_id: None,
                project_id: None,
                limit: None,
            })
            .unwrap()
            .iter()
            .any(|s| s.id == s1.id && s.status == SessionStatus::Exited)
    });

    app.core
        .write_session(&s2.id, "still-here\r", false)
        .unwrap();
    o2.wait_for("ECHO:still-here");
    assert!(app.core.write_session(&s1.id, "x\r", false).is_err());
    app.core.close_session(&s1.id).unwrap();
    app.core.close_session(&s2.id).unwrap();
}

#[test]
fn stopping_a_session_kills_its_process_group() {
    let app = TestApp::new();
    let a = app.account("A");
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let out = Capture::attach(&app.core, &s.id);
    let child: i32 = out.value("CHILD_PID").parse().unwrap();
    assert!(process_alive(child));
    app.core.close_session(&s.id).unwrap();
    wait_until("background child to exit", || !process_alive(child));
    assert!(!process_alive(s.process_id.unwrap() as i32));
}

#[test]
fn stop_escalates_to_sigkill_for_processes_ignoring_hangup() {
    let app = TestApp::new();
    let a = app.account("A");
    fs::write(app.profile_dir(&a).join("mock-ignore-signals"), "").unwrap();
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let out = Capture::attach(&app.core, &s.id);
    out.wait_for("READY");
    app.core.stop_session(&s.id).unwrap();
    assert!(!process_alive(s.process_id.unwrap() as i32));
    app.core.close_session(&s.id).unwrap();
}

#[test]
fn exit_code_is_recorded() {
    let app = TestApp::new();
    let a = app.account("A");
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let out = Capture::attach(&app.core, &s.id);
    out.wait_for("READY");
    app.core.write_session(&s.id, "quit\r", false).unwrap();
    wait_until("exit recorded", || {
        app.core
            .list_sessions(ListSessionsInput {
                account_id: Some(a.clone()),
                project_id: None,
                limit: None,
            })
            .unwrap()
            .iter()
            .any(|x| x.id == s.id && x.status == SessionStatus::Exited && x.exit_code == Some(7))
    });
    // Unexpected exits notify the UI (after the post-exit status check).
    wait_until("SessionFinished event", || {
        app.bridge
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, CoreEvent::SessionFinished { session, .. } if session.id == s.id))
    });
    app.core.close_session(&s.id).unwrap();
}

#[test]
fn restart_starts_a_new_session_with_the_same_binding() {
    let app = TestApp::new();
    let a = app.account("A");
    let p = app.core.add_project(&app.project_dir("proj")).unwrap();
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, Some(&p.id)))
        .unwrap();
    let restarted = app.core.restart_session(&s.id, 90, 25).unwrap();
    assert_ne!(restarted.id, s.id);
    assert_eq!(restarted.account_id, a);
    assert_eq!(restarted.project_id.as_deref(), Some(p.id.as_str()));
    let out = Capture::attach(&app.core, &restarted.id);
    assert_eq!(out.value("CWD"), p.directory);
    app.core.close_session(&restarted.id).unwrap();
}

#[test]
fn continue_flag_is_passed_as_an_argument() {
    let app = TestApp::new();
    let a = app.account("A");
    let mut input = TestApp::claude_input(&a, None);
    input.continue_last = Some(true);
    let s = app.core.start_session(input).unwrap();
    let out = Capture::attach(&app.core, &s.id);
    assert_eq!(out.value("ARGS"), "--continue");
    app.core.close_session(&s.id).unwrap();
}

#[test]
fn missing_cli_produces_a_useful_error() {
    let app = TestApp::new();
    let a = app.account("A");
    let missing = app.root.join("nowhere/claude");
    app.core
        .update_settings(SettingsPatch {
            claude_executable_path: Some(missing.display().to_string()),
            ..Default::default()
        })
        .unwrap();
    let err = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::ExecutableNotFound);
    assert!(err.to_string().contains("does not exist"));
    let account = app.core.refresh_auth_status(&a).unwrap();
    assert_eq!(account.auth_status, AuthStatus::Unknown);
}

#[test]
fn a_slow_startup_check_does_not_undo_a_chosen_executable() {
    use std::os::unix::fs::PermissionsExt;

    let app = TestApp::new();
    // Auto-detection looks here first, and this one is slow to answer.
    let slow = app.paths.home.join(".local/bin/claude");
    fs::create_dir_all(slow.parent().unwrap()).unwrap();
    fs::write(
        &slow,
        "#!/bin/bash\nsleep 1\necho \"2.1.999 (Claude Code)\"\n",
    )
    .unwrap();
    fs::set_permissions(&slow, fs::Permissions::from_mode(0o755)).unwrap();
    let choose = |path: String| {
        app.core
            .update_settings(SettingsPatch {
                claude_executable_path: Some(path),
                ..Default::default()
            })
            .unwrap()
    };
    choose(String::new());

    // The startup check is still running when the user chooses the mock.
    let core = app.core.clone();
    let startup = std::thread::spawn(move || core.refresh_cli());
    std::thread::sleep(std::time::Duration::from_millis(300));
    choose(app.mock.display().to_string());
    let stale = startup.join().unwrap();

    let mock = Some(app.mock.display().to_string());
    assert_eq!(stale.path, mock, "the slow check reports the newer answer");
    assert_eq!(app.core.cli_status().path, mock);
}

#[test]
fn missing_project_directory_is_reported_and_never_replaced_with_home() {
    let app = TestApp::new();
    let a = app.account("A");
    let dir = app.project_dir("vanishing");
    let p = app.core.add_project(&dir).unwrap();
    fs::remove_dir(&dir).unwrap();
    let err = app
        .core
        .start_session(TestApp::claude_input(&a, Some(&p.id)))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::ProjectDirMissing);
    assert!(app.core.tracked_sessions().unwrap().is_empty());
}

#[test]
fn missing_profile_directory_blocks_launch_instead_of_falling_back() {
    let app = TestApp::new();
    let a = app.account("A");
    fs::remove_dir_all(app.profile_dir(&a)).unwrap();
    let err = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidConfigDir);
}

#[test]
fn login_flow_updates_status_without_storing_credentials() {
    let app = TestApp::new();
    let a = app.account("A");
    assert_eq!(
        app.core.refresh_auth_status(&a).unwrap().auth_status,
        AuthStatus::NotConfigured
    );

    let login = app
        .core
        .start_login(StartLoginInput {
            account_id: a.clone(),
            method: LoginMethod::Claudeai,
            email: Some("me@example.com".into()),
            cols: 100,
            rows: 30,
        })
        .unwrap();
    assert_eq!(login.kind, SessionKind::Login);
    let out = Capture::attach(&app.core, &login.id);
    let text = out.wait_for("Login successful");
    assert!(text.contains("ARGS=auth login --claudeai --email me@example.com"));

    wait_until("account authenticated", || {
        app.core.list_accounts().unwrap()[0].auth_status == AuthStatus::Authenticated
    });
    let account = &app.core.list_accounts().unwrap()[0];
    assert_eq!(account.auth_method.as_deref(), Some("claude.ai"));
    assert_eq!(account.verified_email.as_deref(), Some("user@example.com"));
    assert!(account.auth_verified_at.is_some());

    // Nothing credential-like lands in the database.
    drop(app.core.close_session(&login.id));
    let mut db = Vec::new();
    for suffix in ["", "-wal"] {
        let path = format!("{}{suffix}", app.paths.db_path.display());
        if let Ok(bytes) = fs::read(path) {
            db.extend(bytes);
        }
    }
    let db = String::from_utf8_lossy(&db);
    assert!(
        db.contains("user@example.com"),
        "sanity check: the scan sees recent writes"
    );
    assert!(!db.contains("sk-ant"));
    assert!(!db.to_lowercase().contains("token"));
    assert!(
        !db.contains("me@example.com"),
        "the login email argument is not persisted"
    );
}

#[test]
fn failed_or_cancelled_login_keeps_the_profile_for_retry() {
    let app = TestApp::new();
    let a = app.account("A");
    fs::write(app.profile_dir(&a).join("mock-login-fails"), "").unwrap();
    let login = app
        .core
        .start_login(StartLoginInput {
            account_id: a.clone(),
            method: LoginMethod::Claudeai,
            email: None,
            cols: 100,
            rows: 30,
        })
        .unwrap();
    wait_until("login failure recorded", || {
        app.core.list_accounts().unwrap()[0].auth_status == AuthStatus::Failed
    });
    assert!(app.profile_dir(&a).is_dir());
    app.core.close_session(&login.id).unwrap();

    fs::remove_file(app.profile_dir(&a).join("mock-login-fails")).unwrap();
    let retry = app
        .core
        .start_login(StartLoginInput {
            account_id: a.clone(),
            method: LoginMethod::Claudeai,
            email: None,
            cols: 100,
            rows: 30,
        })
        .unwrap();
    wait_until("retry succeeds", || {
        app.core.list_accounts().unwrap()[0].auth_status == AuthStatus::Authenticated
    });
    app.core.close_session(&retry.id).unwrap();
}

#[test]
fn expired_login_is_reported_as_auth_required() {
    let app = TestApp::new();
    let a = app.account("A");
    fs::write(app.profile_dir(&a).join("mock-auth"), "claude.ai").unwrap();
    assert_eq!(
        app.core.refresh_auth_status(&a).unwrap().auth_status,
        AuthStatus::Authenticated
    );
    fs::remove_file(app.profile_dir(&a).join("mock-auth")).unwrap();
    let account = app.core.refresh_auth_status(&a).unwrap();
    assert_eq!(account.auth_status, AuthStatus::AuthRequired);
    assert!(
        account.auth_verified_at.is_some(),
        "last successful verification is kept"
    );
}

#[test]
fn shared_credential_sources_are_reported_as_unsupported_isolation() {
    let app = TestApp::new();
    let a = app.account("A");
    for method in ["third_party", "api_key_helper", "oauth_token"] {
        fs::write(app.profile_dir(&a).join("mock-auth"), method).unwrap();
        let account = app.core.refresh_auth_status(&a).unwrap();
        assert_eq!(
            account.auth_status,
            AuthStatus::UnsupportedIsolation,
            "{method}"
        );
        assert!(account.auth_detail.is_some());
    }
    fs::write(app.profile_dir(&a).join("mock-auth"), "api_key").unwrap();
    assert_eq!(
        app.core.refresh_auth_status(&a).unwrap().auth_status,
        AuthStatus::Authenticated
    );
}

#[test]
fn metadata_survives_restart_and_stale_sessions_become_interrupted() {
    let mut app = TestApp::new();
    let a = app.account("Persistent");
    let p = app.core.add_project(&app.project_dir("keep")).unwrap();
    app.core
        .update_project(UpdateProjectInput {
            id: p.id.clone(),
            name: None,
            favorite: Some(true),
            default_account_id: Some(a.clone()),
        })
        .unwrap();
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, Some(&p.id)))
        .unwrap();

    // Another core opens the database while the first still runs the
    // session (the app and the editor helper share it): it is left alone.
    let old = std::mem::replace(
        &mut app.core,
        TestApp::open_core(&app.paths, &app.paths.home).0,
    );
    app.core.startup();
    let status = |core: &claude_switch_lib::core::AppCore| {
        core.list_sessions(ListSessionsInput {
            account_id: None,
            project_id: None,
            limit: None,
        })
        .unwrap()[0]
            .status
    };
    assert_eq!(status(&app.core), SessionStatus::Running);

    // Simulate a crash: the row says "running", but its process is gone.
    let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let gone_pid = gone.id();
    gone.wait().unwrap();
    claude_switch_lib::db::Database::open(&app.paths.db_path)
        .unwrap()
        .conn()
        .execute(
            "UPDATE sessions SET process_id = ?1 WHERE id = ?2",
            (gone_pid, s.id.as_str()),
        )
        .unwrap();
    app.core.startup();

    let accounts = app.core.list_accounts().unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].name, "Persistent");
    let projects = app.core.list_projects().unwrap();
    assert!(projects[0].favorite);
    assert_eq!(projects[0].default_account_id.as_deref(), Some(a.as_str()));
    let history = app
        .core
        .list_sessions(ListSessionsInput {
            account_id: None,
            project_id: None,
            limit: None,
        })
        .unwrap();
    assert_eq!(history[0].id, s.id);
    assert_eq!(history[0].status, SessionStatus::Interrupted);

    old.stop_all_sessions();
}

#[test]
fn quitting_stops_every_session() {
    let app = TestApp::new();
    let a = app.account("A");
    let b = app.account("B");
    let s1 = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let s2 = app
        .core
        .start_session(TestApp::claude_input(&b, None))
        .unwrap();
    let o1 = Capture::attach(&app.core, &s1.id);
    let o2 = Capture::attach(&app.core, &s2.id);
    let c1: i32 = o1.value("CHILD_PID").parse().unwrap();
    let c2: i32 = o2.value("CHILD_PID").parse().unwrap();
    assert_eq!(app.core.running_session_count(), 2);
    app.core.stop_all_sessions();
    assert_eq!(app.core.running_session_count(), 0);
    for pid in [s1.process_id.unwrap() as i32, s2.process_id.unwrap() as i32] {
        assert!(!process_alive(pid));
    }
    wait_until("children exit", || !process_alive(c1) && !process_alive(c2));
}

#[test]
fn reattaching_replays_buffered_output() {
    let app = TestApp::new();
    let a = app.account("A");
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let first = Capture::attach(&app.core, &s.id);
    first.wait_for("READY");
    let second = Capture::attach(&app.core, &s.id);
    assert!(second.wait_for("READY").contains("CONFIG_DIR="));
    app.core.close_session(&s.id).unwrap();
}

#[test]
fn shell_sessions_carry_the_account_environment() {
    let app = TestApp::new();
    let a = app.account("A");
    let mut input = TestApp::claude_input(&a, None);
    input.kind = SessionKind::Shell;
    let s = app.core.start_session(input).unwrap();
    let out = Capture::attach(&app.core, &s.id);
    app.core
        .write_session(&s.id, "echo \"DIR=[$CLAUDE_CONFIG_DIR]\"; exit\r", false)
        .unwrap();
    out.wait_for(&format!("DIR=[{}]", app.profile_dir(&a).display()));
    let _ = app.core.close_session(&s.id);
}

#[test]
fn account_with_running_sessions_cannot_be_removed() {
    let app = TestApp::new();
    let a = app.account("A");
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let err = app
        .core
        .delete_account(DeleteAccountInput {
            id: a.clone(),
            delete_profile_data: false,
            sign_out_first: false,
            confirmation: String::new(),
        })
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::Conflict);
    app.core.close_session(&s.id).unwrap();
}

#[test]
fn removing_an_account_keeps_data_unless_confirmed() {
    let app = TestApp::new();
    let a = app.account("Keep me");
    let dir = app.profile_dir(&a);
    app.core
        .delete_account(DeleteAccountInput {
            id: a.clone(),
            delete_profile_data: false,
            sign_out_first: false,
            confirmation: String::new(),
        })
        .unwrap();
    assert!(dir.is_dir(), "profile data is kept by default");
    let info = app.core.system_info("test");
    assert_eq!(info.orphaned_profiles, vec![dir.display().to_string()]);

    let b = app.account("Delete me");
    let err = app
        .core
        .delete_account(DeleteAccountInput {
            id: b.clone(),
            delete_profile_data: true,
            sign_out_first: false,
            confirmation: "delete me".into(),
        })
        .unwrap_err();
    assert_eq!(
        err.kind(),
        ErrorKind::InvalidInput,
        "confirmation must match exactly"
    );
    assert!(app.profile_dir(&b).is_dir());

    fs::write(app.profile_dir(&b).join("mock-auth"), "claude.ai").unwrap();
    app.core
        .delete_account(DeleteAccountInput {
            id: b.clone(),
            delete_profile_data: true,
            sign_out_first: true,
            confirmation: "Delete me".into(),
        })
        .unwrap();
    assert!(!app.profile_dir(&b).exists());
}

#[test]
fn profile_data_in_use_outside_the_app_is_not_deleted() {
    let app = TestApp::new();
    let a = app.account("In VS Code");
    let dir = app.profile_dir(&a);
    // Claude Code's registry entry for a live process using this profile
    // (this test process stands in for a Claude tab in VS Code).
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let me = std::process::id();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let entry = sessions.join(format!("{me}.json"));
    fs::write(&entry, format!(r#"{{"pid": {me}, "startedAt": {now}}}"#)).unwrap();
    let delete = || {
        app.core.delete_account(DeleteAccountInput {
            id: a.clone(),
            delete_profile_data: true,
            sign_out_first: false,
            confirmation: "In VS Code".into(),
        })
    };
    let err = delete().unwrap_err();
    assert_eq!(err.kind(), ErrorKind::Conflict);
    assert!(err.to_string().contains("outside Claude Switch"), "{err}");
    assert!(dir.is_dir());
    assert_eq!(app.core.list_accounts().unwrap().len(), 1);

    // Once that process is gone, deleting works.
    fs::remove_file(&entry).unwrap();
    delete().unwrap();
    assert!(!dir.exists());
}

#[test]
fn removing_a_project_never_touches_its_files() {
    let app = TestApp::new();
    let dir = app.project_dir("precious");
    fs::write(dir.join("CLAUDE.md"), "# keep").unwrap();
    let p = app.core.add_project(&dir).unwrap();
    app.core.remove_project(&p.id).unwrap();
    assert_eq!(fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# keep");
    assert!(app.core.list_projects().unwrap().is_empty());
}

#[test]
fn reorder_requires_a_full_permutation() {
    let app = TestApp::new();
    let a = app.account("A");
    let b = app.account("B");
    let c = app.account("C");
    let ordered = app
        .core
        .reorder_accounts(vec![c.clone(), a.clone(), b.clone()])
        .unwrap();
    assert_eq!(
        ordered.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
        vec![c.clone(), a.clone(), b.clone()]
    );
    assert!(app
        .core
        .reorder_accounts(vec![a.clone(), b.clone()])
        .is_err());
    assert!(app
        .core
        .reorder_accounts(vec![a.clone(), a.clone(), b.clone()])
        .is_err());
}

#[test]
fn concurrent_login_for_the_same_account_is_rejected() {
    let app = TestApp::new();
    let a = app.account("A");
    // Make the first login hang by pointing it at an interactive mock path:
    // a login that has not exited yet.
    fs::write(app.profile_dir(&a).join("mock-login-fails"), "").unwrap();
    let first = app
        .core
        .start_login(StartLoginInput {
            account_id: a.clone(),
            method: LoginMethod::Claudeai,
            email: None,
            cols: 80,
            rows: 24,
        })
        .unwrap();
    // The first may already have exited; either outcome is acceptable, but a
    // second start while it runs must be refused.
    let second = app.core.start_login(StartLoginInput {
        account_id: a.clone(),
        method: LoginMethod::Claudeai,
        email: None,
        cols: 80,
        rows: 24,
    });
    if let Err(e) = &second {
        assert!(matches!(e, AppError::Conflict(_)));
    }
    let _ = app.core.close_session(&first.id);
    if let Ok(s) = second {
        let _ = app.core.close_session(&s.id);
    }
}

#[test]
fn version_probe_never_uses_home_or_a_profile_as_config_dir() {
    let app = TestApp::new();
    let log = app.root.join("probe-env.log");
    let script = format!(
        "#!/bin/bash\necho \"$CLAUDE_CONFIG_DIR\" >> {}\n{}",
        log.display(),
        support::MOCK_CLAUDE.trim_start_matches("#!/bin/bash\n")
    );
    fs::write(&app.mock, script).unwrap();
    let status = app.core.refresh_cli();
    assert_eq!(status.version.as_deref(), Some("2.1.999"));
    let seen = fs::read_to_string(&log).unwrap();
    let dir = seen.lines().last().unwrap();
    assert_eq!(dir, app.paths.cli_probe_dir().display().to_string());
    assert_ne!(dir, app.paths.home.display().to_string());
}

fn start_code_login(app: &TestApp, account: &str) -> SessionInfo {
    fs::write(app.profile_dir(account).join("mock-login-needs-code"), "").unwrap();
    app.core
        .start_login(StartLoginInput {
            account_id: account.into(),
            method: LoginMethod::Claudeai,
            email: None,
            cols: 100,
            rows: 30,
        })
        .unwrap()
}

#[test]
fn sign_in_screen_gets_the_url_and_a_working_code_field() {
    use claude_switch_lib::login::LoginPhase;
    let app = TestApp::new();
    let a = app.account("A");
    let login = start_code_login(&app, &a);
    wait_until("sign-in URL", || {
        app.core
            .login_progress(&login.id)
            .is_ok_and(|p| p.awaiting_code && p.url.is_some())
    });
    let progress = app.core.login_progress(&login.id).unwrap();
    assert_eq!(progress.phase, LoginPhase::Waiting);
    assert_eq!(progress.url_host.as_deref(), Some("claude.com"));
    assert!(progress
        .url
        .unwrap()
        .starts_with("https://claude.com/cai/oauth/authorize"));

    // Malformed codes never reach the CLI.
    for bad in ["", "two words", "line\nbreak"] {
        assert_eq!(
            app.core
                .submit_login_code(&login.id, bad)
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidInput
        );
    }
    let verifying = app
        .core
        .submit_login_code(&login.id, "good-code#state")
        .unwrap();
    assert_eq!(verifying.phase, LoginPhase::Verifying);
    wait_until("sign-in success", || {
        app.core.login_progress(&login.id).unwrap().phase == LoginPhase::Succeeded
    });
    wait_until("account authenticated", || {
        app.core.list_accounts().unwrap()[0].auth_status == AuthStatus::Authenticated
    });
    let emitted = app.bridge.events.lock().unwrap().iter().any(|e| {
        matches!(e, CoreEvent::LoginProgress(p) if p.session_id == login.id && p.phase == LoginPhase::Succeeded)
    });
    assert!(emitted);
    app.core.close_session(&login.id).unwrap();
    assert!(
        app.core.login_progress(&login.id).is_err(),
        "state is dropped with the session"
    );
}

#[test]
fn rejected_code_is_explained_and_recorded() {
    use claude_switch_lib::login::LoginPhase;
    let app = TestApp::new();
    let a = app.account("A");
    let login = start_code_login(&app, &a);
    wait_until("code prompt", || {
        app.core
            .login_progress(&login.id)
            .is_ok_and(|p| p.awaiting_code)
    });
    app.core.submit_login_code(&login.id, "wrong#code").unwrap();
    wait_until("failure", || {
        app.core.list_accounts().unwrap()[0].auth_status == AuthStatus::Failed
    });
    let progress = app.core.login_progress(&login.id).unwrap();
    assert_eq!(progress.phase, LoginPhase::Failed);
    let detail = app.core.list_accounts().unwrap()[0]
        .auth_detail
        .clone()
        .unwrap();
    assert!(detail.contains("didn't accept that code"), "{detail}");
    assert_eq!(progress.message.as_deref(), Some(detail.as_str()));
    // A finished sign-in no longer accepts input.
    assert_eq!(
        app.core
            .submit_login_code(&login.id, "good-code#state")
            .unwrap_err()
            .kind(),
        ErrorKind::Conflict
    );
    app.core.close_session(&login.id).unwrap();
}

#[test]
fn incomplete_code_can_be_pasted_again() {
    use claude_switch_lib::login::LoginPhase;
    let app = TestApp::new();
    let a = app.account("A");
    let login = start_code_login(&app, &a);
    wait_until("code prompt", || {
        app.core
            .login_progress(&login.id)
            .is_ok_and(|p| p.awaiting_code)
    });
    let verifying = app.core.submit_login_code(&login.id, "good-code").unwrap();
    assert_eq!(verifying.phase, LoginPhase::Verifying);
    wait_until("code asked for again", || {
        app.core
            .login_progress(&login.id)
            .is_ok_and(|p| p.phase == LoginPhase::Waiting && p.message.is_some())
    });
    let progress = app.core.login_progress(&login.id).unwrap();
    assert!(progress.awaiting_code);
    assert!(progress.message.unwrap().contains("incomplete"));

    app.core
        .submit_login_code(&login.id, "good-code#state")
        .unwrap();
    wait_until("sign-in success", || {
        app.core.login_progress(&login.id).unwrap().phase == LoginPhase::Succeeded
    });
    wait_until("account authenticated", || {
        app.core.list_accounts().unwrap()[0].auth_status == AuthStatus::Authenticated
    });
    app.core.close_session(&login.id).unwrap();
}

#[test]
fn codes_can_only_be_sent_to_sign_in_sessions() {
    let app = TestApp::new();
    let a = app.account("A");
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    assert_eq!(
        app.core
            .submit_login_code(&s.id, "anything")
            .unwrap_err()
            .kind(),
        ErrorKind::NotFound
    );
    app.core.close_session(&s.id).unwrap();
}
