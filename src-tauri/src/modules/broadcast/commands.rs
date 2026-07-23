use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::bus::{self, Event};
use super::model::{ProjectMeta, SessionMeta};
use super::notify_out::{self, Debouncer, NtfyConfig};
use super::server::{self, Asset, AppState};
use super::{token, watch};
use crate::modules::ai_history::{self, AiProject};
use crate::modules::transcript::Format;

const DEFAULT_PORT: u16 = 7331;
/// One buzz per session per minute at most.
const PUSH_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Default)]
pub struct BroadcastState(pub Mutex<Option<Running>>);

pub struct Running {
    info: BroadcastInfo,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    _watch: watch::WatchHandle,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastInfo {
    pub url: String,
    pub token: String,
    pub port: u16,
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastConfig {
    pub port: Option<u16>,
    #[serde(default)]
    pub ntfy: NtfyConfig,
}

#[tauri::command]
pub async fn broadcast_start(
    app: AppHandle,
    config: BroadcastConfig,
) -> Result<BroadcastInfo, String> {
    {
        let state = app.state::<BroadcastState>();
        let guard = state.0.lock().expect("broadcast state poisoned");
        if let Some(running) = guard.as_ref() {
            return Ok(running.info.clone());
        }
    }

    let port = config.port.unwrap_or(DEFAULT_PORT);
    // A fresh token every enable invalidates any QR code shared earlier.
    let secret = token::generate();

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .map_err(|e| format!("cannot bind port {port}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();

    let host = server::lan_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "127.0.0.1".into());
    let info = BroadcastInfo {
        url: format!("http://{host}:{bound}/?t={secret}"),
        token: secret.clone(),
        port: bound,
    };

    let tx = bus::enable();
    let watch_handle = watch::spawn(&watch::default_roots());
    spawn_push_dispatcher(config.ntfy);

    let state = AppState {
        token: Arc::new(secret),
        index: index_fn(),
        assets: asset_fn(app.clone()),
    };
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let router = server::router(state);
    tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
        if let Err(e) = result {
            log::error!("[broadcast] server stopped: {e}");
        }
        bus::disable();
        drop(tx);
    });

    log::info!("[broadcast] serving on port {bound}");
    let state = app.state::<BroadcastState>();
    let mut guard = state.0.lock().expect("broadcast state poisoned");
    *guard = Some(Running {
        info: info.clone(),
        shutdown: Some(stop_tx),
        _watch: watch_handle,
    });
    Ok(info)
}

#[tauri::command]
pub fn broadcast_stop(state: State<'_, BroadcastState>) {
    let mut guard = state.0.lock().expect("broadcast state poisoned");
    if let Some(mut running) = guard.take() {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
    }
    bus::disable();
    log::info!("[broadcast] stopped");
}

#[tauri::command]
pub fn broadcast_status(state: State<'_, BroadcastState>) -> Option<BroadcastInfo> {
    let guard = state.0.lock().expect("broadcast state poisoned");
    guard.as_ref().map(|r| r.info.clone())
}

/// Forwards attention and completion transitions to ntfy. Runs for the lifetime
/// of the broadcast; ends when the bus channel closes.
fn spawn_push_dispatcher(config: NtfyConfig) {
    let Some(endpoint) = config.endpoint() else {
        return;
    };
    let Some(mut rx) = bus::subscribe() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let mut debounce = Debouncer::new(PUSH_WINDOW);
        while let Ok(event) = rx.recv().await {
            let Event::AgentStatus {
                pty_id,
                kind,
                agent,
                session,
            } = event
            else {
                continue;
            };
            let Some(push) = notify_out::push_for(&kind, agent.as_deref(), None) else {
                continue;
            };
            let key = session.unwrap_or_else(|| pty_id.to_string());
            if !debounce.allow(&key, std::time::Instant::now()) {
                continue;
            }
            let res = client
                .post(&endpoint)
                .header("Title", &push.title)
                .header("Priority", push.priority)
                .body(push.body)
                .send()
                .await;
            if let Err(e) = res {
                log::warn!("[broadcast] push failed: {e}");
            }
        }
    });
}

/// Serves the `remote.html` bundle out of the app's embedded frontend assets,
/// so there is no runtime file dependency. Returns nothing in dev, where the
/// frontend is served by the vite dev server rather than embedded.
fn asset_fn(app: AppHandle) -> server::AssetFn {
    Arc::new(move |key: &str| {
        let path = if key == "index.html" {
            "/remote.html".to_string()
        } else {
            format!("/{key}")
        };
        app.asset_resolver().get(path).map(|asset| Asset {
            bytes: asset.bytes,
            content_type: server::content_type_for(key),
        })
    })
}

fn index_fn() -> server::IndexFn {
    Arc::new(|| tauri::async_runtime::block_on(build_index()))
}

/// Merge every agent's history into one project tree. Sessions carry their
/// agent so the client can badge them; projects are keyed by real path so the
/// same repo worked on with two agents appears once.
async fn build_index() -> Vec<ProjectMeta> {
    let claude = ai_history::ai_history_claude().await;
    let codex = ai_history::ai_history_codex().await;
    let command_code = ai_history::ai_history_command_code().await;

    let mut roots: Vec<String> = Vec::new();
    for group in [&claude, &codex, &command_code] {
        roots.extend(group.iter().map(|p| p.full_path.clone()));
    }
    roots.sort();
    roots.dedup();
    let cursor = ai_history::ai_history_cursor(roots).await;

    let mut merged: BTreeMap<String, ProjectMeta> = BTreeMap::new();
    let groups: [(&str, Option<Format>, Vec<AiProject>); 4] = [
        ("claude", Some(Format::Claude), claude),
        ("codex", Some(Format::Codex), codex),
        ("command-code", Some(Format::CommandCode), command_code),
        // Cursor stores transcripts in a SQLite `store.db`; readable when one
        // is found, same as the JSONL-backed agents.
        ("cursor", Some(Format::Cursor), cursor),
    ];

    for (agent, format, projects) in groups {
        for project in projects {
            let entry = merged
                .entry(project.full_path.clone())
                .or_insert_with(|| ProjectMeta {
                    name: project.name.clone(),
                    full_path: project.full_path.clone(),
                    sessions: Vec::new(),
                });
            for s in project.sessions {
                let path = (!s.jsonl_path.is_empty()).then(|| PathBuf::from(&s.jsonl_path));
                let readable = path.is_some() && format.is_some();
                entry.sessions.push(SessionMeta {
                    id: format!("{agent}:{}", s.id),
                    agent: agent.to_string(),
                    title: s.title,
                    cwd: s.cwd,
                    updated_at: s.updated_at,
                    readable,
                    format: readable.then_some(format).flatten(),
                    path: readable.then_some(path).flatten(),
                });
            }
        }
    }

    let mut out: Vec<ProjectMeta> = merged.into_values().collect();
    for p in &mut out {
        p.sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }
    out.sort_by(|a, b| {
        let key = |p: &ProjectMeta| {
            p.sessions
                .first()
                .map(|s| s.updated_at.clone())
                .unwrap_or_default()
        };
        key(b).cmp(&key(a))
    });
    out
}
