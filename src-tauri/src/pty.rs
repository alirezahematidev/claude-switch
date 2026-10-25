//! Native PTY process management.
//!
//! Each session owns one pseudo-terminal and one child process. The child is
//! started with `setsid`, so it leads its own process group; stopping a
//! session signals the whole group (SIGHUP, then SIGTERM, then SIGKILL) so
//! tools spawned by Claude Code do not outlive it.
//!
//! Output is kept in a bounded in-memory ring buffer so a terminal view can
//! re-attach (for example after a webview reload). It is never written to disk.
//!
//! This module has no Tauri dependency; it is exercised directly by tests.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{AppError, AppResult};

const RING_CAPACITY: usize = 512 * 1024;
const READ_CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub enum Program {
    /// An absolute executable path plus arguments, passed as argv entries.
    Executable { path: PathBuf, args: Vec<String> },
    /// The user's login shell (from `SHELL` in the child environment).
    LoginShell,
}

pub struct SpawnRequest {
    pub id: String,
    pub program: Program,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// Sees every output chunk, independently of the attached terminal view.
    pub tap: Option<OutputTap>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub error: Option<String>,
}

impl ExitInfo {
    pub fn success(&self) -> bool {
        self.code == Some(0) && self.signal.is_none() && self.error.is_none()
    }
}

/// Receives lifecycle callbacks. Called from background threads.
pub trait PtyObserver: Send + Sync + 'static {
    fn on_exit(&self, session_id: &str, exit: &ExitInfo);
}

/// Receives output bytes. Returning `false` detaches the sink.
pub type OutputSink = Box<dyn FnMut(&[u8]) -> bool + Send>;

/// Observes output in the reader thread (used to follow `claude auth login`).
pub type OutputTap = Box<dyn FnMut(&[u8]) + Send>;

struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::new(),
            cap,
        }
    }

    fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        self.buf.drain(..overflow);
        self.buf.extend(data);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}

struct Output {
    ring: Ring,
    sink: Option<OutputSink>,
}

struct Live {
    pid: u32,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<Output>,
    exit: Mutex<Option<ExitInfo>>,
    exit_cv: Condvar,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Live {
    fn push_output(&self, data: &[u8]) {
        let mut out = lock(&self.output);
        out.ring.push(data);
        if let Some(sink) = out.sink.as_mut() {
            if !sink(data) {
                out.sink = None;
            }
        }
    }

    fn exit_info(&self) -> Option<ExitInfo> {
        lock(&self.exit).clone()
    }

    /// Waits up to `timeout` for the child to exit.
    fn wait_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut guard = lock(&self.exit);
        while guard.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            guard = self
                .exit_cv
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        true
    }
}

/// Sends `sig` to the process group led by `pid`.
///
/// The group ID stays reserved while any member is alive, so signalling it
/// after the leader exits reaches only our own stragglers.
fn signal_group(pid: u32, sig: libc::c_int) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    if pid <= 1 {
        return;
    }
    // SAFETY: plain syscalls with validated arguments.
    unsafe {
        if libc::killpg(pid, sig) != 0 {
            libc::kill(pid, sig);
        }
    }
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Live>>>,
    observer: Arc<dyn PtyObserver>,
}

