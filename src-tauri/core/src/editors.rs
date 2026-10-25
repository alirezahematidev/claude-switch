//! Opening a project in a VS Code–family editor with an account's profile.
//!
//! The editor's own command-line launcher is started with the account's
//! environment (including `CLAUDE_CONFIG_DIR`). New editor windows inherit
//! that environment, so the Claude Code extension and `claude` in the
//! editor's terminal use the selected account.
//!
//! Only launchers inside known application bundles are used, so the UI can
//! never choose an arbitrary program.
//!
//! An editor's Claude Code extension can also be pointed at one account for
//! all of its windows through the editor's user settings; see
//! [`crate::editor_settings`].

use std::path::{Path, PathBuf};

use serde::Serialize;
use ts_rs::TS;

struct EditorDef {
    id: &'static str,
    name: &'static str,
    bundle: &'static str,
    launcher: &'static str,
    /// Folder in `~/Library/Application Support` holding `User/settings.json`.
    support_dir: &'static str,
    /// URL scheme the editor registers (`<scheme>://<extension-id>/…`).
    url_scheme: &'static str,
    /// Installed extensions, relative to the home folder.
    extensions_dir: &'static str,
}

const EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "vscode",
        name: "VS Code",
        bundle: "Visual Studio Code.app",
        launcher: "Contents/Resources/app/bin/code",
        support_dir: "Code",
        url_scheme: "vscode",
        extensions_dir: ".vscode/extensions",
    },
    EditorDef {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        bundle: "Visual Studio Code - Insiders.app",
        launcher: "Contents/Resources/app/bin/code-insiders",
        support_dir: "Code - Insiders",
        url_scheme: "vscode-insiders",
        extensions_dir: ".vscode-insiders/extensions",
    },
    EditorDef {
        id: "cursor",
        name: "Cursor",
        bundle: "Cursor.app",
        launcher: "Contents/Resources/app/bin/cursor",
        support_dir: "Cursor",
        url_scheme: "cursor",
        extensions_dir: ".cursor/extensions",
    },
    EditorDef {
        id: "windsurf",
        name: "Windsurf",
        bundle: "Windsurf.app",
        launcher: "Contents/Resources/app/bin/windsurf",
        support_dir: "Windsurf",
        url_scheme: "windsurf",
        extensions_dir: ".windsurf/extensions",
    },
];

/// Which account the editor's Claude Code extension uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EditorAccountMode {
    /// Not set in the editor's settings: each window uses the environment it
    /// was opened with.
    Window,
    /// Set by Claude Switch to one account for every window.
    Account,
    /// Set in the editor's settings to a folder that is not an account
    /// profile.
    Custom,
    /// The editor's settings could not be read.
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorAccount {
    pub mode: EditorAccountMode,
    pub account_id: Option<String>,
    /// The configured folder (`custom`) or the problem (`unreadable`).
    pub detail: Option<String>,
}

impl EditorAccount {
    pub fn window() -> Self {
        Self {
            mode: EditorAccountMode::Window,
            account_id: None,
            detail: None,
        }
    }
}

/// The Claude Switch extension's ID in editor marketplaces and folders.
pub const EXTENSION_ID: &str = "alirezahemmati.claude-switch-vscode";

/// IDs the extension had before it was published under its own publisher.
/// Installing the current one removes these, which register the same
/// commands.
pub const LEGACY_EXTENSION_IDS: &[&str] = &["claude-switch.claude-switch-vscode"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    pub claude_account: EditorAccount,
    /// Installed version of the Claude Switch extension, if any.
    pub extension_version: Option<String>,
    #[serde(skip)]
    #[ts(skip)]
    pub launcher: PathBuf,
    /// The application bundle.
    #[serde(skip)]
    #[ts(skip)]
    pub app: PathBuf,
    #[serde(skip)]
    #[ts(skip)]
    pub settings_file: PathBuf,
    #[serde(skip)]
    #[ts(skip)]
    pub url_scheme: &'static str,
    #[serde(skip)]
    #[ts(skip)]
    pub extensions_dir: PathBuf,
}

