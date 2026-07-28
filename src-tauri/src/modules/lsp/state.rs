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
        servers.get(root).cloned()
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
            servers.remove(&key);
        }

        let install = resolve::find_tsgo(root)?;
        let client = LspClient::start(root, &install.exe, app.clone())?;
        servers.insert(key, Arc::clone(&client));
        Ok(client)
    }

    pub fn stop(&self, root: &str) {
        let client = self
            .servers
            .lock()
            .expect("lsp state poisoned")
            .remove(root);
        if let Some(client) = client {
            client.shutdown();
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
