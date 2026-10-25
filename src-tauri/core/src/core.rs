//! Application services. Everything the IPC layer can do goes through
//! [`AppCore`], which validates input, enforces invariants, and owns the
//! database, the PTY manager, and the Claude Code integration.
//!
//! `AppCore` does not depend on Tauri; UI side effects go through
//! [`UiBridge`] so the whole core can be driven from tests.

use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, Weak};
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::cli::{self, CliExecutable, CliState, CliStatus};
use crate::clock;
use crate::db::Database;
use crate::domain::*;
use crate::editor_settings;
use crate::editors::{self, EditorAccount, EditorAccountMode, EditorInfo};
use crate::env::{self, EnvConflict};
use crate::error::{AppError, AppResult};
use crate::live_sessions::{self, OpenConversation};
use crate::logging;
use crate::login::{LoginParser, LoginPhase, LoginProgress};
use crate::paths::AppPaths;
use crate::pty::{ExitInfo, OutputSink, OutputTap, Program, PtyManager, PtyObserver, SpawnRequest};
use crate::settings::{AppSettings, SettingsPatch};
use crate::shell_env;
use crate::store::{self, AuthObservation, NewAccount, NewSession, SessionUpdate};
use crate::transcripts::{self, CopyOutcome, Transcript};
use crate::usage_limit::UsageLimitDetector;

