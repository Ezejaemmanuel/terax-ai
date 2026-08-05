use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::bus::{self, Event};
use super::model::{find_session, ProjectMeta};
use super::reply;
use super::token;
use crate::modules::transcript::{reader, Format};

/// Cap on simultaneous live streams. A read-only mirror for one person's own
/// devices does not need more, and it bounds the file-read fan-out.
const MAX_STREAMS: usize = 8;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
/// Range size for expanding one clamped block. Larger than the per-block page
/// cap so "show the rest" of a big tool result finishes in a few round trips,
/// still small enough that each one stays a snappy request on a phone.
const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;
const MAX_CHUNK_BYTES: usize = 512 * 1024;
/// Floor between accepted replies. A person types one message at a time; this
/// only bites on a stuck retry loop or a script, which is the point.
const MIN_REPLY_INTERVAL: Duration = Duration::from_millis(750);

static ACTIVE_STREAMS: AtomicUsize = AtomicUsize::new(0);
static LAST_REPLY: Mutex<Option<Instant>> = Mutex::new(None);

pub struct Asset {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Rebuilt per request. The index is small and this removes any question of
/// stale caches after a session is created or deleted.
pub type IndexFn = Arc<dyn Fn() -> Vec<ProjectMeta> + Send + Sync>;
pub type AssetFn = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;
/// Writes bytes to a live pty's stdin. Owned data because the write happens on
/// a blocking worker, off the request task.
pub type WriteFn = Arc<dyn Fn(u32, Vec<u8>) -> Result<(), String> + Send + Sync>;
/// Resolves a composite session id to the pty running it, if any. Injected
/// rather than calling the bus directly so this module stays independent of
/// process-wide state — the same reason `index` and `assets` are closures.
pub type LiveFn = Arc<dyn Fn(&str) -> Option<bus::LiveSession> + Send + Sync>;

#[derive(Clone)]
pub struct AppState {
    pub token: Arc<String>,
    pub index: IndexFn,
    pub assets: AssetFn,
    pub write: WriteFn,
    pub live: LiveFn,
    /// Off unless the user turned replies on for this broadcast. The mirror is
    /// read-only by default because a token that can type into a coding agent
    /// is a token that can run commands on this machine.
    pub allow_replies: bool,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{id}", get(transcript))
        .route(
            "/api/sessions/{id}/blocks/{line}/{index}",
            get(block_chunk),
        )
        .route("/api/sessions/{id}/reply", post(reply_to_session))
        .route("/api/config", get(config))
        .route("/events", get(events))
        .fallback(static_asset)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_guard,
        ))
        .with_state(state)
}

