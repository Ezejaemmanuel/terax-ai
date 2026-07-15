mod agent_detect;
mod da_filter;
#[cfg(windows)]
mod job;
mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use session::Session;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    log::debug!("pty_open: cwd={cwd:?} cols={cols} rows={rows}");
    authorize_user_spawn_cwd(&registry, cwd.as_deref(), &workspace).map_err(|e| {
        log::warn!("pty_open: cwd rejected: {e}");
        e
    })?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    log::debug!("pty_open: spawning id={id}");
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, app, cols, rows, cwd, workspace, on_data, on_exit).map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed id={id}: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open spawn failed id={id}: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = {
        let mut writer = session.writer.lock().unwrap();
        write_input(&mut *writer, data.as_bytes()).map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        })
    };
    result
}

// Deliver a whole input payload to the pty in one shot. write_all loops over the
// writer until every byte is accepted, so a partial write (the underlying pipe
// taking fewer bytes than offered) never silently drops the tail — this is the
// bug class that truncates large pastes on ConPTY. The trailing flush pushes any
// buffered tail through instead of letting it sit until the next keystroke.
fn write_input<W: Write>(writer: &mut W, data: &[u8]) -> std::io::Result<()> {
    writer.write_all(data)?;
    writer.flush()
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::write_input;
    use std::io::{self, Write};

    // A writer that accepts at most `limit` bytes per write() call and counts
    // flushes — models a pipe that takes partial writes, the exact condition
    // under which a naive single write() would drop the tail of a large paste.
    struct ShortWriter {
        buf: Vec<u8>,
        limit: usize,
        flushes: usize,
    }

    impl ShortWriter {
        fn new(limit: usize) -> Self {
            Self {
                buf: Vec::new(),
                limit,
                flushes: 0,
            }
        }
    }

    impl Write for ShortWriter {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            let n = data.len().min(self.limit);
            self.buf.extend_from_slice(&data[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    #[test]
    fn writes_small_payload_whole() {
        let mut w = ShortWriter::new(4096);
        write_input(&mut w, b"echo hi\r").unwrap();
        assert_eq!(w.buf, b"echo hi\r");
        assert_eq!(w.flushes, 1);
    }

    #[test]
    fn does_not_truncate_when_writer_takes_partial_writes() {
        // 1-byte-per-call is the worst case: proves write_all loops to completion
        // and nothing is dropped, regardless of how little the pipe accepts.
        let payload: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let mut w = ShortWriter::new(1);
        write_input(&mut w, &payload).unwrap();
        assert_eq!(w.buf.len(), payload.len());
        assert_eq!(w.buf, payload);
    }

    #[test]
    fn keeps_bracketed_paste_markers_intact_across_partial_writes() {
        // A realistic large multi-line paste: the child must see the ESC[200~
        // start and ESC[201~ end with every CR-separated line between them, byte
        // for byte, even though the writer only accepts 1018 bytes per call
        // (the ConPTY threshold reported in the wild).
        let body = "some source code line\r".repeat(500);
        let payload = format!("\x1b[200~{body}\x1b[201~");
        let mut w = ShortWriter::new(1018);
        write_input(&mut w, payload.as_bytes()).unwrap();
        assert_eq!(w.buf, payload.as_bytes());
        assert!(w.buf.starts_with(b"\x1b[200~"));
        assert!(w.buf.ends_with(b"\x1b[201~"));
    }

    #[test]
    fn empty_payload_still_flushes() {
        let mut w = ShortWriter::new(64);
        write_input(&mut w, b"").unwrap();
        assert!(w.buf.is_empty());
        assert_eq!(w.flushes, 1);
    }

    #[test]
    fn propagates_writer_errors() {
        struct FailWriter;
        impl Write for FailWriter {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "child exited"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let err = write_input(&mut FailWriter, b"data").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }
}
