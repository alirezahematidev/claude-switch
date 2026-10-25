//! Claude Code processes that are running with a profile, found through
//! Claude Code's own session registry.
//!
//! While it runs, every interactive Claude Code process keeps
//! `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` with its process ID and the time
//! it started (the Claude Code VS Code extension reads the same list). That
//! includes processes started outside Claude Switch, such as Claude tabs in
//! VS Code. The layout is not a documented API, so this is best effort: a
//! missing or unreadable registry reports nothing.
//!
//! Only `pid` and `startedAt` are read from the `.json` files. Other files in
//! that folder are never opened.

use std::fs;
use std::path::Path;

use serde::Deserialize;

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
}

/// Process IDs of Claude Code processes that use `config_dir` and are still
/// running, in ascending order.
pub fn running_in(config_dir: &Path) -> Vec<u32> {
    let dir = config_dir.join(SESSIONS);
    if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut pids: Vec<u32> = entries
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
            is_running(pid, registered).then_some(pid)
        })
        .collect();
    pids.sort_unstable();
    pids
}

/// True if `pid` is a live process of the current user that started no later
/// than `registered` (seconds since the epoch, when known), so a process ID
/// reused by an unrelated, newer process does not count.
fn is_running(pid: u32, registered: Option<u64>) -> bool {
    let Ok(raw) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if raw <= 1 {
        return false;
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
        return false;
    }
    // SAFETY: getuid has no preconditions.
    if info.pbi_uid != unsafe { libc::getuid() } {
        return false;
    }
    registered.is_none_or(|t| info.pbi_start_tvsec <= t + START_SLACK_SECS)
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
