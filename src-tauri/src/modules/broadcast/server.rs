use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::bus::{self, Event};
use super::model::{find_session, ProjectMeta};
use super::token;
use crate::modules::transcript::{reader, Format};

/// Cap on simultaneous live streams. A read-only mirror for one person's own
/// devices does not need more, and it bounds the file-read fan-out.
const MAX_STREAMS: usize = 8;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

static ACTIVE_STREAMS: AtomicUsize = AtomicUsize::new(0);

pub struct Asset {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Rebuilt per request. The index is small and this removes any question of
/// stale caches after a session is created or deleted.
pub type IndexFn = Arc<dyn Fn() -> Vec<ProjectMeta> + Send + Sync>;
pub type AssetFn = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

#[derive(Clone)]
pub struct AppState {
    pub token: Arc<String>,
    pub index: IndexFn,
    pub assets: AssetFn,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{id}", get(transcript))
        .route("/events", get(events))
        .fallback(static_asset)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_guard,
        ))
        .with_state(state)
}

/// Guards every route including static assets: an unauthenticated viewer must
/// not even learn what the app looks like.
async fn auth_guard(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let header = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let query = req.uri().query().map(str::to_string);

    let ok = token::extract(header.as_deref(), query.as_deref())
        .map(|t| token::matches(&state.token, &t))
        .unwrap_or(false);

    if !ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    // Transcripts are sensitive and always live; never let a proxy or the
    // browser retain them.
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    res
}

async fn sessions(State(state): State<AppState>) -> Json<Vec<ProjectMeta>> {
    let index = state.index.clone();
    let projects = tokio::task::spawn_blocking(move || index())
        .await
        .unwrap_or_default();
    Json(projects)
}

#[derive(Deserialize)]
struct PageQuery {
    before: Option<usize>,
    limit: Option<usize>,
}

async fn transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PageQuery>,
) -> Response {
    let index = state.index.clone();
    // The client sends a session id, never a path. Paths come only from our own
    // index, so there is no traversal surface to defend.
    let lookup = tokio::task::spawn_blocking(move || {
        find_session(&index(), &id).and_then(|s| s.source().map(|(p, f)| (p.clone(), f)))
    })
    .await
    .ok()
    .flatten();
    let Some((path, format)) = lookup else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };

    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let before = q.before;
    match tokio::task::spawn_blocking(move || reader::read_page(&path, format, before, limit)).await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        _ => (StatusCode::NOT_FOUND, "transcript unavailable").into_response(),
    }
}

#[derive(Deserialize)]
struct StreamQuery {
    session: Option<String>,
    offset: Option<u64>,
    line: Option<usize>,
}

/// One SSE stream per viewer. Transcript deltas are sent only for the session
/// the viewer currently has open, so an idle sidebar costs status events alone.
async fn events(State(state): State<AppState>, Query(q): Query<StreamQuery>) -> Response {
    if ACTIVE_STREAMS.load(Ordering::Relaxed) >= MAX_STREAMS {
        return (StatusCode::TOO_MANY_REQUESTS, "too many viewers").into_response();
    }
    let Some(rx) = bus::subscribe() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "broadcast stopped").into_response();
    };
    ACTIVE_STREAMS.fetch_add(1, Ordering::Relaxed);

    let watched = resolve_watched(&state, q.session.as_deref()).await;
    let stream = futures_util::stream::unfold(
        StreamState {
            rx,
            watched,
            offset: q.offset.unwrap_or(0),
            line: q.line.unwrap_or(0),
            _guard: StreamGuard,
        },
        step,
    );

    Sse::new(stream)
        .keep_alive(KeepAlive::default().interval(Duration::from_secs(20)))
        .into_response()
}

async fn resolve_watched(state: &AppState, session: Option<&str>) -> Option<(PathBuf, Format)> {
    let id = session?.to_string();
    let index = state.index.clone();
    tokio::task::spawn_blocking(move || {
        find_session(&index(), &id).and_then(|s| s.source().map(|(p, f)| (p.clone(), f)))
    })
    .await
    .ok()
    .flatten()
}

/// Decrements the live-stream count however the stream ends, including client
/// disconnect, which drops the future without running any explicit cleanup.
struct StreamGuard;

impl Drop for StreamGuard {
    fn drop(&mut self) {
        ACTIVE_STREAMS.fetch_sub(1, Ordering::Relaxed);
    }
}

struct StreamState {
    rx: tokio::sync::broadcast::Receiver<Event>,
    watched: Option<(PathBuf, Format)>,
    offset: u64,
    line: usize,
    /// Held for its Drop impl; never read.
    _guard: StreamGuard,
}

async fn step(mut s: StreamState) -> Option<(Result<SseEvent, std::convert::Infallible>, StreamState)> {
    loop {
        let event = match s.rx.recv().await {
            Ok(e) => e,
            // Lagged: the client re-syncs from its own offset on the next
            // touch, so dropping intermediate events is safe.
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => return None,
        };

        match event {
            Event::AgentStatus {
                pty_id,
                kind,
                agent,
                session,
            } => {
                let data = json!({
                    "ptyId": pty_id,
                    "kind": kind,
                    "agent": agent,
                    "session": session,
                });
                return Some((Ok(SseEvent::default().event("status").data(data.to_string())), s));
            }
            Event::IndexChanged => {
                return Some((Ok(SseEvent::default().event("index").data("{}")), s));
            }
            Event::SessionTouched { path } => {
                let Some((watched, format)) = s.watched.clone() else {
                    continue;
                };
                if std::path::Path::new(&path) != watched.as_path() {
                    continue;
                }
                let (offset, line) = (s.offset, s.line);
                let w = watched.clone();
                let Ok(Ok(append)) =
                    tokio::task::spawn_blocking(move || reader::read_append(&w, format, offset, line))
                        .await
                else {
                    continue;
                };
                s.offset = append.byte_offset;
                s.line = append.next_line;
                if append.messages.is_empty() {
                    continue;
                }
                let data = json!({ "messages": append.messages });
                return Some((Ok(SseEvent::default().event("append").data(data.to_string())), s));
            }
        }
    }
}