/// Protects session data and the HTML shell. Bundled JS/CSS/images stay public:
/// the browser fetches them without the `?t=` query that only rides on the
/// first navigation, so gating those would blank the page after a successful
/// auth'd HTML load.
async fn auth_guard(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if is_public_asset(req.uri().path()) {
        return next.run(req).await;
    }

    let header = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let query = req.uri().query().map(str::to_string);

    // Anything that can change state is held to a stricter standard than a
    // read. The query token is unavoidable for reads — a QR code has to carry
    // it and EventSource cannot set headers — but that means it also leaks into
    // link previews, screenshots and history. A write must present it as a
    // header, which no drive-by navigation, <img> or plain form can do.
    let write = req.method() != Method::GET;
    let ok = if write {
        token::extract(header.as_deref(), None)
            .map(|t| token::matches(&state.token, &t))
            .unwrap_or(false)
    } else {
        token::extract(header.as_deref(), query.as_deref())
            .map(|t| token::matches(&state.token, &t))
            .unwrap_or(false)
    };

    if !ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    // The server is bound on 0.0.0.0 with no TLS, so DNS rebinding is the
    // realistic attack: a page on attacker.example resolves to this LAN address
    // and then talks to us with the browser's blessing. The token alone does
    // not stop that — but such a request necessarily carries the attacker's own
    // name in Host and Origin, and ours never does.
    if write && !addressed_directly(req.headers()) {
        return (StatusCode::FORBIDDEN, "unrecognized host").into_response();
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

/// True for hashed bundle files the HTML shell references. Paths without an
/// extension are SPA routes and still need the token (they serve index.html).
fn is_public_asset(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    matches!(
        ext,
        "js" | "mjs" | "css" | "map" | "png" | "svg" | "webp" | "woff2" | "ico" | "jpg" | "jpeg" | "gif"
    )
}

/// True when the request names this server by address rather than by some
/// domain that merely resolves to it. Our own page is loaded from the LAN IP in
/// the QR link (or localhost), so both headers are always literals; a rebound
/// domain cannot forge either without giving itself away.
fn addressed_directly(headers: &HeaderMap) -> bool {
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(is_address_literal)
        // No Host at all is an HTTP/1.1 protocol error; refuse rather than guess.
        .unwrap_or(false);

    // Absent Origin means a non-browser client (curl, a native app), which
    // rebinding does not apply to. Present means a browser told us where the
    // calling page came from, and that has to be us.
    let origin_ok = match headers.get(axum::http::header::ORIGIN) {
        None => true,
        Some(v) => v
            .to_str()
            .ok()
            .and_then(|o| o.split_once("://"))
            .map(|(_, host)| is_address_literal(host))
            .unwrap_or(false),
    };

    host_ok && origin_ok
}

/// `host[:port]` where host is an IP literal or localhost.
fn is_address_literal(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        // IPv6 literals are bracketed, and contain the colons that would
        // otherwise confuse the port split.
        match rest.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        host.split(':').next().unwrap_or(host)
    };
    name == "localhost" || name.parse::<std::net::IpAddr>().is_ok()
}

/// What this broadcast will let a viewer do. The client asks once at startup so
/// it can show or hide its composer instead of discovering the answer by
/// getting a reply rejected.
async fn config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "reply": {
            "enabled": state.allow_replies,
            "agents": reply::REPLYABLE_AGENTS,
            "maxLength": reply::MAX_LEN,
        }
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyBody {
    text: String,
    /// Send even though the agent is mid-turn, accepting that it queues.
    #[serde(default)]
    force: bool,
}

fn reply_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Type a viewer's message into the terminal running this session.
///
/// Every refusal below is load-bearing: the session must be live (not just a
/// transcript on disk), driven by an agent whose submit semantics are known,
/// and sitting at a prompt — or the sender must have said explicitly that
/// queueing is fine.
async fn reply_to_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ReplyBody>,
) -> Response {
    if !state.allow_replies {
        return reply_error(StatusCode::FORBIDDEN, "replies are turned off for this broadcast");
    }

    let Some(live) = (state.live)(id.as_str()) else {
        return reply_error(
            StatusCode::CONFLICT,
            "that session is not open in a terminal right now",
        );
    };

    if !reply::REPLYABLE_AGENTS.contains(&live.agent.as_str()) {
        return reply_error(
            StatusCode::BAD_REQUEST,
            &format!("replying to {} is not supported yet", live.agent),
        );
    }

    if !reply::accepts(&live.kind, body.force) {
        let (status, message) = if reply::is_busy(&live.kind) {
            (StatusCode::CONFLICT, "the agent is still working")
        } else {
            (StatusCode::CONFLICT, "that terminal is not accepting input")
        };
        return (
            status,
            Json(json!({ "error": message, "busy": reply::is_busy(&live.kind) })),
        )
            .into_response();
    }

    let keys = match reply::encode(&body.text) {
        Ok(k) => k,
        Err(e) => return reply_error(StatusCode::BAD_REQUEST, &e.message()),
    };

    {
        let mut last = LAST_REPLY.lock().expect("reply clock poisoned");
        let now = Instant::now();
        let too_soon = matches!(*last, Some(prev) if now.duration_since(prev) < MIN_REPLY_INTERVAL);
        if too_soon {
            return reply_error(StatusCode::TOO_MANY_REQUESTS, "slow down");
        }
        *last = Some(now);
    }

    // Off the async worker: the pty writer is a blocking pipe behind a std
    // mutex, and a stalled child must not park a runtime thread.
    let write = state.write.clone();
    let pty_id = live.pty_id;
    let sent = tokio::task::spawn_blocking(move || {
        write(pty_id, keys.paste)?;
        write(pty_id, keys.submit)
    })
    .await;

    match sent {
        Ok(Ok(())) => {
            log::info!(
                "[broadcast] reply typed into pty {pty_id} ({} chars, session {id})",
                body.text.chars().count()
            );
            Json(json!({ "ok": true })).into_response()
        }
        Ok(Err(e)) => {
            log::warn!("[broadcast] reply write failed for pty {pty_id}: {e}");
            reply_error(StatusCode::CONFLICT, "that terminal is no longer accepting input")
        }
        Err(e) => {
            log::error!("[broadcast] reply task panicked: {e}");
            reply_error(StatusCode::INTERNAL_SERVER_ERROR, "reply failed")
        }
    }
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

/// The client sends a session id, never a path. Paths come only from our own
/// index, so there is no traversal surface to defend.
async fn resolve_source(state: &AppState, id: String) -> Option<(PathBuf, Format)> {
    let index = state.index.clone();
    tokio::task::spawn_blocking(move || {
        find_session(&index(), &id).and_then(|s| s.source().map(|(p, f)| (p.clone(), f)))
    })
    .await
    .ok()
    .flatten()
}

async fn transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PageQuery>,
) -> Response {
    let Some((path, format)) = resolve_source(&state, id).await else {
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
struct ChunkQuery {
    offset: Option<usize>,
    limit: Option<usize>,
}

/// Serves the payload a page's per-block cap left behind, one range at a time.
/// Addressed by `(line, block index)` — the same line cursor the transcript
/// pages by — so no server-side state ties a request to an earlier one.
async fn block_chunk(
    State(state): State<AppState>,
    Path((id, line, index)): Path<(String, usize, usize)>,
    Query(q): Query<ChunkQuery>,
) -> Response {
    let Some((path, format)) = resolve_source(&state, id).await else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };

    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(DEFAULT_CHUNK_BYTES).clamp(1, MAX_CHUNK_BYTES);
    match tokio::task::spawn_blocking(move || {
        reader::read_block_chunk(&path, format, line, index, offset, limit)
    })
    .await
    {
        Ok(Ok(Some(chunk))) => Json(chunk).into_response(),
        // A resolved session whose block address is gone: the transcript was
        // rewritten under the viewer, which is a stale request, not an error.
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, "unknown block").into_response(),
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
    // Replay every pty's last known status before the live tail, so a viewer
    // who connects mid-session immediately knows what's open right now
    // instead of guessing from history and waiting for the next transition.
    let replay = futures_util::stream::iter(
        bus::snapshot()
            .into_iter()
            .map(|e| Ok::<_, std::convert::Infallible>(status_sse(e))),
    );
    let live = futures_util::stream::unfold(
        StreamState {
            rx,
            watched,
            offset: q.offset.unwrap_or(0),
            line: q.line.unwrap_or(0),
            _guard: StreamGuard,
        },
        step,
    );
    let stream = futures_util::StreamExt::chain(replay, live);

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

/// Shapes one `AgentStatus` bus event into the wire frame the client's status
/// listener expects, shared between the live tail and the connect-time replay.
fn status_sse(event: Event) -> SseEvent {
    let Event::AgentStatus { pty_id, kind, agent, session } = event else {
        unreachable!("status_sse only ever called with AgentStatus events");
    };
    let data = json!({
        "ptyId": pty_id,
        "kind": kind,
        "agent": agent,
        "session": session,
    });
    SseEvent::default().event("status").data(data.to_string())
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
            Event::AgentStatus { .. } => {
                return Some((Ok(status_sse(event)), s));
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

                // A writer that holds its own file locked across a whole turn
                // (Cursor's CLI keeps its SQLite db open for the duration of a
                // response, not just per line the way the JSONL agents do) can
                // make a single read land mid-transaction. Silently dropping
                // that read — the original behavior — meant the update simply
                // never arrived until some unrelated later touch happened to
                // retry it, which reads as "not realtime" even though nothing
                // was structurally broken. Retrying a few times over ~1s
                // absorbs ordinary lock contention within the same debounce
                // window instead.
                let mut append = None;
                for attempt in 0..3u32 {
                    if attempt > 0 {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    let w = watched.clone();
                    match tokio::task::spawn_blocking(move || reader::read_append(&w, format, offset, line))
                        .await
                    {
                        Ok(Ok(a)) => {
                            append = Some(a);
                            break;
                        }
                        Ok(Err(e)) => log::warn!(
                            "[broadcast] append read failed (attempt {}/3) for {}: {e}",
                            attempt + 1,
                            watched.display()
                        ),
                        Err(e) => log::warn!("[broadcast] append read task panicked: {e}"),
                    }
                }
                let Some(append) = append else {
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

    /// Captures what would have been typed, so tests assert on the exact bytes
    /// the pty would receive.
    #[derive(Clone, Default)]
    struct Typed(Arc<Mutex<Vec<Vec<u8>>>>);

    impl Typed {
        fn write_fn(&self) -> WriteFn {
            let sink = self.0.clone();
            Arc::new(move |_id, data| {
                sink.lock().expect("sink").push(data);
                Ok(())
            })
        }

        fn joined(&self) -> Vec<u8> {
            self.0.lock().expect("sink").concat()
        }
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
            write: Arc::new(|_, _| Ok(())),
            live: Arc::new(|_| None),
            allow_replies: false,
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
    async fn session_routes_require_the_token() {
        for uri in [
            "/api/sessions",
            "/api/sessions/s1",
            "/api/sessions/s1/blocks/0/0",
            "/events",
            "/",
            "/session/abc",
        ] {
            let (status, _) = get(state_with(None), uri).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} was reachable");
        }
    }

    #[tokio::test]
    async fn bundled_assets_do_not_need_the_token() {
        // Mirrors the real browser: HTML arrives with ?t=, then <script src>
        // requests come without it.
        let (status, body) = get(state_with(None), "/app.js").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("console.log"));

        let (status, _) = get(state_with(None), "/logo.png").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn public_asset_paths_match_the_bundle() {
        assert!(is_public_asset("/assets/remote-DzfmECxN.js"));
        assert!(is_public_asset("/assets/remote-Bme5EMZm.css"));
        assert!(is_public_asset("/logo.png"));
        assert!(!is_public_asset("/"));
        assert!(!is_public_asset("/api/sessions"));
        assert!(!is_public_asset("/session/abc"));
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

    /// The page's per-block cap is a transport limit, not a data loss: what it
    /// drops has to be reachable through the block route.
    #[tokio::test]
    async fn a_clamped_block_can_be_read_past_the_page_cap() {
        use crate::modules::transcript::MAX_BLOCK_BYTES;

        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("s.jsonl");
        let body = "x".repeat(MAX_BLOCK_BYTES + 2_000);
        std::fs::write(
            &p,
            format!("{{\"type\":\"user\",\"uuid\":\"u0\",\"message\":{{\"content\":\"{body}\"}}}}\n"),
        )
        .expect("write");

        let (status, page) = get(state_with(Some(p.clone())), "/api/sessions/s1?t=secret").await;
        assert_eq!(status, StatusCode::OK);
        assert!(page.contains("\"truncated\":true"));
        assert!(page.contains(&format!("\"fullBytes\":{}", body.len())));

        let (status, chunk) = get(
            state_with(Some(p.clone())),
            &format!("/api/sessions/s1/blocks/0/0?t=secret&offset={MAX_BLOCK_BYTES}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(chunk.contains("\"eof\":true"));
        assert!(chunk.contains(&format!("\"nextOffset\":{}", body.len())));

        // A block index that does not exist is a stale address, not a 500.
        let (status, _) = get(
            state_with(Some(p)),
            "/api/sessions/s1/blocks/0/9?t=secret",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
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

    /// The reply endpoint is the *only* way in. Everything else stays the
    /// read-only mirror it was designed as.
    #[tokio::test]
    async fn reply_is_the_only_write_route() {
        for uri in ["/api/sessions", "/api/sessions/s1", "/events"] {
            let res = router(state_with(None))
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("authorization", "Bearer secret")
                        .header("host", "127.0.0.1:7331")
                        .body(Body::empty())
                        .expect("req"),
                )
                .await
                .expect("response");
            assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED, "{uri} took a write");
        }
    }

    /// A state where `claude:live` is running in a pty in the given state, with
    /// replies enabled.
    fn repliable(kind: &'static str) -> (AppState, Typed) {
        let typed = Typed::default();
        let mut state = state_with(None);
        state.write = typed.write_fn();
        state.allow_replies = true;
        state.live = Arc::new(move |id| {
            (id == "claude:live").then(|| bus::LiveSession {
                pty_id: 7,
                agent: "claude".into(),
                kind: kind.into(),
            })
        });
        (state, typed)
    }

    async fn post_reply(state: AppState, body: &str, headers: &[(&str, &str)]) -> (StatusCode, String) {
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/sessions/claude:live/reply")
            .header("content-type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = router(state)
            .oneshot(req.body(Body::from(body.to_string())).expect("req"))
            .await
            .expect("response");
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.expect("body");
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    const GOOD: &[(&str, &str)] = &[
        ("authorization", "Bearer secret"),
        ("host", "192.168.1.5:7331"),
        ("origin", "http://192.168.1.5:7331"),
    ];

    // The rate-limit clock is process-wide, so the reply cases run as one test
    // to stay deterministic under the parallel harness.
    #[tokio::test]
    async fn reply_route_end_to_end() {
        // Disabled by default: the token alone must not be enough to type.
        let (mut off, typed) = repliable("attention");
        off.allow_replies = false;
        let (status, _) = post_reply(off, r#"{"text":"hi"}"#, GOOD).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(typed.joined().is_empty());

        // A write may not authenticate by query string, only by header.
        let (state, _) = repliable("attention");
        let res = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/claude:live/reply?t=secret")
                    .header("content-type", "application/json")
                    .header("host", "192.168.1.5:7331")
                    .body(Body::from(r#"{"text":"hi"}"#))
                    .expect("req"),
            )
            .await
            .expect("response");
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // A rebound domain carries its own name in Host/Origin.
        let (state, _) = repliable("attention");
        let (status, _) = post_reply(
            state,
            r#"{"text":"hi"}"#,
            &[("authorization", "Bearer secret"), ("host", "evil.example.com")],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (state, _) = repliable("attention");
        let (status, _) = post_reply(
            state,
            r#"{"text":"hi"}"#,
            &[
                ("authorization", "Bearer secret"),
                ("host", "192.168.1.5:7331"),
                ("origin", "http://evil.example.com"),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // The happy path types a bracketed paste and a separate submit.
        *LAST_REPLY.lock().expect("clock") = None;
        let (state, typed) = repliable("attention");
        let (status, body) = post_reply(state, r#"{"text":"do the thing"}"#, GOOD).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(typed.joined(), b"\x1b[200~do the thing\x1b[201~\r".to_vec());

        // Back-to-back sends are rate limited.
        let (state, typed) = repliable("attention");
        let (status, _) = post_reply(state, r#"{"text":"again"}"#, GOOD).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(typed.joined().is_empty());
        *LAST_REPLY.lock().expect("clock") = None;

        // Empty bodies never reach the terminal.
        let (state, typed) = repliable("attention");
        let (status, _) = post_reply(state, r#"{"text":"   "}"#, GOOD).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(typed.joined().is_empty());

        // A working agent needs force, and says so.
        let (state, typed) = repliable("working");
        let (status, body) = post_reply(state, r#"{"text":"stop"}"#, GOOD).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.contains("\"busy\":true"), "{body}");
        assert!(typed.joined().is_empty());

        let (state, typed) = repliable("working");
        let (status, _) = post_reply(state, r#"{"text":"stop","force":true}"#, GOOD).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(typed.joined(), b"\x1b[200~stop\x1b[201~\r".to_vec());
        *LAST_REPLY.lock().expect("clock") = None;

        // An agent that is not claude is refused until its submit semantics
        // have actually been checked.
        let (mut state, typed) = repliable("attention");
        state.live = Arc::new(|_| {
            Some(bus::LiveSession { pty_id: 7, agent: "codex".into(), kind: "attention".into() })
        });
        let (status, _) = post_reply(state, r#"{"text":"hi"}"#, GOOD).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(typed.joined().is_empty());

        // A session with no live pty is refused outright.
        let (mut state, typed) = repliable("attention");
        state.live = Arc::new(|_| None);
        let (status, _) = post_reply(state, r#"{"text":"hi"}"#, GOOD).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(typed.joined().is_empty());
    }

    #[test]
    fn only_literal_addresses_are_accepted() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:7331",
            "192.168.1.5:7331",
            "localhost:7331",
            "[::1]:7331",
        ] {
            assert!(is_address_literal(host), "{host} should pass");
        }
        for host in ["evil.example.com", "evil.example.com:7331", "", "[::1"] {
            assert!(!is_address_literal(host), "{host} should fail");
        }
    }

    #[tokio::test]
    async fn config_advertises_whether_replies_are_on() {
        let (status, body) = get(state_with(None), "/api/config?t=secret").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"enabled\":false"));
        assert!(body.contains("claude"));
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
