// One tsgo process and the JSON-RPC conversation with it.
//
// Threading: a single reader thread owns the server's stdout and is the only
// place inbound messages are interpreted. Callers block on a channel for their
// reply. Writes are serialized by a mutex because the reader thread also writes
// (it answers server-initiated requests, which the server blocks on).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::modules::lsp::protocol;
use crate::modules::lsp::types::{LspDiagnostic, LspDiagnosticsEvent, LspLocation};
use crate::modules::lsp::uri;

/// Long enough for a cold project (tsgo spent ~900ms on the first didOpen of a
/// small project, and a large one loads far more), short enough that a wedged
/// server surfaces as an error instead of a hung editor.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

pub const EVENT_DIAGNOSTICS: &str = "lsp:diagnostics";
pub const EVENT_REFRESH: &str = "lsp:refresh";
pub const EVENT_EXITED: &str = "lsp:exited";

type Pending = Arc<Mutex<HashMap<i64, Sender<Value>>>>;

pub struct LspClient {
    pub root: String,
    pub exe: String,
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicI64,
    /// Open document versions, keyed by canonical path.
    documents: Mutex<HashMap<String, i64>>,
}

fn spawn_process(root: &Path, exe: &Path) -> Result<Child, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--lsp")
        .arg("-stdio")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    cmd.spawn()
        .map_err(|e| format!("failed to start {}: {e}", exe.display()))
}

