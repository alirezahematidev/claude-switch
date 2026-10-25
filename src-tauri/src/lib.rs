//! Claude Switch: a local-first manager for multiple Claude Code accounts.
//!
//! Layers (outer to inner):
//! * `commands` – Tauri IPC handlers (thin adapters)
//! * `desktop`  – menus, tray, lifecycle, shortcuts, notifications
//! * `core`     – application services and invariants
//! * `store`/`db` – SQLite persistence
//! * `pty`, `cli`, `env`, `paths` – process, CLI, environment and filesystem
//!   services

pub mod cli;
pub mod clock;
pub mod commands;
pub mod core;
pub mod db;
pub mod desktop;
pub mod domain;
pub mod editor_bridge;
pub mod editor_settings;
pub mod editors;
pub mod env;
pub mod error;
pub mod logging;
pub mod login;
pub mod paths;
pub mod pty;
pub mod settings;
pub mod store;
pub mod transcripts;
pub mod usage_limit;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

use crate::commands::AppState;
use crate::core::AppCore;
use crate::db::Database;
use crate::desktop::TauriBridge;
use crate::error::AppResult;
use crate::paths::AppPaths;

fn init_core(app: &tauri::AppHandle) -> AppResult<Arc<AppCore>> {
    let paths = AppPaths::resolve()?;
    paths.ensure()?;
    logging::init(&paths.logs_dir);
    log::info!(
        "starting Claude Switch {} (data: {})",
        app.package_info().version,
        paths.data_dir.display()
    );
    let db = Database::open(&paths.db_path)?;
    AppCore::new(
        paths,
        db,
        Arc::new(TauriBridge { app: app.clone() }),
        env::inherited_env(),
        env::system_path_entries(),
    )
}

/// The packaged editor extension: bundled with release builds, or the one
/// built in the repository (`pnpm ext:package`) for development.
fn extension_package(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    const NAME: &str = "claude-switch-vscode.vsix";
    let bundled = app.path().resource_dir().ok().map(|d| d.join(NAME));
    let dev = cfg!(debug_assertions).then(|| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../vscode-extension")
            .join(NAME)
    });
    [bundled, dev].into_iter().flatten().find(|p| p.is_file())
}

/// Every IPC command the frontend may call. Shared by the app and the IPC
/// integration tests so both exercise the same surface.
pub fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::get_system_info,
        commands::refresh_cli_detection,
        commands::get_diagnostics,
        commands::open_external_url,
        commands::reveal_path,
        commands::pick_claude_executable,
        commands::quit_app,
        commands::frontend_ready,
        commands::get_settings,
        commands::update_settings,
        commands::list_accounts,
        commands::create_account,
        commands::update_account,
        commands::reorder_accounts,
        commands::delete_account,
        commands::refresh_auth_status,
        commands::start_login,
        commands::get_login_progress,
        commands::submit_login_code,
        commands::open_in_editor,
        commands::set_editor_account,
        commands::install_editor_extension,
        commands::list_conversations,
        commands::continue_conversation,
        commands::list_projects,
        commands::add_project_via_picker,
        commands::update_project,
        commands::remove_project,
        commands::list_sessions,
        commands::list_open_sessions,
        commands::start_session,
        commands::attach_session,
        commands::write_session,
        commands::resize_session,
        commands::stop_session,
        commands::restart_session,
        commands::close_session,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first so a second launch focuses this instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![desktop::BACKGROUND_ARG]),
        ))
        .plugin(desktop::global_shortcut_plugin())
        .setup(|app| {
            let handle = app.handle().clone();
            let core = init_core(&handle);
            if let Err(e) = &core {
                eprintln!("Claude Switch failed to start: {e}");
                log::error!("startup failed: {e}");
            }
            app.manage(AppState { core: core.clone() });
            desktop::install_menus(&handle)?;
            if let Ok(core) = core {
                desktop::apply_startup_settings(&handle);
                desktop::start_editor_bridge(&handle, &core);
                core.set_extension_package(extension_package(&handle));
                std::thread::Builder::new()
                    .name("startup".into())
                    .spawn(move || core.startup())?;
            }
            // The UI calls `frontend_ready` once rendered; this is a fallback
            // in case it never does (for example, a broken frontend build).
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                desktop::reveal_initial_window(&fallback);
            });
            Ok(())
        })
        .on_menu_event(desktop::handle_menu_event)
        .on_window_event(desktop::handle_window_event)
        .invoke_handler(invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building Claude Switch");

    app.run(desktop::handle_run_event);
}

/// Exports TypeScript bindings for every IPC type (`yarn bindings`).
#[cfg(test)]
mod export_bindings {
    use ts_rs::TS;

    #[test]
    fn export_bindings() {
        let cfg = ts_rs::Config::from_env();
        crate::domain::Account::export_all(&cfg).unwrap();
        crate::domain::Project::export_all(&cfg).unwrap();
        crate::domain::SessionInfo::export_all(&cfg).unwrap();
        crate::domain::CreateAccountInput::export_all(&cfg).unwrap();
        crate::domain::UpdateAccountInput::export_all(&cfg).unwrap();
        crate::domain::DeleteAccountInput::export_all(&cfg).unwrap();
        crate::domain::StartLoginInput::export_all(&cfg).unwrap();
        crate::domain::StartSessionInput::export_all(&cfg).unwrap();
        crate::domain::UpdateProjectInput::export_all(&cfg).unwrap();
        crate::domain::ListSessionsInput::export_all(&cfg).unwrap();
        crate::settings::AppSettings::export_all(&cfg).unwrap();
        crate::settings::SettingsPatch::export_all(&cfg).unwrap();
        crate::core::SystemInfo::export_all(&cfg).unwrap();
        crate::core::ChangeScope::export_all(&cfg).unwrap();
        crate::commands::RevealTarget::export_all(&cfg).unwrap();
        crate::error::ErrorPayload::export_all(&cfg).unwrap();
        crate::login::LoginProgress::export_all(&cfg).unwrap();
        crate::domain::OpenInEditorInput::export_all(&cfg).unwrap();
        crate::desktop::Notice::export_all(&cfg).unwrap();
        crate::domain::OpenInEditorResult::export_all(&cfg).unwrap();
        crate::domain::SetEditorAccountInput::export_all(&cfg).unwrap();
        crate::domain::Conversation::export_all(&cfg).unwrap();
        crate::domain::ContinueConversationInput::export_all(&cfg).unwrap();
        crate::domain::ContinueConversationResult::export_all(&cfg).unwrap();
        crate::editor_bridge::BridgeStatus::export_all(&cfg).unwrap();
        crate::editor_bridge::BridgeAccount::export_all(&cfg).unwrap();
        crate::editor_bridge::BridgeConversation::export_all(&cfg).unwrap();
        crate::editor_bridge::BridgeHandOver::export_all(&cfg).unwrap();
    }
}
