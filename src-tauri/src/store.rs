//! Repository functions. All SQL is parameterized; callers own transactions.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{
    Account, AccountColor, AuthStatus, Project, SessionInfo, SessionKind, SessionStatus,
};
use crate::error::{AppError, AppResult};
use crate::settings::AppSettings;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

pub struct NewAccount<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub label: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub config_dir: &'a str,
    pub color: AccountColor,
    pub sort_order: i32,
    pub now: &'a str,
}

/// What a status check observed. Written atomically.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthObservation {
    pub status: AuthStatus,
    pub method: Option<String>,
    pub email: Option<String>,
    pub org_name: Option<String>,
    pub detail: Option<String>,
}

const ACCOUNT_COLUMNS: &str = "id, name, label, verified_email, org_name, config_dir, color, notes,
    sort_order, created_at, updated_at, last_used_at, auth_status, auth_method,
    auth_status_checked_at, auth_verified_at, auth_detail";

fn account_from_row(row: &Row<'_>) -> rusqlite::Result<(Account, String, String)> {
    Ok((
        Account {
            id: row.get(0)?,
            name: row.get(1)?,
            label: row.get(2)?,
            verified_email: row.get(3)?,
            org_name: row.get(4)?,
            config_dir: row.get(5)?,
            color: AccountColor::Slate,
            notes: row.get(7)?,
            sort_order: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            last_used_at: row.get(11)?,
            auth_status: AuthStatus::Unknown,
            auth_method: row.get(13)?,
            auth_status_checked_at: row.get(14)?,
            auth_verified_at: row.get(15)?,
            auth_detail: row.get(16)?,
            running_sessions: 0,
        },
        row.get(6)?,
        row.get(12)?,
    ))
}

fn finish_account((mut account, color, status): (Account, String, String)) -> AppResult<Account> {
    account.color = AccountColor::parse(&color)?;
    account.auth_status = AuthStatus::parse(&status)?;
    Ok(account)
}

pub fn insert_account(conn: &Connection, a: &NewAccount<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO accounts (id, name, label, notes, config_dir, color, sort_order,
                               created_at, updated_at, auth_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'not_configured')",
        params![
            a.id,
            a.name,
            a.label,
            a.notes,
            a.config_dir,
            a.color.as_str(),
            a.sort_order,
            a.now
        ],
    )?;
    Ok(())
}

pub fn get_account(conn: &Connection, id: &str) -> AppResult<Option<Account>> {
    let row = conn
        .query_row(
            &format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = ?1"),
            [id],
            account_from_row,
        )
        .optional()?;
    row.map(finish_account).transpose()
}

pub fn require_account(conn: &Connection, id: &str) -> AppResult<Account> {
    get_account(conn, id)?.ok_or_else(|| AppError::NotFound("Account".into()))
}

pub fn list_accounts(conn: &Connection) -> AppResult<Vec<Account>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM accounts ORDER BY sort_order ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map([], account_from_row)?;
    rows.map(|r| finish_account(r?)).collect()
}

pub fn next_sort_order(conn: &Connection) -> AppResult<i32> {
    let max: Option<i32> =
        conn.query_row("SELECT max(sort_order) FROM accounts", [], |r| r.get(0))?;
    Ok(max.map_or(0, |m| m + 1))
}

pub fn update_account_fields(
    conn: &Connection,
    id: &str,
    name: &str,
    color: AccountColor,
    label: Option<&str>,
    notes: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE accounts SET name = ?2, color = ?3, label = ?4, notes = ?5, updated_at = ?6
         WHERE id = ?1",
        params![id, name, color.as_str(), label, notes, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Account".into()));
    }
    Ok(())
}

pub fn set_sort_order(conn: &Connection, id: &str, order: i32) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET sort_order = ?2 WHERE id = ?1",
        params![id, order],
    )?;
    Ok(())
}

pub fn delete_account(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Account".into()));
    }
    Ok(())
}

