//! "Open in VS Code" with a fake editor bundle: the launcher receives the
//! project folder and the account's `CLAUDE_CONFIG_DIR`, the editor-wide
//! account setting is only ever changed on request, and nothing else can be
//! launched.

mod support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use claude_switch_lib::domain::{
    ContinueConversationInput, OpenInEditorInput, SetEditorAccountInput,
};
use claude_switch_lib::editors::EditorAccountMode;
use claude_switch_lib::error::ErrorKind;
use support::*;

fn install_editor(root: &Path, log: &Path) -> PathBuf {
    let launcher = root.join("Visual Studio Code.app/Contents/Resources/app/bin/code");
    fs::create_dir_all(launcher.parent().unwrap()).unwrap();
    fs::write(
        &launcher,
        format!(
            "#!/bin/bash\n{{ echo \"ARGS=$*\"; echo \"DIR=$CLAUDE_CONFIG_DIR\"; echo \"PWD=$(pwd)\"; echo \"KEY=${{ANTHROPIC_API_KEY:-unset}}\"; }} > {}\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
    launcher
}

fn read_when_ready(log: &Path) -> String {
    wait_until("editor launcher to run", || {
        fs::read_to_string(log).is_ok_and(|s| s.contains("KEY="))
    });
    fs::read_to_string(log).unwrap()
}

#[test]
fn opens_a_project_with_the_selected_account() {
    let app = TestApp::new();
    let apps = app.root.join("Applications");
    let log = app.root.join("editor.log");
    install_editor(&apps, &log);
    app.core.set_editor_roots(vec![apps]);

    let info = app.core.system_info("test");
    assert_eq!(info.editors.len(), 1);
    assert_eq!(info.editors[0].id, "vscode");

    let a = app.account("Work");
    let p = app.core.add_project(&app.project_dir("site")).unwrap();
    app.core
        .open_in_editor(OpenInEditorInput {
            project_id: p.id.clone(),
            account_id: a.clone(),
            editor_id: "vscode".into(),
        })
        .unwrap();
    let out = read_when_ready(&log);
    assert!(
        out.contains(&format!("ARGS=--new-window {}", p.directory)),
        "{out}"
    );
    assert!(
        out.contains(&format!("DIR={}", app.profile_dir(&a).display())),
        "{out}"
    );
    assert!(out.contains(&format!("PWD={}", p.directory)), "{out}");
    assert!(
        out.contains("KEY=unset"),
        "API keys never reach the editor: {out}"
    );

    assert_eq!(
        app.core.settings().preferred_editor.as_deref(),
        Some("vscode")
    );
    let project = &app.core.list_projects().unwrap()[0];
    assert_eq!(project.default_account_id.as_deref(), Some(a.as_str()));
}

#[test]
fn rejects_unknown_editors_and_missing_folders() {
    let app = TestApp::new();
    let apps = app.root.join("Applications");
    let log = app.root.join("editor.log");
    install_editor(&apps, &log);
    app.core.set_editor_roots(vec![apps]);
    let a = app.account("Work");
    let dir = app.project_dir("gone");
    let p = app.core.add_project(&dir).unwrap();

    let err = app
        .core
        .open_in_editor(OpenInEditorInput {
            project_id: p.id.clone(),
            account_id: a.clone(),
            editor_id: "/bin/sh".into(),
        })
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::NotFound);

    fs::remove_dir(&dir).unwrap();
    let err = app
        .core
        .open_in_editor(OpenInEditorInput {
            project_id: p.id,
            account_id: a,
            editor_id: "vscode".into(),
        })
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::ProjectDirMissing);
    assert!(!log.exists(), "nothing was launched");
}

#[test]
fn no_editor_installed_means_none_listed() {
    let app = TestApp::new();
    app.core
        .set_editor_roots(vec![app.root.join("nothing-here")]);
    assert!(app.core.system_info("test").editors.is_empty());
}

fn settings_file(app: &TestApp) -> PathBuf {
    let user = app.paths.home.join("Library/Application Support/Code/User");
    fs::create_dir_all(&user).unwrap();
    user.join("settings.json")
}

