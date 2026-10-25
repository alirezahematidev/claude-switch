//! macOS desktop integration: menu bar, status-bar (tray) menu, window and
//! quit lifecycle, global shortcut, launch at login, and notifications.
//!
//! Lifecycle policy:
//! * Closing the window hides it by default; sessions keep running and the
//!   app stays available from the Dock and the menu bar. This is
//!   configurable (`CloseBehavior::Quit`).
//! * Quitting stops every session (SIGHUP, then SIGTERM, then SIGKILL to each
//!   process group), after a confirmation when sessions are running.

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{
    AboutMetadataBuilder, IsMenuItem, Menu, MenuBuilder, MenuEvent, MenuItemBuilder,
    PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, Window, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::commands::core_from;
use crate::core::{AppCore, ChangeScope, CoreEvent, UiBridge};
use crate::domain::{SessionKind, StartSessionInput};
use crate::editor_bridge::{BridgeUi, EditorBridge};
use crate::error::{AppError, AppResult};
use crate::settings::CloseBehavior;

pub const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main-tray";
pub const BACKGROUND_ARG: &str = "--background";

/// Events sent to the frontend.
pub mod events {
    pub const STATE_CHANGED: &str = "state-changed";
    pub const SESSION_UPDATED: &str = "session-updated";
    pub const LOGIN_COMPLETED: &str = "login-completed";
    pub const MENU_ACTION: &str = "menu-action";
    pub const FOCUS_SESSION: &str = "focus-session";
    pub const LOGIN_PROGRESS: &str = "login-progress";
    pub const CONFIRM_QUIT: &str = "confirm-quit";
    pub const NOTICE: &str = "notice";
}

/// A message for the UI to show as a toast (errors from menu-bar actions).
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Notice {
    pub title: String,
    pub message: String,
}

static QUITTING: AtomicBool = AtomicBool::new(false);
static MENU_REFRESH_PENDING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Bridge from the core to Tauri
// ---------------------------------------------------------------------------

pub struct TauriBridge {
    pub app: AppHandle,
}

fn window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(MAIN_WINDOW)
        .and_then(|w| Some(w.is_visible().ok()? && w.is_focused().ok()?))
        .unwrap_or(false)
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::debug!("notification failed: {e}");
    }
}

