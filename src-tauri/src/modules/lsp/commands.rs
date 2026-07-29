use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::modules::lsp::check;
use crate::modules::lsp::state::LspState;
use crate::modules::lsp::types::{LspDiagnostic, LspFileProblems, LspLocation, LspStatus};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

/// Documents past this size are not worth a round trip: the server would hold
/// the whole text, and files this large are not what the editor is used for.
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

async fn blocking<F, T>(app: AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&WorkspaceRegistry, &LspState, &AppHandle) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let lsp = app.state::<LspState>();
        f(&registry, &lsp, &app)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn authorized_root(
    registry: &WorkspaceRegistry,
    root: &str,
    workspace: &WorkspaceEnv,
) -> Result<PathBuf, String> {
    if workspace.is_wsl() {
        return Err("The TypeScript language server is not available for WSL workspaces yet.".into());
    }
    let resolved = resolve_path(root, workspace);
    let canonical =
        std::fs::canonicalize(&resolved).map_err(|e| format!("project not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    if !registry.is_authorized(&canonical) {
        return Err(format!(
            "project is outside the authorized workspace: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// A file the server may be told about: it must exist and live inside the
/// project whose server would receive it.
fn authorized_file(root: &Path, path: &str) -> Result<String, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("file not accessible: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "{} is outside {}",
            canonical.display(),
            root.display()
        ));
    }
    Ok(crate::modules::fs::to_canon(canonical))
}

#[tauri::command]
pub async fn lsp_start(
    root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<LspStatus, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, app| {
        let root = authorized_root(registry, &root, &workspace)?;
        let key = crate::modules::fs::to_canon(&root);
        match lsp.ensure(&root, app) {
            Ok(_) => Ok(lsp.status(&key)),
            // Reported as a status rather than a command error: the UI shows it
            // on the project instead of losing it in a rejected promise.
            Err(error) => {
                log::warn!("[lsp {key}] enable failed: {error}");
                Ok(LspStatus::failed(&key, error))
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn lsp_stop(root: String, app: AppHandle) -> Result<(), String> {
    blocking(app, move |_, lsp, _| {
        // Servers are registered under the canonical path, so stopping on the
        // caller's spelling would leave the process running. A folder that no
        // longer exists still has to be stoppable, hence the fallback.
        let key = std::fs::canonicalize(&root)
            .map(crate::modules::fs::to_canon)
            .unwrap_or(root);
        lsp.stop(&key);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn lsp_stop_all(app: AppHandle) -> Result<(), String> {
    blocking(app, move |_, lsp, _| {
        lsp.stop_all();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn lsp_statuses(app: AppHandle) -> Result<Vec<LspStatus>, String> {
    blocking(app, move |_, lsp, _| Ok(lsp.statuses())).await
}

#[tauri::command]
pub async fn lsp_did_open(
    root: String,
    path: String,
    text: String,
    language_id: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, app| {
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err("file is too large for the language server".into());
        }
        let root = authorized_root(registry, &root, &workspace)?;
        let path = authorized_file(&root, &path)?;
        let client = lsp.ensure(&root, app)?;
        client.did_open(&path, &text, &language_id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn lsp_did_change(
    root: String,
    path: String,
    text: String,
    language_id: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, _| {
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err("file is too large for the language server".into());
        }
        let root = authorized_root(registry, &root, &workspace)?;
        let path = authorized_file(&root, &path)?;
        // A change for a project whose server is off is not an error; the user
        // simply has not enabled it, and starting one here would defeat that.
        let Some(client) = lsp.get(&crate::modules::fs::to_canon(&root)) else {
            return Ok(());
        };
        if !client.did_change(&path, &text) {
            client.did_open(&path, &text, &language_id);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn lsp_did_close(
    root: String,
    path: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, _| {
        let root = authorized_root(registry, &root, &workspace)?;
        let Some(client) = lsp.get(&crate::modules::fs::to_canon(&root)) else {
            return Ok(());
        };
        // The file may already be gone from disk; canonicalizing would fail, so
        // close on the path as given once it is confirmed to be one we opened.
        let canonical = std::fs::canonicalize(&path)
            .map(crate::modules::fs::to_canon)
            .unwrap_or(path);
        if client.is_open(&canonical) {
            client.did_close(&canonical);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn lsp_diagnostics(
    root: String,
    path: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<LspDiagnostic>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, _| {
        let root = authorized_root(registry, &root, &workspace)?;
        let path = authorized_file(&root, &path)?;
        let Some(client) = lsp.get(&crate::modules::fs::to_canon(&root)) else {
            return Ok(Vec::new());
        };
        client.diagnostics(&path)
    })
    .await
}

#[tauri::command]
pub async fn lsp_definition(
    root: String,
    path: String,
    line: u32,
    character: u32,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<LspLocation>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, _| {
        let root = authorized_root(registry, &root, &workspace)?;
        let path = authorized_file(&root, &path)?;
        let Some(client) = lsp.get(&crate::modules::fs::to_canon(&root)) else {
            return Ok(None);
        };
        client.definition(&path, line, character)
    })
    .await
}

#[tauri::command]
pub async fn lsp_hover(
    root: String,
    path: String,
    line: u32,
    character: u32,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, lsp, _| {
        let root = authorized_root(registry, &root, &workspace)?;
        let path = authorized_file(&root, &path)?;
        let Some(client) = lsp.get(&crate::modules::fs::to_canon(&root)) else {
            return Ok(None);
        };
        client.hover(&path, line, character)
    })
    .await
}

#[tauri::command]
pub async fn lsp_project_check(
    root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<LspFileProblems>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |registry, _, _| {
        let root = authorized_root(registry, &root, &workspace)?;
        check::project_check(&root)
    })
    .await
}
