//! Smoke tests against the real, installed Claude Code CLI. Ignored by
//! default (CI has no Claude Code); run locally with:
//!
//!     cargo test --test real_cli -- --ignored --nocapture
//!
//! They use throwaway profiles and never sign in, so nothing reaches the API.

mod support;

use std::fs;
use std::sync::Arc;

use claude_switch_lib::core::AppCore;
use claude_switch_lib::db::Database;
use claude_switch_lib::domain::{
    AccountColor, AuthStatus, CreateAccountInput, SessionKind, StartSessionInput,
};
use claude_switch_lib::env;
use claude_switch_lib::paths::AppPaths;
use support::{process_alive, wait_until, Capture, RecordingBridge};

fn real_core() -> (tempfile::TempDir, Arc<AppCore>, AppPaths) {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let home = fs::canonicalize(std::env::var("HOME").unwrap()).unwrap();
    let paths = AppPaths::from_roots(home, root.join("data"), root.join("profiles"));
    paths.ensure().unwrap();
    let db = Database::open(&paths.db_path).unwrap();
    // The real inherited environment: anything auth-affecting (including
    // CLAUDECODE when run from inside Claude Code) must be dropped.
    let core = AppCore::new(
        paths.clone(),
        db,
        Arc::new(RecordingBridge::default()),
        env::inherited_env(),
        env::system_path_entries(),
    )
    .unwrap();
    (tmp, core, paths)
}

#[test]
#[ignore = "requires an installed Claude Code CLI"]
fn fresh_profile_is_isolated_from_existing_logins() {
    let (_tmp, core, _paths) = real_core();
    let status = core.refresh_cli();
    assert!(
        status.version.is_some(),
        "Claude Code not found: {:?}",
        status.message
    );
    println!("Claude Code {}", status.version.unwrap());

    let account = core
        .create_account(CreateAccountInput {
            name: "Smoke".into(),
            color: AccountColor::Teal,
            label: None,
            notes: None,
        })
        .unwrap();
    let checked = core.refresh_auth_status(&account.id).unwrap();
    println!(
        "fresh profile status: {:?} ({:?})",
        checked.auth_status, checked.auth_method
    );
    assert_eq!(
        checked.auth_status,
        AuthStatus::NotConfigured,
        "a brand-new profile must not inherit any existing login: {:?}",
        checked.auth_detail
    );
}

#[test]
#[ignore = "requires an installed Claude Code CLI"]
fn interactive_cli_runs_in_a_pty_and_stops_cleanly() {
    let (_tmp, core, paths) = real_core();
    let account = core
        .create_account(CreateAccountInput {
            name: "Smoke".into(),
            color: AccountColor::Teal,
            label: None,
            notes: None,
        })
        .unwrap();
    let session = core
        .start_session(StartSessionInput {
            account_id: account.id.clone(),
            project_id: None,
            kind: SessionKind::Claude,
            continue_last: None,
            cols: 100,
            rows: 30,
        })
        .unwrap();
    let out = Capture::attach(&core, &session.id);
    wait_until("Claude Code to draw its interface", || {
        out.0.lock().unwrap().len() > 200
    });
    let text = out.text();
    assert!(
        !text.contains("cannot be launched inside another Claude Code session"),
        "nested-session variables leaked into the child"
    );
    println!("received {} bytes of terminal output", text.len());

    // The CLI wrote its configuration into the account's own profile.
    let profile = paths.profiles_root.join(&account.id);
    let entries: Vec<_> = fs::read_dir(&profile)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    println!("profile contents: {entries:?}");
    assert!(
        !entries.is_empty(),
        "Claude Code did not use the profile directory"
    );

    let pid = session.process_id.unwrap() as i32;
    core.close_session(&session.id).unwrap();
    assert!(!process_alive(pid));
}

