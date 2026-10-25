//! Claude Switch's core: everything the desktop app and the editor helper
//! share, with no UI dependency.
//!
//! * `core`     – application services and invariants ([`core::AppCore`])
//! * `store`/`db` – SQLite persistence
//! * `pty`, `cli`, `env`, `paths` – process, CLI, environment and filesystem
//!   services

pub mod cli;
pub mod clock;
pub mod core;
pub mod db;
pub mod domain;
pub mod editor_bridge;
pub mod editor_settings;
pub mod editors;
pub mod env;
pub mod error;
pub mod live_sessions;
pub mod logging;
pub mod login;
pub mod paths;
pub mod pty;
pub mod settings;
pub mod shell_env;
pub mod store;
pub mod transcripts;
pub mod usage_limit;