impl LspClient {
    pub fn start(root: &Path, exe: &Path, app: AppHandle) -> Result<Arc<Self>, String> {
        let mut child = spawn_process(root, exe)?;
        let stdout = child.stdout.take().ok_or("language server has no stdout")?;
        let stderr = child.stderr.take().ok_or("language server has no stderr")?;
        let stdin = child.stdin.take().ok_or("language server has no stdin")?;

        let root_display = crate::modules::fs::to_canon(root);
        let stdin = Arc::new(Mutex::new(stdin));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        let client = Arc::new(Self {
            root: root_display.clone(),
            exe: crate::modules::fs::to_canon(exe),
            child: Mutex::new(child),
            stdin: Arc::clone(&stdin),
            pending: Arc::clone(&pending),
            next_id: AtomicI64::new(1),
            documents: Mutex::new(HashMap::new()),
        });

        // An unread stderr pipe eventually fills and blocks the server.
        let log_root = root_display.clone();
        std::thread::Builder::new()
            .name("terax-lsp-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::debug!("[lsp {log_root}] {line}");
                }
            })
            .map_err(|e| e.to_string())?;

        let reader_root = root_display.clone();
        let reader_stdin = Arc::clone(&stdin);
        let reader_pending = Arc::clone(&pending);
        let reader_app = app.clone();
        std::thread::Builder::new()
            .name("terax-lsp-read".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    match protocol::read_message(&mut reader) {
                        Ok(Some(text)) => {
                            dispatch(&text, &reader_root, &reader_stdin, &reader_pending, &reader_app);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::warn!("[lsp {reader_root}] read failed: {e}");
                            break;
                        }
                    }
                }
                // Dropping the senders unblocks every waiting caller with a
                // disconnect rather than making them all wait out the timeout.
                reader_pending.lock().expect("lsp pending poisoned").clear();
                let _ = reader_app.emit(EVENT_EXITED, json!({ "root": reader_root }));
            })
            .map_err(|e| e.to_string())?;

        client.initialize(root)?;
        Ok(client)
    }

    fn initialize(&self, root: &Path) -> Result<(), String> {
        let root_uri = uri::path_to_uri(root);
        let params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "Terax", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": &root_uri,
            "workspaceFolders": [{ "uri": &root_uri, "name": root.file_name().and_then(|n| n.to_str()).unwrap_or("workspace") }],
            "capabilities": {
                "workspace": {
                    "configuration": true,
                    "workspaceFolders": true,
                    "didChangeConfiguration": { "dynamicRegistration": false },
                    "diagnostics": { "refreshSupport": true },
                },
                "textDocument": {
                    // Full-document sync: verified accepted by tsgo even though
                    // it advertises incremental, and it removes a whole class of
                    // desync bugs between the editor buffer and the server.
                    "synchronization": { "dynamicRegistration": false, "didSave": false },
                    "publishDiagnostics": { "relatedInformation": false },
                    "diagnostic": { "dynamicRegistration": false, "relatedDocumentSupport": false },
                    "definition": { "linkSupport": true },
                    "hover": { "contentFormat": ["plaintext", "markdown"] },
                },
            },
        });
        self.request("initialize", params)?;
        self.notify("initialized", json!({}));
        Ok(())
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let body = message.to_string();
        let mut stdin = self.stdin.lock().expect("lsp stdin poisoned");
        stdin
            .write_all(&protocol::encode(&body))
            .and_then(|()| stdin.flush())
            .map_err(|e| format!("language server is not accepting input: {e}"))
    }

    pub fn notify(&self, method: &str, params: Value) {
        // tsgo rejects a null `params` outright, so omit the key entirely.
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            message["params"] = params;
        }
        if let Err(e) = self.send(&message) {
            log::warn!("[lsp {}] {method} not sent: {e}", self.root);
        }
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending
            .lock()
            .expect("lsp pending poisoned")
            .insert(id, tx);

        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.send(&message) {
            self.pending.lock().expect("lsp pending poisoned").remove(&id);
            return Err(e);
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(response) => {
                if let Some(error) = response.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    return Err(format!("{method} failed: {message}"));
                }
                Ok(response.get("result").cloned().unwrap_or(Value::Null))
            }
            Err(RecvTimeoutError::Timeout) => {
                self.pending.lock().expect("lsp pending poisoned").remove(&id);
                Err(format!("{method} timed out"))
            }
            Err(RecvTimeoutError::Disconnected) => Err("language server exited".into()),
        }
    }

    pub fn is_running(&self) -> bool {
        match self.child.lock() {
            Ok(mut child) => matches!(child.try_wait(), Ok(None)),
            Err(_) => false,
        }
    }

    pub fn open_documents(&self) -> usize {
        self.documents.lock().expect("lsp documents poisoned").len()
    }

    pub fn is_open(&self, path: &str) -> bool {
        self.documents
            .lock()
            .expect("lsp documents poisoned")
            .contains_key(path)
    }

    pub fn did_open(&self, path: &str, text: &str, language_id: &str) {
        // Re-opening an already-open document is a change, not a second open:
        // a duplicate didOpen is a protocol violation.
        let (version, already_open) = {
            let mut docs = self.documents.lock().expect("lsp documents poisoned");
            let version = docs.get(path).copied().map_or(1, |v| v + 1);
            let already_open = docs.insert(path.to_string(), version).is_some();
            (version, already_open)
        };
        if already_open {
            self.send_change(path, text, version);
            return;
        }
        self.notify(
            "textDocument/didOpen",
            json!({ "textDocument": {
                "uri": uri::path_to_uri(path),
                "languageId": language_id,
                "version": version,
                "text": text,
            }}),
        );
    }

    /// Returns false when the document was never opened, so the caller can
    /// decide whether to open it instead of silently desyncing the server.
    pub fn did_change(&self, path: &str, text: &str) -> bool {
        let version = {
            let mut docs = self.documents.lock().expect("lsp documents poisoned");
            let Some(current) = docs.get(path).copied() else {
                return false;
            };
            docs.insert(path.to_string(), current + 1);
            current + 1
        };
        self.send_change(path, text, version);
        true
    }

    fn send_change(&self, path: &str, text: &str, version: i64) {
        self.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri::path_to_uri(path), "version": version },
                "contentChanges": [{ "text": text }],
            }),
        );
    }

    pub fn did_close(&self, path: &str) {
        let existed = self
            .documents
            .lock()
            .expect("lsp documents poisoned")
            .remove(path)
            .is_some();
        if existed {
            self.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri::path_to_uri(path) } }),
            );
        }
    }

    /// Pull diagnostics. tsgo only pushes for config files, so this is how a
    /// source file's errors are obtained, and pulling means no work happens for
    /// files nobody is looking at.
    pub fn diagnostics(&self, path: &str) -> Result<Vec<LspDiagnostic>, String> {
        let result = self.request(
            "textDocument/diagnostic",
            json!({ "textDocument": { "uri": uri::path_to_uri(path) } }),
        )?;
        // An unchanged report carries no items and means "reuse what you have";
        // an empty list is the honest answer for a file with no problems.
        if result.get("kind").and_then(Value::as_str) == Some("unchanged") {
            return Ok(Vec::new());
        }
        Ok(result
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(LspDiagnostic::from_lsp).collect())
            .unwrap_or_default())
    }

    pub fn definition(&self, path: &str, line: u32, character: u32) -> Result<Option<LspLocation>, String> {
        let result = self.request(
            "textDocument/definition",
            json!({
                "textDocument": { "uri": uri::path_to_uri(path) },
                "position": { "line": line, "character": character },
            }),
        )?;
        Ok(first_location(&result))
    }

    pub fn hover(&self, path: &str, line: u32, character: u32) -> Result<Option<String>, String> {
        let result = self.request(
            "textDocument/hover",
            json!({
                "textDocument": { "uri": uri::path_to_uri(path) },
                "position": { "line": line, "character": character },
            }),
        )?;
        Ok(hover_text(&result))
    }

    pub fn shutdown(&self) {
        let _ = self.request("shutdown", Value::Null);
        self.notify("exit", Value::Null);
        let mut child = self.child.lock().expect("lsp child poisoned");
        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                _ => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// `Location`, `Location[]`, or `LocationLink[]` — servers pick freely.
fn first_location(result: &Value) -> Option<LspLocation> {
    let node = match result {
        Value::Array(items) => items.first()?,
        Value::Object(_) => result,
        _ => return None,
    };
    let (uri_value, range) = match (node.get("uri"), node.get("targetUri")) {
        (Some(u), _) => (u, node.get("range")),
        (_, Some(u)) => (u, node.get("targetSelectionRange").or_else(|| node.get("targetRange"))),
        _ => return None,
    };
    let path = uri::uri_to_path(uri_value.as_str()?)?;
    let start = range?.get("start")?;
    Some(LspLocation {
        path,
        line: start.get("line")?.as_u64().unwrap_or(0) as u32,
        character: start.get("character")?.as_u64().unwrap_or(0) as u32,
    })
}

fn hover_text(result: &Value) -> Option<String> {
    let contents = result.get("contents")?;
    let text = match contents {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.get("value").and_then(Value::as_str)?.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o.get("value").and_then(Value::as_str).map(str::to_string),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return None,
    };
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn dispatch(text: &str, root: &str, stdin: &Arc<Mutex<ChildStdin>>, pending: &Pending, app: &AppHandle) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        log::warn!("[lsp {root}] unparseable message");
        return;
    };

    let id = message.get("id");
    let method = message.get("method").and_then(Value::as_str);

    match (id, method) {
        (Some(id), Some(method)) => answer_server_request(id, method, &message, root, stdin, app),
        (Some(id), None) => {
            let Some(key) = id.as_i64() else { return };
            if let Some(tx) = pending.lock().expect("lsp pending poisoned").remove(&key) {
                let _ = tx.send(message);
            }
        }
        (None, Some(method)) => handle_notification(method, &message, root, app),
        (None, None) => {}
    }
}