#[test]
#[ignore = "requires an installed Claude Code CLI"]
fn sign_in_screen_understands_the_real_login_output() {
    use claude_switch_lib::domain::{LoginMethod, StartLoginInput};
    use claude_switch_lib::login::LoginPhase;
    use claude_switch_lib::settings::SettingsPatch;
    use std::os::unix::fs::PermissionsExt;

    let (tmp, core, _paths) = real_core();
    // A fake `open` first on PATH, so Claude Code cannot launch a browser.
    let bin = fs::canonicalize(tmp.path()).unwrap().join("fake-bin");
    fs::create_dir_all(&bin).unwrap();
    let opener = bin.join("open");
    fs::write(&opener, "#!/bin/bash\nexit 0\n").unwrap();
    fs::set_permissions(&opener, fs::Permissions::from_mode(0o755)).unwrap();
    core.update_settings(SettingsPatch {
        extra_path_entries: Some(vec![bin.display().to_string()]),
        ..Default::default()
    })
    .unwrap();

    let account = core
        .create_account(CreateAccountInput {
            name: "Smoke".into(),
            color: AccountColor::Teal,
            label: None,
            notes: None,
        })
        .unwrap();
    let login = core
        .start_login(StartLoginInput {
            account_id: account.id.clone(),
            method: LoginMethod::Claudeai,
            email: None,
            cols: 100,
            rows: 30,
        })
        .unwrap();
    wait_until("the sign-in link and code prompt", || {
        core.login_progress(&login.id)
            .is_ok_and(|p| p.url.is_some() && p.awaiting_code)
    });
    let progress = core.login_progress(&login.id).unwrap();
    println!("sign-in host: {:?}", progress.url_host);
    assert_eq!(progress.phase, LoginPhase::Waiting);
    assert!(progress.url.unwrap().starts_with("https://"));

    // Without its #state part, Claude Code refuses the code and waits.
    core.submit_login_code(&login.id, "not-a-real-code")
        .unwrap();
    wait_until("the incomplete code to be reported", || {
        core.login_progress(&login.id)
            .is_ok_and(|p| p.phase == LoginPhase::Waiting && p.message.is_some())
    });

    core.submit_login_code(&login.id, "not-a-real-code#bogus")
        .unwrap();
    wait_until("the rejected code to be reported", || {
        core.login_progress(&login.id)
            .is_ok_and(|p| p.phase == LoginPhase::Failed)
    });
    let progress = core.login_progress(&login.id).unwrap();
    println!("failure message: {:?}", progress.message);
    assert!(progress.message.is_some());
    let _ = core.close_session(&login.id);
}

/// Runs the real CLI in `dir` with only a profile and the basics in its
/// environment. Unauthenticated, so Claude Code stops before contacting the
/// API.
fn run_unauthenticated(
    exe: &str,
    profile: &std::path::Path,
    dir: &std::path::Path,
    args: &[&str],
) -> String {
    let out = std::process::Command::new(exe)
        .args(args)
        .current_dir(dir)
        .env_clear()
        .env("HOME", std::env::var("HOME").unwrap())
        .env(
            "USER",
            std::env::var("USER").unwrap_or_else(|_| "user".into()),
        )
        .env("PATH", "/usr/bin:/bin")
        .env("CLAUDE_CONFIG_DIR", profile)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
#[ignore = "requires an installed Claude Code CLI"]
fn a_copied_conversation_is_found_by_resume_in_another_profile() {
    let (_tmp, core, paths) = real_core();
    let exe = core.refresh_cli().path.expect("Claude Code not found");
    let account = |name: &str| {
        core.create_account(CreateAccountInput {
            name: name.into(),
            color: AccountColor::Teal,
            label: None,
            notes: None,
        })
        .unwrap()
        .id
    };
    let (a, b) = (account("A"), account("B"));
    let (a_dir, b_dir) = (paths.profiles_root.join(&a), paths.profiles_root.join(&b));
    // Outside the app's folders, which can never be projects.
    let work = tempfile::tempdir().unwrap();
    let project = fs::canonicalize(work.path()).unwrap().join("project");
    fs::create_dir(&project).unwrap();
    let registered = core.add_project(&project).unwrap();

    // Claude Code records a conversation in A's profile even though the
    // request fails for lack of a login.
    let id = uuid::Uuid::new_v4();
    let id_str = id.hyphenated().to_string();
    let out = run_unauthenticated(
        &exe,
        &a_dir,
        &project,
        &["-p", "--session-id", &id_str, "hello"],
    );
    println!("first run: {}", out.trim());
    let folder = a_dir
        .join("projects")
        .join(claude_switch_lib::transcripts::folder_name(&project).unwrap());
    assert!(
        folder.join(format!("{id_str}.jsonl")).is_file(),
        "Claude Code's folder naming changed: {:?}",
        fs::read_dir(a_dir.join("projects"))
            .map(|d| d.flatten().map(|e| e.file_name()).collect::<Vec<_>>())
    );
    let listed = core.list_conversations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].project_id, registered.id);
    assert_eq!(listed[0].account_id.as_deref(), Some(a.as_str()));

    // B cannot resume it until the conversation is copied over.
    let resume = ["-p", "--resume", id_str.as_str(), "continue"];
    let before = run_unauthenticated(&exe, &b_dir, &project, &resume);
    println!("B before copy: {}", before.trim());
    assert!(before.contains("No conversation found"), "{before}");

    claude_switch_lib::transcripts::copy(&a_dir, &b_dir, &project, &id).unwrap();
    let after = run_unauthenticated(&exe, &b_dir, &project, &resume);
    println!("B after copy: {}", after.trim());
    assert!(
        !after.contains("No conversation found"),
        "B should find the copied conversation: {after}"
    );
}
