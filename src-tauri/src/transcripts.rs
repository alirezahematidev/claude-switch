//! Handing a Claude Code conversation over to another account.
//!
//! Claude Code keeps each conversation in its configuration folder:
//!
//! ```text
//! <CLAUDE_CONFIG_DIR>/projects/<folder>/<session-id>.jsonl   transcript
//! <CLAUDE_CONFIG_DIR>/projects/<folder>/<session-id>/        subagent and tool output
//! <CLAUDE_CONFIG_DIR>/file-history/<session-id>/             checkpoints for /rewind
//! ```
//!
//! `<folder>` is the working directory with every character other than an
//! ASCII letter or digit replaced by `-`. Names longer than 200 characters
//! are cut and given a hash suffix. `claude --resume <session-id>` looks the
//! conversation up there, so copying these files into another profile lets
//! that account continue it.
//!
//! Files are copied byte for byte. Their format belongs to Claude Code and is
//! never parsed. A transcript is compared with an existing copy only to avoid
//! replacing one that has diverged.

use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Longest folder name Claude Code uses before adding a hash suffix.
const MAX_FOLDER_NAME: usize = 200;
const PROJECTS: &str = "projects";
const FILE_HISTORY: &str = "file-history";
const TEMP_SUFFIX: &str = ".claude-switch-tmp";

/// A conversation transcript found in a configuration folder.
#[derive(Debug, Clone)]
pub struct Transcript {
    pub session_id: Uuid,
    pub modified: SystemTime,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyOutcome {
    /// The target had no copy.
    Copied,
    /// The target had an older copy of the same conversation.
    Updated,
    /// The target already had the same transcript.
    Unchanged,
}

/// Claude Code's folder name for a working directory (before the hash
/// suffix). Matches JavaScript's `path.replace(/[^a-zA-Z0-9]/g, "-")`, which
/// replaces UTF-16 code units, so characters outside the BMP become `--`.
pub fn folder_name(cwd: &Path) -> Option<String> {
    let path = cwd.to_str()?;
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    Some(out)
}

/// The folder holding `cwd`'s conversations in `config_dir`, if any.
fn find_project_folder(config_dir: &Path, cwd: &Path) -> Option<PathBuf> {
    let name = folder_name(cwd)?;
    let projects = config_dir.join(PROJECTS);
    if name.len() <= MAX_FOLDER_NAME {
        let dir = projects.join(&name);
        return is_real_dir(&dir).then_some(dir);
    }
    // Long names end in a hash of the full path that is not reproduced here.
    // Accept the folder only when the shortened prefix is unambiguous.
    let prefix = format!("{}-", &name[..MAX_FOLDER_NAME]);
    let mut matches = fs::read_dir(&projects)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix))
        })
        .map(|e| e.path())
        .filter(|p| is_real_dir(p));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// Conversations recorded for `cwd` in a configuration folder, newest first.
/// Reads only directory entries and file metadata.
pub fn list(config_dir: &Path, cwd: &Path) -> Vec<Transcript> {
    let Some(folder) = find_project_folder(config_dir, cwd) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&folder) else {
        return Vec::new();
    };
    let mut found: Vec<Transcript> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let stem = name.to_str()?.strip_suffix(".jsonl")?;
            let session_id = Uuid::parse_str(stem).ok()?;
            // Only canonical lowercase names are Claude Code's own files.
            if session_id.hyphenated().to_string() != stem {
                return None;
            }
            let meta = entry.path().symlink_metadata().ok()?;
            if !meta.is_file() || meta.len() == 0 {
                return None;
            }
            Some(Transcript {
                session_id,
                modified: meta.modified().ok()?,
                size: meta.len(),
            })
        })
        .collect();
    found.sort_by(|a, b| b.modified.cmp(&a.modified));
    found
}

