//! Managed directories and filesystem safety checks.
//!
//! Layout:
//!
//! ```text
//! ~/Library/Application Support/ClaudeSwitch/   (data_dir)
//!     claude-switch.sqlite
//!     logs/
//! ~/.claude-switch/profiles/<account-uuid>/      (profiles_root)
//! ```
//!
//! Profiles live outside Application Support on purpose: the profile path is
//! handed to Claude Code as `CLAUDE_CONFIG_DIR`, which ends up inside plugin
//! paths and hook commands. Many of those commands do not quote paths, so a
//! space in "Application Support" would break them.
//!
//! A profile path must never change after creation: Claude Code keys the
//! macOS Keychain entry for an account to the exact `CLAUDE_CONFIG_DIR` string.

use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::{AppError, AppResult};

const DATA_DIR_NAME: &str = "ClaudeSwitch";
const PROFILES_PARENT: &str = ".claude-switch";
const PROFILES_DIR: &str = "profiles";
const DB_FILE: &str = "claude-switch.sqlite";
const LOGS_DIR: &str = "logs";

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub home: PathBuf,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub logs_dir: PathBuf,
    pub profiles_root: PathBuf,
}

impl AppPaths {
    /// Resolves the production layout for the current user.
    ///
    /// Debug builds honour `CLAUDE_SWITCH_HOME` so development never touches
    /// real profiles.
    pub fn resolve() -> AppResult<Self> {
        let home = home_dir()?;
        let home = fs::canonicalize(&home).map_err(|e| {
            AppError::InvalidConfigDir(format!("cannot resolve home directory: {e}"))
        })?;

        if cfg!(debug_assertions) {
            if let Some(dev_root) = std::env::var_os("CLAUDE_SWITCH_HOME") {
                let root = PathBuf::from(dev_root);
                if !root.is_absolute() {
                    return Err(AppError::InvalidConfigDir(
                        "CLAUDE_SWITCH_HOME must be an absolute path".into(),
                    ));
                }
                ensure_private_dir(&root)?;
                let root = fs::canonicalize(&root)?;
                return Ok(Self::from_roots(
                    home,
                    root.join("data"),
                    root.join("profiles"),
                ));
            }
        }

        let data_dir = home
            .join("Library")
            .join("Application Support")
            .join(DATA_DIR_NAME);
        let profiles_root = home.join(PROFILES_PARENT).join(PROFILES_DIR);
        Ok(Self::from_roots(home, data_dir, profiles_root))
    }

    pub fn from_roots(home: PathBuf, data_dir: PathBuf, profiles_root: PathBuf) -> Self {
        Self {
            db_path: data_dir.join(DB_FILE),
            logs_dir: data_dir.join(LOGS_DIR),
            home,
            data_dir,
            profiles_root,
        }
    }

    /// Creates the managed directories (mode 0700) and verifies none of them
    /// is a symlink or owned by another user.
    pub fn ensure(&self) -> AppResult<()> {
        if let Some(parent) = self.profiles_root.parent() {
            ensure_private_dir(parent)?;
        }
        for dir in [&self.data_dir, &self.logs_dir, &self.profiles_root] {
            ensure_private_dir(dir)?;
        }
        let canonical = fs::canonicalize(&self.profiles_root)?;
        if canonical != self.profiles_root {
            return Err(AppError::InvalidConfigDir(format!(
                "the profiles directory resolves to a different location ({}); refusing to use it",
                canonical.display()
            )));
        }
        Ok(())
    }

    /// Scratch `CLAUDE_CONFIG_DIR` for account-independent CLI probes such as
    /// `claude --version`.
    pub fn cli_probe_dir(&self) -> PathBuf {
        self.data_dir.join("cli-probe")
    }

    /// Socket used by the editor extension. Next to the profiles (a short,
    /// space-free path: socket paths are limited to 104 bytes on macOS).
    pub fn bridge_socket(&self) -> PathBuf {
        self.profiles_root
            .parent()
            .unwrap_or(&self.data_dir)
            .join("claude-switch.sock")
    }

