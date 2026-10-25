//! IPC command handlers. Each handler is a thin adapter: it validates the
//! shape of its input (IDs and paths are re-validated in `AppCore`), runs the
//! blocking work off the main thread, and returns typed results or errors.
//!
//! There is deliberately no generic "run command" or "read file" handler.

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

use crate::cli::CliStatus;
use crate::core::{AppCore, SystemInfo};
use crate::desktop;
use crate::domain::*;
use crate::error::{AppError, AppResult};
use crate::login::LoginProgress;
use crate::settings::{AppSettings, SettingsPatch};

/// Holds the core, or the error that prevented it from starting (for
/// example a corrupted database), which every command then reports.
pub struct AppState {
    pub core: Result<Arc<AppCore>, AppError>,
}

impl AppState {
    fn core(&self) -> AppResult<Arc<AppCore>> {
        self.core.clone()
    }
}

async fn blocking<T, F>(state: &State<'_, AppState>, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Arc<AppCore>) -> AppResult<T> + Send + 'static,
{
    let core = state.core()?;
    tauri::async_runtime::spawn_blocking(move || f(core))
        .await
        .map_err(|e| AppError::Io(format!("background task failed: {e}")))?
}

fn app_version<R: Runtime>(app: &AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_system_info<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> AppResult<SystemInfo> {
    let version = app_version(&app);
    blocking(&state, move |core| Ok(core.system_info(&version))).await
}

#[tauri::command]
pub async fn refresh_cli_detection(state: State<'_, AppState>) -> AppResult<CliStatus> {
    blocking(&state, |core| Ok(core.refresh_cli())).await
}

#[tauri::command]
pub async fn get_diagnostics<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let version = app_version(&app);
    blocking(&state, move |core| Ok(core.diagnostics(&version))).await
}

/// Opens a web link (from terminal output) in the default browser. Only
/// http(s) URLs are allowed. URLs are never logged: they can be login links.
#[tauri::command]
pub fn open_external_url<R: Runtime>(app: AppHandle<R>, url: String) -> AppResult<()> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| AppError::invalid("Not a valid URL"))?;
    if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
        return Err(AppError::invalid("Only web links can be opened"));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| AppError::Io(format!("could not open the link: {e}")))
}

#[derive(Debug, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum RevealTarget {
    Profile {
        #[serde(rename = "accountId")]
        #[ts(rename = "accountId")]
        account_id: String,
    },
    Project {
        #[serde(rename = "projectId")]
        #[ts(rename = "projectId")]
        project_id: String,
    },
    DataDir,
    LogsDir,
    ProfilesDir,
}

/// Shows a managed directory or a registered project in Finder. Paths are
/// resolved here from IDs; the frontend never supplies a path.
#[tauri::command]
pub async fn reveal_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    target: RevealTarget,
) -> AppResult<()> {
    let path = blocking(&state, move |core| {
        Ok(match target {
            RevealTarget::Profile { account_id } => {
                let uuid = parse_id(&account_id, "Account")?;
                let account = core
                    .list_accounts()?
                    .into_iter()
                    .find(|a| a.id == uuid.hyphenated().to_string())
                    .ok_or_else(|| AppError::NotFound("Account".into()))?;
                core.paths.verify_profile_dir(&uuid, &account.config_dir)?
            }
            RevealTarget::Project { project_id } => {
                let uuid = parse_id(&project_id, "Project")?.hyphenated().to_string();
                let project = core
                    .list_projects()?
                    .into_iter()
                    .find(|p| p.id == uuid)
                    .ok_or_else(|| AppError::NotFound("Project".into()))?;
                if !project.exists {
                    return Err(AppError::ProjectDirMissing(project.directory));
                }
                project.directory.into()
            }
            RevealTarget::DataDir => core.paths.data_dir.clone(),
            RevealTarget::LogsDir => core.paths.logs_dir.clone(),
            RevealTarget::ProfilesDir => core.paths.profiles_root.clone(),
        })
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::Io(format!("could not show the folder: {e}")))
}

/// Lets the user choose the Claude Code executable in a native dialog.
#[tauri::command]
pub async fn pick_claude_executable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> AppResult<Option<CliStatus>> {
    blocking(&state, move |core| {
        let picked = app
            .dialog()
            .file()
            .set_title("Choose the Claude Code executable")
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|_| AppError::invalid("Unsupported file location"))?;
        let path = path
            .to_str()
            .ok_or_else(|| AppError::invalid("The path is not valid UTF-8"))?
            .to_string();
        crate::cli::validate_configured(&path)?;
        core.update_settings(SettingsPatch {
            claude_executable_path: Some(path),
            ..Default::default()
        })?;
        Ok(Some(core.cli_status()))
    })
    .await
}