/// Copies one conversation from `from` to `to` (both configuration folders).
///
/// The transcript is copied whole. An existing copy in `to` is replaced only
/// when it is an earlier state of the same transcript (a byte prefix of the
/// source), so nothing written in the target profile is lost. Subagent
/// output and `/rewind` checkpoints are added best effort.
pub fn copy(from: &Path, to: &Path, cwd: &Path, session_id: &Uuid) -> AppResult<CopyOutcome> {
    let not_found = || AppError::NotFound("Conversation".into());
    let id = session_id.hyphenated().to_string();
    let src_folder = find_project_folder(from, cwd).ok_or_else(not_found)?;
    let src = src_folder.join(format!("{id}.jsonl"));
    if !is_real_file(&src) {
        return Err(not_found());
    }
    let folder = src_folder.file_name().ok_or_else(not_found)?.to_os_string();

    let projects = to.join(PROJECTS);
    create_private_dir(&projects)?;
    let dst_folder = find_project_folder(to, cwd).unwrap_or_else(|| projects.join(&folder));
    create_private_dir(&dst_folder)?;
    let dst = dst_folder.join(format!("{id}.jsonl"));

    let outcome = match fs::symlink_metadata(&dst) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            copy_file_atomic(&src, &dst)?;
            CopyOutcome::Copied
        }
        Err(e) => return Err(e.into()),
        Ok(meta) if !meta.is_file() => {
            return Err(AppError::Conflict(
                "The other account has something unexpected where this conversation would go"
                    .into(),
            ))
        }
        Ok(_) => match compare(&dst, &src)? {
            Prefix::Equal => CopyOutcome::Unchanged,
            Prefix::Shorter => {
                copy_file_atomic(&src, &dst)?;
                CopyOutcome::Updated
            }
            Prefix::Diverged => {
                return Err(AppError::Conflict(
                    "The other account already continued this conversation separately. Resume it there instead, or pick a different conversation.".into(),
                ))
            }
        },
    };

    // Best effort: these only matter for subagent details and /rewind.
    let extras = [
        (src_folder.join(&id), dst_folder.clone()),
        (from.join(FILE_HISTORY).join(&id), to.join(FILE_HISTORY)),
    ];
    for (src_dir, dst_parent) in extras {
        if !is_real_dir(&src_dir) {
            continue;
        }
        let result = create_private_dir(&dst_parent)
            .and_then(|_| merge_tree(&src_dir, &dst_parent.join(&id)));
        if let Err(e) = result {
            log::warn!("could not copy conversation extras: {e}");
        }
    }
    Ok(outcome)
}

enum Prefix {
    Equal,
    /// The first file is a strict prefix of the second.
    Shorter,
    Diverged,
}

fn compare(existing: &Path, source: &Path) -> io::Result<Prefix> {
    let mut a = BufReader::new(File::open(existing)?);
    let mut b = BufReader::new(File::open(source)?);
    let mut buf_a = [0u8; 64 * 1024];
    let mut buf_b = [0u8; 64 * 1024];
    loop {
        let n = read_full(&mut a, &mut buf_a)?;
        let m = read_full(&mut b, &mut buf_b)?;
        if buf_a[..n.min(m)] != buf_b[..n.min(m)] {
            return Ok(Prefix::Diverged);
        }
        match (n, m) {
            (0, 0) => return Ok(Prefix::Equal),
            (n, m) if n == m => continue,
            (n, m) if n < m => {
                // The existing copy ended first.
                return Ok(if read_full(&mut a, &mut buf_a)? == 0 {
                    Prefix::Shorter
                } else {
                    Prefix::Diverged
                });
            }
            _ => return Ok(Prefix::Diverged),
        }
    }
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match r.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}

