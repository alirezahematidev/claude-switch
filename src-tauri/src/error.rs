//! Typed application errors.
//!
//! Every error that crosses the IPC boundary is converted into an
//! [`ErrorPayload`] with a stable `kind` the frontend can branch on and a
//! user-facing message. Messages are written by us; they never embed tokens,
//! authentication URLs, environment values, or terminal output.

use serde::Serialize;
use ts_rs::TS;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    #[error("Claude Code is not installed, or it could not be found in the usual locations.")]
    ClaudeNotInstalled,
    #[error("The Claude Code executable could not be used: {0}")]
    ExecutableNotFound(String),
    #[error("This version of Claude Code is not supported: {0}")]
    UnsupportedCliVersion(String),
    #[error("The account's configuration directory is invalid: {0}")]
    InvalidConfigDir(String),
    #[error("This account needs to sign in before it can be used.")]
    AuthRequired,
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    #[error("Profile isolation is not supported for this account: {0}")]
    IsolationUnsupported(String),
    #[error("The project directory is missing: {0}")]
    ProjectDirMissing(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Could not create a terminal: {0}")]
    PtyCreation(String),
    #[error("Could not start the process: {0}")]
    ProcessStart(String),
    #[error("Could not stop the process: {0}")]
    ProcessTermination(String),
    #[error("Database error: {0}")]
    Database(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Application data appears to be corrupted: {0}")]
    DataCorruption(String),
    #[error("{0} was not found.")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("File system error: {0}")]
    Io(String),
}

/// Stable error categories exposed to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ErrorKind {
    ClaudeNotInstalled,
    ExecutableNotFound,
    UnsupportedCliVersion,
    InvalidConfigDir,
    AuthRequired,
    AuthFailed,
    IsolationUnsupported,
    ProjectDirMissing,
    PermissionDenied,
    PtyCreation,
    ProcessStart,
    ProcessTermination,
    Database,
    InvalidInput,
    DataCorruption,
    NotFound,
    Conflict,
    Io,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorPayload {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            AppError::ClaudeNotInstalled => ErrorKind::ClaudeNotInstalled,
            AppError::ExecutableNotFound(_) => ErrorKind::ExecutableNotFound,
            AppError::UnsupportedCliVersion(_) => ErrorKind::UnsupportedCliVersion,
            AppError::InvalidConfigDir(_) => ErrorKind::InvalidConfigDir,
            AppError::AuthRequired => ErrorKind::AuthRequired,
            AppError::AuthFailed(_) => ErrorKind::AuthFailed,
            AppError::IsolationUnsupported(_) => ErrorKind::IsolationUnsupported,
            AppError::ProjectDirMissing(_) => ErrorKind::ProjectDirMissing,
            AppError::PermissionDenied(_) => ErrorKind::PermissionDenied,
            AppError::PtyCreation(_) => ErrorKind::PtyCreation,
            AppError::ProcessStart(_) => ErrorKind::ProcessStart,
            AppError::ProcessTermination(_) => ErrorKind::ProcessTermination,
            AppError::Database(_) => ErrorKind::Database,
            AppError::InvalidInput(_) => ErrorKind::InvalidInput,
            AppError::DataCorruption(_) => ErrorKind::DataCorruption,
            AppError::NotFound(_) => ErrorKind::NotFound,
            AppError::Conflict(_) => ErrorKind::Conflict,
            AppError::Io(_) => ErrorKind::Io,
        }
    }

    pub fn payload(&self) -> ErrorPayload {
        ErrorPayload {
            kind: self.kind(),
            message: self.to_string(),
        }
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        AppError::InvalidInput(msg.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.payload().serialize(serializer)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        match err {
            rusqlite::Error::SqliteFailure(e, _)
                if matches!(
                    e.code,
                    rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
                ) =>
            {
                AppError::DataCorruption(e.to_string())
            }
            other => AppError::Database(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::PermissionDenied => AppError::PermissionDenied(err.to_string()),
            _ => AppError::Io(err.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::DataCorruption(format!("invalid stored JSON: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let json = serde_json::to_value(AppError::ProjectDirMissing("/tmp/x".into())).unwrap();
        assert_eq!(json["kind"], "projectDirMissing");
        assert_eq!(json["message"], "The project directory is missing: /tmp/x");
    }

    #[test]
    fn maps_io_permission_denied() {
        let err: AppError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn maps_corrupt_database() {
        let err: AppError = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            None,
        )
        .into();
        assert_eq!(err.kind(), ErrorKind::DataCorruption);
    }
}