impl UiBridge for TauriBridge {
    fn emit(&self, event: CoreEvent) {
        match event {
            CoreEvent::Changed(scope) => {
                let _ = self.app.emit(events::STATE_CHANGED, scope);
                if matches!(scope, ChangeScope::Accounts | ChangeScope::Projects) {
                    schedule_menu_refresh(&self.app);
                }
            }
            CoreEvent::SessionUpdated(session) => {
                let _ = self.app.emit(events::SESSION_UPDATED, session);
            }
            CoreEvent::SessionFinished {
                session,
                account_name,
            } => {
                let enabled =
                    core_from(&self.app).is_some_and(|c| c.settings().notify_on_session_exit);
                if enabled && !window_focused(&self.app) {
                    let how = match (session.exit_code, session.exit_signal.as_deref()) {
                        (Some(0), _) => "finished".to_string(),
                        (Some(code), _) => format!("exited with code {code}"),
                        (None, Some(sig)) => format!("ended ({sig})"),
                        (None, None) => "ended".to_string(),
                    };
                    notify(
                        &self.app,
                        &session.title,
                        &format!("{account_name}: session {how}"),
                    );
                }
            }
            CoreEvent::LoginProgress(progress) => {
                let _ = self.app.emit(events::LOGIN_PROGRESS, progress);
            }
            CoreEvent::LoginCompleted { account } => {
                let _ = self.app.emit(events::LOGIN_COMPLETED, &account);
                if !window_focused(&self.app) {
                    notify(
                        &self.app,
                        "Signed in",
                        &format!("{} is ready to use", account.name),
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn emit_menu_action(app: &AppHandle, action: &str) {
    let _ = app.emit(events::MENU_ACTION, action);
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

fn item(
    app: &AppHandle,
    id: &str,
    text: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    let mut b = MenuItemBuilder::with_id(id, text);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

fn accounts_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let mut sub = SubmenuBuilder::new(app, "Accounts");
    let accounts = core_from(app)
        .and_then(|c| c.list_accounts().ok())
        .unwrap_or_default();
    for (idx, account) in accounts.iter().enumerate() {
        let accel = (idx < 9).then(|| format!("CmdOrCtrl+{}", idx + 1));
        sub = sub.item(&item(
            app,
            &format!("select-account:{}", account.id),
            &account.name,
            accel.as_deref(),
        )?);
    }
    if !accounts.is_empty() {
        sub = sub.separator();
    }
    sub = sub
        .item(&item(
            app,
            "quick-switch",
            "Switch Account…",
            Some("CmdOrCtrl+P"),
        )?)
        .item(&item(
            app,
            "add-account",
            "Add Account…",
            Some("CmdOrCtrl+Shift+N"),
        )?);
    sub.build()
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("Claude Switch"))
        .version(Some(app.package_info().version.to_string()))
        .comments(Some("Manage multiple Claude Code accounts."))
        .build();
    let app_menu = SubmenuBuilder::new(app, "Claude Switch")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About Claude Switch"),
            Some(about),
        )?)
        .separator()
        .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&item(
            app,
            "app-quit",
            "Quit Claude Switch",
            Some("CmdOrCtrl+Q"),
        )?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(
            app,
            "new-session",
            "New Claude Session",
            Some("CmdOrCtrl+T"),
        )?)
        .item(&item(
            app,
            "new-shell",
            "New Shell",
            Some("CmdOrCtrl+Shift+T"),
        )?)
        .separator()
        .item(&item(
            app,
            "continue-conversation",
            "Continue in Another Account…",
            Some("CmdOrCtrl+Shift+C"),
        )?)
        .separator()
        .item(&item(
            app,
            "add-project",
            "Add Project…",
            Some("CmdOrCtrl+O"),
        )?)
        .separator()
        .item(&item(app, "close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            app,
            "clear-terminal",
            "Clear Terminal",
            Some("CmdOrCtrl+K"),
        )?)
        .separator()
        .item(&item(
            app,
            "prev-tab",
            "Previous Tab",
            Some("CmdOrCtrl+Shift+["),
        )?)
        .item(&item(
            app,
            "next-tab",
            "Next Tab",
            Some("CmdOrCtrl+Shift+]"),
        )?)
        .separator()
        .item(&item(
            app,
            "toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+\\"),
        )?)
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&item(
            app,
            "show-sessions",
            "Running Sessions",
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(
            app,
            "troubleshooting",
            "Troubleshooting & Diagnostics",
            None,
        )?)
        .build()?;
    let accounts = accounts_submenu(app)?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &accounts, &window, &help])
        .build()
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let core = core_from(app);
    let accounts = core
        .as_ref()
        .and_then(|c| c.list_accounts().ok())
        .unwrap_or_default();
    let projects = core
        .as_ref()
        .and_then(|c| c.list_projects().ok())
        .unwrap_or_default();
    let recent: Vec<_> = projects.iter().filter(|p| p.exists).take(5).collect();

    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    items.push(Box::new(item(
        app,
        "tray-show",
        "Show Claude Switch",
        None,
    )?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    if accounts.is_empty() {
        items.push(Box::new(item(app, "add-account", "Add an Account…", None)?));
    }
    for account in accounts.iter().take(12) {
        let mut sub = SubmenuBuilder::new(app, &account.name)
            .item(&item(
                app,
                &format!("launch:claude:{}", account.id),
                "New Claude Session",
                None,
            )?)
            .item(&item(
                app,
                &format!("launch:shell:{}", account.id),
                "New Shell",
                None,
            )?);
        if !recent.is_empty() {
            sub = sub.separator();
            for project in &recent {
                sub = sub.item(&item(
                    app,
                    &format!("launch:claude:{}:{}", account.id, project.id),
                    &format!("Open {}", project.name),
                    None,
                )?);
            }
        }
        items.push(Box::new(sub.build()?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    if accounts.len() > 1 {
        items.push(Box::new(item(
            app,
            "continue-conversation",
            "Continue in Another Account…",
            None,
        )?));
        items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    items.push(Box::new(item(app, "app-quit", "Quit Claude Switch", None)?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    MenuBuilder::new(app).items(&refs).build()
}

pub fn install_menus(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build_app_menu(app)?)?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Claude Switch")
        .menu(&build_tray_menu(app)?)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

fn refresh_menus(app: &AppHandle) {
    match build_app_menu(app) {
        Ok(menu) => {
            let _ = app.set_menu(menu);
        }
        Err(e) => log::warn!("could not rebuild the app menu: {e}"),
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_tray_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => log::warn!("could not rebuild the tray menu: {e}"),
        }
    }
}

/// Coalesces bursts of changes into one menu rebuild.
fn schedule_menu_refresh(app: &AppHandle) {
    if MENU_REFRESH_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        MENU_REFRESH_PENDING.store(false, Ordering::SeqCst);
        refresh_menus(&app);
    });
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "app-quit" => request_quit(app),
        "tray-show" => show_main_window(app),
        _ if id.starts_with("launch:") => launch_from_menu(app, &id),
        _ => {
            show_main_window(app);
            emit_menu_action(app, &id);
        }
    }
}

/// Starts a session directly from the tray, then focuses it in the UI.
fn launch_from_menu(app: &AppHandle, id: &str) {
    let parts: Vec<&str> = id.split(':').collect();
    let (kind, account_id, project_id) = match parts.as_slice() {
        ["launch", kind, account] => (*kind, *account, None),
        ["launch", kind, account, project] => (*kind, *account, Some(project.to_string())),
        _ => return,
    };
    let kind = match kind {
        "claude" => SessionKind::Claude,
        "shell" => SessionKind::Shell,
        _ => return,
    };
    let Some(core) = core_from(app) else { return };
    let app = app.clone();
    let input = StartSessionInput {
        account_id: account_id.to_string(),
        project_id,
        kind,
        continue_last: None,
        cols: 120,
        rows: 32,
    };
    std::thread::spawn(move || {
        show_main_window(&app);
        match core.start_session(input) {
            Ok(session) => {
                let _ = app.emit(events::FOCUS_SESSION, session.id);
            }
            Err(e) => {
                let _ = app.emit(
                    events::NOTICE,
                    Notice {
                        title: "Could not start the session".into(),
                        message: e.to_string(),
                    },
                );
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        api.prevent_close();
        let behavior = core_from(window.app_handle())
            .map(|c| c.settings().close_behavior)
            .unwrap_or(CloseBehavior::KeepRunning);
        match behavior {
            CloseBehavior::KeepRunning => {
                let _ = window.hide();
            }
            CloseBehavior::Quit => request_quit(window.app_handle()),
        }
    }
}

// ---------------------------------------------------------------------------
// Editor extension
// ---------------------------------------------------------------------------

/// Holds the extension socket so it can be removed at exit.
pub struct BridgeState(pub std::sync::Mutex<Option<EditorBridge>>);

struct DesktopBridgeUi {
    app: AppHandle,
}

impl BridgeUi for DesktopBridgeUi {
    fn show(&self, account_id: Option<String>) {
        show_main_window(&self.app);
        if let Some(id) = account_id {
            let _ = self
                .app
                .emit(events::MENU_ACTION, format!("select-account:{id}"));
        }
    }
}

/// Starts the socket used by the Claude Switch editor extension. A failure
/// only disables the extension, so it is logged rather than fatal.
pub fn start_editor_bridge(app: &AppHandle, core: &std::sync::Arc<AppCore>) {
    let bridge = EditorBridge::start(
        core.clone(),
        std::sync::Arc::new(DesktopBridgeUi { app: app.clone() }),
        core.paths.bridge_socket(),
        app.package_info().version.to_string(),
    );
    match bridge {
        Ok(bridge) => {
            app.manage(BridgeState(std::sync::Mutex::new(Some(bridge))));
        }
        Err(e) => log::warn!("editor extension socket unavailable: {e}"),
    }
}

fn close_editor_bridge(app: &AppHandle) {
    if let Some(state) = app.try_state::<BridgeState>() {
        if let Some(bridge) = state.0.lock().unwrap_or_else(|p| p.into_inner()).take() {
            bridge.close();
        }
    }
}

pub fn handle_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // `code` is set when we call `app.exit` ourselves.
            if code.is_none() && !QUITTING.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app);
            }
        }
        RunEvent::Exit => {
            close_editor_bridge(app);
            // Final safety net; normally sessions were stopped before exit.
            if let Some(core) = core_from(app) {
                core.stop_all_sessions();
            }
        }
        RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    }
}

/// Asks for confirmation when sessions are running, then stops them and
/// exits.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let core = core_from(app);
    let running = core.as_ref().map_or(0, |c| c.running_session_count());
    let confirm = core
        .as_ref()
        .is_some_and(|c| c.settings().confirm_quit_with_running_sessions);
    if running == 0 || !confirm {
        perform_quit(app.clone());
        return;
    }
    // The UI shows its own confirmation and calls `quit_app` with
    // `confirmed: true`.
    show_main_window(app);
    let _ = app.emit(events::CONFIRM_QUIT, running);
}

/// Quits after the UI confirmed (stops every session first).
pub fn confirm_quit<R: Runtime>(app: &AppHandle<R>) {
    perform_quit(app.clone());
}

fn perform_quit<R: Runtime>(app: AppHandle<R>) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        if let Some(core) = core_from(&app) {
            core.stop_all_sessions();
        }
        log::info!("quitting");
        log::logger().flush();
        app.exit(0);
    });
}

