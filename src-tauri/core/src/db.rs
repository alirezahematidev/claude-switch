//! SQLite connection and schema migrations.
//!
//! The database holds metadata only. It never stores passwords, tokens,
//! cookies, authentication URLs, or terminal output.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OpenFlags};

use crate::error::{AppError, AppResult};

/// Ordered migrations. Never edit a shipped migration; append a new one.
const MIGRATIONS: &[&str] = &[
    // 1: initial schema
    r#"
    CREATE TABLE accounts (
        id                     TEXT PRIMARY KEY NOT NULL,
        name                   TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
        label                  TEXT,
        verified_email         TEXT,
        org_name               TEXT,
        config_dir             TEXT NOT NULL UNIQUE,
        color                  TEXT NOT NULL,
        notes                  TEXT,
        sort_order             INTEGER NOT NULL DEFAULT 0,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        last_used_at           TEXT,
        auth_status            TEXT NOT NULL DEFAULT 'not_configured',
        auth_method            TEXT,
        auth_status_checked_at TEXT,
        auth_verified_at       TEXT,
        auth_detail            TEXT
    );
    CREATE INDEX idx_accounts_sort_order ON accounts(sort_order);

    CREATE TABLE projects (
        id                 TEXT PRIMARY KEY NOT NULL,
        name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
        directory          TEXT NOT NULL UNIQUE,
        favorite           INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        default_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        last_used_at       TEXT
    );
    CREATE INDEX idx_projects_last_used ON projects(last_used_at);

    CREATE TABLE sessions (
        id          TEXT PRIMARY KEY NOT NULL,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('claude', 'login', 'shell')),
        title       TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        process_id  INTEGER,
        status      TEXT NOT NULL CHECK (status IN
                        ('starting', 'running', 'stopping', 'exited', 'failed', 'interrupted')),
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        exit_code   INTEGER,
        exit_signal TEXT,
        error       TEXT
    );
    CREATE INDEX idx_sessions_account ON sessions(account_id, started_at DESC);
    CREATE INDEX idx_sessions_project ON sessions(project_id, started_at DESC);
    CREATE INDEX idx_sessions_status ON sessions(status);

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    );
    "#,
];

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // Metadata only, but still private to the user.
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> AppResult<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(AppError::DataCorruption(format!(
                "database integrity check failed: {check}"
            )));
        }
        migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock means a panic mid-query; the connection itself is
        // still usable because every multi-statement change is a transaction.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub fn schema_version(conn: &Connection) -> AppResult<usize> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    Ok(v.max(0) as usize)
}

fn migrate(conn: &mut Connection) -> AppResult<()> {
    let current = schema_version(conn)?;
    if current > MIGRATIONS.len() {
        return Err(AppError::DataCorruption(format!(
            "the database was created by a newer version of Claude Switch (schema {current})"
        )));
    }
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (idx + 1) as i64)?;
        tx.commit()?;
        log::info!("applied database migration {}", idx + 1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_database() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len());
        for table in ["accounts", "projects", "sessions", "settings"] {
            let n: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} missing");
        }
    }

    #[test]
    fn migration_is_idempotent_across_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("db.sqlite");
        drop(Database::open(&path).unwrap());
        let db = Database::open(&path).unwrap();
        assert_eq!(schema_version(&db.conn()).unwrap(), MIGRATIONS.len());
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn refuses_newer_schema() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("db.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 999).unwrap();
        }
        let err = Database::open(&path).err().unwrap();
        assert!(matches!(err, AppError::DataCorruption(_)));
    }

    #[test]
    fn reports_non_database_file_as_corruption() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("db.sqlite");
        fs::write(
            &path,
            b"this is definitely not a sqlite database, just text padding....",
        )
        .unwrap();
        let err = Database::open(&path).err().unwrap();
        assert!(matches!(err, AppError::DataCorruption(_)), "{err:?}");
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let res = conn.execute(
            "INSERT INTO sessions (id, account_id, kind, title, working_dir, status, started_at)
             VALUES ('s', 'missing', 'claude', 't', '/', 'running', 'now')",
            [],
        );
        assert!(res.is_err());
    }
}
