//! The helper as the VS Code extension drives it: a child process spoken to
//! over stdin and stdout, with a mock `claude` and a throwaway home folder.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(15);

/// Signs in on `auth login`, reports the profile on `auth status`, and
/// otherwise prints where it runs and echoes its input.
const MOCK_CLAUDE: &str = r#"#!/bin/bash
case "$1" in
  --version) echo "2.1.999 (Claude Code)"; exit 0 ;;
  auth)
    case "$2" in
      status)
        if [ -f "$CLAUDE_CONFIG_DIR/mock-auth" ]; then
          printf '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "user@example.com", "orgName": "Example"}\n'
          exit 0
        fi
        echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'
        exit 1 ;;
      login)
        url='https://claude.com/cai/oauth/authorize?code=true&state=mock'
        printf "If the browser didn't open, visit: %s\r\n" "$url"
        printf 'claude.ai' > "$CLAUDE_CONFIG_DIR/mock-auth"
        echo "Login successful"
        exit 0 ;;
    esac ;;
esac
sleep 300 &
echo "CHILD_PID=$!"
echo "CONFIG_DIR=$CLAUDE_CONFIG_DIR"
echo "READY"
while IFS= read -r line; do echo "ECHO:$line"; done
"#;

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
    next_id: u64,
    /// Events received while waiting for responses, oldest first.
    events: Vec<Value>,
}

impl Helper {
    fn start(home: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_claude-switch-helper"))
            .args(["--app-version", "9.9.9"])
            .env_clear()
            .env("HOME", home)
            .env("USER", "tester")
            .env("PATH", "/usr/bin:/bin")
            .env("CLAUDE_SWITCH_HOME", home.join("switch"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            stdin: child.stdin.take(),
            child,
            lines,
            next_id: 0,
            events: Vec::new(),
        }
    }

    fn send(&mut self, line: &str) {
        writeln!(self.stdin.as_mut().unwrap(), "{line}").unwrap();
    }

    /// Sends a request and waits for its response, keeping events.
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "id": id, "method": method, "params": params }).to_string());
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("no answer to {method}"));
            if line["id"] == id {
                return line;
            }
            self.events.push(line);
        }
    }

    fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.call(method, params);
        assert!(response["error"].is_null(), "{method}: {response}");
        response["result"].clone()
    }

    /// Waits for an event matching `want`, consuming the events before it.
    fn wait_event(&mut self, name: &str, want: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self
            .events
            .iter()
            .position(|e| e["event"] == name && want(&e["data"]))
        {
            return self.events.drain(..=i).next_back().unwrap()["data"].clone();
        }
        self.events.clear();
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(line) if line["event"] == name && want(&line["data"]) => {
                    return line["data"].clone();
                }
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    panic!("no {name} event")
                }
            }
        }
    }

    /// Terminal output of session `id` until it contains `text`.
    fn output_until(&mut self, id: &str, text: &str) -> String {
        let mut seen = String::new();
        let deadline = Instant::now() + TIMEOUT;
        while !seen.contains(text) {
            assert!(Instant::now() < deadline, "no {text:?} in {seen:?}");
            let data = self.wait_event("output", |d| d["id"] == id);
            seen.push_str(&String::from_utf8_lossy(&decode(
                data["data"].as_str().unwrap(),
            )));
        }
        seen
    }
}

fn decode(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = Vec::new();
    for chunk in text.as_bytes().chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .filter(|(_, c)| **c != b'=')
            .fold(0u32, |n, (i, c)| n | u32::from(value(*c)) << (18 - 6 * i));
        let len = chunk.iter().filter(|c| **c != b'=').count() - 1;
        out.extend_from_slice(&n.to_be_bytes()[1..=len]);
    }
    out
}