impl PtyManager {
    pub fn new(observer: Arc<dyn PtyObserver>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            observer,
        }
    }

    fn get(&self, id: &str) -> AppResult<Arc<Live>> {
        lock(&self.sessions)
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Session".into()))
    }

    /// Spawns a process in a new PTY. Returns the child PID.
    pub fn spawn(&self, req: SpawnRequest) -> AppResult<u32> {
        if lock(&self.sessions).contains_key(&req.id) {
            return Err(AppError::Conflict("Session is already running".into()));
        }
        // portable-pty silently falls back to $HOME for a missing cwd; never
        // let a session start somewhere other than where it was asked to.
        if !req.cwd.is_dir() {
            return Err(AppError::ProjectDirMissing(req.cwd.display().to_string()));
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: req.rows,
                cols: req.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::PtyCreation(e.to_string()))?;

        let mut cmd = match &req.program {
            Program::Executable { path, args } => {
                if !path.is_absolute() {
                    return Err(AppError::ProcessStart(
                        "executable path must be absolute".into(),
                    ));
                }
                let mut cmd = CommandBuilder::new(path);
                cmd.args(args);
                cmd
            }
            Program::LoginShell => CommandBuilder::new_default_prog(),
        };
        cmd.env_clear();
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        cmd.cwd(&req.cwd);

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::ProcessStart(e.to_string()))?;
        // The parent must not hold the slave open, or EOF never arrives.
        drop(pair.slave);

        let setup = (|| -> AppResult<_> {
            let pid = child
                .process_id()
                .ok_or_else(|| AppError::ProcessStart("the child has no process ID".into()))?;
            let reader = pair
                .master
                .try_clone_reader()
                .map_err(|e| AppError::PtyCreation(e.to_string()))?;
            let writer = pair
                .master
                .take_writer()
                .map_err(|e| AppError::PtyCreation(e.to_string()))?;
            Ok((pid, reader, writer))
        })();
        let (pid, reader, writer) = match setup {
            Ok(parts) => parts,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };

        let live = Arc::new(Live {
            pid,
            killer: Mutex::new(child.clone_killer()),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            output: Mutex::new(Output {
                ring: Ring::new(RING_CAPACITY),
                sink: None,
            }),
            exit: Mutex::new(None),
            exit_cv: Condvar::new(),
        });
        lock(&self.sessions).insert(req.id.clone(), live.clone());

        spawn_reader(Arc::downgrade(&live), reader, req.tap, &req.id);

        let observer = self.observer.clone();
        let id = req.id.clone();
        let weak = Arc::downgrade(&live);
        drop(live);
        std::thread::Builder::new()
            .name(format!("pty-wait-{}", short(&id)))
            .spawn(move || {
                let info = match child.wait() {
                    Ok(status) => {
                        let signal = status.signal().map(str::to_string);
                        ExitInfo {
                            code: if signal.is_some() {
                                None
                            } else {
                                i32::try_from(status.exit_code()).ok()
                            },
                            signal,
                            error: None,
                        }
                    }
                    Err(e) => ExitInfo {
                        code: None,
                        signal: None,
                        error: Some(e.to_string()),
                    },
                };
                // Hang up anything the child left behind in its group.
                signal_group(pid, libc::SIGHUP);
                if let Some(live) = weak.upgrade() {
                    *lock(&live.exit) = Some(info.clone());
                    live.exit_cv.notify_all();
                }
                observer.on_exit(&id, &info);
            })
            .map_err(|e| AppError::ProcessStart(format!("cannot start wait thread: {e}")))?;

        Ok(pid)
    }

    /// Replays buffered output into `sink`, then streams new output to it.
    /// Replaces any previous sink.
    pub fn attach(&self, id: &str, mut sink: OutputSink) -> AppResult<()> {
        let live = self.get(id)?;
        let mut out = lock(&live.output);
        let replay = out.ring.snapshot();
        if !replay.is_empty() && !sink(&replay) {
            out.sink = None;
            return Ok(());
        }
        out.sink = Some(sink);
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        let live = self.get(id)?;
        if live.exit_info().is_some() {
            return Err(AppError::Conflict("The session has exited".into()));
        }
        let mut writer = lock(&live.writer);
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|e| AppError::Io(format!("cannot write to terminal: {e}")))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let live = self.get(id)?;
        if live.exit_info().is_some() {
            return Ok(());
        }
        let master = lock(&live.master);
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Io(format!("cannot resize terminal: {e}")))
    }

    pub fn pid(&self, id: &str) -> Option<u32> {
        self.get(id).ok().map(|l| l.pid)
    }

    pub fn is_tracked(&self, id: &str) -> bool {
        lock(&self.sessions).contains_key(id)
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.get(id).is_ok_and(|l| l.exit_info().is_none())
    }

    pub fn exit_info(&self, id: &str) -> Option<ExitInfo> {
        self.get(id).ok().and_then(|l| l.exit_info())
    }

    pub fn tracked_ids(&self) -> Vec<String> {
        lock(&self.sessions).keys().cloned().collect()
    }

    pub fn running_ids(&self) -> Vec<String> {
        lock(&self.sessions)
            .iter()
            .filter(|(_, l)| l.exit_info().is_none())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Stops a session: SIGHUP, then SIGTERM, then SIGKILL to its process
    /// group, waiting `grace` between steps. Blocks until the child exits.
    pub fn terminate(&self, id: &str, grace: Duration) -> AppResult<()> {
        let live = self.get(id)?;
        terminate_live(&live, grace)
    }

    /// Stops every running session in parallel. Used on quit.
    pub fn terminate_all(&self, grace: Duration) {
        let running: Vec<Arc<Live>> = lock(&self.sessions)
            .values()
            .filter(|l| l.exit_info().is_none())
            .cloned()
            .collect();
        if running.is_empty() {
            return;
        }
        for (sig, wait) in [
            (libc::SIGHUP, grace),
            (libc::SIGTERM, grace),
            (libc::SIGKILL, Duration::from_secs(1)),
        ] {
            let pending: Vec<&Arc<Live>> =
                running.iter().filter(|l| l.exit_info().is_none()).collect();
            if pending.is_empty() {
                return;
            }
            for live in &pending {
                signal_group(live.pid, sig);
            }
            let deadline = Instant::now() + wait;
            for live in pending {
                live.wait_exit(deadline.saturating_duration_since(Instant::now()));
            }
        }
    }

    /// Forgets an exited session and releases its PTY.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let live = self.get(id)?;
        if live.exit_info().is_none() {
            return Err(AppError::Conflict(
                "Stop the session before closing it".into(),
            ));
        }
        lock(&self.sessions).remove(id);
        Ok(())
    }
}