/// Default application folders, the user's own first.
pub fn default_roots(home: &Path) -> Vec<PathBuf> {
    vec![home.join("Applications"), PathBuf::from("/Applications")]
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Installed editors in display order. The first root containing an editor
/// wins. `claude_account` is left at its default for the caller to fill in.
pub fn detect(roots: &[PathBuf], home: &Path) -> Vec<EditorInfo> {
    EDITORS
        .iter()
        .filter_map(|def| {
            let app = roots
                .iter()
                .map(|root| root.join(def.bundle))
                .find(|app| is_executable(&app.join(def.launcher)))?;
            let extensions_dir = home.join(def.extensions_dir);
            Some(EditorInfo {
                id: def.id.to_string(),
                name: def.name.to_string(),
                claude_account: EditorAccount::window(),
                extension_version: installed_extension(&extensions_dir),
                extensions_dir,
                launcher: app.join(def.launcher),
                settings_file: home
                    .join("Library/Application Support")
                    .join(def.support_dir)
                    .join("User/settings.json"),
                url_scheme: def.url_scheme,
                app,
            })
        })
        .collect()
}

/// The installed version of the Claude Switch extension in an editor's
/// extensions folder.
pub fn installed_extension(dir: &Path) -> Option<String> {
    installed_version(dir, EXTENSION_ID)
}

/// Earlier IDs of the extension still installed in an editor's extensions
/// folder.
pub fn installed_legacy(dir: &Path) -> Vec<&'static str> {
    LEGACY_EXTENSION_IDS
        .iter()
        .copied()
        .filter(|id| installed_version(dir, id).is_some())
        .collect()
}

/// The installed version of extension `id` in an extensions folder: from
/// `extensions.json` (the editor's own list) when it exists, otherwise from
/// the folder names.
fn installed_version(dir: &Path, extension: &str) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(dir.join("extensions.json")) {
        let list: serde_json::Value = serde_json::from_str(&text).ok()?;
        return list.as_array()?.iter().find_map(|e| {
            let id = e.get("identifier")?.get("id")?.as_str()?;
            if !id.eq_ignore_ascii_case(extension) {
                return None;
            }
            e.get("version")?.as_str().map(str::to_string)
        });
    }
    let prefix = format!("{extension}-");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let rest = name.strip_prefix(&prefix)?;
            // Platform-specific builds append `-darwin-arm64` and similar.
            Some(rest.split('-').next()?.to_string())
        })
        .max_by_key(|v| {
            v.split('.')
                .map(|p| p.parse::<u32>().unwrap_or(0))
                .collect::<Vec<_>>()
        })
}