fn mock_claude(dir: &Path) -> PathBuf {
    let path = dir.join("claude");
    fs::write(&path, MOCK_CLAUDE).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn is_running(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc_kill(pid, 0) == 0 }
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[test]
fn runs_accounts_sign_in_and_terminals() {
    let tmp = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(tmp.path()).unwrap();
    let mock = mock_claude(&home);
    let project = home.join("site");
    fs::create_dir(&project).unwrap();
    let mut helper = Helper::start(&home);

    assert_eq!(
        helper.ok("hello", json!({})),
        json!({ "protocol": 1, "version": "9.9.9" })
    );
    let cli = helper.ok("setClaudeExecutable", json!({ "path": mock }));
    assert_eq!(cli["state"], "found", "{cli}");

    // An account, and the sign-in the app would run.
    let account = helper.ok(
        "createAccount",
        json!({ "input": { "name": "Work", "color": "blue" } }),
    );
    let account_id = account["id"].as_str().unwrap().to_string();
    helper.wait_event("changed", |d| d == "accounts");
    let login = helper.ok(
        "startLogin",
        json!({ "input": { "accountId": account_id, "method": "claudeai", "cols": 80, "rows": 24 } }),
    );
    assert_eq!(login["kind"], "login");
    let done = helper.wait_event("loginCompleted", |d| d["id"] == account_id.as_str());
    assert_eq!(done["verifiedEmail"], "user@example.com");
    let bridge = helper.ok("accounts", json!({}));
    assert_eq!(bridge[0]["signedIn"], true, "{bridge}");

    // A Claude session in a project, streamed and typed into.
    let project = helper.ok("addProject", json!({ "directory": project }));
    let session = helper.ok(
        "startSession",
        json!({ "input": { "accountId": account_id, "projectId": project["id"], "kind": "claude", "cols": 80, "rows": 24 } }),
    );
    let session_id = session["id"].as_str().unwrap().to_string();
    helper.ok("attachSession", json!({ "id": session_id }));
    let started = helper.output_until(&session_id, "READY");
    assert!(
        started.contains(&format!(
            "CONFIG_DIR={}",
            account["configDir"].as_str().unwrap()
        )),
        "{started}"
    );
    let child: i32 = started
        .split("CHILD_PID=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap();
    helper.ok(
        "writeSession",
        json!({ "id": session_id, "data": "hello\r" }),
    );
    helper.output_until(&session_id, "ECHO:hello");

    // Keystrokes sent one by one, without waiting for each answer, arrive in
    // the order they were typed.
    let typed: String = (0..300)
        .map(|i| char::from(b"abcdefghijklmnopqrstuvwxyz0123456789"[i % 36]))
        .collect();
    for c in typed.chars().chain(['\r']) {
        helper.send(
            &json!({ "id": 0, "method": "writeSession", "params": { "id": session_id, "data": c.to_string() } })
                .to_string(),
        );
    }
    helper.output_until(&session_id, &format!("ECHO:{typed}"));
    helper.ok(
        "resizeSession",
        json!({ "id": session_id, "cols": 100, "rows": 30 }),
    );
    let open = helper.ok("openSessions", json!({}));
    assert!(
        open.as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == session_id.as_str() && s["status"] == "running"),
        "{open}"
    );

    // Closing the window (stdin) stops what it started.
    helper.stdin = None;
    let deadline = Instant::now() + TIMEOUT;
    while helper.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the helper did not exit");
        std::thread::sleep(Duration::from_millis(100));
    }
    let deadline = Instant::now() + TIMEOUT;
    while is_running(child) {
        assert!(Instant::now() < deadline, "the session kept running");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn refuses_anything_else() {
    let tmp = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(tmp.path()).unwrap();
    let mut helper = Helper::start(&home);

    let kind = |r: &Value| r["error"]["kind"].as_str().unwrap_or("none").to_string();
    assert_eq!(
        kind(&helper.call("run", json!({ "cmd": "ls" }))),
        "invalidInput"
    );
    assert_eq!(
        kind(&helper.call("listAccounts", json!({ "extra": 1 }))),
        "none",
        "methods without parameters ignore them"
    );
    assert_eq!(
        kind(&helper.call("refreshAuthStatus", json!({ "id": "x", "extra": 1 }))),
        "invalidInput"
    );
    assert_eq!(
        kind(&helper.call("addProject", json!({ "directory": "relative" }))),
        "invalidInput"
    );
    assert_eq!(
        kind(&helper.call("setClaudeExecutable", json!({ "path": "/bin/ls; rm" }))),
        kind(&helper.call(
            "setClaudeExecutable",
            json!({ "path": "/nonexistent/claude" })
        )),
    );
    helper.send("not json");
    let line = helper.lines.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(line["error"]["kind"], "invalidInput");
    assert!(helper
        .ok("listAccounts", json!({}))
        .as_array()
        .unwrap()
        .is_empty());
}