fn answer_server_request(
    id: &Value,
    method: &str,
    message: &Value,
    root: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    app: &AppHandle,
) {
    // Every server request must be answered: tsgo blocks its initialization on
    // `workspace/configuration`, and an unanswered request wedges the server.
    let result = match method {
        "workspace/configuration" => {
            let count = message
                .pointer("/params/items")
                .and_then(Value::as_array)
                .map_or(1, Vec::len);
            // Empty objects mean "no overrides"; the server keeps its defaults.
            Value::Array(vec![json!({}); count])
        }
        "workspace/workspaceFolders" => {
            json!([{ "uri": uri::path_to_uri(root), "name": root.rsplit('/').next().unwrap_or("workspace") }])
        }
        "workspace/diagnostic/refresh" => {
            let _ = app.emit(EVENT_REFRESH, json!({ "root": root }));
            Value::Null
        }
        _ => Value::Null,
    };

    let body = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    if let Ok(mut handle) = stdin.lock() {
        let _ = handle.write_all(&protocol::encode(&body));
        let _ = handle.flush();
    }
}

fn handle_notification(method: &str, message: &Value, root: &str, app: &AppHandle) {
    match method {
        "textDocument/publishDiagnostics" => {
            let Some(params) = message.get("params") else { return };
            let Some(path) = params
                .get("uri")
                .and_then(Value::as_str)
                .and_then(uri::uri_to_path)
            else {
                return;
            };
            let diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(LspDiagnostic::from_lsp).collect())
                .unwrap_or_default();
            let _ = app.emit(
                EVENT_DIAGNOSTICS,
                LspDiagnosticsEvent {
                    root: root.to_string(),
                    path,
                    diagnostics,
                },
            );
        }
        // tsgo logs a line per handled request; only its errors are worth keeping.
        "window/logMessage" | "window/showMessage"
            if message.pointer("/params/type").and_then(Value::as_u64) == Some(1) =>
        {
            let text = message
                .pointer("/params/message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            log::warn!("[lsp {root}] {text}");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_plain_location() {
        let result = json!([{ "uri": "file:///src/lib.ts", "range": { "start": { "line": 4, "character": 16 }, "end": { "line": 4, "character": 21 } } }]);
        let loc = first_location(&result).unwrap();
        assert_eq!(loc.line, 4);
        assert_eq!(loc.character, 16);
        assert!(loc.path.ends_with("/src/lib.ts"));
    }

    #[test]
    fn reads_a_location_link_and_prefers_the_selection_range() {
        let result = json!([{
            "targetUri": "file:///src/lib.ts",
            "targetRange": { "start": { "line": 0, "character": 0 }, "end": { "line": 9, "character": 0 } },
            "targetSelectionRange": { "start": { "line": 0, "character": 16 }, "end": { "line": 0, "character": 21 } }
        }]);
        let loc = first_location(&result).unwrap();
        assert_eq!((loc.line, loc.character), (0, 16));
    }

    #[test]
    fn no_definition_is_not_an_error() {
        assert!(first_location(&Value::Null).is_none());
        assert!(first_location(&json!([])).is_none());
    }

    #[test]
    fn hover_handles_every_content_shape() {
        assert_eq!(hover_text(&json!({ "contents": "plain" })).as_deref(), Some("plain"));
        assert_eq!(
            hover_text(&json!({ "contents": { "kind": "markdown", "value": "```ts\nx\n```" } })).as_deref(),
            Some("```ts\nx\n```")
        );
        assert_eq!(
            hover_text(&json!({ "contents": ["a", { "value": "b" }] })).as_deref(),
            Some("a\n\nb")
        );
        assert!(hover_text(&json!({ "contents": "   " })).is_none());
        assert!(hover_text(&Value::Null).is_none());
    }
}