pub fn touch_account_used(conn: &Connection, id: &str, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET last_used_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub fn record_auth_observation(
    conn: &Connection,
    id: &str,
    obs: &AuthObservation,
    now: &str,
) -> AppResult<()> {
    let verified = obs.status == AuthStatus::Authenticated;
    // Identity fields are only replaced when the CLI reported them, so a
    // transient failure does not erase the last known email.
    conn.execute(
        "UPDATE accounts SET
            auth_status = ?2,
            auth_method = CASE WHEN ?3 IS NOT NULL OR ?2 IN ('auth_required', 'not_configured')
                               THEN ?3 ELSE auth_method END,
            verified_email = CASE WHEN ?4 IS NOT NULL THEN ?4
                                  WHEN ?2 IN ('auth_required', 'not_configured') THEN NULL
                                  ELSE verified_email END,
            org_name = CASE WHEN ?5 IS NOT NULL THEN ?5
                            WHEN ?2 IN ('auth_required', 'not_configured') THEN NULL
                            ELSE org_name END,
            auth_detail = ?6,
            auth_status_checked_at = ?7,
            auth_verified_at = CASE WHEN ?8 THEN ?7 ELSE auth_verified_at END,
            updated_at = ?7
         WHERE id = ?1",
        params![
            id,
            obs.status.as_str(),
            obs.method,
            obs.email,
            obs.org_name,
            obs.detail,
            now,
            verified
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const PROJECT_COLUMNS: &str =
    "id, name, directory, favorite, default_account_id, created_at, updated_at, last_used_at";

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    let directory: String = row.get(2)?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        exists: std::path::Path::new(&directory).is_dir(),
        directory,
        favorite: row.get::<_, i64>(3)? != 0,
        default_account_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        last_used_at: row.get(7)?,
        running_sessions: 0,
    })
}

pub fn insert_project(
    conn: &Connection,
    id: &str,
    name: &str,
    directory: &str,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO projects (id, name, directory, created_at, updated_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?4)",
        params![id, name, directory, now],
    )?;
    Ok(())
}

pub fn get_project(conn: &Connection, id: &str) -> AppResult<Option<Project>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"),
            [id],
            project_from_row,
        )
        .optional()?)
}

pub fn require_project(conn: &Connection, id: &str) -> AppResult<Project> {
    get_project(conn, id)?.ok_or_else(|| AppError::NotFound("Project".into()))
}

pub fn get_project_by_directory(conn: &Connection, directory: &str) -> AppResult<Option<Project>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE directory = ?1"),
            [directory],
            project_from_row,
        )
        .optional()?)
}

pub fn list_projects(conn: &Connection) -> AppResult<Vec<Project>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROJECT_COLUMNS} FROM projects
         ORDER BY favorite DESC, last_used_at DESC NULLS LAST, name COLLATE NOCASE ASC"
    ))?;
    let rows = stmt.query_map([], project_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn update_project_fields(
    conn: &Connection,
    id: &str,
    name: &str,
    favorite: bool,
    default_account_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE projects SET name = ?2, favorite = ?3, default_account_id = ?4, updated_at = ?5
         WHERE id = ?1",
        params![id, name, favorite as i64, default_account_id, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Project".into()));
    }
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Project".into()));
    }
    Ok(())
}

pub fn touch_project_used(
    conn: &Connection,
    id: &str,
    account_id: &str,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE projects SET last_used_at = ?2, default_account_id = ?3 WHERE id = ?1",
        params![id, now, account_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

pub struct NewSession<'a> {
    pub id: &'a str,
    pub account_id: &'a str,
    pub project_id: Option<&'a str>,
    pub kind: SessionKind,
    pub title: &'a str,
    pub working_dir: &'a str,
    pub now: &'a str,
}

/// Fields written when a session changes state.
#[derive(Debug, Clone, Default)]
pub struct SessionUpdate {
    pub process_id: Option<u32>,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub error: Option<String>,
}

const SESSION_COLUMNS: &str = "id, account_id, project_id, kind, title, working_dir, process_id,
    status, started_at, ended_at, exit_code, exit_signal, error";

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<(SessionInfo, String, String)> {
    Ok((
        SessionInfo {
            id: row.get(0)?,
            account_id: row.get(1)?,
            project_id: row.get(2)?,
            kind: SessionKind::Claude,
            title: row.get(4)?,
            working_dir: row.get(5)?,
            process_id: row
                .get::<_, Option<i64>>(6)?
                .and_then(|p| u32::try_from(p).ok()),
            status: SessionStatus::Exited,
            started_at: row.get(8)?,
            ended_at: row.get(9)?,
            exit_code: row.get(10)?,
            exit_signal: row.get(11)?,
            error: row.get(12)?,
            attached: false,
            usage_limit_reached: false,
        },
        row.get(3)?,
        row.get(7)?,
    ))
}

fn finish_session((mut s, kind, status): (SessionInfo, String, String)) -> AppResult<SessionInfo> {
    s.kind = SessionKind::parse(&kind)?;
    s.status = SessionStatus::parse(&status)?;
    Ok(s)
}

pub fn insert_session(conn: &Connection, s: &NewSession<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sessions (id, account_id, project_id, kind, title, working_dir, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', ?7)",
        params![
            s.id,
            s.account_id,
            s.project_id,
            s.kind.as_str(),
            s.title,
            s.working_dir,
            s.now
        ],
    )?;
    Ok(())
}

pub fn get_session(conn: &Connection, id: &str) -> AppResult<Option<SessionInfo>> {
    let row = conn
        .query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
            [id],
            session_from_row,
        )
        .optional()?;
    row.map(finish_session).transpose()
}

