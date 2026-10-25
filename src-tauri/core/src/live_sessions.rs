//! Claude Code processes that are running with a profile, found through
//! Claude Code's own session registry.
//!
//! While it runs, every interactive Claude Code process keeps
//! `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` with its process ID, the time it
//! started, its conversation and its working folder (the Claude Code VS Code
//! extension reads the same list). That includes processes started outside
//! Claude Switch, such as Claude tabs in VS Code. The layout is not a
//! documented API, so this is best effort: a missing or unreadable registry
//! reports nothing.
//!
//! Only `pid`, `startedAt`, `sessionId` and `cwd` are read from the `.json`
//! files. Other files in that folder are never opened.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use uuid::Uuid;

const SESSIONS: &str = "sessions";
const MAX_ENTRIES: usize = 512;
const MAX_FILE: u64 = 64 * 1024;
/// How much later than its registration a process may appear to have started.
const START_SLACK_SECS: u64 = 5;
/// `SZOMB` in `<sys/proc.h>`: exited, not yet reaped.
const ZOMBIE: u32 = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    pid: i64,
    /// Milliseconds since the epoch.
    #[serde(default)]
    started_at: Option<f64>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

/// A conversation a running Claude Code process has open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenConversation {
    pub session_id: Uuid,
    /// The folder Claude Code runs in, which names the conversation's folder.
    pub cwd: PathBuf,
}

/// Registry entries of `config_dir` whose process is still running, with
/// what the process reports about itself.
fn running(config_dir: &Path) -> Vec<(u32, Entry, libc::proc_bsdinfo)> {
    let dir = config_dir.join(SESSIONS);
    if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(MAX_ENTRIES)
        .filter_map(|entry| {
            let name = entry.file_name();
            let pid: u32 = name.to_str()?.strip_suffix(".json")?.parse().ok()?;
            let meta = entry.path().symlink_metadata().ok()?;
            if !meta.is_file() || meta.len() > MAX_FILE {
                return None;
            }
            let text = fs::read_to_string(entry.path()).ok()?;
            let recorded: Entry = serde_json::from_str(&text).ok()?;
            if recorded.pid != i64::from(pid) {
                return None;
            }
            let registered = recorded
                .started_at
                .filter(|ms| ms.is_finite() && *ms > 0.0)
                .map(|ms| (ms / 1000.0) as u64);
            let info = live_process(pid, registered)?;
            Some((pid, recorded, info))
        })
        .collect()
}

/// Process IDs of Claude Code processes that use `config_dir` and are still
/// running, in ascending order.
pub fn running_in(config_dir: &Path) -> Vec<u32> {
    let mut pids: Vec<u32> = running(config_dir)
        .into_iter()
        .map(|(pid, _, _)| pid)
        .collect();
    pids.sort_unstable();
    pids
}

/// Conversations open in Claude Code processes that use `config_dir` and
/// were started by process `parent` (for example one VS Code window's
/// extension host), ordered by process ID.
pub fn opened_by(config_dir: &Path, parent: u32) -> Vec<OpenConversation> {
    let mut found: Vec<(u32, OpenConversation)> = running(config_dir)
        .into_iter()
        .filter(|(_, _, info)| info.pbi_ppid == parent)
        .filter_map(|(pid, entry, _)| {
            let session_id = Uuid::parse_str(entry.session_id.as_deref()?).ok()?;
            let cwd = PathBuf::from(entry.cwd?);
            cwd.is_absolute()
                .then_some((pid, OpenConversation { session_id, cwd }))
        })
        .collect();
    found.sort_unstable_by_key(|(pid, _)| *pid);
    found.into_iter().map(|(_, c)| c).collect()
}

/// True if `pid` is a live process of the current user.
pub fn is_alive(pid: u32) -> bool {
    live_process(pid, None).is_some()
}