    /// Copies of editor settings files from before Claude Switch changed
    /// them.
    pub fn editor_backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups").join("editor-settings")
    }

    /// The only path an account's profile may ever have.
    pub fn profile_dir_for(&self, id: &Uuid) -> PathBuf {
        self.profiles_root.join(id.hyphenated().to_string())
    }

    /// Creates a brand-new profile directory. Fails if anything already exists
    /// at that path, so an existing Claude configuration is never reused or
    /// overwritten.
    pub fn create_profile_dir(&self, id: &Uuid) -> AppResult<PathBuf> {
        let dir = self.profile_dir_for(id);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => AppError::InvalidConfigDir(format!(
                    "{} already exists; refusing to reuse an existing directory",
                    dir.display()
                )),
                _ => AppError::from(e),
            })?;
        Ok(dir)
    }

    /// Validates a stored profile path before it is handed to a process.
    ///
    /// The stored value must equal the derived path exactly (defending against
    /// a tampered database), and the directory must be a real directory owned
    /// by the current user.
    pub fn verify_profile_dir(&self, id: &Uuid, stored: &str) -> AppResult<PathBuf> {
        let expected = self.profile_dir_for(id);
        if Path::new(stored) != expected {
            return Err(AppError::InvalidConfigDir(format!(
                "stored path {stored} does not match the managed location {}",
                expected.display()
            )));
        }
        let meta = match fs::symlink_metadata(&expected) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::InvalidConfigDir(format!(
                    "{} no longer exists. Re-authenticate the account to create a fresh profile.",
                    expected.display()
                )))
            }
            Err(e) => return Err(e.into()),
        };
        check_private_dir_meta(&expected, &meta)?;
        Ok(expected)
    }

    /// Recreates a missing profile directory. Used only by explicit
    /// re-authentication; never by a normal launch.
    pub fn recreate_missing_profile_dir(&self, id: &Uuid) -> AppResult<PathBuf> {
        let dir = self.profile_dir_for(id);
        match fs::symlink_metadata(&dir) {
            Ok(meta) => {
                check_private_dir_meta(&dir, &meta)?;
                Ok(dir)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.create_profile_dir(id),
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes a profile directory. Only direct children of the profiles root
    /// that are real directories named after the account UUID are removed.
    pub fn delete_profile_dir(&self, id: &Uuid) -> AppResult<()> {
        let dir = self.profile_dir_for(id);
        let meta = match fs::symlink_metadata(&dir) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(AppError::InvalidConfigDir(format!(
                "{} is not a regular directory; refusing to delete it",
                dir.display()
            )));
        }
        let canonical = fs::canonicalize(&dir)?;
        if canonical.parent() != Some(self.profiles_root.as_path()) {
            return Err(AppError::InvalidConfigDir(format!(
                "{} is outside the managed profiles directory; refusing to delete it",
                canonical.display()
            )));
        }
        // `remove_dir_all` does not follow symlinks inside the tree.
        fs::remove_dir_all(&canonical)?;
        Ok(())
    }

    /// Profile directories on disk that no account references.
    pub fn orphaned_profile_dirs(&self, known: &[Uuid]) -> AppResult<Vec<PathBuf>> {
        let mut orphans = Vec::new();
        let entries = match fs::read_dir(&self.profiles_root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(orphans),
            Err(e) => return Err(e.into()),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(id) = Uuid::parse_str(name) else {
                continue;
            };
            if !known.contains(&id) {
                orphans.push(entry.path());
            }
        }
        orphans.sort();
        Ok(orphans)
    }

    /// True if `path` is one of the directories this app manages, or lies
    /// inside one. Such paths may not be registered as projects.
    pub fn is_managed_path(&self, path: &Path) -> bool {
        let roots = [
            Some(self.data_dir.as_path()),
            self.profiles_root.parent(),
            Some(self.profiles_root.as_path()),
        ];
        roots
            .into_iter()
            .flatten()
            .any(|root| path.starts_with(root))
    }
}

fn home_dir() -> AppResult<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        let home = PathBuf::from(home);
        if home.is_absolute() {
            return Ok(home);
        }
    }
    passwd_home()
        .ok_or_else(|| AppError::InvalidConfigDir("cannot determine home directory".into()))
}

fn passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    let mut buf = vec![0 as libc::c_char; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: all pointers reference live, correctly sized buffers.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: pw_dir is a NUL-terminated string inside `buf`.
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
}

/// Creates `dir` (and parents) with mode 0700 if needed, then checks it.
pub fn ensure_private_dir(dir: &Path) -> AppResult<()> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => check_private_dir_meta(dir, &meta),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
            let meta = fs::symlink_metadata(dir)?;
            check_private_dir_meta(dir, &meta)
        }
        Err(e) => Err(e.into()),
    }
}