/// Moves a session to `next`, enforcing the lifecycle state machine.
pub fn transition_session(
    conn: &Connection,
    id: &str,
    next: SessionStatus,
    update: &SessionUpdate,
) -> AppResult<SessionInfo> {
    let current = get_session(conn, id)?.ok_or_else(|| AppError::NotFound("Session".into()))?;
    if current.status != next && !current.status.can_transition_to(next) {
        return Err(AppError::Conflict(format!(
            "Session cannot move from {} to {}",
            current.status.as_str(),
            next.as_str()
        )));
    }
    conn.execute(
        "UPDATE sessions SET
            status = ?2,
            process_id = COALESCE(?3, process_id),
            ended_at = COALESCE(?4, ended_at),
            exit_code = COALESCE(?5, exit_code),
            exit_signal = COALESCE(?6, exit_signal),
            error = COALESCE(?7, error)
         WHERE id = ?1",
        params![
            id,
            next.as_str(),
            update.process_id.map(i64::from),
            update.ended_at,
            update.exit_code,
            update.exit_signal,
            update.error
        ],
    )?;
    get_session(conn, id)?.ok_or_else(|| AppError::NotFound("Session".into()))
}

pub fn list_sessions(
    conn: &Connection,
    account_id: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
) -> AppResult<Vec<SessionInfo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM sessions
         WHERE (?1 IS NULL OR account_id = ?1) AND (?2 IS NULL OR project_id = ?2)
         ORDER BY started_at DESC LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![account_id, project_id, limit], session_from_row)?;
    rows.map(|r| finish_session(r?)).collect()
}

/// Sessions left active by a previous run can no longer be running: their PTY
/// died with the old process.
pub fn mark_stale_sessions_interrupted(conn: &Connection, now: &str) -> AppResult<usize> {
    Ok(conn.execute(
        "UPDATE sessions SET status = 'interrupted', ended_at = COALESCE(ended_at, ?1)
         WHERE status IN ('starting', 'running', 'stopping')",
        [now],
    )?)
}

/// Keeps the newest `keep` session records.
pub fn prune_session_history(conn: &Connection, keep: u32) -> AppResult<usize> {
    Ok(conn.execute(
        "DELETE FROM sessions WHERE status NOT IN ('starting', 'running', 'stopping')
         AND id NOT IN (SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?1)",
        [keep],
    )?)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY: &str = "app";

pub fn load_settings(conn: &Connection) -> AppResult<AppSettings> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [SETTINGS_KEY],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        None => Ok(AppSettings::default()),
        Some(raw) => match serde_json::from_str(&raw) {
            Ok(settings) => Ok(settings),
            Err(e) => {
                log::warn!("stored settings are unreadable ({e}); using defaults");
                Ok(AppSettings::default())
            }
        },
    }
}