// ---------------------------------------------------------------------------
// Global shortcut and launch at login
// ---------------------------------------------------------------------------

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                show_main_window(app);
                emit_menu_action(app, "quick-switch");
            }
        })
        .build()
}

pub fn validate_shortcut(raw: &str) -> AppResult<()> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(());
    }
    let shortcut = Shortcut::from_str(raw)
        .map_err(|_| AppError::invalid(format!("{raw:?} is not a valid shortcut")))?;
    if shortcut.mods.is_empty() {
        return Err(AppError::invalid(
            "A global shortcut needs at least one modifier key",
        ));
    }
    Ok(())
}

pub fn apply_global_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: Option<&str>,
) -> AppResult<()> {
    let gs = app.global_shortcut();
    gs.unregister_all()
        .map_err(|e| AppError::Io(format!("could not clear the global shortcut: {e}")))?;
    if let Some(raw) = shortcut.filter(|s| !s.trim().is_empty()) {
        let shortcut = Shortcut::from_str(raw.trim())
            .map_err(|_| AppError::invalid(format!("{raw:?} is not a valid shortcut")))?;
        gs.register(shortcut).map_err(|e| {
            AppError::Conflict(format!(
                "Could not register {raw}. Another app may already use it. ({e})"
            ))
        })?;
    }
    Ok(())
}

