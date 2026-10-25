fn main() {
    // Every IPC command is declared here so Tauri generates an explicit
    // `allow-<command>` permission for it. Commands are then denied unless a
    // capability file grants them (see `capabilities/main.json`).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            // system
            "get_system_info",
            "refresh_cli_detection",
            "get_diagnostics",
            "open_external_url",
            "reveal_path",
            "pick_claude_executable",
            "quit_app",
            "frontend_ready",
            // settings
            "get_settings",
            "update_settings",
            // accounts
            "list_accounts",
            "create_account",
            "update_account",
            "reorder_accounts",
            "delete_account",
            "refresh_auth_status",
            "start_login",
            "get_login_progress",
            "submit_login_code",
            "open_in_editor",
            "set_editor_account",
            "install_editor_extension",
            // conversations
            "list_conversations",
            "continue_conversation",
            // projects
            "list_projects",
            "add_project_via_picker",
            "update_project",
            "remove_project",
            // sessions
            "list_sessions",
            "list_open_sessions",
            "start_session",
            "attach_session",
            "write_session",
            "resize_session",
            "stop_session",
            "restart_session",
            "close_session",
        ]),
    ))
    .expect("failed to run tauri-build");
}
