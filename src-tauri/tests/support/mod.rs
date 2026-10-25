//! Shared fixtures: a temporary app layout, a mock `claude` executable, and
//! a recording UI bridge. No test needs real Anthropic credentials.

#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use claude_switch_lib::core::{AppCore, CoreEvent, UiBridge};
use claude_switch_lib::db::Database;
use claude_switch_lib::domain::{AccountColor, CreateAccountInput, SessionKind, StartSessionInput};
use claude_switch_lib::paths::AppPaths;
use claude_switch_lib::settings::SettingsPatch;

/// Behaviour of the mock is driven by marker files in `$CLAUDE_CONFIG_DIR`:
/// * `mock-auth` – contents are the `authMethod` to report as signed in
/// * `mock-ignore-signals` – the interactive session ignores SIGHUP/SIGTERM
pub const MOCK_CLAUDE: &str = r#"#!/bin/bash
# Mock Claude Code used by automated tests.
case "$1" in
  --version)
    echo "2.1.999 (Claude Code)"
    exit 0
    ;;
  auth)
    case "$2" in
      status)
        if [ -f "$CLAUDE_CONFIG_DIR/mock-auth" ]; then
          method=$(cat "$CLAUDE_CONFIG_DIR/mock-auth")
          printf '{"loggedIn": true, "authMethod": "%s", "apiProvider": "firstParty", "email": "user@example.com", "orgName": "Example"}\n' "$method"
          exit 0
        fi
        echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'
        exit 1
        ;;
      login)
        echo "MOCK LOGIN ARGS=$*"
        if [ -f "$CLAUDE_CONFIG_DIR/mock-login-fails" ]; then
          echo "Login failed"
          exit 2
        fi
        # Same shape as Claude Code 2.1.236: an OSC 8 hyperlink, then a prompt.
        url='https://claude.com/cai/oauth/authorize?code=true&state=mock'
        printf 'Opening browser to sign in\342\200\246\r\n'
        printf "If the browser didn't open, visit: \033]8;;%s\007%s\033]8;;\007\r\n" "$url" "$url"
        if [ -f "$CLAUDE_CONFIG_DIR/mock-login-needs-code" ]; then
          printf 'Paste code here if prompted > '
          IFS= read -r code
          if [ "$code" = "good-code#state" ]; then
            printf 'claude.ai' > "$CLAUDE_CONFIG_DIR/mock-auth"
            echo "Login successful."
            exit 0
          fi
          echo "Login failed: Request failed with status code 400"
          exit 1
        fi
        printf 'claude.ai' > "$CLAUDE_CONFIG_DIR/mock-auth"
        echo "Login successful"
        exit 0
        ;;
      logout)
        rm -f "$CLAUDE_CONFIG_DIR/mock-auth"
        exit 0
        ;;
    esac
    ;;
esac

if [ -f "$CLAUDE_CONFIG_DIR/mock-ignore-signals" ]; then
  trap '' HUP TERM
fi
sleep 300 &
echo "CHILD_PID=$!"
echo "CONFIG_DIR=$CLAUDE_CONFIG_DIR"
echo "CWD=$(pwd)"
echo "API_KEY=${ANTHROPIC_API_KEY:-unset}"
echo "NESTED=${CLAUDECODE:-unset}"
echo "TERM=$TERM"
echo "ARGS=$*"
echo "READY"
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then
    kill $! 2>/dev/null
    exit 7
  fi
  if [ "$line" = "limit" ]; then
    # Claude Code 2.1.236's wording, in color.
    printf "\033[31mYou've hit your session limit \302\267 resets 5pm\033[39m\r\n"
    continue
  fi
  echo "ECHO:$line"
done
"#;

#[derive(Default)]
pub struct RecordingBridge {
    pub events: Mutex<Vec<CoreEvent>>,
}

impl UiBridge for RecordingBridge {
    fn emit(&self, event: CoreEvent) {
        self.events.lock().unwrap().push(event);
    }
}

pub struct TestApp {
    pub tmp: tempfile::TempDir,
    pub root: PathBuf,
    pub paths: AppPaths,
    pub core: Arc<AppCore>,
    pub bridge: Arc<RecordingBridge>,
    pub mock: PathBuf,
    /// Arguments passed to the stand-in for `/usr/bin/open`, one call per
    /// line.
    pub opened: PathBuf,
}

pub fn inherited_env(home: &Path) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), home.display().to_string()),
        ("USER".into(), "tester".into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
        (
            "ANTHROPIC_API_KEY".into(),
            "sk-ant-test-secret-value".into(),
        ),
        ("CLAUDECODE".into(), "1".into()),
        (
            "CLAUDE_CONFIG_DIR".into(),
            home.join(".claude").display().to_string(),
        ),
    ]
}