pub fn apply_autostart<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> AppResult<()> {
    let manager = app.autolaunch();
    let current = manager.is_enabled().unwrap_or(false);
    if current == enabled {
        return Ok(());
    }
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| AppError::Io(format!("could not change launch at login: {e}")))
}

/// Applies settings that live outside the app (shortcut, login item) after
/// startup. Failures are logged, not fatal.
pub fn apply_startup_settings(app: &AppHandle) {
    let Some(core) = core_from(app) else { return };
    let settings = core.settings();
    if let Err(e) = apply_global_shortcut(app, settings.global_shortcut.as_deref()) {
        log::warn!("global shortcut not registered: {e}");
    }
    if let Err(e) = apply_autostart(app, settings.launch_at_login) {
        log::warn!("launch-at-login not applied: {e}");
    }
}

pub fn started_in_background() -> bool {
    std::env::args().any(|a| a == BACKGROUND_ARG)
}

static INITIAL_WINDOW_HANDLED: AtomicBool = AtomicBool::new(false);

/// Shows the main window the first time the UI is ready, unless the app was
/// started at login (then it stays in the menu bar until opened).
pub fn reveal_initial_window<R: Runtime>(app: &AppHandle<R>) {
    if INITIAL_WINDOW_HANDLED.swap(true, Ordering::SeqCst) {
        return;
    }
    if !started_in_background() {
        show_main_window(app);
    }
}