fn terminate_live(live: &Live, grace: Duration) -> AppResult<()> {
    if live.exit_info().is_some() {
        return Ok(());
    }
    for (sig, wait) in [
        (libc::SIGHUP, grace),
        (libc::SIGTERM, grace),
        (libc::SIGKILL, Duration::from_secs(2)),
    ] {
        signal_group(live.pid, sig);
        if sig == libc::SIGKILL {
            let _ = lock(&live.killer).kill();
        }
        if live.wait_exit(wait) {
            return Ok(());
        }
    }
    Err(AppError::ProcessTermination(format!(
        "process {} did not exit after SIGKILL",
        live.pid
    )))
}

fn spawn_reader(
    live: Weak<Live>,
    mut reader: Box<dyn Read + Send>,
    mut tap: Option<OutputTap>,
    id: &str,
) {
    let _ = std::thread::Builder::new()
        .name(format!("pty-read-{}", short(id)))
        .spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(tap) = tap.as_mut() {
                            tap(&buf[..n]);
                        }
                        match live.upgrade() {
                            Some(live) => live.push_output(&buf[..n]),
                            None => break,
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // EIO once every slave descriptor has closed.
                    Err(_) => break,
                }
            }
        });
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_most_recent_bytes() {
        let mut ring = Ring::new(8);
        ring.push(b"abcd");
        ring.push(b"efgh");
        assert_eq!(ring.snapshot(), b"abcdefgh");
        ring.push(b"ij");
        assert_eq!(ring.snapshot(), b"cdefghij");
        ring.push(b"0123456789");
        assert_eq!(ring.snapshot(), b"23456789");
    }

    #[test]
    fn exit_info_success() {
        assert!(ExitInfo {
            code: Some(0),
            signal: None,
            error: None
        }
        .success());
        assert!(!ExitInfo {
            code: Some(1),
            signal: None,
            error: None
        }
        .success());
        assert!(!ExitInfo {
            code: None,
            signal: Some("Hangup".into()),
            error: None
        }
        .success());
    }
}