/// Creates a directory (mode 0700) unless it already exists as a real
/// directory. Refuses symlinks so a copy can never be redirected.
fn create_private_dir(dir: &Path) -> AppResult<()> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(AppError::InvalidConfigDir(format!(
            "{} is not a regular directory",
            dir.display()
        ))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::DirBuilder::new().mode(0o700).create(dir)?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// Writes a copy next to `dst` and renames it into place, so Claude Code
/// never sees a partial transcript.
fn copy_file_atomic(src: &Path, dst: &Path) -> AppResult<()> {
    let name = dst
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::invalid("Invalid file name"))?;
    let tmp = dst.with_file_name(format!(".{name}{TEMP_SUFFIX}"));
    let _ = fs::remove_file(&tmp);
    let result = (|| -> io::Result<()> {
        let mut input = File::open(src)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        fs::rename(&tmp, dst)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(AppError::from)
}

/// Copies files from `src` into `dst` that are missing there or newer in
/// `src`. Symlinks are skipped.
fn merge_tree(src: &Path, dst: &Path) -> AppResult<()> {
    create_private_dir(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&from)?;
        if meta.is_dir() {
            merge_tree(&from, &to)?;
        } else if meta.is_file() {
            let newer = match fs::symlink_metadata(&to) {
                Ok(existing) if existing.is_file() => {
                    meta.modified().ok() > existing.modified().ok()
                }
                Ok(_) => false,
                Err(_) => true,
            };
            if newer {
                copy_file_atomic(&from, &to)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const ID: &str = "7f4aab4c-e050-4682-8962-2346d802b722";

    fn session() -> Uuid {
        Uuid::parse_str(ID).unwrap()
    }

    fn write_transcript(config: &Path, cwd: &Path, body: &str) -> PathBuf {
        let folder = config.join(PROJECTS).join(folder_name(cwd).unwrap());
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join(format!("{ID}.jsonl"));
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn folder_names_match_claude_code() {
        assert_eq!(
            folder_name(Path::new("/Users/me/my project.v2")).unwrap(),
            "-Users-me-my-project-v2"
        );
        // One dash per UTF-16 code unit, like JavaScript.
        assert_eq!(folder_name(Path::new("/a/é")).unwrap(), "-a--");
        assert_eq!(folder_name(Path::new("/a/😀")).unwrap(), "-a---");
    }

    #[test]
    fn lists_only_transcripts_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = Path::new("/work/app");
        let path = write_transcript(tmp.path(), cwd, "{}\n");
        let folder = path.parent().unwrap();
        fs::write(folder.join("notes.jsonl"), "x").unwrap();
        // (A different ID: macOS file names are case-insensitive.)
        fs::write(
            folder.join("ABCDEF00-E050-4682-8962-2346D802B722.jsonl"),
            "x",
        )
        .unwrap();
        fs::write(
            folder.join("11111111-1111-4111-8111-111111111111.jsonl"),
            "",
        )
        .unwrap();
        fs::create_dir(folder.join(ID)).unwrap();

        let found = list(tmp.path(), cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, session());
        assert_eq!(found[0].size, 3);
        assert!(list(tmp.path(), Path::new("/work/other")).is_empty());
    }

    #[test]
    fn copies_a_conversation_with_its_extras() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&b).unwrap();
        let cwd = Path::new("/work/app");
        let src = write_transcript(&a, cwd, "line 1\n");
        let extras = src.parent().unwrap().join(ID).join("tool-results");
        fs::create_dir_all(&extras).unwrap();
        fs::write(extras.join("out.txt"), "tool").unwrap();
        let history = a.join(FILE_HISTORY).join(ID);
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("abc@v1"), "old").unwrap();

        assert_eq!(copy(&a, &b, cwd, &session()).unwrap(), CopyOutcome::Copied);
        let folder = b.join(PROJECTS).join(folder_name(cwd).unwrap());
        let copied = folder.join(format!("{ID}.jsonl"));
        assert_eq!(fs::read_to_string(&copied).unwrap(), "line 1\n");
        assert_eq!(
            fs::metadata(&copied).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::read_to_string(folder.join(ID).join("tool-results/out.txt")).unwrap(),
            "tool"
        );
        assert_eq!(
            fs::read_to_string(b.join(FILE_HISTORY).join(ID).join("abc@v1")).unwrap(),
            "old"
        );
        assert_eq!(list(&b, cwd).len(), 1);
        // No temporary files are left behind.
        let names: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(TEMP_SUFFIX)));
    }

    #[test]
    fn updates_an_earlier_copy_but_never_a_diverged_one() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        let cwd = Path::new("/work/app");
        write_transcript(&a, cwd, "line 1\nline 2\n");
        let target = write_transcript(&b, cwd, "line 1\n");

        assert_eq!(copy(&a, &b, cwd, &session()).unwrap(), CopyOutcome::Updated);
        assert_eq!(fs::read_to_string(&target).unwrap(), "line 1\nline 2\n");
        assert_eq!(
            copy(&a, &b, cwd, &session()).unwrap(),
            CopyOutcome::Unchanged
        );

        fs::write(&target, "line 1\nother\n").unwrap();
        let err = copy(&a, &b, cwd, &session()).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        assert_eq!(fs::read_to_string(&target).unwrap(), "line 1\nother\n");

        // A longer copy in the target is newer than the source: keep it.
        fs::write(&target, "line 1\nline 2\nline 3\n").unwrap();
        assert!(matches!(
            copy(&a, &b, cwd, &session()).unwrap_err(),
            AppError::Conflict(_)
        ));
    }

    #[test]
    fn large_transcripts_compare_across_buffers() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        let cwd = Path::new("/work/app");
        let long = "x".repeat(200_000);
        write_transcript(&a, cwd, &format!("{long}tail"));
        write_transcript(&b, cwd, &long);
        assert_eq!(copy(&a, &b, cwd, &session()).unwrap(), CopyOutcome::Updated);
    }

    #[test]
    fn refuses_missing_conversations_and_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&b).unwrap();
        let cwd = Path::new("/work/app");
        assert!(matches!(
            copy(&a, &b, cwd, &session()).unwrap_err(),
            AppError::NotFound(_)
        ));

        // A symlinked transcript in the source is not followed.
        let real = tmp.path().join("secret.txt");
        fs::write(&real, "not a transcript").unwrap();
        let folder = a.join(PROJECTS).join(folder_name(cwd).unwrap());
        fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(&real, folder.join(format!("{ID}.jsonl"))).unwrap();
        assert!(list(&a, cwd).is_empty());
        assert!(matches!(
            copy(&a, &b, cwd, &session()).unwrap_err(),
            AppError::NotFound(_)
        ));

        // A symlinked projects folder in the target is refused.
        fs::remove_file(folder.join(format!("{ID}.jsonl"))).unwrap();
        write_transcript(&a, cwd, "line\n");
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, b.join(PROJECTS)).unwrap();
        assert!(copy(&a, &b, cwd, &session()).is_err());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[test]
    fn long_folder_names_use_the_unambiguous_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&b).unwrap();
        let cwd = PathBuf::from(format!("/work/{}", "d".repeat(260)));
        let name = folder_name(&cwd).unwrap();
        let hashed = format!("{}-abc123", &name[..MAX_FOLDER_NAME]);
        let folder = a.join(PROJECTS).join(&hashed);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(format!("{ID}.jsonl")), "line\n").unwrap();

        assert_eq!(list(&a, &cwd).len(), 1);
        copy(&a, &b, &cwd, &session()).unwrap();
        // The target uses the same (hashed) folder name as the source.
        assert!(b
            .join(PROJECTS)
            .join(&hashed)
            .join(format!("{ID}.jsonl"))
            .is_file());

        // Two folders sharing the prefix are ambiguous.
        fs::create_dir_all(
            a.join(PROJECTS)
                .join(format!("{}-zzz", &name[..MAX_FOLDER_NAME])),
        )
        .unwrap();
        assert!(list(&a, &cwd).is_empty());
    }
}