fn check_private_dir_meta(dir: &Path, meta: &fs::Metadata) -> AppResult<()> {
    if meta.file_type().is_symlink() {
        return Err(AppError::InvalidConfigDir(format!(
            "{} is a symbolic link; managed directories must be real directories",
            dir.display()
        )));
    }
    if !meta.is_dir() {
        return Err(AppError::InvalidConfigDir(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    // SAFETY: getuid has no failure modes.
    let uid = unsafe { libc::getuid() };
    if meta.uid() != uid {
        return Err(AppError::PermissionDenied(format!(
            "{} is owned by another user",
            dir.display()
        )));
    }
    // Tighten permissions on directories we own but that drifted.
    if meta.permissions().mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temp_paths() -> (tempfile::TempDir, AppPaths) {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let paths = AppPaths::from_roots(
            root.clone(),
            root.join("data"),
            root.join(".claude-switch").join("profiles"),
        );
        paths.ensure().unwrap();
        (tmp, paths)
    }

    #[test]
    fn creates_private_managed_dirs() {
        let (_tmp, paths) = temp_paths();
        for dir in [&paths.data_dir, &paths.logs_dir, &paths.profiles_root] {
            let mode = fs::metadata(dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", dir.display());
        }
    }

    #[test]
    fn profile_dir_is_derived_from_uuid_only() {
        let (_tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        let dir = paths.profile_dir_for(&id);
        assert_eq!(dir.parent().unwrap(), paths.profiles_root);
        assert_eq!(dir.file_name().unwrap().to_str().unwrap(), id.to_string());
    }

    #[test]
    fn two_accounts_get_distinct_directories() {
        let (_tmp, paths) = temp_paths();
        let a = paths.create_profile_dir(&Uuid::new_v4()).unwrap();
        let b = paths.create_profile_dir(&Uuid::new_v4()).unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
    }

    #[test]
    fn never_reuses_an_existing_directory() {
        let (_tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        let dir = paths.create_profile_dir(&id).unwrap();
        fs::write(dir.join(".claude.json"), "{}").unwrap();
        let err = paths.create_profile_dir(&id).unwrap_err();
        assert!(matches!(err, AppError::InvalidConfigDir(_)));
        assert!(dir.join(".claude.json").exists());
    }

    #[test]
    fn verify_rejects_tampered_stored_path() {
        let (_tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        paths.create_profile_dir(&id).unwrap();
        let other = paths.profile_dir_for(&Uuid::new_v4());
        assert!(paths
            .verify_profile_dir(&id, other.to_str().unwrap())
            .is_err());
        assert!(paths
            .verify_profile_dir(&id, "/Users/someone/.claude")
            .is_err());
        let traversal = format!("{}/../../etc", paths.profiles_root.display());
        assert!(paths.verify_profile_dir(&id, &traversal).is_err());
    }

    #[test]
    fn verify_rejects_symlinked_profile() {
        let (tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        let target = tmp.path().join("elsewhere");
        fs::create_dir(&target).unwrap();
        symlink(&target, paths.profile_dir_for(&id)).unwrap();
        let stored = paths.profile_dir_for(&id);
        let err = paths
            .verify_profile_dir(&id, stored.to_str().unwrap())
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidConfigDir(_)));
    }

    #[test]
    fn verify_reports_missing_profile() {
        let (_tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        let stored = paths.profile_dir_for(&id);
        let err = paths
            .verify_profile_dir(&id, stored.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("no longer exists"));
    }

    #[test]
    fn delete_refuses_symlinks_and_keeps_target() {
        let (tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        let target = tmp.path().join("precious");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "x").unwrap();
        symlink(&target, paths.profile_dir_for(&id)).unwrap();
        assert!(paths.delete_profile_dir(&id).is_err());
        assert!(target.join("keep.txt").exists());
    }

    #[test]
    fn delete_does_not_follow_inner_symlinks() {
        let (tmp, paths) = temp_paths();
        let id = Uuid::new_v4();
        let dir = paths.create_profile_dir(&id).unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "x").unwrap();
        symlink(&outside, dir.join("link")).unwrap();
        paths.delete_profile_dir(&id).unwrap();
        assert!(!dir.exists());
        assert!(outside.join("keep.txt").exists());
    }

    #[test]
    fn ensure_rejects_symlinked_profiles_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let real = root.join("real");
        fs::create_dir(&real).unwrap();
        symlink(&real, root.join(".claude-switch")).unwrap();
        let paths = AppPaths::from_roots(
            root.clone(),
            root.join("data"),
            root.join(".claude-switch").join("profiles"),
        );
        assert!(paths.ensure().is_err());
    }

    #[test]
    fn detects_managed_paths() {
        let (tmp, paths) = temp_paths();
        assert!(paths.is_managed_path(&paths.profiles_root.join("abc")));
        assert!(paths.is_managed_path(&paths.data_dir));
        assert!(!paths.is_managed_path(&tmp.path().join("project")));
    }

    #[test]
    fn lists_orphaned_profiles() {
        let (_tmp, paths) = temp_paths();
        let known = Uuid::new_v4();
        let orphan = Uuid::new_v4();
        paths.create_profile_dir(&known).unwrap();
        paths.create_profile_dir(&orphan).unwrap();
        fs::create_dir(paths.profiles_root.join("not-a-uuid")).unwrap();
        let orphans = paths.orphaned_profile_dirs(&[known]).unwrap();
        assert_eq!(orphans, vec![paths.profile_dir_for(&orphan)]);
    }
}
