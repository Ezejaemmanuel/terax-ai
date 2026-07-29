// Per-project server supervision. Nothing here runs until the user enables a
// specific project, and stopping one frees the process outright, so a project
// that is off costs nothing.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::modules::lsp::client::LspClient;
use crate::modules::lsp::resolve;
use crate::modules::lsp::types::{LspStatus, ServerState};

#[derive(Default)]
pub struct LspState {
    servers: Mutex<HashMap<String, Arc<LspClient>>>,
}

impl LspState {
    pub fn get(&self, root: &str) -> Option<Arc<LspClient>> {
        let servers = self.servers.lock().expect("lsp state poisoned");
        if let Some(client) = servers.get(root) {
            return Some(Arc::clone(client));
        }
        // The caller's spelling can differ from the one the server was
        // registered under (drive-letter case on Windows), and missing here
        // would strand the process while the UI reports the project as off.
        servers
            .iter()
            .find(|(key, _)| Self::same_root(key, root))
            .map(|(_, client)| Arc::clone(client))
    }

    /// The running client for `root`, starting one if needed. Holding the lock
    /// across the spawn is deliberate: two panes enabling the same project at
    /// once must not race into two servers.
    pub fn ensure(&self, root: &Path, app: &AppHandle) -> Result<Arc<LspClient>, String> {
        let key = crate::modules::fs::to_canon(root);
        let mut servers = self.servers.lock().expect("lsp state poisoned");

        if let Some(existing) = servers.get(&key) {
            if existing.is_running() {
                return Ok(Arc::clone(existing));
            }
            // Crashed since last use; replace it rather than hand back a corpse.
            log::warn!("[lsp {key}] previous server is gone, restarting");
            servers.remove(&key);
        }

        let install = resolve::find_tsgo(root).inspect_err(|e| {
            log::warn!("[lsp {key}] no language server: {e}");
        })?;
        log::info!("[lsp {key}] resolved {}", install.display);
        let client = LspClient::start(root, &install.exe, app.clone())?;
        servers.insert(key, Arc::clone(&client));
        Ok(client)
    }

    pub fn stop(&self, root: &str) {
        let client = {
            let mut servers = self.servers.lock().expect("lsp state poisoned");
            let key = servers
                .keys()
                .find(|key| Self::same_root(key, root))
                .cloned();
            key.and_then(|key| servers.remove(&key))
        };
        if let Some(client) = client {
            log::info!("[lsp {root}] stopping");
            client.shutdown();
        }
    }

    fn same_root(key: &str, root: &str) -> bool {
        if cfg!(windows) {
            key.eq_ignore_ascii_case(root)
        } else {
            key == root
        }
    }

    pub fn stop_all(&self) {
        let clients: Vec<Arc<LspClient>> = self
            .servers
            .lock()
            .expect("lsp state poisoned")
            .drain()
            .map(|(_, client)| client)
            .collect();
        for client in clients {
            client.shutdown();
        }
    }

    pub fn status(&self, root: &str) -> LspStatus {
        match self.get(root) {
            Some(client) if client.is_running() => LspStatus {
                root: root.to_string(),
                state: ServerState::Ready,
                exe: Some(client.exe.clone()),
                error: None,
                open_documents: client.open_documents(),
            },
            Some(client) => LspStatus::failed(root, format!("{} exited", client.exe)),
            None => LspStatus::stopped(root),
        }
    }

    pub fn statuses(&self) -> Vec<LspStatus> {
        let roots: Vec<String> = self
            .servers
            .lock()
            .expect("lsp state poisoned")
            .keys()
            .cloned()
            .collect();
        roots.iter().map(|root| self.status(root)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::LspState;

    #[test]
    fn a_differently_cased_root_matches_only_where_the_filesystem_agrees() {
        assert!(LspState::same_root("C:/Users/me/app", "C:/Users/me/app"));
        assert_eq!(
            LspState::same_root("C:/Users/me/app", "c:/users/me/app"),
            cfg!(windows)
        );
        assert!(!LspState::same_root("C:/Users/me/app", "C:/Users/me/other"));
    }
}