/// Grace period between stop signals.
const STOP_GRACE: Duration = Duration::from_millis(1500);
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const SESSION_HISTORY_KEEP: u32 = 2000;
const CONVERSATIONS_LISTED: usize = 50;
/// How long an editor's launcher may take to hand a folder to the editor.
const EDITOR_LAUNCH_WAIT: Duration = Duration::from_secs(20);
/// How long an editor may take to install the Claude Switch extension.
const EXTENSION_INSTALL_WAIT: Duration = Duration::from_secs(120);
/// Time for the editor to focus the project's window before a link is sent.
const EDITOR_FOCUS_DELAY: Duration = Duration::from_millis(1200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChangeScope {
    Accounts,
    Projects,
    Sessions,
    Settings,
    System,
}

/// Events the core publishes for the desktop layer.
#[derive(Debug, Clone)]
pub enum CoreEvent {
    Changed(ChangeScope),
    SessionUpdated(SessionInfo),
    SessionFinished {
        session: SessionInfo,
        account_name: String,
    },
    LoginCompleted {
        account: Account,
    },
    LoginProgress(LoginProgress),
}

pub trait UiBridge: Send + Sync + 'static {
    fn emit(&self, event: CoreEvent);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SystemWarningCode {
    AnthropicProfilesPresent,
    ManagedSettingsPresent,
    CliVersionUntested,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemWarning {
    pub code: SystemWarningCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemInfo {
    pub app_version: String,
    pub os_version: String,
    pub arch: String,
    pub cli: CliStatus,
    pub home_dir: String,
    pub data_dir: String,
    pub profiles_dir: String,
    pub logs_dir: String,
    /// Inherited variables dropped from child environments (names only).
    pub env_conflicts: Vec<EnvConflict>,
    pub warnings: Vec<SystemWarning>,
    pub orphaned_profiles: Vec<String>,
    /// Installed editors that can open a project with an account.
    pub editors: Vec<EditorInfo>,
    /// The Claude Switch editor extension can be installed from the app.
    pub extension_package_available: bool,
}

#[derive(Debug, Clone)]
struct LaunchSpec {
    account_id: String,
    project_id: Option<String>,
    kind: SessionKind,
    continue_last: bool,
    login: Option<(LoginMethod, Option<String>)>,
    /// Claude Code session to resume (`--resume <id>`).
    resume: Option<String>,
    /// First prompt for this launch only; not repeated on restart.
    prompt: Option<String>,
}

/// Everything needed to start one PTY session.
struct Launch<'a> {
    spec: LaunchSpec,
    account: &'a Account,
    project: Option<&'a Project>,
    config_dir: &'a Path,
    cwd: PathBuf,
    program: Program,
    exe: Option<&'a CliExecutable>,
    title: String,
    size: (u16, u16),
    /// Follow `claude auth login` output for the sign-in screen.
    follow_login: bool,
}

struct CliCache {
    status: CliStatus,
    exe: Option<CliExecutable>,
}

pub struct AppCore {
    pub paths: AppPaths,
    db: Database,
    pty: PtyManager,
    settings: RwLock<AppSettings>,
    cli: Mutex<Option<CliCache>>,
    inherited_env: Vec<(String, String)>,
    system_path: Vec<String>,
    bridge: Arc<dyn UiBridge>,
    launches: Mutex<HashMap<String, LaunchSpec>>,
    stop_requested: Mutex<HashSet<String>>,
    logins: Mutex<HashMap<String, Arc<Mutex<LoginParser>>>>,
    /// Sessions in which Claude Code reported a usage limit.
    limit_hits: Mutex<HashSet<String>>,
    editor_roots: RwLock<Vec<PathBuf>>,
    /// Program that hands a link to an application (`open -a <app> <url>`).
    url_opener: RwLock<PathBuf>,
    /// The packaged editor extension (`.vsix`) shipped with the app.
    extension_package: RwLock<Option<PathBuf>>,
    /// Shell that resolves the environment editors are launched with
    /// (tests replace the user's login shell).
    login_shell_override: RwLock<Option<PathBuf>>,
    /// The user's login-shell environment, resolved once on first use.
    login_env: OnceLock<Option<BTreeMap<String, String>>>,
    /// SQLite's `data_version` when this process last caught up with changes
    /// made by another (the app and the editor helper share the database).
    data_version: Mutex<Option<i64>>,
    this: Weak<AppCore>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

struct CoreObserver {
    core: Weak<AppCore>,
}

impl PtyObserver for CoreObserver {
    fn on_exit(&self, session_id: &str, exit: &ExitInfo) {
        if let Some(core) = self.core.upgrade() {
            core.handle_exit(session_id, exit);
        }
    }
}

impl AppCore {
    pub fn new(
        paths: AppPaths,
        db: Database,
        bridge: Arc<dyn UiBridge>,
        inherited_env: Vec<(String, String)>,
        system_path: Vec<String>,
    ) -> AppResult<Arc<Self>> {
        let settings = store::load_settings(&db.conn())?;
        let paths_home = paths.home.clone();
        Ok(Arc::new_cyclic(|weak: &Weak<AppCore>| AppCore {
            paths,
            db,
            pty: PtyManager::new(Arc::new(CoreObserver { core: weak.clone() })),
            settings: RwLock::new(settings),
            cli: Mutex::new(None),
            inherited_env,
            system_path,
            bridge,
            launches: Mutex::new(HashMap::new()),
            stop_requested: Mutex::new(HashSet::new()),
            logins: Mutex::new(HashMap::new()),
            limit_hits: Mutex::new(HashSet::new()),
            editor_roots: RwLock::new(editors::default_roots(&paths_home)),
            url_opener: RwLock::new(PathBuf::from("/usr/bin/open")),
            extension_package: RwLock::new(None),
            login_shell_override: RwLock::new(None),
            login_env: OnceLock::new(),
            data_version: Mutex::new(None),
            this: weak.clone(),
        }))
    }

    /// One-time startup work. Blocking; run off the main thread.
    pub fn startup(&self) {
        let status = self.prepare();
        if self.settings().check_auth_on_startup && status.state == CliState::Found {
            if let Ok(accounts) = self.list_accounts() {
                for account in accounts {
                    if let Err(e) = self.refresh_auth_status(&account.id) {
                        log::warn!("startup status check failed for {}: {e}", account.id);
                    }
                }
            }
        }
    }

    /// Startup work without the sign-in checks: cleans up after a previous
    /// run and finds Claude Code. Blocking.
    pub fn prepare(&self) -> CliStatus {
        let now = clock::now();
        {
            let conn = self.db.conn();
            let alive = |pid: u32| live_sessions::is_alive(pid);
            match store::mark_stale_sessions_interrupted(&conn, &now, &alive) {
                Ok(n) if n > 0 => {
                    log::info!("marked {n} sessions from a previous run as interrupted")
                }
                Ok(_) => {}
                Err(e) => log::warn!("could not mark stale sessions: {e}"),
            }
            if let Err(e) = store::prune_session_history(&conn, SESSION_HISTORY_KEEP) {
                log::warn!("could not prune session history: {e}");
            }
        }
        let status = self.refresh_cli();
        log::info!("claude code: {:?} {:?}", status.state, status.version);
        self.sync_external_changes();
        status
    }

    fn emit(&self, event: CoreEvent) {
        self.bridge.emit(event);
    }

    /// Catches up with changes another process (the app, or the editor
    /// helper of another window) committed to the shared database: reloads
    /// the settings and announces the change. Returns whether there was one.
    pub fn sync_external_changes(&self) -> bool {
        let version: Option<i64> = self
            .db
            .conn()
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .ok();
        let previous = std::mem::replace(&mut *lock(&self.data_version), version);
        if previous.is_none() || previous == version {
            return false;
        }
        if let Ok(settings) = store::load_settings(&self.db.conn()) {
            *self.settings.write().unwrap_or_else(|p| p.into_inner()) = settings;
        }
        for scope in [
            ChangeScope::Accounts,
            ChangeScope::Projects,
            ChangeScope::Sessions,
            ChangeScope::Settings,
        ] {
            self.emit(CoreEvent::Changed(scope));
        }
        true
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    pub fn settings(&self) -> AppSettings {
        self.settings
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> AppResult<AppSettings> {
        let executable_changed = patch.claude_executable_path.is_some();
        let next = self.settings().apply(patch)?;
        store::save_settings(&self.db.conn(), &next)?;
        *self.settings.write().unwrap_or_else(|p| p.into_inner()) = next.clone();
        if executable_changed {
            self.refresh_cli();
        }
        self.emit(CoreEvent::Changed(ChangeScope::Settings));
        Ok(next)
    }

    // -----------------------------------------------------------------------
    // Claude Code CLI
    // -----------------------------------------------------------------------

    fn process_path(&self) -> Option<String> {
        self.inherited_env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
    }

    /// Re-detects the executable and its version.
    pub fn refresh_cli(&self) -> CliStatus {
        let settings = self.settings();
        let configured = settings.claude_executable_path.as_deref();
        let searched: Vec<String> =
            cli::candidate_paths(&self.paths.home, self.process_path().as_deref())
                .iter()
                .map(|p| p.display().to_string())
                .collect();

        let cache = match cli::resolve(configured, &self.paths.home, self.process_path().as_deref())
        {
            Ok(exe) => {
                // Never point a probe at a real profile or at $HOME (where
                // CLAUDE_CONFIG_DIR=$HOME would mean the user's global
                // ~/.claude.json); use a private scratch directory.
                let probe_dir = self.paths.cli_probe_dir();
                let version = crate::paths::ensure_private_dir(&probe_dir).and_then(|_| {
                    let env = self.env_for(&probe_dir.to_string_lossy(), Some(&exe), false);
                    cli::query_version(&exe.path, &env, &self.paths.home)
                });
                match version {
                    Ok(version) => CliCache {
                        status: CliStatus {
                            state: CliState::Found,
                            path: Some(exe.path.display().to_string()),
                            version: Some(version),
                            source: Some(exe.source),
                            message: None,
                            searched,
                        },
                        exe: Some(exe),
                    },
                    Err(e) => CliCache {
                        status: CliStatus {
                            state: CliState::Unsupported,
                            path: Some(exe.path.display().to_string()),
                            version: None,
                            source: Some(exe.source),
                            message: Some(e.to_string()),
                            searched,
                        },
                        exe: None,
                    },
                }
            }
            Err(e) => CliCache {
                status: CliStatus {
                    state: if configured.is_some() {
                        CliState::InvalidConfigured
                    } else {
                        CliState::NotFound
                    },
                    path: configured.map(str::to_string),
                    version: None,
                    source: configured.map(|_| cli::CliSource::Configured),
                    message: Some(e.to_string()),
                    searched,
                },
                exe: None,
            },
        };
        let status = cache.status.clone();
        *lock(&self.cli) = Some(cache);
        self.emit(CoreEvent::Changed(ChangeScope::System));
        status
    }

    pub fn cli_status(&self) -> CliStatus {
        if let Some(cache) = lock(&self.cli).as_ref() {
            return cache.status.clone();
        }
        self.refresh_cli()
    }

    fn cli(&self) -> AppResult<CliExecutable> {
        if lock(&self.cli).is_none() {
            self.refresh_cli();
        }
        let guard = lock(&self.cli);
        let cache = guard.as_ref().expect("cache populated above");
        match (&cache.exe, cache.status.state) {
            (Some(exe), _) => Ok(exe.clone()),
            (None, CliState::NotFound) => Err(AppError::ClaudeNotInstalled),
            (None, CliState::Unsupported) => Err(AppError::UnsupportedCliVersion(
                cache.status.message.clone().unwrap_or_default(),
            )),
            (None, _) => Err(AppError::ExecutableNotFound(
                cache.status.message.clone().unwrap_or_default(),
            )),
        }
    }

    // -----------------------------------------------------------------------
    // Environment
    // -----------------------------------------------------------------------

    fn env_for(
        &self,
        config_dir: &str,
        exe: Option<&CliExecutable>,
        terminal: bool,
    ) -> BTreeMap<String, String> {
        let settings = self.settings();
        env::build(&env::EnvInput {
            inherited: &self.inherited_env,
            home: &self.paths.home,
            config_dir,
            executable_dir: exe.and_then(|e| e.bin_dir()),
            extra_path_entries: &settings.extra_path_entries,
            system_path_entries: &self.system_path,
            custom: &settings.custom_env,
            terminal,
        })
    }

    pub fn env_conflicts(&self) -> Vec<EnvConflict> {
        env::detect_conflicts(
            self.inherited_env
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str())),
        )
    }

    /// The user's login shell, validated against `/etc/shells`.
    fn login_shell(&self) -> String {
        let candidate = self
            .inherited_env
            .iter()
            .find(|(k, _)| k == "SHELL")
            .map(|(_, v)| v.clone());
        let allowed: Vec<String> = fs::read_to_string("/etc/shells")
            .map(|s| {
                s.lines()
                    .map(str::trim)
                    .filter(|l| l.starts_with('/'))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        match candidate {
            Some(shell)
                if Path::new(&shell).is_absolute()
                    && Path::new(&shell).is_file()
                    && (allowed.is_empty() || allowed.contains(&shell)) =>
            {
                shell
            }
            _ => "/bin/zsh".to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // Accounts
    // -----------------------------------------------------------------------

    fn running_counts(&self) -> (HashMap<String, u32>, HashMap<String, u32>) {
        let running: HashSet<String> = self.pty.running_ids().into_iter().collect();
        let mut by_account = HashMap::new();
        let mut by_project = HashMap::new();
        for (id, spec) in lock(&self.launches).iter() {
            if running.contains(id) {
                *by_account.entry(spec.account_id.clone()).or_insert(0) += 1;
                if let Some(p) = &spec.project_id {
                    *by_project.entry(p.clone()).or_insert(0) += 1;
                }
            }
        }
        (by_account, by_project)
    }

    pub fn list_accounts(&self) -> AppResult<Vec<Account>> {
        let mut accounts = store::list_accounts(&self.db.conn())?;
        let (counts, _) = self.running_counts();
        for a in &mut accounts {
            a.running_sessions = counts.get(&a.id).copied().unwrap_or(0);
        }
        Ok(accounts)
    }

    fn account(&self, id: &str) -> AppResult<Account> {
        let mut account = store::require_account(&self.db.conn(), id)?;
        let (counts, _) = self.running_counts();
        account.running_sessions = counts.get(id).copied().unwrap_or(0);
        Ok(account)
    }

    pub fn create_account(&self, input: CreateAccountInput) -> AppResult<Account> {
        let name = validate_name(&input.name, "Account")?;
        let label = validate_optional_line(input.label.as_deref(), 254, "Label")?;
        let notes = validate_notes(input.notes.as_deref())?;
        let id = Uuid::new_v4();
        let id_str = id.hyphenated().to_string();

        let dir = self.paths.create_profile_dir(&id)?;
        let dir_str = dir
            .to_str()
            .ok_or_else(|| AppError::InvalidConfigDir("profile path is not valid UTF-8".into()))?
            .to_string();

        let result = (|| -> AppResult<()> {
            let mut conn = self.db.conn();
            let tx = conn.transaction()?;
            let order = store::next_sort_order(&tx)?;
            store::insert_account(
                &tx,
                &NewAccount {
                    id: &id_str,
                    name: &name,
                    label: label.as_deref(),
                    notes: notes.as_deref(),
                    config_dir: &dir_str,
                    color: input.color,
                    sort_order: order,
                    now: &clock::now(),
                },
            )?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = result {
            // Roll back the directory we just created; it is empty.
            let _ = fs::remove_dir(&dir);
            return Err(e);
        }
        log::info!("created account {id_str}");
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.account(&id_str)
    }

    pub fn update_account(&self, input: UpdateAccountInput) -> AppResult<Account> {
        let id = parse_id(&input.id, "Account")?.hyphenated().to_string();
        let current = store::require_account(&self.db.conn(), &id)?;
        let name = match input.name.as_deref() {
            Some(n) => validate_name(n, "Account")?,
            None => current.name.clone(),
        };
        let label = match input.label.as_deref() {
            Some(l) => validate_optional_line(Some(l), 254, "Label")?,
            None => current.label.clone(),
        };
        let notes = match input.notes.as_deref() {
            Some(n) => validate_notes(Some(n))?,
            None => current.notes.clone(),
        };
        let color = input.color.unwrap_or(current.color);
        // The profile path is intentionally not updatable.
        store::update_account_fields(
            &self.db.conn(),
            &id,
            &name,
            color,
            label.as_deref(),
            notes.as_deref(),
            &clock::now(),
        )?;
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.account(&id)
    }

    pub fn reorder_accounts(&self, ids: Vec<String>) -> AppResult<Vec<Account>> {
        let parsed = ids
            .iter()
            .map(|id| parse_id(id, "Account").map(|u| u.hyphenated().to_string()))
            .collect::<AppResult<Vec<_>>>()?;
        {
            let mut conn = self.db.conn();
            let tx = conn.transaction()?;
            let existing: HashSet<String> = store::list_accounts(&tx)?
                .into_iter()
                .map(|a| a.id)
                .collect();
            let given: HashSet<String> = parsed.iter().cloned().collect();
            if given.len() != parsed.len() || given != existing {
                return Err(AppError::invalid(
                    "The new order must list every account exactly once",
                ));
            }
            for (idx, id) in parsed.iter().enumerate() {
                store::set_sort_order(&tx, id, idx as i32)?;
            }
            tx.commit()?;
        }
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.list_accounts()
    }

    pub fn delete_account(&self, input: DeleteAccountInput) -> AppResult<()> {
        let uuid = parse_id(&input.id, "Account")?;
        let id = uuid.hyphenated().to_string();
        let account = store::require_account(&self.db.conn(), &id)?;

        let tracked: Vec<String> = lock(&self.launches)
            .iter()
            .filter(|(_, s)| s.account_id == id)
            .map(|(sid, _)| sid.clone())
            .collect();
        if tracked.iter().any(|sid| self.pty.is_running(sid)) {
            return Err(AppError::Conflict(
                "Stop this account's running sessions before removing it".into(),
            ));
        }

        if input.delete_profile_data {
            if input.confirmation.trim() != account.name {
                return Err(AppError::invalid(
                    "Type the account name exactly to confirm deleting its profile data",
                ));
            }
            // A Claude Code process still using the profile (a VS Code tab,
            // a terminal) would keep its login alive and write the folder
            // back after it is deleted.
            if let Ok(dir) = self.paths.verify_profile_dir(&uuid, &account.config_dir) {
                let running = live_sessions::running_in(&dir).len();
                if running > 0 {
                    return Err(AppError::Conflict(format!(
                        "Claude Code is still running with this account outside Claude Switch ({running} {}, for example a Claude tab in VS Code or a terminal). Close {}, then try again.",
                        if running == 1 { "process" } else { "processes" },
                        if running == 1 { "it" } else { "them" },
                    )));
                }
            }
            if input.sign_out_first {
                self.sign_out(&uuid, &account)?;
            }
        }
        // Editors set to this account would otherwise keep starting Claude
        // Code with a profile that no longer belongs to Claude Switch.
        self.release_editors(&id)?;

        for sid in &tracked {
            let _ = self.pty.remove(sid);
            lock(&self.launches).remove(sid);
            lock(&self.logins).remove(sid);
            lock(&self.limit_hits).remove(sid);
        }
        store::delete_account(&self.db.conn(), &id)?;
        log::info!(
            "removed account {id} (delete data: {})",
            input.delete_profile_data
        );

        let result = if input.delete_profile_data {
            self.paths.delete_profile_dir(&uuid).map_err(|e| {
                AppError::Io(format!(
                    "The account was removed, but its profile folder could not be deleted: {e}"
                ))
            })
        } else {
            Ok(())
        };
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.emit(CoreEvent::Changed(ChangeScope::Sessions));
        self.emit(CoreEvent::Changed(ChangeScope::System));
        result
    }

    /// Returns editors whose Claude Code extension is set to this account to
    /// per-window accounts.
    fn release_editors(&self, account_id: &str) -> AppResult<()> {
        for editor in self.editors() {
            let uses_account = editor.claude_account.mode == EditorAccountMode::Account
                && editor.claude_account.account_id.as_deref() == Some(account_id);
            if !uses_account {
                continue;
            }
            self.write_editor_account(&editor, None).map_err(|e| {
                AppError::Conflict(format!(
                    "{} is set to use this account for Claude Code, and that setting could not be reset: {e}",
                    editor.name
                ))
            })?;
        }
        Ok(())
    }

    /// Runs the official `claude auth logout` for a profile.
    fn sign_out(&self, uuid: &Uuid, account: &Account) -> AppResult<()> {
        let dir = match self.paths.verify_profile_dir(uuid, &account.config_dir) {
            Ok(dir) => dir,
            // Nothing to sign out of if the profile is already gone.
            Err(AppError::InvalidConfigDir(_)) => return Ok(()),
            Err(e) => return Err(e),
        };
        let exe = self.cli()?;
        let env = self.env_for(&dir.to_string_lossy(), Some(&exe), false);
        let out = cli::run(
            &exe.path,
            &["auth", "logout"],
            &env,
            &self.paths.home,
            Duration::from_secs(30),
        )?;
        if out.status != Some(0) {
            return Err(AppError::AuthFailed(
                "`claude auth logout` did not succeed. You can retry, or delete the profile without signing out.".into(),
            ));
        }
        Ok(())
    }

    /// Checks the account's status with `claude auth status --json`.
    pub fn refresh_auth_status(&self, id: &str) -> AppResult<Account> {
        let uuid = parse_id(id, "Account")?;
        let id = uuid.hyphenated().to_string();
        let account = store::require_account(&self.db.conn(), &id)?;
        let observation = self.observe_auth(&uuid, &account);
        store::record_auth_observation(&self.db.conn(), &id, &observation, &clock::now())?;
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.account(&id)
    }

    fn observe_auth(&self, uuid: &Uuid, account: &Account) -> AuthObservation {
        let unknown = |detail: String| AuthObservation {
            status: AuthStatus::Unknown,
            method: None,
            email: None,
            org_name: None,
            detail: Some(detail),
        };
        let dir = match self.paths.verify_profile_dir(uuid, &account.config_dir) {
            Ok(dir) => dir,
            Err(e) => return unknown(e.to_string()),
        };
        let exe = match self.cli() {
            Ok(exe) => exe,
            Err(e) => return unknown(e.to_string()),
        };
        let config_dir = dir.to_string_lossy().into_owned();
        let env = self.env_for(&config_dir, Some(&exe), false);
        match cli::probe_auth_status(&exe.path, &env, &self.paths.home) {
            Ok(report) => cli::interpret(&report, &config_dir, account.auth_verified_at.is_some()),
            Err(e) => unknown(e.to_string()),
        }
    }

    /// Starts `claude auth login` for an account in a new PTY session.
    pub fn start_login(&self, input: StartLoginInput) -> AppResult<SessionInfo> {
        let uuid = parse_id(&input.account_id, "Account")?;
        let id = uuid.hyphenated().to_string();
        let (cols, rows) = validate_terminal_size(input.cols, input.rows)?;
        let email = input
            .email
            .as_deref()
            .filter(|e| !e.trim().is_empty())
            .map(validate_login_email)
            .transpose()?;
        let account = store::require_account(&self.db.conn(), &id)?;
        if lock(&self.launches).iter().any(|(sid, s)| {
            s.account_id == id && s.kind == SessionKind::Login && self.pty.is_running(sid)
        }) {
            return Err(AppError::Conflict(
                "A sign-in for this account is already in progress".into(),
            ));
        }
        // Re-authentication is the one place a missing profile directory is
        // recreated, and only at its managed, UUID-derived path.
        if Path::new(&account.config_dir) != self.paths.profile_dir_for(&uuid) {
            return Err(AppError::InvalidConfigDir(
                "the stored profile path does not match its managed location".into(),
            ));
        }
        let dir = self.paths.recreate_missing_profile_dir(&uuid)?;
        let exe = self.cli()?;

        let mut args = vec!["auth".to_string(), "login".to_string()];
        args.push(match input.method {
            LoginMethod::Claudeai => "--claudeai".into(),
            LoginMethod::Console => "--console".into(),
        });
        if let Some(email) = &email {
            args.push("--email".into());
            args.push(email.clone());
        }
        self.launch(Launch {
            spec: LaunchSpec {
                account_id: id,
                project_id: None,
                kind: SessionKind::Login,
                continue_last: false,
                login: Some((input.method, email)),
                resume: None,
                prompt: None,
            },
            account: &account,
            project: None,
            config_dir: &dir,
            cwd: self.paths.home.clone(),
            program: Program::Executable {
                path: exe.path.clone(),
                args,
            },
            exe: Some(&exe),
            title: format!("Sign in · {}", account.name),
            size: (cols, rows),
            follow_login: true,
        })
    }

    /// Follows `claude auth login` output for the sign-in screen.
    fn login_tap(&self, session_id: &str, account_id: &str) -> OutputTap {
        let parser = Arc::new(Mutex::new(LoginParser::new(session_id, account_id)));
        lock(&self.logins).insert(session_id.to_string(), parser.clone());
        let core = self.this.clone();
        Box::new(move |bytes: &[u8]| {
            let changed = lock(&parser).feed(bytes);
            if let (Some(progress), Some(core)) = (changed, core.upgrade()) {
                core.emit(CoreEvent::LoginProgress(progress));
            }
        })
    }

    /// Watches a Claude session's output for a usage-limit message. Only the
    /// fact is kept (in memory), never the text.
    fn usage_limit_tap(&self, session_id: &str) -> OutputTap {
        let core = self.this.clone();
        let session_id = session_id.to_string();
        let mut detector = Some(UsageLimitDetector::new());
        Box::new(move |bytes: &[u8]| {
            let Some(d) = detector.as_mut() else { return };
            if !d.feed(bytes) {
                return;
            }
            detector = None;
            let Some(core) = core.upgrade() else { return };
            lock(&core.limit_hits).insert(session_id.clone());
            log::info!("session {session_id} reported a usage limit");
            let session = store::get_session(&core.db.conn(), &session_id);
            if let Ok(Some(s)) = session {
                core.emit(CoreEvent::SessionUpdated(core.with_live_state(s)));
            }
        })
    }

    /// Current sign-in state for a login session.
    pub fn login_progress(&self, session_id: &str) -> AppResult<LoginProgress> {
        let id = parse_id(session_id, "Session")?.hyphenated().to_string();
        let parser = lock(&self.logins)
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Sign-in".into()))?;
        let progress = lock(&parser).progress().clone();
        Ok(progress)
    }

    /// Sends the authorization code shown by the browser to a running
    /// `claude auth login`. Only accepted for sign-in sessions, so this cannot
    /// be used to type into arbitrary terminals.
    pub fn submit_login_code(&self, session_id: &str, code: &str) -> AppResult<LoginProgress> {
        let id = parse_id(session_id, "Session")?.hyphenated().to_string();
        let parser = lock(&self.logins)
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Sign-in".into()))?;
        let code = code.trim();
        if code.is_empty()
            || code.len() > 4096
            || code.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(AppError::invalid(
                "Paste the code exactly as shown in the browser",
            ));
        }
        if !self.pty.is_running(&id) {
            return Err(AppError::Conflict(
                "This sign-in has already finished".into(),
            ));
        }
        if lock(&parser).progress().is_finished() {
            return Err(AppError::Conflict(
                "This sign-in has already finished".into(),
            ));
        }
        self.pty.write(&id, format!("{code}\r").as_bytes())?;
        let progress = lock(&parser).code_submitted();
        self.emit(CoreEvent::LoginProgress(progress.clone()));
        Ok(progress)
    }

    /// Records the final sign-in outcome on the session's parser.
    fn finish_login(&self, session_id: &str, signed_in: bool, detail: Option<&str>) {
        let Some(parser) = lock(&self.logins).get(session_id).cloned() else {
            return;
        };
        let progress = {
            let mut p = lock(&parser);
            let mut progress = p.progress().clone();
            progress.phase = if signed_in {
                LoginPhase::Succeeded
            } else {
                LoginPhase::Failed
            };
            progress.awaiting_code = false;
            progress.message = if signed_in {
                None
            } else {
                detail.map(str::to_string)
            };
            // Keep later reads consistent with what was emitted.
            *p = LoginParser::finished(progress.clone());
            progress
        };
        self.emit(CoreEvent::LoginProgress(progress));
    }

    // -----------------------------------------------------------------------
    // Editors
    // -----------------------------------------------------------------------

    /// Restricts editor discovery to the given folders (used by tests).
    pub fn set_editor_roots(&self, roots: Vec<PathBuf>) {
        *self.editor_roots.write().unwrap_or_else(|p| p.into_inner()) = roots;
    }

    /// Replaces `/usr/bin/open` (used by tests).
    pub fn set_url_opener(&self, program: PathBuf) {
        *self.url_opener.write().unwrap_or_else(|p| p.into_inner()) = program;
    }

    /// Where the packaged editor extension is (set at startup).
    pub fn set_extension_package(&self, package: Option<PathBuf>) {
        *self
            .extension_package
            .write()
            .unwrap_or_else(|p| p.into_inner()) = package;
    }

    fn extension_package(&self) -> Option<PathBuf> {
        self.extension_package
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .filter(|p| p.is_file())
    }

    /// Installs (or updates) the Claude Switch extension in an editor with
    /// the editor's own `--install-extension`. Returns the editor afterwards.
    pub fn install_editor_extension(&self, editor_id: &str) -> AppResult<EditorInfo> {
        let editor = self.find_editor(editor_id)?;
        let package = self
            .extension_package()
            .ok_or_else(|| AppError::NotFound("The editor extension package".into()))?;
        let probe = self.paths.cli_probe_dir();
        crate::paths::ensure_private_dir(&probe)?;
        let exe = self.cli().ok();
        let env = self.env_for(&probe.to_string_lossy(), exe.as_ref(), false);
        let mut child = std::process::Command::new(&editor.launcher)
            .arg("--install-extension")
            .arg(&package)
            .arg("--force")
            .env_clear()
            .envs(&env)
            .current_dir(&self.paths.home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| AppError::ProcessStart(format!("could not start {}: {e}", editor.name)))?;
        let deadline = std::time::Instant::now() + EXTENSION_INSTALL_WAIT;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                return Err(AppError::ProcessStart(format!(
                    "{} took too long to install the extension",
                    editor.name
                )));
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        if !status.success() {
            return Err(AppError::ProcessStart(format!(
                "{} could not install the extension ({status})",
                editor.name
            )));
        }
        log::info!("installed the editor extension in {}", editor.id);
        self.emit(CoreEvent::Changed(ChangeScope::System));
        self.find_editor(editor_id)
    }

    /// Installed editors, with the account each one's Claude Code extension
    /// is set to use.
    pub fn editors(&self) -> Vec<EditorInfo> {
        let roots = self
            .editor_roots
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let accounts = self.list_accounts().unwrap_or_default();
        let mut found = editors::detect(&roots, &self.paths.home);
        for editor in &mut found {
            editor.claude_account = editor_account(editor, &accounts);
        }
        found
    }

    fn find_editor(&self, id: &str) -> AppResult<EditorInfo> {
        self.editors()
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound("Editor".into()))
    }

    /// Points the editor's Claude Code extension at a profile for every
    /// window (`None` removes the setting). Returns false if it already was.
    fn write_editor_account(
        &self,
        editor: &EditorInfo,
        profile: Option<(&str, &Path)>,
    ) -> AppResult<bool> {
        let value = profile
            .map(|(_, dir)| {
                dir.to_str().ok_or_else(|| {
                    AppError::InvalidConfigDir("profile path is not valid UTF-8".into())
                })
            })
            .transpose()?;
        let changed = editor_settings::write_config_dir(
            &editor.settings_file,
            &self.paths.editor_backups_dir(),
            &editor.id,
            value,
        )?;
        if changed {
            match profile {
                Some((account_id, _)) => log::info!(
                    "set the Claude Code extension in {} to account {account_id}",
                    editor.id
                ),
                None => log::info!("removed the Claude Code account setting from {}", editor.id),
            }
            self.emit(CoreEvent::Changed(ChangeScope::System));
        }
        Ok(changed)
    }

    /// Chooses the account of an editor's Claude Code extension for all of
    /// its windows, or (`None`) returns it to using each window's
    /// environment.
    pub fn set_editor_account(&self, input: SetEditorAccountInput) -> AppResult<()> {
        let editor = self.find_editor(&input.editor_id)?;
        match input.account_id.as_deref() {
            None => {
                self.write_editor_account(&editor, None)?;
            }
            Some(raw) => {
                let uuid = parse_id(raw, "Account")?;
                let id = uuid.hyphenated().to_string();
                let account = store::require_account(&self.db.conn(), &id)?;
                let dir = self.paths.verify_profile_dir(&uuid, &account.config_dir)?;
                self.write_editor_account(&editor, Some((&id, &dir)))?;
            }
        }
        Ok(())
    }

    /// Starts an editor's launcher with an account's environment and, if
    /// given, then sends the editor a link. Waits for both so failures can be
    /// reported.
    fn run_editor(
        &self,
        editor: &EditorInfo,
        args: &[&std::ffi::OsStr],
        profile: &Path,
        cwd: &Path,
        link: Option<String>,
    ) -> AppResult<()> {
        let env = self.editor_env(profile);
        let mut child = std::process::Command::new(&editor.launcher)
            .args(args)
            .env_clear()
            .envs(&env)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| AppError::ProcessStart(format!("could not start {}: {e}", editor.name)))?;
        let deadline = std::time::Instant::now() + EDITOR_LAUNCH_WAIT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    // Still running: let it finish on its own.
                    let name = editor.name.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = child.wait() {
                            log::warn!("{name} launcher: {e}");
                        }
                    });
                    break None;
                }
                Err(e) => {
                    log::warn!("{} launcher: {e}", editor.name);
                    break None;
                }
            }
        };
        if let Some(status) = status.filter(|s| !s.success()) {
            return Err(AppError::ProcessStart(format!(
                "{} could not open the folder ({status})",
                editor.name
            )));
        }
        let Some(link) = link else { return Ok(()) };
        std::thread::sleep(EDITOR_FOCUS_DELAY);
        // Links are never logged: they can contain the user's message.
        let opener = self
            .url_opener
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let opened = std::process::Command::new(opener)
            .arg("-a")
            .arg(&editor.app)
            .arg(&link)
            .env_clear()
            .envs(&env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| AppError::ProcessStart(format!("could not open the conversation: {e}")))?;
        if !opened.success() {
            return Err(AppError::ProcessStart(format!(
                "{} did not accept the link to the conversation",
                editor.name
            )));
        }
        Ok(())
    }

    /// Replaces the user's login shell for resolving editor environments
    /// (used by tests).
    pub fn set_login_shell_override(&self, shell: Option<PathBuf>) {
        *self
            .login_shell_override
            .write()
            .unwrap_or_else(|p| p.into_inner()) = shell;
    }

    /// The user's login-shell environment (see [`shell_env`]), resolved once.
    fn login_env(&self) -> Option<&BTreeMap<String, String>> {
        self.login_env
            .get_or_init(|| {
                let shell = self
                    .login_shell_override
                    .read()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or_else(|| PathBuf::from(self.login_shell()));
                let mut base = self.env_for(&self.paths.home.to_string_lossy(), None, false);
                base.remove("CLAUDE_CONFIG_DIR");
                let resolved = shell_env::resolve(&shell, &base, &self.paths.home);
                if resolved.is_none() {
                    log::warn!(
                        "could not read the login shell's environment; editors get a minimal one"
                    );
                }
                resolved
            })
            .as_ref()
    }

    /// The environment an editor is launched with for a profile: the user's
    /// login-shell environment (without anything that affects Claude Code's
    /// account), Claude Switch's PATH entries and custom variables, and the
    /// profile. Falls back to the session environment if the shell could not
    /// be read.
    fn editor_env(&self, profile: &Path) -> BTreeMap<String, String> {
        let exe = self.cli().ok();
        let base = self.env_for(&profile.to_string_lossy(), exe.as_ref(), false);
        let Some(login) = self.login_env() else {
            return base;
        };
        let mut env = login.clone();
        let mut path: Vec<&str> = login
            .get("PATH")
            .map(|p| p.split(':').filter(|e| !e.is_empty()).collect())
            .unwrap_or_default();
        for entry in base.get("PATH").map(|p| p.split(':')).into_iter().flatten() {
            if !entry.is_empty() && !path.contains(&entry) {
                path.push(entry);
            }
        }
        let path = path.join(":");
        for (name, value) in base {
            if name != "PATH" && !env.contains_key(&name) {
                env.insert(name, value);
            }
        }
        for var in &self.settings().custom_env {
            if env::validate_custom_var_name(&var.name).is_ok() {
                env.insert(var.name.clone(), var.value.clone());
            }
        }
        env.insert("PATH".into(), path);
        env.insert(
            "CLAUDE_CONFIG_DIR".into(),
            profile.to_string_lossy().into_owned(),
        );
        env
    }

    /// Records an editor launch for an account and project.
    fn record_editor_use(
        &self,
        editor: &EditorInfo,
        account_id: &str,
        project_id: &str,
    ) -> AppResult<()> {
        let now = clock::now();
        {
            let mut conn = self.db.conn();
            let tx = conn.transaction()?;
            store::touch_account_used(&tx, account_id, &now)?;
            store::touch_project_used(&tx, project_id, account_id, &now)?;
            tx.commit()?;
        }
        if self.settings().preferred_editor.as_deref() != Some(editor.id.as_str()) {
            self.update_settings(SettingsPatch {
                preferred_editor: Some(editor.id.clone()),
                ..Default::default()
            })?;
        }
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.emit(CoreEvent::Changed(ChangeScope::Projects));
        Ok(())
    }

    /// Opens a project in an editor with the account's profile, so the
    /// Claude Code extension and terminals in new editor windows use it.
    ///
    /// If the editor's settings already choose an account for every window
    /// (set by Claude Switch), that setting is switched to this account too;
    /// otherwise it would silently win over the window's environment. A
    /// folder set there by the user is never overridden here.
    pub fn open_in_editor(&self, input: OpenInEditorInput) -> AppResult<OpenInEditorResult> {
        let uuid = parse_id(&input.account_id, "Account")?;
        let account_id = uuid.hyphenated().to_string();
        let project_id = parse_id(&input.project_id, "Project")?
            .hyphenated()
            .to_string();
        let editor = self.find_editor(&input.editor_id)?;
        let account = store::require_account(&self.db.conn(), &account_id)?;
        let project = store::require_project(&self.db.conn(), &project_id)?;
        let dir = self.paths.verify_profile_dir(&uuid, &account.config_dir)?;
        let project_dir = PathBuf::from(&project.directory);
        if !project_dir.is_dir() {
            return Err(AppError::ProjectDirMissing(project.directory));
        }

        let editor_account_changed = match editor.claude_account.mode {
            EditorAccountMode::Window => false,
            EditorAccountMode::Unreadable => {
                log::warn!("{} settings are unreadable; opening per window", editor.id);
                false
            }
            EditorAccountMode::Account => {
                self.write_editor_account(&editor, Some((&account_id, &dir)))?
            }
            // Left behind by an account that was removed from Claude Switch.
            EditorAccountMode::Custom
                if editor
                    .claude_account
                    .detail
                    .as_deref()
                    .is_some_and(|d| self.paths.is_profile_path(Path::new(d))) =>
            {
                self.write_editor_account(&editor, Some((&account_id, &dir)))?
            }
            EditorAccountMode::Custom => {
                return Err(AppError::Conflict(format!(
                    "{name}'s user settings set CLAUDE_CONFIG_DIR for the Claude Code extension (claudeCode.environmentVariables), which would override the account. Choose the account for {name} in Settings → Editors, or remove that entry from {name}'s settings.",
                    name = editor.name
                )))
            }
        };

        let new_window = std::ffi::OsStr::new("--new-window");
        self.run_editor(
            &editor,
            &[new_window, project_dir.as_os_str()],
            &dir,
            &project_dir,
            None,
        )?;
        log::info!(
            "opened project {project_id} in {} for account {account_id}",
            editor.id
        );
        self.record_editor_use(&editor, &account_id, &project_id)?;
        Ok(OpenInEditorResult {
            editor_account_changed,
        })
    }

    // -----------------------------------------------------------------------
    // Conversations
    // -----------------------------------------------------------------------

    /// Claude Code's default configuration folder, read (never written) as a
    /// source of conversations to continue elsewhere.
    fn default_config_dir(&self) -> Option<PathBuf> {
        let dir = self.paths.home.join(".claude");
        fs::metadata(&dir).is_ok_and(|m| m.is_dir()).then_some(dir)
    }

    /// Where conversations can be: every verified account profile, then
    /// `~/.claude`.
    fn conversation_sources(&self) -> AppResult<Vec<(Option<String>, PathBuf)>> {
        let accounts = store::list_accounts(&self.db.conn())?;
        let mut sources: Vec<(Option<String>, PathBuf)> = accounts
            .iter()
            .filter_map(|a| {
                let uuid = Uuid::parse_str(&a.id).ok()?;
                let dir = self.paths.verify_profile_dir(&uuid, &a.config_dir).ok()?;
                Some((Some(a.id.clone()), dir))
            })
            .collect();
        if let Some(dir) = self.default_config_dir() {
            sources.push((None, dir));
        }
        Ok(sources)
    }

    /// Conversations recorded for `cwd`, newest first, each listed once from
    /// its most recent copy (with the account holding it).
    fn conversations_for(
        sources: &[(Option<String>, PathBuf)],
        cwd: &Path,
    ) -> Vec<(Option<String>, Transcript)> {
        let mut newest: HashMap<Uuid, (Option<String>, Transcript)> = HashMap::new();
        for (account_id, dir) in sources {
            for t in transcripts::list(dir, cwd) {
                if newest
                    .get(&t.session_id)
                    .is_some_and(|(_, seen)| seen.modified >= t.modified)
                {
                    continue;
                }
                newest.insert(t.session_id, (account_id.clone(), t));
            }
        }
        let mut list: Vec<_> = newest.into_values().collect();
        list.sort_by_key(|(_, t)| Reverse(t.modified));
        list
    }

    /// Recent Claude Code conversations in registered projects, across every
    /// account and `~/.claude`, newest first. A conversation copied to
    /// several profiles is listed once, from its most recent copy.
    pub fn list_conversations(&self) -> AppResult<Vec<Conversation>> {
        let sources = self.conversation_sources()?;
        let projects = store::list_projects(&self.db.conn())?;
        let mut list: Vec<(std::time::SystemTime, Conversation)> = Vec::new();
        for project in projects.iter().filter(|p| p.exists) {
            let cwd = Path::new(&project.directory);
            for (account_id, t) in Self::conversations_for(&sources, cwd) {
                list.push((
                    t.modified,
                    Conversation {
                        session_id: t.session_id.hyphenated().to_string(),
                        project_id: project.id.clone(),
                        account_id,
                        modified_at: clock::format(t.modified),
                        size_bytes: t.size,
                    },
                ));
            }
        }
        list.sort_by_key(|(modified, _)| Reverse(*modified));
        Ok(list
            .into_iter()
            .take(CONVERSATIONS_LISTED)
            .map(|(_, c)| c)
            .collect())
    }

    /// A working directory named by the editor extension: an existing folder
    /// outside Claude Switch's own, in the canonical form Claude Code uses
    /// for its conversation folders. It is only used to find conversations;
    /// nothing is written there.
    pub fn validate_working_dir(&self, raw: &str) -> AppResult<PathBuf> {
        let path = Path::new(raw);
        if raw.is_empty() || raw.len() > 4096 || !path.is_absolute() {
            return Err(AppError::invalid("The folder must be an absolute path"));
        }
        let canonical = fs::canonicalize(path)
            .ok()
            .filter(|p| p.is_dir())
            .ok_or_else(|| AppError::ProjectDirMissing(raw.to_string()))?;
        if canonical == Path::new("/") || self.paths.is_managed_path(&canonical) {
            return Err(AppError::PermissionDenied(
                "Conversations in this folder cannot be handed over".into(),
            ));
        }
        Ok(canonical)
    }

    /// Conversations recorded for a working directory (see
    /// [`Self::validate_working_dir`]), newest first.
    pub fn conversations_in_dir(&self, dir: &Path) -> AppResult<Vec<(Option<String>, Transcript)>> {
        let sources = self.conversation_sources()?;
        let mut list = Self::conversations_for(&sources, dir);
        list.truncate(CONVERSATIONS_LISTED);
        Ok(list)
    }

    /// Conversations open in Claude Code processes started by process
    /// `parent` (an editor window's extension host), with the account each
    /// runs with (`None` for `~/.claude`).
    pub fn conversations_opened_by(
        &self,
        parent: u32,
    ) -> AppResult<Vec<(Option<String>, OpenConversation)>> {
        Ok(self
            .conversation_sources()?
            .into_iter()
            .flat_map(|(account_id, dir)| {
                live_sessions::opened_by(&dir, parent)
                    .into_iter()
                    .map(move |c| (account_id.clone(), c))
            })
            .collect())
    }

    /// Copies a conversation of `cwd` into a signed-in account's profile so
    /// that account can resume it. The source (an account, or `~/.claude`
    /// for `None`) is only read. Returns the target profile.
    fn hand_over_parsed(
        &self,
        cwd: &Path,
        session: &Uuid,
        from: Option<Uuid>,
        to: Uuid,
    ) -> AppResult<(PathBuf, CopyOutcome)> {
        if from == Some(to) {
            return Err(AppError::invalid(
                "Choose a different account to continue with",
            ));
        }
        let to_id = to.hyphenated().to_string();
        let target = store::require_account(&self.db.conn(), &to_id)?;
        if target.auth_status != AuthStatus::Authenticated {
            return Err(AppError::AuthRequired);
        }
        let to_dir = self.paths.verify_profile_dir(&to, &target.config_dir)?;
        let from_dir = match from {
            Some(uuid) => {
                let source =
                    store::require_account(&self.db.conn(), &uuid.hyphenated().to_string())?;
                self.paths.verify_profile_dir(&uuid, &source.config_dir)?
            }
            None => self
                .default_config_dir()
                .ok_or_else(|| AppError::NotFound("Conversation".into()))?,
        };
        let outcome = transcripts::copy(&from_dir, &to_dir, cwd, session)?;
        log::info!(
            "conversation {} handed to account {to_id} ({outcome:?})",
            session.hyphenated()
        );
        Ok((to_dir, outcome))
    }

    /// [`Self::hand_over_parsed`] for the editor extension, which resumes the
    /// conversation itself. `dir` must come from
    /// [`Self::validate_working_dir`].
    pub fn hand_over(
        &self,
        dir: &Path,
        session_id: &str,
        from_account_id: Option<&str>,
        to_account_id: &str,
    ) -> AppResult<CopyOutcome> {
        let session = parse_id(session_id, "Conversation")?;
        let from = from_account_id
            .map(|a| parse_id(a, "Account"))
            .transpose()?;
        let to = parse_id(to_account_id, "Account")?;
        let (_, outcome) = self.hand_over_parsed(dir, &session, from, to)?;
        Ok(outcome)
    }

    /// Continues a conversation with another account: copies it into that
    /// account's profile, then resumes it there in a Claude Switch terminal
    /// (`claude --resume <id>`) or in an editor's Claude Code extension.
    ///
    /// Nothing is ever resumed with an account that is not signed in, and the
    /// source profile is only read.
    pub fn continue_conversation(
        &self,
        input: ContinueConversationInput,
    ) -> AppResult<ContinueConversationResult> {
        let session = parse_id(&input.session_id, "Conversation")?;
        let session_id = session.hyphenated().to_string();
        let project_id = parse_id(&input.project_id, "Project")?
            .hyphenated()
            .to_string();
        let to_uuid = parse_id(&input.to_account_id, "Account")?;
        let to_id = to_uuid.hyphenated().to_string();
        let from = input
            .from_account_id
            .as_deref()
            .map(|a| parse_id(a, "Account"))
            .transpose()?;
        let message = validate_continue_message(input.message.as_deref())?;
        let size = validate_terminal_size(input.cols, input.rows)?;

        let project = store::require_project(&self.db.conn(), &project_id)?;
        let cwd = PathBuf::from(&project.directory);
        if !cwd.is_dir() {
            return Err(AppError::ProjectDirMissing(project.directory));
        }
        let editor = input
            .editor_id
            .as_deref()
            .map(|id| self.find_editor(id))
            .transpose()?;

        let (to_dir, outcome) = self.hand_over_parsed(&cwd, &session, from, to_uuid)?;
        let copied = outcome != CopyOutcome::Unchanged;

        let Some(editor) = editor else {
            let info = self.start_from_spec(
                LaunchSpec {
                    account_id: to_id,
                    project_id: Some(project_id),
                    kind: SessionKind::Claude,
                    continue_last: false,
                    login: None,
                    resume: Some(session_id),
                    prompt: message,
                },
                size,
            )?;
            return Ok(ContinueConversationResult {
                session: Some(info),
                copied,
            });
        };

        self.write_editor_account(&editor, Some((&to_id, &to_dir)))?;
        let link = editors::claude_open_url(editor.url_scheme, &session_id, message.as_deref());
        self.run_editor(&editor, &[cwd.as_os_str()], &to_dir, &cwd, Some(link))?;
        log::info!("opened conversation {session_id} in {}", editor.id);
        self.record_editor_use(&editor, &to_id, &project_id)?;
        Ok(ContinueConversationResult {
            session: None,
            copied,
        })
    }

    // -----------------------------------------------------------------------
    // Projects
    // -----------------------------------------------------------------------

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let mut projects = store::list_projects(&self.db.conn())?;
        let (_, counts) = self.running_counts();
        for p in &mut projects {
            p.running_sessions = counts.get(&p.id).copied().unwrap_or(0);
        }
        Ok(projects)
    }

    /// Registers a directory chosen in the native picker. The directory is
    /// never modified.
    pub fn add_project(&self, dir: &Path) -> AppResult<Project> {
        let canonical = fs::canonicalize(dir)
            .map_err(|_| AppError::ProjectDirMissing(dir.display().to_string()))?;
        if !canonical.is_dir() {
            return Err(AppError::invalid("A project must be a directory"));
        }
        if canonical == Path::new("/") {
            return Err(AppError::invalid("The root directory cannot be a project"));
        }
        if self.paths.is_managed_path(&canonical) {
            return Err(AppError::PermissionDenied(
                "Claude Switch's own data folders cannot be added as projects".into(),
            ));
        }
        let dir_str = canonical
            .to_str()
            .ok_or_else(|| AppError::invalid("The project path is not valid UTF-8"))?
            .to_string();
        if let Some(existing) = store::get_project_by_directory(&self.db.conn(), &dir_str)? {
            return Ok(existing);
        }
        let name = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| validate_name(n, "Project").ok())
            .unwrap_or_else(|| "Project".to_string());
        let id = Uuid::new_v4().hyphenated().to_string();
        store::insert_project(&self.db.conn(), &id, &name, &dir_str, &clock::now())?;
        self.emit(CoreEvent::Changed(ChangeScope::Projects));
        store::require_project(&self.db.conn(), &id)
    }

    pub fn update_project(&self, input: UpdateProjectInput) -> AppResult<Project> {
        let id = parse_id(&input.id, "Project")?.hyphenated().to_string();
        let conn = self.db.conn();
        let current = store::require_project(&conn, &id)?;
        let name = match input.name.as_deref() {
            Some(n) => validate_name(n, "Project")?,
            None => current.name.clone(),
        };
        let default_account = match input.default_account_id.as_deref() {
            None => current.default_account_id.clone(),
            Some("") => None,
            Some(raw) => {
                let aid = parse_id(raw, "Account")?.hyphenated().to_string();
                store::require_account(&conn, &aid)?;
                Some(aid)
            }
        };
        store::update_project_fields(
            &conn,
            &id,
            &name,
            input.favorite.unwrap_or(current.favorite),
            default_account.as_deref(),
            &clock::now(),
        )?;
        let project = store::require_project(&conn, &id)?;
        drop(conn);
        self.emit(CoreEvent::Changed(ChangeScope::Projects));
        Ok(project)
    }

    /// Removes a project from the app. Never touches the directory.
    pub fn remove_project(&self, id: &str) -> AppResult<()> {
        let id = parse_id(id, "Project")?.hyphenated().to_string();
        store::delete_project(&self.db.conn(), &id)?;
        self.emit(CoreEvent::Changed(ChangeScope::Projects));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    fn with_live_state(&self, mut s: SessionInfo) -> SessionInfo {
        s.attached = self.pty.is_tracked(&s.id);
        s.usage_limit_reached = lock(&self.limit_hits).contains(&s.id);
        s
    }

    pub fn list_sessions(&self, input: ListSessionsInput) -> AppResult<Vec<SessionInfo>> {
        let account = input
            .account_id
            .as_deref()
            .map(|a| parse_id(a, "Account").map(|u| u.hyphenated().to_string()))
            .transpose()?;
        let project = input
            .project_id
            .as_deref()
            .map(|p| parse_id(p, "Project").map(|u| u.hyphenated().to_string()))
            .transpose()?;
        let limit = input.limit.unwrap_or(50).clamp(1, 500);
        let sessions = store::list_sessions(
            &self.db.conn(),
            account.as_deref(),
            project.as_deref(),
            limit,
        )?;
        Ok(sessions
            .into_iter()
            .map(|s| self.with_live_state(s))
            .collect())
    }

    /// Sessions currently held in memory (running, or exited with an open tab).
    pub fn tracked_sessions(&self) -> AppResult<Vec<SessionInfo>> {
        let conn = self.db.conn();
        let mut out = Vec::new();
        for id in self.pty.tracked_ids() {
            if let Some(s) = store::get_session(&conn, &id)? {
                out.push(s);
            }
        }
        drop(conn);
        out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        Ok(out.into_iter().map(|s| self.with_live_state(s)).collect())
    }

    pub fn start_session(&self, input: StartSessionInput) -> AppResult<SessionInfo> {
        let uuid = parse_id(&input.account_id, "Account")?;
        let account_id = uuid.hyphenated().to_string();
        let project_id = input
            .project_id
            .as_deref()
            .map(|p| parse_id(p, "Project").map(|u| u.hyphenated().to_string()))
            .transpose()?;
        self.start_from_spec(
            LaunchSpec {
                account_id,
                project_id,
                kind: input.kind,
                continue_last: input.continue_last.unwrap_or(false),
                login: None,
                resume: None,
                prompt: None,
            },
            (input.cols, input.rows),
        )
    }

    fn start_from_spec(&self, spec: LaunchSpec, size: (u16, u16)) -> AppResult<SessionInfo> {
        let size = validate_terminal_size(size.0, size.1)?;
        if spec.kind == SessionKind::Login {
            let (method, email) = spec.login.clone().unwrap_or((LoginMethod::Claudeai, None));
            return self.start_login(StartLoginInput {
                account_id: spec.account_id,
                method,
                email,
                cols: size.0,
                rows: size.1,
            });
        }
        let uuid = parse_id(&spec.account_id, "Account")?;
        let account = store::require_account(&self.db.conn(), &spec.account_id)?;
        // Never fall back to another directory (or to the global ~/.claude).
        let dir = self.paths.verify_profile_dir(&uuid, &account.config_dir)?;

        let project = match &spec.project_id {
            Some(pid) => {
                let project = store::require_project(&self.db.conn(), pid)?;
                if !Path::new(&project.directory).is_dir() {
                    return Err(AppError::ProjectDirMissing(project.directory));
                }
                Some(project)
            }
            None => None,
        };
        let cwd = project
            .as_ref()
            .map(|p| PathBuf::from(&p.directory))
            .unwrap_or_else(|| self.paths.home.clone());

        let (program, exe, title) = match spec.kind {
            SessionKind::Claude => {
                let exe = self.cli()?;
                let mut args = Vec::new();
                if let Some(id) = &spec.resume {
                    args.extend(["--resume".to_string(), id.clone()]);
                } else if spec.continue_last {
                    args.push("--continue".to_string());
                }
                // Validated not to look like a flag.
                args.extend(spec.prompt.clone());
                let title = project
                    .as_ref()
                    .map_or_else(|| account.name.clone(), |p| p.name.clone());
                (
                    Program::Executable {
                        path: exe.path.clone(),
                        args,
                    },
                    Some(exe),
                    title,
                )
            }
            SessionKind::Shell => {
                let title = format!(
                    "Shell · {}",
                    project.as_ref().map_or("~", |p| p.name.as_str())
                );
                (Program::LoginShell, self.cli().ok(), title)
            }
            SessionKind::Login => unreachable!("handled above"),
        };
        self.launch(Launch {
            spec,
            account: &account,
            project: project.as_ref(),
            config_dir: &dir,
            cwd,
            program,
            exe: exe.as_ref(),
            title,
            size,
            follow_login: false,
        })
    }

    fn launch(&self, launch: Launch<'_>) -> AppResult<SessionInfo> {
        let Launch {
            spec,
            account,
            project,
            config_dir,
            cwd,
            program,
            exe,
            title,
            size: (cols, rows),
            follow_login,
        } = launch;
        let config_dir = config_dir
            .to_str()
            .ok_or_else(|| AppError::InvalidConfigDir("profile path is not valid UTF-8".into()))?;
        let mut env = self.env_for(config_dir, exe, true);
        if matches!(program, Program::LoginShell) {
            env.insert("SHELL".into(), self.login_shell());
        }
        let session_id = Uuid::new_v4().hyphenated().to_string();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let now = clock::now();

        {
            let mut conn = self.db.conn();
            let tx = conn.transaction()?;
            store::insert_session(
                &tx,
                &NewSession {
                    id: &session_id,
                    account_id: &account.id,
                    project_id: project.map(|p| p.id.as_str()),
                    kind: spec.kind,
                    title: &title,
                    working_dir: &cwd_str,
                    now: &now,
                },
            )?;
            store::touch_account_used(&tx, &account.id, &now)?;
            if let Some(p) = project {
                store::touch_project_used(&tx, &p.id, &account.id, &now)?;
            }
            tx.commit()?;
        }
        lock(&self.launches).insert(session_id.clone(), spec.clone());
        let tap = if follow_login {
            Some(self.login_tap(&session_id, &account.id))
        } else if spec.kind == SessionKind::Claude {
            Some(self.usage_limit_tap(&session_id))
        } else {
            None
        };

        let spawned = self.pty.spawn(SpawnRequest {
            id: session_id.clone(),
            program,
            cwd,
            env,
            cols,
            rows,
            tap,
        });
        let info = match spawned {
            Ok(pid) => {
                log::info!(
                    "started {} session {session_id} for account {} (pid {pid})",
                    spec.kind.as_str(),
                    account.id
                );
                let conn = self.db.conn();
                let update = SessionUpdate {
                    process_id: Some(pid),
                    ..Default::default()
                };
                match store::transition_session(&conn, &session_id, SessionStatus::Running, &update)
                {
                    Ok(s) => s,
                    // The process may already have exited and been recorded.
                    Err(AppError::Conflict(_)) => store::get_session(&conn, &session_id)?
                        .ok_or_else(|| AppError::NotFound("Session".into()))?,
                    Err(e) => return Err(e),
                }
            }
            Err(err) => {
                log::warn!("failed to start session {session_id}: {err}");
                lock(&self.launches).remove(&session_id);
                lock(&self.logins).remove(&session_id);
                let update = SessionUpdate {
                    ended_at: Some(clock::now()),
                    error: Some(err.to_string()),
                    ..Default::default()
                };
                let failed = store::transition_session(
                    &self.db.conn(),
                    &session_id,
                    SessionStatus::Failed,
                    &update,
                );
                if let Ok(failed) = failed {
                    self.emit(CoreEvent::SessionUpdated(failed));
                }
                self.emit(CoreEvent::Changed(ChangeScope::Sessions));
                return Err(err);
            }
        };
        let info = self.with_live_state(info);
        self.emit(CoreEvent::SessionUpdated(info.clone()));
        self.emit(CoreEvent::Changed(ChangeScope::Sessions));
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        if project.is_some() {
            self.emit(CoreEvent::Changed(ChangeScope::Projects));
        }
        Ok(info)
    }

    fn require_tracked(&self, id: &str) -> AppResult<String> {
        let id = parse_id(id, "Session")?.hyphenated().to_string();
        if !self.pty.is_tracked(&id) {
            return Err(AppError::NotFound("Session".into()));
        }
        Ok(id)
    }

    pub fn attach_session(&self, id: &str, sink: OutputSink) -> AppResult<()> {
        let id = self.require_tracked(id)?;
        self.pty.attach(&id, sink)
    }

    pub fn write_session(&self, id: &str, data: &str, binary: bool) -> AppResult<()> {
        let id = self.require_tracked(id)?;
        if data.len() > MAX_WRITE_BYTES {
            return Err(AppError::invalid("Input is too large"));
        }
        if binary {
            let bytes = data
                .chars()
                .map(|c| u8::try_from(u32::from(c)))
                .collect::<Result<Vec<u8>, _>>()
                .map_err(|_| AppError::invalid("Binary input must be byte-valued"))?;
            self.pty.write(&id, &bytes)
        } else {
            self.pty.write(&id, data.as_bytes())
        }
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let id = self.require_tracked(id)?;
        let (cols, rows) = validate_terminal_size(cols, rows)?;
        self.pty.resize(&id, cols, rows)
    }

    /// Stops a running session and waits for it to exit.
    pub fn stop_session(&self, id: &str) -> AppResult<()> {
        let id = self.require_tracked(id)?;
        if !self.pty.is_running(&id) {
            return Ok(());
        }
        lock(&self.stop_requested).insert(id.clone());
        if let Ok(s) = store::transition_session(
            &self.db.conn(),
            &id,
            SessionStatus::Stopping,
            &SessionUpdate::default(),
        ) {
            self.emit(CoreEvent::SessionUpdated(self.with_live_state(s)));
        }
        log::info!("stopping session {id}");
        self.pty.terminate(&id, STOP_GRACE)
    }

    /// Starts a fresh session with the same account, project and kind.
    pub fn restart_session(&self, id: &str, cols: u16, rows: u16) -> AppResult<SessionInfo> {
        let id = parse_id(id, "Session")?.hyphenated().to_string();
        let spec = match lock(&self.launches).get(&id).cloned() {
            Some(spec) => LaunchSpec {
                prompt: None,
                ..spec
            },
            None => {
                let s = store::get_session(&self.db.conn(), &id)?
                    .ok_or_else(|| AppError::NotFound("Session".into()))?;
                LaunchSpec {
                    account_id: s.account_id,
                    project_id: s.project_id,
                    kind: s.kind,
                    continue_last: false,
                    login: None,
                    resume: None,
                    prompt: None,
                }
            }
        };
        if self.pty.is_tracked(&id) {
            self.close_session(&id)?;
        }
        self.start_from_spec(spec, (cols, rows))
    }

    /// Stops the session if needed and releases its terminal.
    pub fn close_session(&self, id: &str) -> AppResult<()> {
        let id = self.require_tracked(id)?;
        if self.pty.is_running(&id) {
            self.stop_session(&id)?;
        }
        self.pty.remove(&id)?;
        lock(&self.launches).remove(&id);
        lock(&self.logins).remove(&id);
        lock(&self.limit_hits).remove(&id);
        self.emit(CoreEvent::Changed(ChangeScope::Sessions));
        Ok(())
    }

    pub fn running_session_count(&self) -> usize {
        self.pty.running_ids().len()
    }

    /// Stops every running session. Used when the app quits.
    pub fn stop_all_sessions(&self) {
        let running = self.pty.running_ids();
        if running.is_empty() {
            return;
        }
        log::info!("stopping {} sessions for shutdown", running.len());
        {
            let mut stops = lock(&self.stop_requested);
            stops.extend(running.iter().cloned());
        }
        self.pty.terminate_all(STOP_GRACE);
    }

    fn handle_exit(&self, session_id: &str, exit: &ExitInfo) {
        let user_stopped = lock(&self.stop_requested).remove(session_id);
        let update = SessionUpdate {
            ended_at: Some(clock::now()),
            exit_code: exit.code,
            exit_signal: exit.signal.clone(),
            error: exit.error.clone(),
            ..Default::default()
        };
        let session = match store::transition_session(
            &self.db.conn(),
            session_id,
            SessionStatus::Exited,
            &update,
        ) {
            Ok(s) => self.with_live_state(s),
            Err(e) => {
                log::warn!("could not record exit of session {session_id}: {e}");
                return;
            }
        };
        log::info!(
            "session {session_id} exited (code {:?}, signal {:?})",
            exit.code,
            exit.signal
        );
        self.emit(CoreEvent::SessionUpdated(session.clone()));
        self.emit(CoreEvent::Changed(ChangeScope::Sessions));
        self.emit(CoreEvent::Changed(ChangeScope::Accounts));
        self.emit(CoreEvent::Changed(ChangeScope::Projects));

        let Ok(uuid) = parse_id(&session.account_id, "Account") else {
            return;
        };
        let Ok(account) = store::require_account(&self.db.conn(), &session.account_id) else {
            return;
        };

        match session.kind {
            SessionKind::Login => {
                let mut obs = self.observe_auth(&uuid, &account);
                let signed_in = matches!(
                    obs.status,
                    AuthStatus::Authenticated | AuthStatus::UnsupportedIsolation
                );
                if !signed_in {
                    let reported = lock(&self.logins)
                        .get(session_id)
                        .and_then(|p| lock(p).progress().message.clone());
                    obs.status = AuthStatus::Failed;
                    obs.detail = Some(if user_stopped {
                        "Sign-in was cancelled.".to_string()
                    } else if let Some(reported) = reported {
                        reported
                    } else if exit.success() {
                        "Claude Code finished without a stored login.".to_string()
                    } else {
                        "Sign-in did not complete. Try again.".to_string()
                    });
                }
                self.finish_login(session_id, signed_in, obs.detail.as_deref());
                if let Err(e) = store::record_auth_observation(
                    &self.db.conn(),
                    &account.id,
                    &obs,
                    &clock::now(),
                ) {
                    log::warn!("could not record login result: {e}");
                }
                self.emit(CoreEvent::Changed(ChangeScope::Accounts));
                if signed_in {
                    if let Ok(account) = self.account(&account.id) {
                        self.emit(CoreEvent::LoginCompleted { account });
                    }
                }
            }
            SessionKind::Claude => {
                // The user may have run /login or /logout inside Claude Code.
                let obs = self.observe_auth(&uuid, &account);
                if let Err(e) = store::record_auth_observation(
                    &self.db.conn(),
                    &account.id,
                    &obs,
                    &clock::now(),
                ) {
                    log::warn!("could not record status after session exit: {e}");
                }
                self.emit(CoreEvent::Changed(ChangeScope::Accounts));
                if !user_stopped {
                    self.emit(CoreEvent::SessionFinished {
                        session,
                        account_name: account.name.clone(),
                    });
                }
            }
            SessionKind::Shell => {
                if !user_stopped {
                    self.emit(CoreEvent::SessionFinished {
                        session,
                        account_name: account.name.clone(),
                    });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // System
    // -----------------------------------------------------------------------

    fn known_account_ids(&self) -> Vec<Uuid> {
        self.list_accounts()
            .unwrap_or_default()
            .iter()
            .filter_map(|a| Uuid::parse_str(&a.id).ok())
            .collect()
    }

    pub fn system_warnings(&self, cli: &CliStatus) -> Vec<SystemWarning> {
        let mut warnings = Vec::new();
        let anthropic_dir = self
            .inherited_env
            .iter()
            .find(|(k, _)| k == "ANTHROPIC_CONFIG_DIR")
            .map(|(_, v)| PathBuf::from(v))
            .unwrap_or_else(|| self.paths.home.join(".config/anthropic"));
        // Existence check only; the directory's contents are never read.
        if anthropic_dir.exists() {
            warnings.push(SystemWarning {
                code: SystemWarningCode::AnthropicProfilesPresent,
                message: format!(
                    "Anthropic profiles exist in {}. They are stored outside account profiles and shared by all of them; some (such as Workload Identity Federation profiles or one named by ANTHROPIC_PROFILE) take precedence over each account's own login.",
                    anthropic_dir.display()
                ),
            });
        }
        let managed = [
            "/Library/Application Support/ClaudeCode/managed-settings.json",
            "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        ];
        if let Some(found) = managed.iter().find(|p| Path::new(p).exists()) {
            warnings.push(SystemWarning {
                code: SystemWarningCode::ManagedSettingsPresent,
                message: format!(
                    "Managed Claude Code settings were found ({found}). Your organization's policy can force a login method or organization, or override the configuration directory for every account."
                ),
            });
        }
        if let Some(version) = cli.version.as_deref().and_then(cli::version_tuple) {
            if version < cli::TESTED_MIN_VERSION {
                warnings.push(SystemWarning {
                    code: SystemWarningCode::CliVersionUntested,
                    message: format!(
                        "Claude Code {} is older than the versions Claude Switch was tested with. Update it with `claude update`.",
                        cli.version.as_deref().unwrap_or_default()
                    ),
                });
            }
        }
        warnings
    }

    pub fn system_info(&self, app_version: &str) -> SystemInfo {
        let cli = self.cli_status();
        let warnings = self.system_warnings(&cli);
        SystemInfo {
            app_version: app_version.to_string(),
            os_version: os_version().unwrap_or_else(|| "unknown".into()),
            arch: std::env::consts::ARCH.to_string(),
            home_dir: self.paths.home.display().to_string(),
            data_dir: self.paths.data_dir.display().to_string(),
            profiles_dir: self.paths.profiles_root.display().to_string(),
            logs_dir: self.paths.logs_dir.display().to_string(),
            env_conflicts: self.env_conflicts(),
            warnings,
            orphaned_profiles: self
                .paths
                .orphaned_profile_dirs(&self.known_account_ids())
                .unwrap_or_default()
                .iter()
                .map(|p| p.display().to_string())
                .collect(),
            editors: self.editors(),
            extension_package_available: self.extension_package().is_some(),
            cli,
        }
    }

    /// A support report with no names, emails, tokens, URLs, environment
    /// values, or terminal content.
    pub fn diagnostics(&self, app_version: &str) -> String {
        let info = self.system_info(app_version);
        let settings = self.settings();
        let accounts = self.list_accounts().unwrap_or_default();
        let projects = self.list_projects().unwrap_or_default();
        let mut by_status: BTreeMap<&str, usize> = BTreeMap::new();
        let mut by_method: BTreeMap<String, usize> = BTreeMap::new();
        for a in &accounts {
            *by_status.entry(a.auth_status.as_str()).or_default() += 1;
            *by_method
                .entry(a.auth_method.clone().unwrap_or_else(|| "none".into()))
                .or_default() += 1;
        }
        let mut out = String::new();
        let mut line = |s: String| {
            out.push_str(&s);
            out.push('\n');
        };
        line("Claude Switch diagnostics".into());
        line(format!("Generated: {}", clock::now()));
        line(format!("App version: {}", info.app_version));
        line(format!("macOS: {} ({})", info.os_version, info.arch));
        line(format!(
            "Claude Code: {:?}, version {}, source {:?}, path {}",
            info.cli.state,
            info.cli.version.as_deref().unwrap_or("-"),
            info.cli.source,
            info.cli.path.as_deref().unwrap_or("-")
        ));
        if let Some(msg) = &info.cli.message {
            line(format!("Claude Code message: {msg}"));
        }
        line(format!("Data directory: {}", info.data_dir));
        line(format!("Profiles directory: {}", info.profiles_dir));
        line(format!("Accounts: {} {:?}", accounts.len(), by_status));
        line(format!("Auth methods: {by_method:?}"));
        line(format!("Projects: {}", projects.len()));
        line(format!(
            "Running sessions: {}",
            self.running_session_count()
        ));
        line(format!(
            "Orphaned profile directories: {}",
            info.orphaned_profiles.len()
        ));
        line(format!(
            "Dropped inherited variables (names only): {}",
            if info.env_conflicts.is_empty() {
                "none".to_string()
            } else {
                info.env_conflicts
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ));
        line(format!(
            "Custom environment variables (values hidden): {}",
            settings
                .custom_env
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
        line(format!(
            "Extra PATH entries: {}",
            settings.extra_path_entries.len()
        ));
        line(format!("Close behavior: {:?}", settings.close_behavior));
        for w in &info.warnings {
            line(format!("Warning [{:?}]: {}", w.code, w.message));
        }
        line(String::new());
        line("Recent log (redacted):".into());
        for l in logging::tail(&self.paths.logs_dir, 80) {
            line(l);
        }
        out
    }
}

/// The account an editor's Claude Code extension is set to, from its user
/// settings.
fn editor_account(editor: &EditorInfo, accounts: &[Account]) -> EditorAccount {
    let text = match fs::read_to_string(&editor.settings_file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return EditorAccount::window(),
        Err(e) => {
            return EditorAccount {
                mode: EditorAccountMode::Unreadable,
                account_id: None,
                detail: Some(e.to_string()),
            }
        }
    };
    match editor_settings::read_config_dir(&text) {
        Ok(None) => EditorAccount::window(),
        Ok(Some(dir)) => match accounts
            .iter()
            .find(|a| Path::new(&a.config_dir) == Path::new(&dir))
        {
            Some(account) => EditorAccount {
                mode: EditorAccountMode::Account,
                account_id: Some(account.id.clone()),
                detail: None,
            },
            None => EditorAccount {
                mode: EditorAccountMode::Custom,
                account_id: None,
                detail: Some(dir),
            },
        },
        Err(e) => EditorAccount {
            mode: EditorAccountMode::Unreadable,
            account_id: None,
            detail: Some(e.to_string()),
        },
    }
}

fn os_version() -> Option<String> {
    let name = std::ffi::CString::new("kern.osproductversion").ok()?;
    let mut size: libc::size_t = 0;
    // SAFETY: sysctlbyname is called first to size the buffer, then to fill it.
    unsafe {
        if libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
        let mut buf = vec![0u8; size];
        if libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
        buf.truncate(size);
        let s = String::from_utf8_lossy(&buf)
            .trim_end_matches('\0')
            .to_string();
        Some(s)
    }
}