/// `<scheme>://anthropic.claude-code/open?session=<id>&prompt=<text>`: the
/// Claude Code extension's documented link for resuming a conversation of the
/// focused window's workspace in a tab, with `prompt` placed in the message
/// box (not sent).
pub fn claude_open_url(scheme: &str, session_id: &str, prompt: Option<&str>) -> String {
    let mut url = format!("{scheme}://anthropic.claude-code/open?session={session_id}");
    if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
        url.push_str("&prompt=");
        url.push_str(&percent_encode(prompt));
    }
    url
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn install(root: &Path, bundle: &str, launcher: &str) -> PathBuf {
        let path = root.join(bundle).join(launcher);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "#!/bin/bash\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn detects_known_editors_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        install(&root, "Cursor.app", "Contents/Resources/app/bin/cursor");
        install(
            &root,
            "Visual Studio Code.app",
            "Contents/Resources/app/bin/code",
        );
        let found = detect(std::slice::from_ref(&root), Path::new("/Users/me"));
        let ids: Vec<&str> = found.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["vscode", "cursor"]);
        assert_eq!(found[0].app, root.join("Visual Studio Code.app"));
        assert_eq!(
            found[0].settings_file,
            Path::new("/Users/me/Library/Application Support/Code/User/settings.json")
        );
        assert_eq!(found[1].url_scheme, "cursor");
    }

    #[test]
    fn earlier_roots_win_and_non_executables_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user");
        let system = tmp.path().join("system");
        let mine = install(
            &user,
            "Visual Studio Code.app",
            "Contents/Resources/app/bin/code",
        );
        install(
            &system,
            "Visual Studio Code.app",
            "Contents/Resources/app/bin/code",
        );
        let home = Path::new("/Users/me");
        let found = detect(&[user.clone(), system], home);
        assert_eq!(found[0].launcher, mine);

        let plain = user.join("Cursor.app/Contents/Resources/app/bin/cursor");
        fs::create_dir_all(plain.parent().unwrap()).unwrap();
        fs::write(&plain, "not executable").unwrap();
        assert!(detect(&[user], home).iter().all(|e| e.id != "cursor"));
    }

    #[test]
    fn paths_are_not_serialized() {
        let info = EditorInfo {
            id: "vscode".into(),
            name: "VS Code".into(),
            claude_account: EditorAccount::window(),
            launcher: PathBuf::from("/Applications/x"),
            app: PathBuf::from("/Applications"),
            settings_file: PathBuf::from("/Users/me/settings.json"),
            url_scheme: "vscode",
            extension_version: Some("0.1.0".into()),
            extensions_dir: PathBuf::from("/Users/me/.vscode/extensions"),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "vscode",
                "name": "VS Code",
                "claudeAccount": { "mode": "window", "accountId": null, "detail": null },
                "extensionVersion": "0.1.0",
            })
        );
    }

    #[test]
    fn finds_the_installed_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert_eq!(installed_extension(dir), None);
        fs::create_dir(dir.join("alirezahemmati.claude-switch-vscode-0.1.0")).unwrap();
        fs::create_dir(dir.join("alirezahemmati.claude-switch-vscode-0.10.2-darwin-arm64"))
            .unwrap();
        fs::create_dir(dir.join("anthropic.claude-code-2.1.310")).unwrap();
        assert_eq!(installed_extension(dir).as_deref(), Some("0.10.2"));
        assert!(installed_legacy(dir).is_empty());
        // The ID it had before its own publisher is a different extension.
        fs::create_dir(dir.join("claude-switch.claude-switch-vscode-0.1.0")).unwrap();
        assert_eq!(
            installed_legacy(dir),
            ["claude-switch.claude-switch-vscode"]
        );

        // The editor's own list wins when it exists.
        fs::write(
            dir.join("extensions.json"),
            r#"[{"identifier":{"id":"anthropic.claude-code"},"version":"2.1.310"},
                {"identifier":{"id":"AlirezaHemmati.claude-switch-vscode"},"version":"0.1.0"}]"#,
        )
        .unwrap();
        assert_eq!(installed_extension(dir).as_deref(), Some("0.1.0"));
        assert!(installed_legacy(dir).is_empty());
        fs::write(dir.join("extensions.json"), "[]").unwrap();
        assert_eq!(installed_extension(dir), None);
    }

    #[test]
    fn builds_the_extension_link() {
        let id = "7f4aab4c-e050-4682-8962-2346d802b722";
        assert_eq!(
            claude_open_url("vscode", id, None),
            format!("vscode://anthropic.claude-code/open?session={id}")
        );
        assert_eq!(
            claude_open_url("cursor", id, Some("Go on & finish: 100%?")),
            format!("cursor://anthropic.claude-code/open?session={id}&prompt=Go%20on%20%26%20finish%3A%20100%25%3F")
        );
        assert_eq!(
            claude_open_url("vscode", id, Some("é")),
            format!("vscode://anthropic.claude-code/open?session={id}&prompt=%C3%A9")
        );
    }
}