pub fn save_settings(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    let raw = serde_json::to_string(settings).map_err(|e| AppError::Database(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SETTINGS_KEY, raw],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn account(conn: &Connection, id: &str, name: &str, order: i32) {
        insert_account(
            conn,
            &NewAccount {
                id,
                name,
                label: None,
                notes: None,
                config_dir: &format!("/p/{id}"),
                color: AccountColor::Blue,
                sort_order: order,
                now: "2026-01-01T00:00:00Z",
            },
        )
        .unwrap();
    }

    #[test]
    fn account_crud_round_trip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        account(&conn, "a", "Work", 0);
        let a = require_account(&conn, "a").unwrap();
        assert_eq!(a.name, "Work");
        assert_eq!(a.auth_status, AuthStatus::NotConfigured);
        update_account_fields(
            &conn,
            "a",
            "Work 2",
            AccountColor::Pink,
            Some("me@x.com"),
            None,
            "t2",
        )
        .unwrap();
        let a = require_account(&conn, "a").unwrap();
        assert_eq!(a.name, "Work 2");
        assert_eq!(
            a.config_dir, "/p/a",
            "rename must not change the profile path"
        );
        assert_eq!(a.label.as_deref(), Some("me@x.com"));
        delete_account(&conn, "a").unwrap();
        assert!(get_account(&conn, "a").unwrap().is_none());
    }

    #[test]
    fn config_dir_is_unique() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        account(&conn, "a", "A", 0);
        let dup = insert_account(
            &conn,
            &NewAccount {
                id: "b",
                name: "B",
                label: None,
                notes: None,
                config_dir: "/p/a",
                color: AccountColor::Blue,
                sort_order: 1,
                now: "t",
            },
        );
        assert!(dup.is_err());
    }

    #[test]
    fn names_with_sql_are_stored_verbatim() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let evil = "x'); DROP TABLE accounts; --";
        account(&conn, "a", evil, 0);
        assert_eq!(require_account(&conn, "a").unwrap().name, evil);
        assert_eq!(list_accounts(&conn).unwrap().len(), 1);
    }

    #[test]
    fn auth_observation_keeps_identity_on_unknown() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        account(&conn, "a", "A", 0);
        let ok = AuthObservation {
            status: AuthStatus::Authenticated,
            method: Some("claude.ai".into()),
            email: Some("me@x.com".into()),
            org_name: Some("Org".into()),
            detail: None,
        };
        record_auth_observation(&conn, "a", &ok, "t1").unwrap();
        let unknown = AuthObservation {
            status: AuthStatus::Unknown,
            method: None,
            email: None,
            org_name: None,
            detail: Some("timed out".into()),
        };
        record_auth_observation(&conn, "a", &unknown, "t2").unwrap();
        let a = require_account(&conn, "a").unwrap();
        assert_eq!(a.auth_status, AuthStatus::Unknown);
        assert_eq!(a.verified_email.as_deref(), Some("me@x.com"));
        assert_eq!(a.auth_verified_at.as_deref(), Some("t1"));
        assert_eq!(a.auth_status_checked_at.as_deref(), Some("t2"));

        let logged_out = AuthObservation {
            status: AuthStatus::AuthRequired,
            method: Some("none".into()),
            email: None,
            org_name: None,
            detail: None,
        };
        record_auth_observation(&conn, "a", &logged_out, "t3").unwrap();
        let a = require_account(&conn, "a").unwrap();
        assert_eq!(a.verified_email, None);
        assert_eq!(a.auth_verified_at.as_deref(), Some("t1"));
    }

    #[test]
    fn session_transitions_are_enforced() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        account(&conn, "a", "A", 0);
        insert_session(
            &conn,
            &NewSession {
                id: "s",
                account_id: "a",
                project_id: None,
                kind: SessionKind::Claude,
                title: "t",
                working_dir: "/",
                now: "t0",
            },
        )
        .unwrap();
        let s = transition_session(
            &conn,
            "s",
            SessionStatus::Running,
            &SessionUpdate {
                process_id: Some(42),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.process_id, Some(42));
        let s = transition_session(
            &conn,
            "s",
            SessionStatus::Exited,
            &SessionUpdate {
                exit_code: Some(0),
                ended_at: Some("t1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.exit_code, Some(0));
        assert!(transition_session(
            &conn,
            "s",
            SessionStatus::Running,
            &SessionUpdate::default()
        )
        .is_err());
    }

    #[test]
    fn stale_sessions_become_interrupted_and_cascade_on_account_delete() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        account(&conn, "a", "A", 0);
        insert_session(
            &conn,
            &NewSession {
                id: "s",
                account_id: "a",
                project_id: None,
                kind: SessionKind::Shell,
                title: "t",
                working_dir: "/",
                now: "t0",
            },
        )
        .unwrap();
        assert_eq!(mark_stale_sessions_interrupted(&conn, "t1").unwrap(), 1);
        assert_eq!(
            get_session(&conn, "s").unwrap().unwrap().status,
            SessionStatus::Interrupted
        );
        delete_account(&conn, "a").unwrap();
        assert!(get_session(&conn, "s").unwrap().is_none());
    }

    #[test]
    fn deleting_a_project_keeps_session_history() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        account(&conn, "a", "A", 0);
        insert_project(&conn, "p", "Proj", "/tmp/proj", "t0").unwrap();
        insert_session(
            &conn,
            &NewSession {
                id: "s",
                account_id: "a",
                project_id: Some("p"),
                kind: SessionKind::Claude,
                title: "t",
                working_dir: "/tmp/proj",
                now: "t0",
            },
        )
        .unwrap();
        delete_project(&conn, "p").unwrap();
        let s = get_session(&conn, "s").unwrap().unwrap();
        assert_eq!(s.project_id, None);
    }

    #[test]
    fn settings_round_trip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        assert_eq!(load_settings(&conn).unwrap(), AppSettings::default());
        let s = AppSettings {
            terminal_font_size: 16,
            ..Default::default()
        };
        save_settings(&conn, &s).unwrap();
        assert_eq!(load_settings(&conn).unwrap().terminal_font_size, 16);
    }
}