impl TestApp {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths::from_roots(
            home.clone(),
            root.join("data"),
            home.join(".claude-switch").join("profiles"),
        );
        paths.ensure().unwrap();

        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let mock = bin.join("claude");
        fs::write(&mock, MOCK_CLAUDE).unwrap();
        fs::set_permissions(&mock, fs::Permissions::from_mode(0o755)).unwrap();

        let opened = root.join("opened.log");
        let opener = bin.join("open");
        fs::write(
            &opener,
            format!("#!/bin/bash\necho \"$*\" >> '{}'\n", opened.display()),
        )
        .unwrap();
        fs::set_permissions(&opener, fs::Permissions::from_mode(0o755)).unwrap();

        let (core, bridge) = Self::open_core(&paths, &home);
        // Never discover (or launch) editors installed on the test machine,
        // or hand links to real applications.
        core.set_editor_roots(Vec::new());
        core.set_url_opener(opener);
        core.update_settings(SettingsPatch {
            claude_executable_path: Some(mock.display().to_string()),
            ..Default::default()
        })
        .unwrap();
        Self {
            tmp,
            root,
            paths,
            core,
            bridge,
            mock,
            opened,
        }
    }

    pub fn open_core(paths: &AppPaths, home: &Path) -> (Arc<AppCore>, Arc<RecordingBridge>) {
        let bridge = Arc::new(RecordingBridge::default());
        let db = Database::open(&paths.db_path).unwrap();
        let core = AppCore::new(
            paths.clone(),
            db,
            bridge.clone(),
            inherited_env(home),
            Vec::new(),
        )
        .unwrap();
        (core, bridge)
    }

    /// Simulates an app restart on the same data directory.
    pub fn restart(&mut self) {
        let (core, bridge) = Self::open_core(&self.paths, &self.paths.home);
        core.set_editor_roots(Vec::new());
        core.set_url_opener(self.root.join("bin/open"));
        self.core = core;
        self.bridge = bridge;
        self.core.startup();
    }

    pub fn account(&self, name: &str) -> String {
        self.core
            .create_account(CreateAccountInput {
                name: name.into(),
                color: AccountColor::Blue,
                label: None,
                notes: None,
            })
            .unwrap()
            .id
    }

    /// An account that `claude auth status` reports as signed in.
    pub fn signed_in_account(&self, name: &str) -> String {
        let id = self.account(name);
        fs::write(self.profile_dir(&id).join("mock-auth"), "claude.ai").unwrap();
        self.core.refresh_auth_status(&id).unwrap();
        id
    }

    pub fn profile_dir(&self, account_id: &str) -> PathBuf {
        self.paths.profiles_root.join(account_id)
    }

    pub fn project_dir(&self, name: &str) -> PathBuf {
        let dir = self.root.join("projects").join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn claude_input(account_id: &str, project_id: Option<&str>) -> StartSessionInput {
        StartSessionInput {
            account_id: account_id.into(),
            project_id: project_id.map(str::to_string),
            kind: SessionKind::Claude,
            continue_last: None,
            cols: 100,
            rows: 30,
        }
    }
}

/// Collects a session's output.
#[derive(Clone, Default)]
pub struct Capture(pub Arc<Mutex<Vec<u8>>>);

impl Capture {
    pub fn attach(core: &AppCore, session_id: &str) -> Self {
        let cap = Capture::default();
        let buf = cap.0.clone();
        core.attach_session(
            session_id,
            Box::new(move |bytes: &[u8]| {
                buf.lock().unwrap().extend_from_slice(bytes);
                true
            }),
        )
        .unwrap();
        cap
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }

    pub fn wait_for(&self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let text = self.text();
            if text.contains(needle) {
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {needle:?}; got:\n{text}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Value of a `KEY=value` line printed by the mock.
    pub fn value(&self, key: &str) -> String {
        let text = self.wait_for(&format!("{key}="));
        text.lines()
            .find_map(|l| l.trim().strip_prefix(&format!("{key}=")))
            .unwrap()
            .trim()
            .to_string()
    }
}

pub fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Writes a conversation transcript the way Claude Code stores it.
pub fn write_transcript(
    config_dir: &Path,
    project_dir: &Path,
    session_id: &str,
    body: &str,
) -> PathBuf {
    let folder = config_dir
        .join("projects")
        .join(claude_switch_lib::transcripts::folder_name(project_dir).unwrap());
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join(format!("{session_id}.jsonl"));
    fs::write(&path, body).unwrap();
    path
}

pub fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid, 0) == 0 }
}
