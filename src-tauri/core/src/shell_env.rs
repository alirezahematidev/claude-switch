//! The user's login-shell environment, used to launch editors.
//!
//! A VS Code–family editor gives a new window the environment of the
//! launcher (`code …`) that opened it, on top of the environment it resolved
//! from the user's shell; when the launcher starts the editor, that is all
//! the editor gets. Claude Switch's own environment is deliberately minimal
//! (a GUI app starts with launchd's), so launching an editor with it would
//! leave that window's extensions, including Claude Code's, without the
//! user's `PATH` and tool variables.
//!
//! Like the editors themselves, Claude Switch asks the user's login shell for
//! its environment once (`<shell> -i -l -c <fixed command>`, no input, with a
//! time limit) and launches editors with that, minus every variable that
//! changes which account or provider Claude Code uses. Values are never
//! logged.

use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::env::classify_auth_affecting;

/// Set while the shell runs, so start-up files can skip slow work.
pub const RESOLVING_VAR: &str = "CLAUDE_SWITCH_RESOLVING_ENVIRONMENT";
/// Surrounds the environment in the shell's output, which start-up files may
/// also write to.
const MARK: &str = "__CLAUDE_SWITCH_ENV_3d1f9c__";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

/// Variables that describe the resolving shell itself, not the user's setup.
const SHELL_SESSION: &[&str] = &[
    "_",
    "PWD",
    "OLDPWD",
    "SHLVL",
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "COLORTERM",
    "LINES",
    "COLUMNS",
    RESOLVING_VAR,
];

/// Runs `shell -i -l -c` with `base` as its environment and returns the
/// environment it ends up with, filtered by [`keep`]. `None` if the shell
/// cannot be started, takes longer than ten seconds, or prints no
/// environment.
pub fn resolve(
    shell: &Path,
    base: &BTreeMap<String, String>,
    cwd: &Path,
) -> Option<BTreeMap<String, String>> {
    let script = format!(
        "command printf '%s' '{MARK}'; command /usr/bin/env -0; command printf '%s' '{MARK}'"
    );
    let mut child = Command::new(shell)
        .args(["-i", "-l", "-c", &script])
        .env_clear()
        .envs(base)
        .env(RESOLVING_VAR, "1")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // Stop at the closing marker: a background job started by a
        // start-up file may keep the pipe open long after.
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n @ 1..) = stdout.read(&mut buf) {
            out.extend_from_slice(&buf[..n]);
            if out.len() as u64 > MAX_OUTPUT || parse(&out).is_some() {
                break;
            }
        }
        let _ = tx.send(out);
    });

    let output = rx.recv_timeout(TIMEOUT).ok();
    // Give the shell a moment to exit, then stop whatever is left of it.
    let grace = Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < grace => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
                    // SAFETY: the child is not reaped yet and leads its own
                    // process group (process_group(0)).
                    unsafe { libc::killpg(pgid, libc::SIGKILL) };
                }
                let _ = child.wait();
                break;
            }
        }
    }
    let vars = parse(&output?)?;
    Some(vars.into_iter().filter(|(name, _)| keep(name)).collect())
}

/// The `NAME=value` pairs between the markers of the shell's output.
fn parse(out: &[u8]) -> Option<Vec<(String, String)>> {
    let mark = MARK.as_bytes();
    let start = find(out, mark)? + mark.len();
    let len = find(&out[start..], mark)?;
    let vars = out[start..start + len]
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let entry = std::str::from_utf8(entry).ok()?;
            let (name, value) = entry.split_once('=')?;
            (!name.is_empty() && !name.contains('\n'))
                .then(|| (name.to_string(), value.to_string()))
        })
        .collect::<Vec<_>>();
    (!vars.is_empty()).then_some(vars)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// False for variables that must not reach an editor launched for an
/// account: anything that changes Claude Code's account, provider or
/// configuration folder (Claude Switch sets `CLAUDE_CONFIG_DIR` itself),
/// the editor's own launcher variables, and the resolving shell's state.
pub fn keep(name: &str) -> bool {
    classify_auth_affecting(name).is_none()
        && !SHELL_SESSION.contains(&name)
        && !name.starts_with("VSCODE_")
        && !name.starts_with("ELECTRON_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn parses_between_markers_only() {
        let out = format!("Welcome!\n{MARK}A=1\0PATH=/x:/y\0EQ=a=b\0BROKEN\0{MARK}bye");
        let vars = parse(out.as_bytes()).unwrap();
        assert_eq!(
            vars,
            vec![
                ("A".to_string(), "1".to_string()),
                ("PATH".to_string(), "/x:/y".to_string()),
                ("EQ".to_string(), "a=b".to_string()),
            ]
        );
        assert!(parse(b"no markers here").is_none());
        assert!(parse(format!("{MARK}{MARK}").as_bytes()).is_none());
    }

    #[test]
    fn drops_account_and_session_variables() {
        for name in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
            "CLAUDECODE",
            "VSCODE_IPC_HOOK_CLI",
            "ELECTRON_RUN_AS_NODE",
            "SHLVL",
            "PWD",
            RESOLVING_VAR,
        ] {
            assert!(!keep(name), "{name} should be dropped");
        }
        for name in [
            "PATH",
            "NVM_DIR",
            "JAVA_HOME",
            "GOPATH",
            "LANG",
            "SSH_AUTH_SOCK",
        ] {
            assert!(keep(name), "{name} should be kept");
        }
    }

    #[test]
    fn resolves_through_a_login_shell() {
        let tmp = tempfile::tempdir().unwrap();
        // Stands in for zsh: start-up output, exports, then the command.
        let shell = tmp.path().join("shell");
        fs::write(
            &shell,
            "#!/bin/bash\necho 'motd'\nexport FROM_PROFILE=yes ANTHROPIC_API_KEY=leak PATH=/custom/bin:$PATH\n[ \"$1$2$3\" = '-i-l-c' ] || exit 3\nexec /bin/bash -c \"$4\"\n",
        )
        .unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
        let base = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("HOME".to_string(), tmp.path().display().to_string()),
        ]);
        let env = resolve(&shell, &base, tmp.path()).unwrap();
        assert_eq!(env.get("FROM_PROFILE").map(String::as_str), Some("yes"));
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/custom/bin:/usr/bin:/bin")
        );
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.contains_key(RESOLVING_VAR));
    }

    #[test]
    fn gives_up_on_a_shell_that_fails_or_prints_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let base = BTreeMap::new();
        assert!(resolve(&tmp.path().join("missing"), &base, tmp.path()).is_none());
        let quiet = tmp.path().join("quiet");
        fs::write(&quiet, "#!/bin/bash\nexit 0\n").unwrap();
        fs::set_permissions(&quiet, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(resolve(&quiet, &base, tmp.path()).is_none());
    }
}