fn config_dir_setting(app: &TestApp) -> Option<String> {
    claude_switch_lib::editor_settings::read_config_dir(
        &fs::read_to_string(settings_file(app)).unwrap_or_default(),
    )
    .unwrap()
}

const SETTINGS: &str = "{\n  // my font\n  \"editor.fontSize\": 14\n}\n";
const CONVERSATION: &str = "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10";

#[test]
fn continues_a_conversation_in_the_editor_with_another_account() {
    let app = TestApp::new();
    let apps = app.root.join("Applications");
    let log = app.root.join("editor.log");
    install_editor(&apps, &log);
    app.core.set_editor_roots(vec![apps.clone()]);
    fs::write(settings_file(&app), SETTINGS).unwrap();

    let a = app.signed_in_account("Work");
    let b = app.signed_in_account("Personal");
    let dir = app.project_dir("site");
    let p = app.core.add_project(&dir).unwrap();
    write_transcript(&app.profile_dir(&a), &dir, CONVERSATION, "{}\n");

    let result = app
        .core
        .continue_conversation(ContinueConversationInput {
            project_id: p.id.clone(),
            session_id: CONVERSATION.into(),
            from_account_id: Some(a.clone()),
            to_account_id: b.clone(),
            editor_id: Some("vscode".into()),
            message: Some("Continue where you left off.".into()),
            cols: 100,
            rows: 30,
        })
        .unwrap();
    assert!(result.session.is_none());
    assert!(result.copied);

    // The extension now uses B in every window; the user's settings stay.
    let b_dir = app.profile_dir(&b).display().to_string();
    assert_eq!(config_dir_setting(&app).as_deref(), Some(b_dir.as_str()));
    let text = fs::read_to_string(settings_file(&app)).unwrap();
    assert!(text.contains("// my font") && text.contains("\"editor.fontSize\": 14"));
    let backups = app.paths.editor_backups_dir();
    let saved: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
    assert_eq!(saved.len(), 1);
    assert_eq!(fs::read_to_string(saved[0].path()).unwrap(), SETTINGS);

    // The folder is focused (not a new window), with B's environment, then
    // the extension's link opens the conversation with the message filled in.
    let out = read_when_ready(&log);
    assert!(out.contains(&format!("ARGS={}\n", p.directory)), "{out}");
    assert!(out.contains(&format!("DIR={b_dir}")), "{out}");
    let opened = fs::read_to_string(&app.opened).unwrap();
    assert_eq!(
        opened.trim(),
        format!(
            "-a {} vscode://anthropic.claude-code/open?session={CONVERSATION}&prompt=Continue%20where%20you%20left%20off.",
            apps.join("Visual Studio Code.app").display()
        )
    );

    let editor = &app.core.system_info("test").editors[0];
    assert_eq!(editor.claude_account.mode, EditorAccountMode::Account);
    assert_eq!(
        editor.claude_account.account_id.as_deref(),
        Some(b.as_str())
    );
}

#[test]
fn open_in_editor_keeps_an_editor_wide_account_in_step() {
    let app = TestApp::new();
    let apps = app.root.join("Applications");
    let log = app.root.join("editor.log");
    install_editor(&apps, &log);
    app.core.set_editor_roots(vec![apps]);
    let a = app.account("Work");
    let b = app.account("Personal");
    let p = app.core.add_project(&app.project_dir("site")).unwrap();
    let open = |account: &str| {
        app.core.open_in_editor(OpenInEditorInput {
            project_id: p.id.clone(),
            account_id: account.into(),
            editor_id: "vscode".into(),
        })
    };

    // Not set: per-window environment only, settings untouched.
    assert!(!open(&a).unwrap().editor_account_changed);
    assert!(!settings_file(&app).exists());

    // Set by Claude Switch to B: opening with A switches it, so the
    // setting never silently overrides the chosen account.
    app.core
        .set_editor_account(SetEditorAccountInput {
            editor_id: "vscode".into(),
            account_id: Some(b.clone()),
        })
        .unwrap();
    assert!(open(&a).unwrap().editor_account_changed);
    let a_dir = app.profile_dir(&a).display().to_string();
    assert_eq!(config_dir_setting(&app).as_deref(), Some(a_dir.as_str()));
    assert!(!open(&a).unwrap().editor_account_changed);

    // Back to per window.
    app.core
        .set_editor_account(SetEditorAccountInput {
            editor_id: "vscode".into(),
            account_id: None,
        })
        .unwrap();
    assert_eq!(config_dir_setting(&app), None);
    assert_eq!(
        app.core.system_info("test").editors[0].claude_account.mode,
        EditorAccountMode::Window
    );
}

