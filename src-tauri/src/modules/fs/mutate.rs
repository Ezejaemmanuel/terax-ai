use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Creates a new empty file. Fails if the file already exists.
#[tauri::command]
pub fn fs_create_file(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::write(&p, "").map_err(|e| {
        log::debug!("fs_create_file({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Creates a new directory. Fails if the directory already exists.
/// Parents are created as needed — matches the common "new folder" UX
/// where typing "a/b/c" creates the full chain.
#[tauri::command]
pub fn fs_create_dir(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| {
        log::debug!("fs_create_dir({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Renames (or moves) a path. Refuses to overwrite an existing target.
#[tauri::command]
pub fn fs_rename(from: String, to: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let from_p = resolve_path(&from, &workspace);
    let to_p = resolve_path(&to, &workspace);
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    std::fs::rename(&from_p, &to_p).map_err(|e| {
        log::debug!(
            "fs_rename({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        e.to_string()
    })
}

/// Deletes a file or directory (recursively for dirs). Callers are
/// responsible for confirming destructive operations with the user.
#[tauri::command]
pub fn fs_delete(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::symlink_metadata(&p).map_err(|e| {
        log::debug!("fs_delete stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };

    result.map_err(|e| {
        log::warn!("fs_delete({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// What to do when a copy would land on an existing name in the destination.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// Auto-rename the incoming item (`foo.txt` -> `foo copy.txt` -> `foo copy 2.txt`).
    #[default]
    Rename,
    /// Delete the existing target, then copy over it.
    Replace,
    /// Leave the existing target untouched and skip the source.
    Skip,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CopyStatus {
    Copied,
    Skipped,
}

/// Per-source result so the frontend can reconcile (e.g. select the new rows,
/// learn the deduped name a renamed paste actually got).
#[derive(Debug, Serialize)]
pub struct CopyOutcome {
    /// Echoes back the request's source path so results can be matched up.
    pub source: String,
    /// Final destination path (canonical/display form), or `None` when skipped.
    pub dest: Option<String>,
    pub status: CopyStatus,
}

/// Splits a file name into `(stem, extension_with_dot)`. Leading-dot files with
/// no other dot (`.gitignore`) are treated as all-stem so the "copy" suffix
/// lands at the end rather than mangling the dotfile name.
fn split_stem_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(0) | None => (name, ""),
        Some(i) => (&name[..i], &name[i..]),
    }
}

/// Finds a name under `dir` that doesn't collide, mirroring the familiar
/// `name copy`, `name copy 2`, ... progression.
fn dedup_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = split_stem_ext(name);
    let first = format!("{stem} copy{ext}");
    if !dir.join(&first).exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{stem} copy {n}{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Recursively copies `src` to `dst`. Symlinks are recreated as links — like
/// `fs_delete`, we never follow a symlink into its target (avoids duplicating
/// the target's contents and sidesteps cyclic links).
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        copy_symlink(src, dst)
    } else if ft.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst).map(|_| ())
    }
}

fn copy_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    let target = std::fs::read_link(src)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, dst)
    }
    #[cfg(windows)]
    {
        // Choose the dir/file link flavor from the resolved target so Windows
        // records the correct symlink type. `metadata` follows the link here.
        if std::fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) {
            std::os::windows::fs::symlink_dir(target, dst)
        } else {
            std::os::windows::fs::symlink_file(target, dst)
        }
    }
}

fn skipped() -> CopyOutcome {
    CopyOutcome {
        source: String::new(),
        dest: None,
        status: CopyStatus::Skipped,
    }
}

fn placed(target: &Path) -> CopyOutcome {
    CopyOutcome {
        source: String::new(),
        dest: Some(crate::modules::fs::to_canon(target)),
        status: CopyStatus::Copied,
    }
}

/// Validates a source and returns its base name. `verb` ("copy"/"move") shapes
/// the error message. Rejects nesting a directory inside itself, which would
/// otherwise recurse forever.
fn prepare_source(src: &Path, dest_dir: &Path, verb: &str) -> Result<String, String> {
    if src.symlink_metadata().is_err() {
        return Err(format!("not found: {}", src.display()));
    }
    if dest_dir == src || dest_dir.starts_with(src) {
        return Err(format!("cannot {verb} {} into itself", src.display()));
    }
    Ok(src
        .file_name()
        .ok_or_else(|| format!("invalid source path: {}", src.display()))?
        .to_string_lossy()
        .into_owned())
}

/// Resolves where an incoming item named `name` lands in `dest_dir`, applying
/// the conflict policy. `Ok(None)` means "skip". For `Replace` the existing
/// target is deleted here so the caller can write freely.
fn resolve_target(
    dest_dir: &Path,
    name: &str,
    policy: ConflictPolicy,
) -> Result<Option<PathBuf>, String> {
    let mut target = dest_dir.join(name);
    if target.exists() {
        match policy {
            ConflictPolicy::Skip => return Ok(None),
            ConflictPolicy::Replace => {
                let meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
                let removed = if meta.is_dir() && !meta.file_type().is_symlink() {
                    std::fs::remove_dir_all(&target)
                } else {
                    std::fs::remove_file(&target)
                };
                removed.map_err(|e| e.to_string())?;
            }
            ConflictPolicy::Rename => target = dest_dir.join(dedup_name(dest_dir, name)),
        }
    }
    Ok(Some(target))
}

/// Copies one source into `dest_dir`. The `source` field is filled in by the caller.
fn copy_one(src: &Path, dest_dir: &Path, policy: ConflictPolicy) -> Result<CopyOutcome, String> {
    let name = prepare_source(src, dest_dir, "copy")?;
    let Some(target) = resolve_target(dest_dir, &name, policy)? else {
        return Ok(skipped());
    };
    copy_recursive(src, &target).map_err(|e| e.to_string())?;
    Ok(placed(&target))
}

/// Moves one source into `dest_dir`. Uses a rename when possible, falling back
/// to copy-then-delete across filesystem boundaries.
fn move_one(src: &Path, dest_dir: &Path, policy: ConflictPolicy) -> Result<CopyOutcome, String> {
    let name = prepare_source(src, dest_dir, "move")?;
    // Moving an item into the folder it already lives in is a no-op (without
    // this guard the Rename policy would pointlessly create a " copy").
    if src.parent() == Some(dest_dir) {
        return Ok(skipped());
    }
    let Some(target) = resolve_target(dest_dir, &name, policy)? else {
        return Ok(skipped());
    };
    if std::fs::rename(src, &target).is_err() {
        // Cross-device rename fails with EXDEV; copy then remove the original.
        copy_recursive(src, &target).map_err(|e| e.to_string())?;
        let meta = std::fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        let removed = if meta.is_dir() && !meta.file_type().is_symlink() {
            std::fs::remove_dir_all(src)
        } else {
            std::fs::remove_file(src)
        };
        removed.map_err(|e| e.to_string())?;
    }
    Ok(placed(&target))
}

/// Shared runner for `fs_copy`/`fs_move`. Fails fast on the first hard error
/// (e.g. permissions); ordinary name collisions are handled by `on_conflict`
/// rather than treated as errors.
fn run_batch(
    label: &str,
    sources: Vec<String>,
    dest_dir: String,
    on_conflict: Option<ConflictPolicy>,
    workspace: Option<WorkspaceEnv>,
    op: fn(&Path, &Path, ConflictPolicy) -> Result<CopyOutcome, String>,
) -> Result<Vec<CopyOutcome>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let policy = on_conflict.unwrap_or_default();
    let dest = resolve_path(&dest_dir, &workspace);
    if !dest.is_dir() {
        return Err(format!("destination is not a directory: {}", dest.display()));
    }

    let mut outcomes = Vec::with_capacity(sources.len());
    for source in &sources {
        let src = resolve_path(source, &workspace);
        let outcome = op(&src, &dest, policy).map_err(|e| {
            log::warn!("{label}({} -> {}) failed: {e}", src.display(), dest.display());
            e
        })?;
        outcomes.push(CopyOutcome {
            source: source.clone(),
            ..outcome
        });
    }
    Ok(outcomes)
}

/// Copies files and/or directories into `dest_dir`. Shared backend for clipboard
/// paste (copy) and drag-and-drop.
#[tauri::command]
pub fn fs_copy(
    sources: Vec<String>,
    dest_dir: String,
    on_conflict: Option<ConflictPolicy>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<CopyOutcome>, String> {
    run_batch("fs_copy", sources, dest_dir, on_conflict, workspace, copy_one)
}

/// Moves files and/or directories into `dest_dir`. Shared backend for clipboard
/// paste (cut) and drag-and-drop moves.
#[tauri::command]
pub fn fs_move(
    sources: Vec<String>,
    dest_dir: String,
    on_conflict: Option<ConflictPolicy>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<CopyOutcome>, String> {
    run_batch("fs_move", sources, dest_dir, on_conflict, workspace, move_one)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: std::path::PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn create_file_makes_empty_and_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("new.txt");
        fs_create_file(s(f.clone()), None).expect("create");
        assert!(f.exists());
        assert_eq!(std::fs::read(&f).unwrap(), b"");

        // A second create must error, not truncate existing content.
        std::fs::write(&f, b"data").unwrap();
        let err = fs_create_file(s(f.clone()), None).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&f).unwrap(), b"data");
    }

    #[test]
    fn create_dir_builds_nested_chain_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        fs_create_dir(s(nested.clone()), None).expect("create dir");
        assert!(nested.is_dir());
        let err = fs_create_dir(s(nested), None).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn rename_moves_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        std::fs::write(&from, b"payload").unwrap();

        fs_rename(s(from.clone()), s(to.clone()), None).expect("rename");
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"payload");

        // Missing source is reported, not silently ignored.
        let err = fs_rename(s(from), s(dir.path().join("c.txt")), None).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");

        // Refusing to overwrite an existing target is the data-loss guard.
        let occupied = dir.path().join("keep.txt");
        std::fs::write(&occupied, b"keep").unwrap();
        let err = fs_rename(s(to.clone()), s(occupied.clone()), None).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"keep");
        assert!(to.exists());
    }

    #[test]
    fn delete_removes_file_then_dir_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.txt");
        std::fs::write(&f, b"x").unwrap();
        fs_delete(s(f.clone()), None).expect("delete file");
        assert!(!f.exists());

        let sub = dir.path().join("sub");
        std::fs::create_dir_all(sub.join("inner")).unwrap();
        std::fs::write(sub.join("inner/y.txt"), b"y").unwrap();
        fs_delete(s(sub.clone()), None).expect("delete dir");
        assert!(!sub.exists());

        let err = fs_delete(s(dir.path().join("missing")), None).unwrap_err();
        assert!(!err.is_empty());
    }

    // Deleting a symlink that points at a directory must remove only the link,
    // never recurse through it and wipe the target's contents.
    #[cfg(unix)]
    #[test]
    fn delete_does_not_follow_symlink_into_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"keep").unwrap();

        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        fs_delete(s(link.clone()), None).expect("delete symlink");
        assert!(!link.exists(), "symlink itself should be gone");
        assert!(real.is_dir(), "target dir must survive");
        assert_eq!(std::fs::read(real.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn copy_places_file_into_destination_dir() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        std::fs::write(&src, b"payload").unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();

        let out = fs_copy(vec![s(src.clone())], s(dest.clone()), None, None).expect("copy");
        assert_eq!(out.len(), 1);
        assert!(src.exists(), "source must be left in place");
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"payload");
        assert_eq!(out[0].dest.as_deref(), Some(crate::modules::fs::to_canon(dest.join("a.txt")).as_str()));
    }

    #[test]
    fn copy_recurses_directories() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("tree");
        std::fs::create_dir_all(src.join("inner")).unwrap();
        std::fs::write(src.join("top.txt"), b"top").unwrap();
        std::fs::write(src.join("inner/deep.txt"), b"deep").unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();

        fs_copy(vec![s(src.clone())], s(dest.clone()), None, None).expect("copy dir");
        assert_eq!(std::fs::read(dest.join("tree/top.txt")).unwrap(), b"top");
        assert_eq!(std::fs::read(dest.join("tree/inner/deep.txt")).unwrap(), b"deep");
        // Original survives the copy.
        assert!(src.join("inner/deep.txt").exists());
    }

    #[test]
    fn copy_rename_policy_dedups_colliding_name() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("note.txt");
        std::fs::write(&src, b"v1").unwrap();
        // Pre-seed the destination with the same name so the paste must dedup.
        std::fs::write(dir.path().join("note.txt"), b"v1").unwrap();
        let dest = dir.path();

        // Copy into the same dir twice: "note copy.txt" then "note copy 2.txt".
        let out1 = fs_copy(vec![s(src.clone())], s(dest.to_path_buf()), None, None).expect("copy 1");
        assert!(dest.join("note copy.txt").exists(), "first dedup name");
        assert_eq!(out1[0].dest.as_deref(), Some(crate::modules::fs::to_canon(dest.join("note copy.txt")).as_str()));

        let out2 = fs_copy(vec![s(src.clone())], s(dest.to_path_buf()), None, None).expect("copy 2");
        assert!(dest.join("note copy 2.txt").exists(), "second dedup name");
        assert!(matches!(out2[0].status, CopyStatus::Copied));
    }

    #[test]
    fn copy_skip_policy_leaves_target_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        std::fs::write(&src, b"new").unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"old").unwrap();

        let out = fs_copy(
            vec![s(src.clone())],
            s(dest.clone()),
            Some(ConflictPolicy::Skip),
            None,
        )
        .expect("copy skip");
        assert!(matches!(out[0].status, CopyStatus::Skipped));
        assert!(out[0].dest.is_none());
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"old");
    }

    #[test]
    fn copy_replace_policy_overwrites_target() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        std::fs::write(&src, b"new").unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"old").unwrap();

        fs_copy(
            vec![s(src.clone())],
            s(dest.clone()),
            Some(ConflictPolicy::Replace),
            None,
        )
        .expect("copy replace");
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"new");
    }

    #[test]
    fn copy_refuses_to_copy_dir_into_its_own_descendant() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("parent");
        let inner = src.join("inner");
        std::fs::create_dir_all(&inner).unwrap();

        let err = fs_copy(vec![s(src.clone())], s(inner.clone()), None, None).unwrap_err();
        assert!(err.contains("into itself"), "got: {err}");
    }

    #[test]
    fn copy_missing_source_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        let err = fs_copy(
            vec![s(dir.path().join("nope.txt"))],
            s(dest),
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    // A symlink inside a copied tree must be recreated as a link, never followed
    // into its target — otherwise the target's contents get duplicated (or a
    // cyclic link hangs the copy).
    #[cfg(unix)]
    #[test]
    fn copy_does_not_follow_symlink_into_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"keep").unwrap();

        let src = dir.path().join("tree");
        std::fs::create_dir(&src).unwrap();
        std::os::unix::fs::symlink(&real, src.join("link")).unwrap();

        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        fs_copy(vec![s(src.clone())], s(dest.clone()), None, None).expect("copy with symlink");

        let copied_link = dest.join("tree/link");
        let meta = std::fs::symlink_metadata(&copied_link).unwrap();
        assert!(meta.file_type().is_symlink(), "link must stay a symlink");
        // The link resolves to the original target, whose contents were not copied
        // into the destination tree.
        assert!(!dest.join("tree/link").join("keep.txt").is_symlink());
        assert_eq!(std::fs::read(copied_link.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn move_relocates_and_removes_source() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        std::fs::write(&src, b"payload").unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();

        let out = fs_move(vec![s(src.clone())], s(dest.clone()), None, None).expect("move");
        assert!(!src.exists(), "source must be gone after a move");
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"payload");
        assert!(matches!(out[0].status, CopyStatus::Copied));
    }

    #[test]
    fn move_into_same_dir_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        std::fs::write(&src, b"x").unwrap();

        let out = fs_move(vec![s(src.clone())], s(dir.path().to_path_buf()), None, None)
            .expect("move noop");
        assert!(matches!(out[0].status, CopyStatus::Skipped));
        // Must not have spawned an "a copy.txt"; the original stays put.
        assert!(src.exists());
        assert!(!dir.path().join("a copy.txt").exists());
    }

    #[test]
    fn move_rename_policy_dedups_on_collision() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.txt");
        std::fs::write(&src, b"new").unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"old").unwrap();

        fs_move(vec![s(src.clone())], s(dest.clone()), None, None).expect("move dedup");
        assert!(!src.exists());
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(dest.join("a copy.txt")).unwrap(), b"new");
    }

    #[test]
    fn move_refuses_into_own_descendant() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("parent");
        let inner = src.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let err = fs_move(vec![s(src.clone())], s(inner.clone()), None, None).unwrap_err();
        assert!(err.contains("into itself"), "got: {err}");
    }
}