async fn static_asset(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    // Unknown paths fall back to the shell so client-side routing works on a
    // hard refresh.
    let key = if raw.is_empty() || !raw.contains('.') {
        "index.html"
    } else {
        raw
    };
    match (state.assets)(key) {
        Some(asset) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            (headers, asset.bytes).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

pub fn content_type_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Local address the OS would use to reach the outside world. No packets are
/// sent: a UDP socket only records the route the kernel picked.
pub fn lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::broadcast::model::{find_by_path, SessionMeta};
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn asset_fn() -> AssetFn {
        Arc::new(|key: &str| match key {
            "index.html" => Some(Asset {
                bytes: b"<html>shell</html>".to_vec(),
                content_type: "text/html; charset=utf-8",
            }),
            "app.js" => Some(Asset {
                bytes: b"console.log(1)".to_vec(),
                content_type: "text/javascript; charset=utf-8",
            }),
            _ => None,
        })
    }

    fn state_with(path: Option<PathBuf>) -> AppState {
        let session = SessionMeta {
            id: "s1".into(),
            agent: "claude".into(),
            title: "t".into(),
            cwd: "/w".into(),
            updated_at: "1".into(),
            readable: path.is_some(),
            format: path.as_ref().map(|_| Format::Claude),
            path,
        };
        let projects = vec![ProjectMeta {
            name: "p".into(),
            full_path: "/p".into(),
            sessions: vec![session],
        }];
        AppState {
            token: Arc::new("secret".into()),
            index: Arc::new(move || projects.clone()),
            assets: asset_fn(),
        }
    }

    async fn get(state: AppState, uri: &str) -> (StatusCode, String) {
        let res = router(state)
            .oneshot(Request::builder().uri(uri).body(Body::empty()).expect("req"))
            .await
            .expect("response");
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .expect("body");
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    #[tokio::test]
    async fn every_route_requires_the_token() {
        for uri in ["/api/sessions", "/api/sessions/s1", "/events", "/", "/app.js"] {
            let (status, _) = get(state_with(None), uri).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} was reachable");
        }
    }

    #[tokio::test]
    async fn a_wrong_token_is_rejected() {
        let (status, _) = get(state_with(None), "/api/sessions?t=wrong").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn bearer_header_authenticates() {
        let res = router(state_with(None))
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .expect("req"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn index_returns_metadata_without_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("s.jsonl");
        std::fs::write(&p, "").expect("write");
        let (status, body) = get(state_with(Some(p)), "/api/sessions?t=secret").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"id\":\"s1\""));
        assert!(!body.contains("s.jsonl"));
    }

    #[tokio::test]
    async fn transcript_reads_a_known_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("s.jsonl");
        std::fs::write(
            &p,
            "{\"type\":\"user\",\"uuid\":\"u0\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .expect("write");
        let (status, body) = get(state_with(Some(p)), "/api/sessions/s1?t=secret").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"id\":\"u0\""));
        assert!(body.contains("\"byteLen\""));
    }

    #[tokio::test]
    async fn unknown_and_unreadable_sessions_are_404() {
        let (status, _) = get(state_with(None), "/api/sessions/s1?t=secret").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("s.jsonl");
        std::fs::write(&p, "").expect("write");
        let (status, _) = get(state_with(Some(p)), "/api/sessions/nope?t=secret").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn there_is_no_write_route() {
        let res = router(state_with(None))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions?t=secret")
                    .body(Body::empty())
                    .expect("req"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn client_routes_fall_back_to_the_shell() {
        let (status, body) = get(state_with(None), "/session/abc?t=secret").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("shell"));

        let (status, _) = get(state_with(None), "/missing.js?t=secret").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn responses_are_never_cached() {
        let res = router(state_with(None))
            .oneshot(
                Request::builder()
                    .uri("/api/sessions?t=secret")
                    .body(Body::empty())
                    .expect("req"),
            )
            .await
            .expect("response");
        assert_eq!(
            res.headers().get("cache-control").expect("header"),
            "no-store"
        );
        assert_eq!(
            res.headers().get("x-content-type-options").expect("header"),
            "nosniff"
        );
    }

    #[test]
    fn limits_are_clamped_not_trusted() {
        assert_eq!(usize::MAX.clamp(1, MAX_LIMIT), MAX_LIMIT);
        assert_eq!(0usize.clamp(1, MAX_LIMIT), 1);
    }

    #[test]
    fn content_types_cover_the_bundle() {
        assert_eq!(content_type_for("a.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("a.bin"), "application/octet-stream");
    }

    #[test]
    fn find_by_path_backs_the_watcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("s.jsonl");
        let state = state_with(Some(p.clone()));
        let projects = (state.index)();
        assert_eq!(find_by_path(&projects, &p).expect("found").id, "s1");
    }
}