/// Starts quitting. With `confirmed`, stops all sessions and exits; without,
/// asks the UI to confirm first when sessions are running.
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>, confirmed: Option<bool>) {
    if confirmed == Some(true) {
        desktop::confirm_quit(&app);
    } else {
        desktop::request_quit(&app);
    }
}

/// Called once the UI has rendered; shows the window unless the app was
/// launched in the background (at login).
#[tauri::command]
pub fn frontend_ready<R: Runtime>(app: AppHandle<R>) {
    log::info!("user interface ready");
    desktop::reveal_initial_window(&app);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    blocking(&state, |core| Ok(core.settings())).await
}

#[tauri::command]
pub async fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> AppResult<AppSettings> {
    if let Some(shortcut) = patch.global_shortcut.as_deref() {
        desktop::validate_shortcut(shortcut)?;
    }
    let shortcut_changed = patch.global_shortcut.is_some();
    let autostart_changed = patch.launch_at_login.is_some();
    let previous = state.core()?.settings();
    let next = blocking(&state, move |core| core.update_settings(patch)).await?;

    if shortcut_changed {
        if let Err(e) = desktop::apply_global_shortcut(&app, next.global_shortcut.as_deref()) {
            // Roll back so the stored setting matches what is registered.
            let core = state.core()?;
            let restored = core.update_settings(SettingsPatch {
                global_shortcut: Some(previous.global_shortcut.clone().unwrap_or_default()),
                ..Default::default()
            })?;
            let _ = desktop::apply_global_shortcut(&app, restored.global_shortcut.as_deref());
            return Err(e);
        }
    }
    if autostart_changed {
        desktop::apply_autostart(&app, next.launch_at_login)?;
    }
    Ok(next)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> AppResult<Vec<Account>> {
    blocking(&state, |core| core.list_accounts()).await
}

#[tauri::command]
pub async fn create_account(
    state: State<'_, AppState>,
    input: CreateAccountInput,
) -> AppResult<Account> {
    blocking(&state, move |core| core.create_account(input)).await
}

#[tauri::command]
pub async fn update_account(
    state: State<'_, AppState>,
    input: UpdateAccountInput,
) -> AppResult<Account> {
    blocking(&state, move |core| core.update_account(input)).await
}

#[tauri::command]
pub async fn reorder_accounts(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<Account>> {
    if ids.len() > 1000 {
        return Err(AppError::invalid("Too many accounts"));
    }
    blocking(&state, move |core| core.reorder_accounts(ids)).await
}

#[tauri::command]
pub async fn delete_account(
    state: State<'_, AppState>,
    input: DeleteAccountInput,
) -> AppResult<()> {
    blocking(&state, move |core| core.delete_account(input)).await
}

#[tauri::command]
pub async fn refresh_auth_status(state: State<'_, AppState>, id: String) -> AppResult<Account> {
    blocking(&state, move |core| core.refresh_auth_status(&id)).await
}

#[tauri::command]
pub async fn get_login_progress(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<LoginProgress> {
    blocking(&state, move |core| core.login_progress(&session_id)).await
}

/// Sends the authorization code from the browser to a running sign-in.
#[tauri::command]
pub async fn submit_login_code(
    state: State<'_, AppState>,
    session_id: String,
    code: String,
) -> AppResult<LoginProgress> {
    blocking(&state, move |core| {
        core.submit_login_code(&session_id, &code)
    })
    .await
}

#[tauri::command]
pub async fn open_in_editor(
    state: State<'_, AppState>,
    input: OpenInEditorInput,
) -> AppResult<OpenInEditorResult> {
    blocking(&state, move |core| core.open_in_editor(input)).await
}

/// Installs the Claude Switch extension in a detected editor.
#[tauri::command]
pub async fn install_editor_extension(
    state: State<'_, AppState>,
    editor_id: String,
) -> AppResult<crate::editors::EditorInfo> {
    blocking(&state, move |core| {
        core.install_editor_extension(&editor_id)
    })
    .await
}

/// Chooses the account of an editor's Claude Code extension (all windows).
#[tauri::command]
pub async fn set_editor_account(
    state: State<'_, AppState>,
    input: SetEditorAccountInput,
) -> AppResult<()> {
    blocking(&state, move |core| core.set_editor_account(input)).await
}

#[tauri::command]
pub async fn list_conversations(state: State<'_, AppState>) -> AppResult<Vec<Conversation>> {
    blocking(&state, |core| core.list_conversations()).await
}

/// Copies a conversation to another account and resumes it there.
#[tauri::command]
pub async fn continue_conversation(
    state: State<'_, AppState>,
    input: ContinueConversationInput,
) -> AppResult<ContinueConversationResult> {
    blocking(&state, move |core| core.continue_conversation(input)).await
}

#[tauri::command]
pub async fn start_login(
    state: State<'_, AppState>,
    input: StartLoginInput,
) -> AppResult<SessionInfo> {
    blocking(&state, move |core| core.start_login(input)).await
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    blocking(&state, |core| core.list_projects()).await
}

/// Opens the native folder picker and registers the chosen directory.
/// Returns `None` if the user cancels.
#[tauri::command]
pub async fn add_project_via_picker<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> AppResult<Option<Project>> {
    blocking(&state, move |core| {
        let picked = app
            .dialog()
            .file()
            .set_title("Choose a project folder")
            .blocking_pick_folder();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|_| AppError::invalid("Unsupported folder location"))?;
        core.add_project(&path).map(Some)
    })
    .await
}

#[tauri::command]
pub async fn update_project(
    state: State<'_, AppState>,
    input: UpdateProjectInput,
) -> AppResult<Project> {
    blocking(&state, move |core| core.update_project(input)).await
}

#[tauri::command]
pub async fn remove_project(state: State<'_, AppState>, id: String) -> AppResult<()> {
    blocking(&state, move |core| core.remove_project(&id)).await
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    input: ListSessionsInput,
) -> AppResult<Vec<SessionInfo>> {
    blocking(&state, move |core| core.list_sessions(input)).await
}

#[tauri::command]
pub async fn list_open_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    blocking(&state, |core| core.tracked_sessions()).await
}

#[tauri::command]
pub async fn start_session(
    state: State<'_, AppState>,
    input: StartSessionInput,
) -> AppResult<SessionInfo> {
    blocking(&state, move |core| core.start_session(input)).await
}

/// Streams terminal output to `on_output` as raw bytes (an `ArrayBuffer` in
/// JavaScript), starting with buffered output.
#[tauri::command]
pub fn attach_session(
    state: State<'_, AppState>,
    id: String,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let core = state.core()?;
    core.attach_session(
        &id,
        Box::new(move |bytes: &[u8]| {
            on_output
                .send(InvokeResponseBody::Raw(bytes.to_vec()))
                .is_ok()
        }),
    )
}

#[tauri::command]
pub fn write_session(
    state: State<'_, AppState>,
    id: String,
    data: String,
    binary: Option<bool>,
) -> AppResult<()> {
    state
        .core()?
        .write_session(&id, &data, binary.unwrap_or(false))
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.core()?.resize_session(&id, cols, rows)
}

#[tauri::command]
pub async fn stop_session(state: State<'_, AppState>, id: String) -> AppResult<()> {
    blocking(&state, move |core| core.stop_session(&id)).await
}

#[tauri::command]
pub async fn restart_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> AppResult<SessionInfo> {
    blocking(&state, move |core| core.restart_session(&id, cols, rows)).await
}

#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, id: String) -> AppResult<()> {
    blocking(&state, move |core| core.close_session(&id)).await
}

/// Used by tray/menu handlers that need the core outside a command.
pub fn core_from<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<AppCore>> {
    app.try_state::<AppState>()
        .and_then(|s| s.core.as_ref().ok().cloned())
}