/// What the kernel reports about `pid`, if it is a live process of the
/// current user that started no later than `registered` (seconds since the
/// epoch, when known), so a process ID reused by an unrelated, newer process
/// does not count.
fn live_process(pid: u32, registered: Option<u64>) -> Option<libc::proc_bsdinfo> {
    let raw = libc::pid_t::try_from(pid).ok()?;
    if raw <= 1 {
        return None;
    }
    // SAFETY: proc_bsdinfo is plain data, so all-zero is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is a live proc_bsdinfo of exactly `size` bytes.
    let filled = unsafe {
        libc::proc_pidinfo(
            raw,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if filled != size || info.pbi_status == ZOMBIE {
        return None;
    }
    // SAFETY: getuid has no preconditions.
    if info.pbi_uid != unsafe { libc::getuid() } {
        return None;
    }
    registered
        .is_none_or(|t| info.pbi_start_tvsec <= t + START_SLACK_SECS)
        .then_some(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    }

    fn register(dir: &Path, name: &str, body: &str) {
        let sessions = dir.join(SESSIONS);
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join(name), body).unwrap();
    }

    #[test]
    fn finds_a_live_process() {
        let tmp = tempfile::tempdir().unwrap();
        let me = std::process::id();
        register(
            tmp.path(),
            &format!("{me}.json"),
            &format!(
                r#"{{"pid": {me}, "startedAt": {}, "kind": "interactive"}}"#,
                now_ms()
            ),
        );
        // Not a registry entry.
        register(tmp.path(), &format!("{me}.abc.key"), "secret");
        assert_eq!(running_in(tmp.path()), vec![me]);
    }

    #[test]
    fn finds_conversations_by_parent_process() {
        let tmp = tempfile::tempdir().unwrap();
        let me = std::process::id();
        let parent = std::os::unix::process::parent_id();
        let session = "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10";
        register(
            tmp.path(),
            &format!("{me}.json"),
            &format!(
                r#"{{"pid": {me}, "startedAt": {}, "sessionId": "{session}", "cwd": "/Users/someone/project", "status": "idle"}}"#,
                now_ms()
            ),
        );
        assert_eq!(
            opened_by(tmp.path(), parent),
            vec![OpenConversation {
                session_id: Uuid::parse_str(session).unwrap(),
                cwd: PathBuf::from("/Users/someone/project"),
            }]
        );
        assert!(opened_by(tmp.path(), me).is_empty());

        // Without a conversation, or with a relative folder, there is nothing
        // to hand over.
        register(
            tmp.path(),
            &format!("{me}.json"),
            &format!(r#"{{"pid": {me}, "sessionId": "{session}", "cwd": "project"}}"#),
        );
        assert!(opened_by(tmp.path(), parent).is_empty());
        register(
            tmp.path(),
            &format!("{me}.json"),
            &format!(r#"{{"pid": {me}, "cwd": "/Users/someone/project"}}"#),
        );
        assert!(opened_by(tmp.path(), parent).is_empty());
        assert_eq!(running_in(tmp.path()), vec![me]);
    }

    #[test]
    fn ignores_exited_and_reused_processes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let gone = child.id();
        child.wait().unwrap();
        register(
            tmp.path(),
            &format!("{gone}.json"),
            &format!(r#"{{"pid": {gone}, "startedAt": {}}}"#, now_ms()),
        );
        // This test process started long after the registration time, so its
        // ID counts as reused.
        let me = std::process::id();
        register(
            tmp.path(),
            &format!("{me}.json"),
            &format!(r#"{{"pid": {me}, "startedAt": 1000}}"#),
        );
        assert!(running_in(tmp.path()).is_empty());
    }

    #[test]
    fn ignores_malformed_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let me = std::process::id();
        register(tmp.path(), &format!("{me}.json"), "{ not json");
        register(tmp.path(), "1.json", r#"{"pid": 1}"#);
        register(tmp.path(), "abc.json", &format!(r#"{{"pid": {me}}}"#));
        // The file name and the recorded process ID disagree.
        register(tmp.path(), "999999.json", &format!(r#"{{"pid": {me}}}"#));
        assert!(running_in(tmp.path()).is_empty());
        assert!(running_in(&tmp.path().join("missing")).is_empty());
    }

    #[test]
    fn does_not_follow_a_symlinked_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("elsewhere");
        let me = std::process::id();
        register(&real, &format!("{me}.json"), &format!(r#"{{"pid": {me}}}"#));
        let profile = tmp.path().join("profile");
        fs::create_dir(&profile).unwrap();
        std::os::unix::fs::symlink(real.join(SESSIONS), profile.join(SESSIONS)).unwrap();
        assert!(running_in(&profile).is_empty());
        assert_eq!(running_in(&real), vec![me]);
    }
}
