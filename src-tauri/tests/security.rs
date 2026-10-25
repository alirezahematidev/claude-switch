//! Security-focused tests: input validation at the IPC boundary, path
//! handling, injection, and the capability model.

mod support;

use std::fs;
use std::os::unix::fs::symlink;

use claude_switch_lib::domain::*;
use claude_switch_lib::error::ErrorKind;
use claude_switch_lib::settings::{EnvVar, SettingsPatch};
use support::*;

#[test]
fn malformed_ids_are_rejected_everywhere() {
    let app = TestApp::new();
    let bad_ids = [
        "",
        "../../etc",
        "'; DROP TABLE accounts; --",
        "$(touch /tmp/pwned)",
        "00000000-0000-0000-0000-000000000000/..",
    ];
    for bad in bad_ids {
        assert_eq!(
            app.core.refresh_auth_status(bad).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            app.core.remove_project(bad).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            app.core.stop_session(bad).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            app.core.write_session(bad, "x", false).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            app.core
                .start_session(TestApp::claude_input(bad, None))
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidInput
        );
    }
}

#[test]
fn unknown_but_well_formed_ids_are_not_found() {
    let app = TestApp::new();
    let ghost = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    assert_eq!(
        app.core.refresh_auth_status(ghost).unwrap_err().kind(),
        ErrorKind::NotFound
    );
    assert_eq!(
        app.core.stop_session(ghost).unwrap_err().kind(),
        ErrorKind::NotFound
    );
    assert_eq!(
        app.core
            .start_session(TestApp::claude_input(ghost, None))
            .unwrap_err()
            .kind(),
        ErrorKind::NotFound
    );
    let a = app.account("A");
    assert_eq!(
        app.core
            .start_session(TestApp::claude_input(&a, Some(ghost)))
            .unwrap_err()
            .kind(),
        ErrorKind::NotFound
    );
}

#[test]
fn hostile_names_are_data_not_paths() {
    let app = TestApp::new();
    let name = "../../../tmp/evil; $(rm -rf ~) `id`";
    let a = app.account(name);
    let account = &app.core.list_accounts().unwrap()[0];
    assert_eq!(account.name, name);
    assert_eq!(
        account.config_dir,
        app.profile_dir(&a).display().to_string()
    );
    assert!(!app.root.join("tmp/evil").exists());
}

#[test]
fn managed_directories_cannot_be_projects() {
    let app = TestApp::new();
    let a = app.account("A");
    for dir in [
        app.paths.profiles_root.clone(),
        app.profile_dir(&a),
        app.paths.data_dir.clone(),
        app.paths.profiles_root.parent().unwrap().to_path_buf(),
    ] {
        let err = app.core.add_project(&dir).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied, "{}", dir.display());
    }
    assert_eq!(
        app.core
            .add_project(std::path::Path::new("/"))
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidInput
    );
}

#[test]
fn symlinked_project_is_stored_by_its_real_path() {
    let app = TestApp::new();
    let real = app.project_dir("real");
    let link = app.root.join("link-to-real");
    symlink(&real, &link).unwrap();
    let p = app.core.add_project(&link).unwrap();
    assert_eq!(p.directory, real.display().to_string());
    // Adding the same directory twice returns the existing project.
    assert_eq!(app.core.add_project(&real).unwrap().id, p.id);
}

#[test]
fn symlink_into_managed_dirs_is_rejected_as_project() {
    let app = TestApp::new();
    let link = app.root.join("sneaky");
    symlink(&app.paths.profiles_root, &link).unwrap();
    assert_eq!(
        app.core.add_project(&link).unwrap_err().kind(),
        ErrorKind::PermissionDenied
    );
}

#[test]
fn swapped_profile_symlink_blocks_launch() {
    let app = TestApp::new();
    let a = app.account("A");
    let b = app.account("B");
    // An attacker replaces A's profile with a link to B's.
    fs::remove_dir_all(app.profile_dir(&a)).unwrap();
    symlink(app.profile_dir(&b), app.profile_dir(&a)).unwrap();
    let err = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidConfigDir);
}

#[test]
fn custom_environment_cannot_redirect_authentication() {
    let app = TestApp::new();
    for name in [
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_VERTEX",
    ] {
        let err = app
            .core
            .update_settings(SettingsPatch {
                custom_env: Some(vec![EnvVar {
                    name: name.into(),
                    value: "x".into(),
                }]),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{name}");
    }
}

#[test]
fn one_account_never_receives_another_accounts_directory() {
    let app = TestApp::new();
    let ids: Vec<String> = (0..4).map(|i| app.account(&format!("acct-{i}"))).collect();
    let sessions: Vec<_> = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                app.core
                    .start_session(TestApp::claude_input(id, None))
                    .unwrap(),
            )
        })
        .collect();
    for (id, s) in &sessions {
        let out = Capture::attach(&app.core, &s.id);
        assert_eq!(
            out.value("CONFIG_DIR"),
            app.profile_dir(id).display().to_string()
        );
    }
    for (_, s) in sessions {
        app.core.close_session(&s.id).unwrap();
    }
}

#[test]
fn oversized_or_invalid_terminal_input_is_rejected() {
    let app = TestApp::new();
    let a = app.account("A");
    let s = app
        .core
        .start_session(TestApp::claude_input(&a, None))
        .unwrap();
    let huge = "x".repeat(2 * 1024 * 1024);
    assert_eq!(
        app.core
            .write_session(&s.id, &huge, false)
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidInput
    );
    assert_eq!(
        app.core
            .write_session(&s.id, "\u{4e2d}", true)
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidInput
    );
    assert_eq!(
        app.core.resize_session(&s.id, 0, 0).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );
    app.core.close_session(&s.id).unwrap();
}

#[test]
fn login_email_cannot_inject_flags() {
    let app = TestApp::new();
    let a = app.account("A");
    let err = app
        .core
        .start_login(StartLoginInput {
            account_id: a,
            method: LoginMethod::Claudeai,
            email: Some("--console".into()),
            cols: 80,
            rows: 24,
        })
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidInput);
}

#[test]
fn capability_file_grants_only_app_commands() {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/capabilities/main.json"
    ))
    .unwrap();
    let cap: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let perms: Vec<&str> = cap["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    for p in &perms {
        let allowed = p.starts_with("allow-")
            || matches!(
                *p,
                "core:event:allow-listen"
                    | "core:event:allow-unlisten"
                    | "core:window:allow-start-dragging"
                    | "core:window:allow-set-theme"
            );
        assert!(allowed, "unexpected permission {p}");
        for forbidden in [
            "shell", "fs:", "http:", "process", "execute", "spawn", "dialog:", "opener:",
        ] {
            assert!(!p.contains(forbidden), "capability grants {p}");
        }
    }
    // No command can run arbitrary programs or read arbitrary files.
    let build = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/build.rs")).unwrap();
    for forbidden in [
        "\"exec",
        "\"run_command",
        "\"spawn",
        "\"read_file",
        "\"write_file",
        "\"shell",
    ] {
        assert!(!build.contains(forbidden), "build.rs declares {forbidden}");
    }
}