#[test]
fn a_folder_set_by_the_user_is_never_overridden_silently() {
    let app = TestApp::new();
    let apps = app.root.join("Applications");
    let log = app.root.join("editor.log");
    install_editor(&apps, &log);
    app.core.set_editor_roots(vec![apps]);
    let custom = r#"{
  "claudeCode.environmentVariables": [
    { "name": "CLAUDE_CONFIG_DIR", "value": "/Users/me/.claude-work" }
  ]
}"#;
    fs::write(settings_file(&app), custom).unwrap();
    let a = app.account("Work");
    let p = app.core.add_project(&app.project_dir("site")).unwrap();

    let editor = &app.core.system_info("test").editors[0];
    assert_eq!(editor.claude_account.mode, EditorAccountMode::Custom);
    assert_eq!(
        editor.claude_account.detail.as_deref(),
        Some("/Users/me/.claude-work")
    );
    let err = app
        .core
        .open_in_editor(OpenInEditorInput {
            project_id: p.id,
            account_id: a,
            editor_id: "vscode".into(),
        })
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::Conflict);
    assert_eq!(fs::read_to_string(settings_file(&app)).unwrap(), custom);
    assert!(!log.exists(), "nothing was launched");

    // Unreadable settings are reported and never rewritten.
    fs::write(settings_file(&app), "{ broken").unwrap();
    let editor = &app.core.system_info("test").editors[0];
    assert_eq!(editor.claude_account.mode, EditorAccountMode::Unreadable);
    let err = app
        .core
        .set_editor_account(SetEditorAccountInput {
            editor_id: "vscode".into(),
            account_id: Some(app.account("Other")),
        })
        .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidInput);
    assert_eq!(fs::read_to_string(settings_file(&app)).unwrap(), "{ broken");
}

#[test]
fn installs_the_claude_switch_extension_with_the_editors_own_cli() {
    let app = TestApp::new();
    let apps = app.root.join("Applications");
    let launcher = apps.join("Visual Studio Code.app/Contents/Resources/app/bin/code");
    fs::create_dir_all(launcher.parent().unwrap()).unwrap();
    let log = app.root.join("install.log");
    // Like `code --install-extension`: records the call and installs.
    fs::write(
        &launcher,
        format!(
            "#!/bin/bash\necho \"ARGS=$*\" > '{}'\nmkdir -p \"$HOME/.vscode/extensions/claude-switch.claude-switch-vscode-0.1.0\"\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
    app.core.set_editor_roots(vec![apps]);

    let info = app.core.system_info("test");
    assert!(!info.extension_package_available);
    assert_eq!(info.editors[0].extension_version, None);
    let err = app.core.install_editor_extension("vscode").unwrap_err();
    assert_eq!(err.kind(), ErrorKind::NotFound);
    assert!(!log.exists());

    let package = app.root.join("claude-switch-vscode.vsix");
    fs::write(&package, "vsix").unwrap();
    app.core.set_extension_package(Some(package.clone()));
    assert!(app.core.system_info("test").extension_package_available);

    let editor = app.core.install_editor_extension("vscode").unwrap();
    assert_eq!(editor.extension_version.as_deref(), Some("0.1.0"));
    assert_eq!(
        fs::read_to_string(&log).unwrap().trim(),
        format!("ARGS=--install-extension {} --force", package.display())
    );
    assert_eq!(
        app.core
            .install_editor_extension("/bin/sh")
            .unwrap_err()
            .kind(),
        ErrorKind::NotFound
    );
}
