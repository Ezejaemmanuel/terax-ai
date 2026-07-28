// Finding tsgo, the native TypeScript language server. Terax never downloads a
// toolchain: the binary must already be in the project's own dependencies, so
// the server always matches the TypeScript the project builds with.

use std::path::{Path, PathBuf};

/// How far up from the project we look for a `node_modules` that holds the
/// package. Deep enough for a monorepo package that hoists to the workspace
/// root, shallow enough never to wander into unrelated parents.
const MAX_ANCESTOR_HOPS: usize = 12;

const PACKAGE: &str = "@typescript/native-preview";

#[derive(Debug)]
pub struct TsgoInstall {
    pub exe: PathBuf,
    /// Display form of `exe`, for status and logs.
    pub display: String,
}

pub fn install_hint(project_root: &Path) -> String {
    format!(
        "TypeScript language server not found. Install it in this project with \
         `pnpm add -D {PACKAGE}` (searched {} and its parents for node_modules/{PACKAGE}).",
        crate::modules::fs::to_canon(project_root)
    )
}

/// npm platform package suffix, e.g. `win32-x64`. `None` on a target the
/// upstream package does not publish a binary for.
fn platform_suffix() -> Option<String> {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "arm" => "arm",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "tsgo.exe"
    } else {
        "tsgo"
    }
}

/// The directory holding `node_modules/@typescript/native-preview`, nearest
/// first. Returned alongside the package dir so the caller can keep the
/// resolved binary confined to the tree that declared it.
fn find_package_dir(project_root: &Path) -> Option<(PathBuf, PathBuf)> {
    project_root
        .ancestors()
        .take(MAX_ANCESTOR_HOPS)
        .find_map(|dir| {
            let pkg = dir.join("node_modules").join("@typescript").join("native-preview");
            pkg.is_dir().then(|| (dir.to_path_buf(), pkg))
        })
}

pub fn find_tsgo(project_root: &Path) -> Result<TsgoInstall, String> {
    let suffix = platform_suffix()
        .ok_or("The TypeScript language server has no prebuilt binary for this platform.")?;
    let (owner, pkg) =
        find_package_dir(project_root).ok_or_else(|| install_hint(project_root))?;

    // The binary lives in a sibling platform package. Resolve through the
    // realpath first: under pnpm the visible `native-preview` is a link into
    // the virtual store, and only its real location has that sibling.
    let real = std::fs::canonicalize(&pkg).map_err(|e| format!("{} is unreadable: {e}", pkg.display()))?;
    let siblings = real
        .parent()
        .ok_or_else(|| install_hint(project_root))?
        .to_path_buf();

    let candidates = [
        siblings.join(format!("native-preview-{suffix}")).join("lib").join(exe_name()),
        real.join("lib").join(exe_name()),
    ];
    let exe = candidates
        .into_iter()
        .find(|c| c.is_file())
        .ok_or_else(|| {
            format!(
                "{PACKAGE} is installed but its {suffix} binary is missing. \
                 Reinstall dependencies so the platform package is fetched."
            )
        })?;

    // A link that resolves out of the tree that declared the dependency would
    // let a checked-in symlink run an arbitrary executable.
    let exe = std::fs::canonicalize(&exe).map_err(|e| format!("{} is unreadable: {e}", exe.display()))?;
    let owner_real = std::fs::canonicalize(&owner).map_err(|e| e.to_string())?;
    if !exe.starts_with(&owner_real) {
        return Err(format!(
            "Refusing to run {}: it resolves outside {}.",
            crate::modules::fs::to_canon(&exe),
            crate::modules::fs::to_canon(&owner_real)
        ));
    }

    let display = crate::modules::fs::to_canon(&exe);
    Ok(TsgoInstall { exe, display })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_suffix_matches_the_published_package_names() {
        // Whatever host runs the suite, the suffix must be one npm publishes.
        let published = [
            "win32-x64",
            "win32-arm64",
            "darwin-x64",
            "darwin-arm64",
            "linux-x64",
            "linux-arm64",
            "linux-arm",
        ];
        if let Some(suffix) = platform_suffix() {
            assert!(published.contains(&suffix.as_str()), "unexpected suffix {suffix}");
        }
    }

    #[test]
    fn missing_dependency_names_the_install_command() {
        let dir = std::env::temp_dir().join("terax-lsp-resolve-empty");
        std::fs::create_dir_all(&dir).unwrap();
        let err = find_tsgo(&dir).unwrap_err();
        assert!(err.contains("pnpm add -D @typescript/native-preview"), "{err}");
    }

    #[test]
    fn ancestor_search_is_bounded() {
        // A path deeper than the hop limit must not walk all the way to root.
        let deep: PathBuf = (0..MAX_ANCESTOR_HOPS + 6).fold(std::env::temp_dir(), |acc, i| {
            acc.join(format!("d{i}"))
        });
        assert_eq!(deep.ancestors().take(MAX_ANCESTOR_HOPS).count(), MAX_ANCESTOR_HOPS);
        assert!(find_package_dir(&deep).is_none());
    }
}
