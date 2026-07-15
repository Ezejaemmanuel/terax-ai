use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use crate::modules::workspace::WorkspaceRegistry;

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024; // 2 MB — matches the git module cap

#[derive(Serialize, Clone)]
pub struct AiSession {
    pub id: String,
    pub title: String,
    pub updated_at: String, // zero-padded unix-ms or ISO 8601; sorts lexicographically
    pub cwd: String,
    pub jsonl_path: String, // absolute path to the session JSONL file
}

#[derive(Serialize, Clone)]
pub struct AiProject {
    pub name: String,      // last path segment for display
    pub full_path: String, // real filesystem path, used as CWD when opening terminal
    pub sessions: Vec<AiSession>,
}

// Returns file mtime as a zero-padded decimal string so it sorts correctly.
fn file_mtime_ms_str(path: &Path) -> String {
    let ms = fs::metadata(path)
        .and_then(|m| m.modified())
        .and_then(|t| {
            t.duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    format!("{:020}", ms)
}

// Last non-empty segment of a path, used as the display project name.
fn short_name(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

// Read title and cwd from a Claude Code session JSONL file.
// We scan at most 30 lines: the ai-title is typically line 1 and the cwd
// appears in the first user/assistant message (usually lines 2-5).
fn read_claude_session_info(jsonl_path: &Path) -> (Option<String>, Option<String>) {
    let content = match fs::read_to_string(jsonl_path) {
        Ok(c) => c,
        Err(_) => return (None, None),
    };

    let mut title: Option<String> = None;
    let mut cwd: Option<String> = None;

    for line in content.lines().take(30) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        // Extract title from ai-title record (usually the very first line).
        if title.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
            title = v.get("aiTitle").and_then(|t| t.as_str()).map(|s| s.to_string());
        }

        // The cwd field is present on every user/assistant/attachment record.
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }

        // Fallback title from first user message text.
        if title.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            if let Some(text) = v
                .pointer("/message/content/0/text")
                .and_then(|t| t.as_str())
            {
                let truncated: String = text.chars().take(60).collect();
                title = Some(truncated);
            }
        }

        if title.is_some() && cwd.is_some() {
            break;
        }
    }

    (title, cwd)
}

#[tauri::command]
pub async fn ai_history_claude() -> Vec<AiProject> {
    tokio::task::spawn_blocking(|| {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return vec![],
        };
        let projects_dir = home.join(".claude").join("projects");
        if !projects_dir.exists() {
            return vec![];
        }

        let mut project_map: HashMap<String, AiProject> = HashMap::new();

        let project_dirs = match fs::read_dir(&projects_dir) {
            Ok(e) => e,
            Err(_) => return vec![],
        };

        for project_entry in project_dirs.filter_map(|e| e.ok()) {
            let project_dir = project_entry.path();
            if !project_dir.is_dir() {
                continue;
            }
            let session_entries = match fs::read_dir(&project_dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for s_entry in session_entries.filter_map(|e| e.ok()) {
                let s_path = s_entry.path();
                if s_path.is_dir() {
                    continue;
                }
                if s_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let session_id = match s_path.file_stem().and_then(|s| s.to_str()) {
                    Some(id) => id.to_string(),
                    None => continue,
                };
                let (title, cwd_opt) = read_claude_session_info(&s_path);
                let title = title.unwrap_or_else(|| "Untitled session".to_string());
                let full_path = match cwd_opt {
                    Some(c) if !c.is_empty() => c,
                    _ => continue,
                };
                let updated_at = file_mtime_ms_str(&s_path);
                let jsonl_path = s_path.to_string_lossy().into_owned();
                let session = AiSession {
                    id: session_id,
                    title,
                    updated_at,
                    cwd: full_path.clone(),
                    jsonl_path,
                };
                let name = short_name(&full_path);
                project_map
                    .entry(full_path.clone())
                    .and_modify(|p| p.sessions.push(session.clone()))
                    .or_insert_with(|| AiProject {
                        name,
                        full_path,
                        sessions: vec![session],
                    });
            }
        }

        let mut projects: Vec<AiProject> = project_map.into_values().collect();
        for p in &mut projects {
            p.sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        }
        projects.sort_by(|a, b| {
            let a_ts = a.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            let b_ts = b.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            b_ts.cmp(a_ts)
        });
        projects
    })
    .await
    .unwrap_or_default()
}

// Lightweight cwd-only read: stops at the first record carrying a `cwd` field
// (present on every user/assistant/attachment record), so we don't pay for
// title extraction when only resolving which folder a session belongs to.
fn read_claude_session_cwd(jsonl_path: &Path) -> Option<String> {
    let content = fs::read_to_string(jsonl_path).ok()?;
    for line in content.lines().take(30) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
            if !c.is_empty() {
                return Some(c.to_string());
            }
        }
    }
    None
}

// Normalize a path for comparison: forward slashes, no trailing slash, and
// case-folded on Windows where the filesystem is case-insensitive.
fn norm_cwd(s: &str) -> String {
    let n = s.replace('\\', "/");
    let n = n.trim_end_matches('/').to_string();
    if cfg!(windows) {
        n.to_lowercase()
    } else {
        n
    }
}

/// Most reliable session tracker: scan Claude's own on-disk session store
/// (`~/.claude/projects/*/*.jsonl`) and return the id of the most-recently
/// modified session whose recorded cwd matches `cwd`. Matching on the cwd
/// embedded in each file (rather than reconstructing Claude's directory-name
/// encoding) keeps this correct across platforms. Returns None when the folder
/// has no Claude history yet — the caller then starts a fresh session.
#[tauri::command]
pub async fn claude_latest_session(cwd: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir()?;
        let projects_dir = home.join(".claude").join("projects");
        if !projects_dir.exists() {
            return None;
        }
        let target = norm_cwd(&cwd);
        let mut best: Option<(String, String)> = None; // (mtime_str, session_id)
        for project_entry in fs::read_dir(&projects_dir).ok()?.filter_map(|e| e.ok()) {
            let project_dir = project_entry.path();
            if !project_dir.is_dir() {
                continue;
            }
            let Ok(entries) = fs::read_dir(&project_dir) else {
                continue;
            };
            for s_entry in entries.filter_map(|e| e.ok()) {
                let s_path = s_entry.path();
                if s_path.is_dir()
                    || s_path.extension().and_then(|e| e.to_str()) != Some("jsonl")
                {
                    continue;
                }
                let Some(id) = s_path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Some(c) = read_claude_session_cwd(&s_path) else {
                    continue;
                };
                if norm_cwd(&c) != target {
                    continue;
                }
                let mtime = file_mtime_ms_str(&s_path);
                if best.as_ref().is_none_or(|(bm, _)| mtime > *bm) {
                    best = Some((mtime, id.to_string()));
                }
            }
        }
        let result = best.map(|(_, id)| id);
        match &result {
            Some(id) => log::info!("[agent] resume: latest session for cwd={cwd} -> {id}"),
            None => log::info!("[agent] resume: no prior Claude session for cwd={cwd}; will start fresh"),
        }
        result
    })
    .await
    .ok()
    .flatten()
}

/// Resolve a Claude session id to its conversation title (the ai-title record,
/// or the first user message as a fallback). Used to label a terminal tab once
/// its session id is bound via the agent hook. Looks the file up directly as
/// `~/.claude/projects/*/<session_id>.jsonl`, so it's cheap. Returns None when
/// the session has no title yet (brand-new session before the first turn).
#[tauri::command]
pub async fn claude_session_title(session_id: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir()?;
        let projects_dir = home.join(".claude").join("projects");
        if !projects_dir.exists() {
            return None;
        }
        let file_name = format!("{session_id}.jsonl");
        for project_entry in fs::read_dir(&projects_dir).ok()?.filter_map(|e| e.ok()) {
            let candidate = project_entry.path().join(&file_name);
            if candidate.is_file() {
                let (title, _) = read_claude_session_info(&candidate);
                if let Some(ref t) = title {
                    log::info!("[agent] session title for {session_id}: {t}");
                }
                return title;
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// Most-recently-updated Cursor chat id for a workspace.
/// Cursor stores chats under `~/.cursor/chats/<md5(path)>/<chatId>/meta.json`.
/// Returns the chat directory name (used with `cursor-agent --resume=<id>`)
/// or None when the folder has no prior Cursor sessions.
#[tauri::command]
pub async fn cursor_latest_session(cwd: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir()?;
        let chats_dir = home.join(".cursor").join("chats");
        if !chats_dir.exists() {
            return None;
        }
        let mut best: Option<(u64, String)> = None; // (updated_at_ms, chat_id)
        for hash in cursor_root_hashes(&cwd) {
            let hash_dir = chats_dir.join(&hash);
            if !hash_dir.is_dir() {
                continue;
            }
            let Ok(entries) = fs::read_dir(&hash_dir) else { continue };
            for entry in entries.flatten() {
                let chat_path = entry.path();
                if !chat_path.is_dir() {
                    continue;
                }
                let Some(chat_id) = chat_path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else {
                    continue;
                };
                let meta_path = chat_path.join("meta.json");
                let Ok(content) = fs::read_to_string(&meta_path) else { continue };
                let Ok(meta) = serde_json::from_str::<CursorChatMeta>(&content) else { continue };
                if !meta.has_conversation {
                    continue;
                }
                let ts = if meta.updated_at_ms > 0 { meta.updated_at_ms } else { meta.created_at_ms };
                if best.as_ref().is_none_or(|(bt, _)| ts > *bt) {
                    best = Some((ts, chat_id));
                }
            }
        }
        let result = best.map(|(_, id)| id);
        match &result {
            Some(id) => log::info!("[agent] cursor resume: latest session for cwd={cwd} -> {id}"),
            None => log::info!("[agent] cursor resume: no prior Cursor session for cwd={cwd}"),
        }
        result
    })
    .await
    .ok()
    .flatten()
}

/// Most-recently-modified Command Code session title for a workspace.
/// Command Code stores sessions under `~/.commandcode/projects/<encoded_path>/<id>.meta.json`.
/// Returns the session title (used with `command-code --resume "<title>"`)
/// or None when the folder has no prior Command Code sessions.
#[tauri::command]
pub async fn command_code_latest_session(cwd: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir()?;
        let projects_dir = home.join(".commandcode").join("projects");
        if !projects_dir.exists() {
            return None;
        }
        let trimmed = cwd.trim_end_matches(['/', '\\']).to_string();
        let variants = [
            trimmed.clone(),
            trimmed.replace('/', "\\"),
            trimmed.replace('\\', "/"),
        ];
        let mut best: Option<(String, String)> = None; // (mtime_str, title)
        for variant in &variants {
            let encoded = encode_path_component(variant);
            let project_dir = projects_dir.join(&encoded);
            if !project_dir.is_dir() {
                continue;
            }
            let Ok(entries) = fs::read_dir(&project_dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                if !fname.ends_with(".meta.json") {
                    continue;
                }
                let id = fname.trim_end_matches(".meta.json").to_string();
                if id.is_empty() {
                    continue;
                }
                let title = read_commandcode_title(&path).unwrap_or(id);
                let mtime = file_mtime_ms_str(&path);
                if best.as_ref().is_none_or(|(bm, _)| mtime > *bm) {
                    best = Some((mtime, title));
                }
            }
            if best.is_some() {
                break; // found sessions for this encoding variant
            }
        }
        let result = best.map(|(_, title)| title);
        match &result {
            Some(t) => log::info!("[agent] cc resume: latest session for cwd={cwd} -> {t}"),
            None => log::info!("[agent] cc resume: no prior CommandCode session for cwd={cwd}"),
        }
        result
    })
    .await
    .ok()
    .flatten()
}

// Build a map of session_id → file path by scanning the Codex sessions directory
// once rather than doing an O(n) walk per session lookup.
fn build_codex_file_index(sessions_dir: &Path) -> HashMap<String, PathBuf> {
    let mut map: HashMap<String, PathBuf> = HashMap::new();

    let Ok(years) = fs::read_dir(sessions_dir) else {
        return map;
    };
    for year in years.filter_map(|e| e.ok()) {
        let year_path = year.path();
        if !year_path.is_dir() {
            continue;
        }
        let Ok(months) = fs::read_dir(&year_path) else {
            continue;
        };
        for month in months.filter_map(|e| e.ok()) {
            let month_path = month.path();
            if !month_path.is_dir() {
                continue;
            }
            let Ok(days) = fs::read_dir(&month_path) else {
                continue;
            };
            for day in days.filter_map(|e| e.ok()) {
                let file_path = day.path();
                if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                // Filename: rollout-TIMESTAMP-SESSION_ID.jsonl
                // Extract the UUID at the end of the stem.
                if let Some(stem) = file_path.file_stem().and_then(|s| s.to_str()) {
                    // The session ID is the last UUID segment after the last '-'
                    // Pattern: rollout-2026-04-22T14-07-31-019db54d-8b18-7312-9ac3-5310e7a71e14
                    // The UUID is the last 36 chars (with hyphens) but it's easier to
                    // find it from the index entry. We store the full stem-after-rollout
                    // and match it against the session id from the index.
                    if let Some(id_part) = extract_codex_session_id(stem) {
                        map.insert(id_part, file_path);
                    }
                }
            }
        }
    }

    map
}

// Extract the Codex session UUID from a rollout filename stem.
// Filename stem: "rollout-2026-04-22T14-07-31-019db54d-8b18-7312-9ac3-5310e7a71e14"
// The UUID is the last portion. Codex UUIDs are 128-bit (32 hex chars with 4 dashes = 36 chars),
// but Codex uses ULID format. We just grab everything after the timestamp segment.
fn extract_codex_session_id(stem: &str) -> Option<String> {
    // Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>
    // The timestamp part is "YYYY-MM-DDTHH-MM-SS" = 19 chars, preceded by "rollout-" (8 chars)
    // Total prefix = 8 + 19 + 1 (separator) = 28 chars
    if !stem.starts_with("rollout-") {
        return None;
    }
    let after_rollout = &stem[8..]; // strip "rollout-"
    // Skip the timestamp: "YYYY-MM-DDTHH-MM-SS-" = 20 chars
    if after_rollout.len() <= 20 {
        return None;
    }
    Some(after_rollout[20..].to_string())
}

// Read the cwd from a Codex rollout JSONL file (first session_meta event).
fn read_codex_cwd(jsonl_path: &Path) -> Option<String> {
    let content = fs::read_to_string(jsonl_path).ok()?;
    for line in content.lines().take(10) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
            if let Some(cwd) = entry.pointer("/payload/cwd").and_then(|c| c.as_str()) {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Holds one recursive notify watcher per tool, kept alive for the app lifetime.
#[derive(Default)]
pub struct AiHistoryWatchState {
    claude: Mutex<Option<RecommendedWatcher>>,
    codex: Mutex<Option<RecommendedWatcher>>,
    command_code: Mutex<Option<RecommendedWatcher>>,
    cursor: Mutex<Option<RecommendedWatcher>>,
}

/// Start a recursive file watcher on the tool's session directory.
/// Idempotent — calling it a second time for the same tool is a no-op.
/// Emits `ai:history_changed` (payload = tool string) on any write/create/delete.
#[tauri::command]
pub fn ai_history_watch(
    tool: String,
    app: AppHandle,
    state: State<'_, AiHistoryWatchState>,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    let watch_dir = match tool.as_str() {
        "claude" => home.join(".claude").join("projects"),
        "codex" => home.join(".codex"),
        "command-code" => home.join(".commandcode").join("projects"),
        "cursor" => home.join(".cursor").join("chats"),
        other => return Err(format!("unknown tool: {other}")),
    };

    let slot = match tool.as_str() {
        "claude" => &state.claude,
        "command-code" => &state.command_code,
        "cursor" => &state.cursor,
        _ => &state.codex,
    };
    let mut guard = slot.lock().expect("ai history watch state poisoned");
    if guard.is_some() {
        return Ok(());
    }

    // Directory may not exist yet on a fresh install — skip silently.
    if !watch_dir.is_dir() {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&watch_dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let tool_str = tool.clone();
    std::thread::Builder::new()
        .name(format!("terax-ai-history-{tool}"))
        .spawn(move || {
            const DEBOUNCE: Duration = Duration::from_millis(300);
            const MAX_WINDOW: Duration = Duration::from_millis(1500);
            loop {
                let first = match rx.recv() {
                    Ok(ev) => ev,
                    Err(_) => return,
                };
                let mut has_change =
                    first.is_ok_and(|ev| !matches!(ev.kind, EventKind::Access(_)));

                let deadline = Instant::now() + MAX_WINDOW;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let timeout = DEBOUNCE.min(remaining);
                    match rx.recv_timeout(timeout) {
                        Ok(Ok(ev)) => {
                            if !matches!(ev.kind, EventKind::Access(_)) {
                                has_change = true;
                            }
                        }
                        Ok(Err(_)) => {}
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                }

                if has_change {
                    let _ = app.emit("ai:history_changed", &tool_str);
                }
            }
        })
        .map_err(|e| e.to_string())?;

    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub async fn ai_history_codex() -> Vec<AiProject> {
    tokio::task::spawn_blocking(|| {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return vec![],
        };
        let codex_dir = home.join(".codex");
        if !codex_dir.exists() {
            return vec![];
        }

        let index_path = codex_dir.join("session_index.jsonl");
        let sessions_dir = codex_dir.join("sessions");

        let index_content = match fs::read_to_string(&index_path) {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        let file_index = if sessions_dir.exists() {
            build_codex_file_index(&sessions_dir)
        } else {
            HashMap::new()
        };

        let mut project_map: HashMap<String, AiProject> = HashMap::new();

        for line in index_content.lines() {
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let id = match entry.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let title = entry
                .get("thread_name")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled session")
                .to_string();
            let updated_at = entry
                .get("updated_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let cwd = file_index
                .get(&id)
                .and_then(|p| read_codex_cwd(p))
                .unwrap_or_default();
            let full_path = if cwd.is_empty() {
                home.to_string_lossy().to_string()
            } else {
                cwd
            };
            let name = short_name(&full_path);
            let session = AiSession {
                id,
                title,
                updated_at,
                cwd: full_path.clone(),
                jsonl_path: String::new(), // Codex JSONL tracking not yet supported
            };
            project_map
                .entry(full_path.clone())
                .and_modify(|p| p.sessions.push(session.clone()))
                .or_insert_with(|| AiProject {
                    name,
                    full_path,
                    sessions: vec![session],
                });
        }

        let mut projects: Vec<AiProject> = project_map.into_values().collect();
        for p in &mut projects {
            p.sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        }
        projects.sort_by(|a, b| {
            let a_ts = a.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            let b_ts = b.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            b_ts.cmp(a_ts)
        });
        projects
    })
    .await
    .unwrap_or_default()
}

// ── Command Code history ──────────────────────────────────────────────────────

fn read_commandcode_title(meta_path: &Path) -> Option<String> {
    let content = fs::read_to_string(meta_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("title").and_then(|t| t.as_str()).map(|s| s.to_string())
}

/// Encode a single path component the way Command Code does: lowercase,
/// drop colons, replace separators with hyphens.
fn encode_path_component(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            ':' => None,
            '\\' | '/' => Some('-'),
            c => Some(c.to_ascii_lowercase()),
        })
        .collect()
}

/// Greedily walk the real filesystem to decode a Command Code encoded folder
/// name back to the absolute path it originally represented.
///
/// Command Code encodes `C:\Users\HP\dev\my-proj` as `c-users-hp-dev-my-proj`
/// (colon removed, separators → `-`, lowercased). Because folder names can also
/// contain hyphens, we can't simply split on `-`; instead we read actual
/// directory entries at each level and try the longest match first.
///
/// Returns the decoded `PathBuf` when every segment resolves on disk, or `None`
/// when the project directory no longer exists.
fn decode_commandcode_path(encoded: &str, home: &Path) -> Option<PathBuf> {
    let home_encoded = encode_path_component(&home.to_string_lossy());
    let home_encoded = home_encoded.trim_matches('-');

    let relative_encoded = encoded.strip_prefix(home_encoded)?.trim_start_matches('-');
    if relative_encoded.is_empty() {
        return if home.is_dir() { Some(home.to_path_buf()) } else { None };
    }

    let mut current = home.to_path_buf();
    let mut remaining = relative_encoded;

    while !remaining.is_empty() {
        // Collect subdirectory names under `current`.
        let mut names: Vec<String> = fs::read_dir(&current)
            .ok()?
            .flatten()
            .filter_map(|e| {
                if e.path().is_dir() {
                    e.file_name().to_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        // Sort longest-first so longer names win over shorter prefixes.
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));

        let mut matched = false;
        for name in &names {
            let enc = encode_path_component(name);
            if remaining.starts_with(enc.as_str()) {
                let after = &remaining[enc.len()..];
                if after.is_empty() || after.starts_with('-') {
                    current = current.join(name);
                    remaining = after.trim_start_matches('-');
                    matched = true;
                    break;
                }
            }
        }

        if !matched {
            return None;
        }
    }

    if current.is_dir() { Some(current) } else { None }
}

#[tauri::command]
pub async fn ai_history_command_code() -> Vec<AiProject> {
    tokio::task::spawn_blocking(|| {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return vec![],
        };
        let projects_dir = home.join(".commandcode").join("projects");
        if !projects_dir.exists() {
            return vec![];
        }

        let mut projects: Vec<AiProject> = Vec::new();

        let entries = match fs::read_dir(&projects_dir) {
            Ok(e) => e,
            Err(_) => return vec![],
        };

        for entry in entries.flatten() {
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                continue;
            }

            let folder_name = project_dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();

            // Decode the encoded folder name to the real filesystem path so
            // the "+" button opens a terminal in the right directory.
            let (full_path, name) = if let Some(real) = decode_commandcode_path(&folder_name, &home) {
                let s = real.to_string_lossy().into_owned();
                let n = short_name(&s);
                (s, n)
            } else {
                // Project folder deleted or path can't be decoded; show the
                // encoded name as a fallback and use it as the key.
                (folder_name.clone(), folder_name.clone())
            };

            let mut sessions: Vec<AiSession> = Vec::new();

            let session_entries = match fs::read_dir(&project_dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for sess_entry in session_entries.flatten() {
                let path = sess_entry.path();
                let fname = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();

                if !fname.ends_with(".meta.json") {
                    continue;
                }

                let id = fname.trim_end_matches(".meta.json").to_string();
                if id.is_empty() {
                    continue;
                }

                let title = read_commandcode_title(&path).unwrap_or_else(|| id.clone());
                let updated_at = file_mtime_ms_str(&path);

                sessions.push(AiSession {
                    id,
                    title,
                    updated_at,
                    cwd: full_path.clone(),
                    jsonl_path: String::new(),
                });
            }

            if sessions.is_empty() {
                continue;
            }

            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

            projects.push(AiProject {
                name,
                full_path,
                sessions,
            });
        }

        projects.sort_by(|a, b| {
            let a_ts = a.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            let b_ts = b.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            b_ts.cmp(a_ts)
        });

        projects
    })
    .await
    .unwrap_or_default()
}

// Variant hashes for a candidate workspace path. The Cursor CLI keys its chat
// store on `md5(<workspace path>)` using the path exactly as the OS reports it
// (native separators, original case). Since the host may carry a cwd with either
// separator and a trailing slash, we hash a few normalizations and map each back
// to the original path, so whichever form Cursor used still resolves.
fn cursor_root_hashes(root: &str) -> Vec<String> {
    let trimmed = root.trim_end_matches(['/', '\\']);
    let mut variants: Vec<String> = vec![
        trimmed.to_string(),
        trimmed.replace('/', "\\"),
        trimmed.replace('\\', "/"),
    ];
    variants.sort();
    variants.dedup();
    variants
        .into_iter()
        .map(|v| format!("{:x}", md5::compute(v.as_bytes())))
        .collect()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorChatMeta {
    title: Option<String>,
    #[serde(default)]
    has_conversation: bool,
    #[serde(default)]
    updated_at_ms: u64,
    #[serde(default)]
    created_at_ms: u64,
}

/// History reader for the Cursor CLI agent (`cursor-agent`). Unlike Claude /
/// Codex / Command Code, Cursor does NOT record the workspace path on disk — it
/// stores each chat under `~/.cursor/chats/<md5(workspace path)>/<chatId>/` with
/// a `meta.json` (title + timestamps) and a SQLite `store.db` transcript. Because
/// the directory name is a one-way hash, we can't enumerate folders from the
/// store; instead the caller passes the workspace paths the host already knows
/// (open terminals, active folders), we hash each, and surface the chats that
/// live under a matching hash. Chats in folders the host doesn't know about are
/// not shown (there is no way to recover their path from the hash).
#[tauri::command]
pub async fn ai_history_cursor(roots: Vec<String>) -> Vec<AiProject> {
    tokio::task::spawn_blocking(move || {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return vec![],
        };
        let chats_dir = home.join(".cursor").join("chats");
        if !chats_dir.exists() {
            return vec![];
        }

        // hash -> real workspace path (first writer wins on collision).
        let mut hash_to_root: HashMap<String, String> = HashMap::new();
        for root in &roots {
            if root.is_empty() {
                continue;
            }
            for h in cursor_root_hashes(root) {
                hash_to_root.entry(h).or_insert_with(|| root.clone());
            }
        }

        let mut projects: Vec<AiProject> = Vec::new();

        for root_entry in fs::read_dir(&chats_dir).into_iter().flatten().flatten() {
            let root_path = root_entry.path();
            if !root_path.is_dir() {
                continue;
            }
            let hash = match root_path.file_name().and_then(|n| n.to_str()) {
                Some(h) => h.to_string(),
                None => continue,
            };
            let Some(workspace) = hash_to_root.get(&hash).cloned() else {
                continue; // unknown workspace — path not recoverable from the hash
            };

            let mut sessions: Vec<AiSession> = Vec::new();
            for chat_entry in fs::read_dir(&root_path).into_iter().flatten().flatten() {
                let chat_path = chat_entry.path();
                if !chat_path.is_dir() {
                    continue;
                }
                let chat_id = match chat_path.file_name().and_then(|n| n.to_str()) {
                    Some(id) => id.to_string(),
                    None => continue,
                };
                let meta_path = chat_path.join("meta.json");
                let Ok(content) = fs::read_to_string(&meta_path) else {
                    continue;
                };
                let Ok(meta) = serde_json::from_str::<CursorChatMeta>(&content) else {
                    continue;
                };
                // Empty chats (created but never used) carry no conversation.
                if !meta.has_conversation {
                    continue;
                }
                let ts = if meta.updated_at_ms > 0 {
                    meta.updated_at_ms
                } else {
                    meta.created_at_ms
                };
                sessions.push(AiSession {
                    id: chat_id,
                    title: meta.title.filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled chat".to_string()),
                    updated_at: format!("{:020}", ts),
                    cwd: workspace.clone(),
                    // Cursor transcripts are SQLite, not JSONL — no session-diff source.
                    jsonl_path: String::new(),
                });
            }

            if sessions.is_empty() {
                continue;
            }
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            projects.push(AiProject {
                name: short_name(&workspace),
                full_path: workspace,
                sessions,
            });
        }

        projects.sort_by(|a, b| {
            let a_ts = a.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            let b_ts = b.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
            b_ts.cmp(a_ts)
        });
        projects
    })
    .await
    .unwrap_or_default()
}

// ── Session file-change tracking ─────────────────────────────────────────────

const GIT_TIMEOUT_SECS: u64 = 30;

// Runs a git command on a separate thread and waits up to `timeout_secs`.
// We can't kill the child on timeout, but we stop blocking the caller's thread.
fn git_output_with_timeout(
    args: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    use std::sync::mpsc;
    let args: Vec<String> = args.iter().map(|&s| s.to_string()).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.args(&args);
        // Suppress the console window that would otherwise flash on Windows for
        // every git invocation — this path runs once per changed file and is
        // re-triggered on each live session refresh.
        crate::modules::proc::hide_console(&mut cmd);
        let _ = tx.send(cmd.output());
    });
    rx.recv_timeout(Duration::from_secs(timeout_secs))
        .map_err(|_| format!("git timed out after {timeout_secs}s"))?
        .map_err(|e| e.to_string())
}

// Validate that a jsonl_path is within ~/.claude/projects/ to prevent
// the frontend from pointing this command at arbitrary files.
fn is_safe_claude_jsonl_path(path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    let Some(home) = dirs::home_dir() else { return false };
    path.starts_with(home.join(".claude").join("projects"))
}

fn extract_changed_files_from_jsonl(jsonl_path: &Path) -> Vec<String> {
    let file = match fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let mut files: HashSet<String> = HashSet::new();

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(arr) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                        continue;
                    }
                    let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if !FILE_TOOLS.contains(&name) {
                        continue;
                    }
                    if let Some(fp) = item.pointer("/input/file_path").and_then(|f| f.as_str()) {
                        files.insert(fp.to_string());
                    }
                }
            }
        }
    }

    let mut result: Vec<String> = files.into_iter().collect();
    result.sort();
    result
}

/// Return the list of file paths that a Claude session touched (via Edit/Write/etc.).
/// Accepts the absolute path to the session JSONL — no directory scan needed.
#[tauri::command]
pub async fn session_changed_files(jsonl_path: String) -> Vec<String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&jsonl_path);
        if !is_safe_claude_jsonl_path(path) {
            return vec![];
        }
        extract_changed_files_from_jsonl(path)
    })
    .await
    .unwrap_or_default()
}

/// Return true if the given directory is inside a git repository.
#[tauri::command]
pub async fn session_check_git(
    cwd: String,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<bool, String> {
    let _ = registry.authorize(&cwd);
    Ok(tokio::task::spawn_blocking(move || {
        git_output_with_timeout(&["-C", &cwd, "rev-parse", "--git-dir"], GIT_TIMEOUT_SECS)
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false))
}

/// Run `git init` in the given directory.
#[tauri::command]
pub async fn session_git_init(
    cwd: String,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let _ = registry.authorize(&cwd);
    tokio::task::spawn_blocking(move || {
        let out = git_output_with_timeout(&["-C", &cwd, "init", "--"], GIT_TIMEOUT_SECS)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return `git diff <base_ref> -- <file>` (capped at 2 MB).
/// `base_ref` defaults to "HEAD" when empty. Pass "main" or "origin/main"
/// to show all changes on the current branch vs that ref.
/// For new untracked files, returns an all-additions diff.
#[tauri::command]
pub async fn session_file_diff(
    cwd: String,
    file_path: String,
    base_ref: Option<String>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    let _ = registry.authorize(&cwd);
    tokio::task::spawn_blocking(move || {
        let base = base_ref.as_deref().filter(|s| !s.is_empty()).unwrap_or("HEAD");
        let out = git_output_with_timeout(
            &["-C", &cwd, "diff", base, "--", &file_path],
            GIT_TIMEOUT_SECS,
        )?;

        if !out.stdout.is_empty() {
            let truncated = out.stdout.len() > MAX_DIFF_BYTES;
            let slice = &out.stdout[..out.stdout.len().min(MAX_DIFF_BYTES)];
            let mut diff = String::from_utf8_lossy(slice).into_owned();
            if truncated {
                diff.push_str("\n\\ Diff truncated (> 2 MB)\n");
            }
            return Ok(diff);
        }

        let is_untracked = git_output_with_timeout(
            &["-C", &cwd, "ls-files", "--others", "--exclude-standard", "--", &file_path],
            GIT_TIMEOUT_SECS,
        )
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

        if is_untracked {
            let abs_path = if Path::new(&file_path).is_absolute() {
                PathBuf::from(&file_path)
            } else {
                PathBuf::from(&cwd).join(&file_path)
            };
            let content = fs::read_to_string(&abs_path).unwrap_or_default();
            let added: String = content.lines().map(|l| format!("+{l}\n")).collect();
            return Ok(format!(
                "--- /dev/null\n+++ b/{file_path}\n@@ -0,0 +1 @@\n{added}"
            ));
        }

        Ok(String::new())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Session changes with file-history baseline ───────────────────────────────
//
// Claude Code records a `file-history-snapshot` event before it edits a file,
// stashing the *pre-edit* content under ~/.claude/file-history/<session>/<hash>@vN.
// The lowest version (@v1) is the original; a `null` backupFileName at the
// lowest version means the file was created during the session (empty baseline).
// We diff that baseline against the current on-disk content — so the changes a
// conversation made stay visible even after the user commits them (unlike a
// plain `git diff HEAD`, which goes blank once committed).

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileChange {
    pub path: String, // absolute path of the changed file
    pub diff: String, // unified diff (baseline -> current) with clean headers
    pub additions: u32,
    pub deletions: u32,
    pub status: String, // "added" | "deleted" | "modified" | "unchanged"
    // Baseline ("original") and on-disk ("current") content so the frontend can
    // render a real CodeMirror diff instead of a plain text patch. Empty when
    // `is_binary` is true or either side exceeds DIFF_CONTENT_CAP — fall back to
    // `diff` in those cases.
    pub original_content: String,
    pub modified_content: String,
    pub is_binary: bool,
}

// Cap the inline content we ship to the frontend per side. Above this the
// CodeMirror merge view is too heavy; the UI falls back to the patch text.
const DIFF_CONTENT_CAP: usize = 512 * 1024; // 512 KB

fn looks_binary(s: &str) -> bool {
    s.as_bytes().iter().take(8192).any(|&b| b == 0)
}

const FILE_TOOLS: &[&str] = &["Edit", "Write", "Create", "MultiEdit", "NotebookEdit"];

// Case/separator-insensitive key for de-duplicating paths across the two
// sources (relative backup keys vs absolute tool_use paths) on Windows.
fn norm_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

// Resolve a (possibly relative, backslash-separated) backup key to an absolute path.
fn join_abs(cwd: &str, rel: &str) -> String {
    let p = Path::new(rel);
    let drive_prefixed = rel.as_bytes().get(1) == Some(&b':');
    if p.is_absolute() || rel.starts_with('/') || drive_prefixed {
        rel.to_string()
    } else {
        PathBuf::from(cwd).join(rel).to_string_lossy().into_owned()
    }
}

// Path relative to cwd (forward slashes) for clean diff headers / git pathspecs.
fn rel_label(abs: &str, cwd: &str) -> String {
    let cwd_n = cwd.replace('\\', "/");
    let abs_n = abs.replace('\\', "/");
    let prefix = format!("{}/", cwd_n.trim_end_matches('/'));
    abs_n.strip_prefix(&prefix).unwrap_or(&abs_n).to_string()
}

// Read the original pre-edit content from Claude's file-history store.
fn read_backup(session_id: &str, backup_name: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let p = home
        .join(".claude")
        .join("file-history")
        .join(session_id)
        .join(backup_name);
    fs::read_to_string(p).ok()
}

// Fallback baseline for sessions with no file-history record (older Claude):
// the file's content at HEAD. Best-effort — empty string if unavailable.
fn git_head_content(cwd: &str, abs_path: &str) -> String {
    let rel = rel_label(abs_path, cwd);
    // strip_prefix failed (path outside cwd) — can't form a HEAD pathspec.
    if rel == abs_path.replace('\\', "/") {
        return String::new();
    }
    git_output_with_timeout(&["-C", cwd, "show", &format!("HEAD:{rel}")], GIT_TIMEOUT_SECS)
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

// Produce a unified diff (with clean a/<rel> b/<rel> headers) plus +/- counts.
// Both sides are CRLF-normalized first so cross-platform line endings don't
// produce a whole-file diff. Uses `git diff --no-index` on temp files.
fn unified_diff(baseline: &str, current: &str, rel_label: &str) -> (String, u32, u32) {
    let b = baseline.replace("\r\n", "\n");
    let c = current.replace("\r\n", "\n");
    if b == c {
        return (String::new(), 0, 0);
    }

    let write_tmp = |s: &str| -> Option<tempfile::NamedTempFile> {
        let mut f = tempfile::NamedTempFile::new().ok()?;
        f.write_all(s.as_bytes()).ok()?;
        f.flush().ok()?;
        Some(f)
    };
    let (Some(tb), Some(tc)) = (write_tmp(&b), write_tmp(&c)) else {
        return (String::new(), 0, 0);
    };
    let base_path = tb.path().to_string_lossy().into_owned();
    let cur_path = tc.path().to_string_lossy().into_owned();

    // `git diff --no-index` exits 1 when the files differ — that's success here.
    let out = match git_output_with_timeout(
        &["diff", "--no-index", "--unified=3", "--", &base_path, &cur_path],
        GIT_TIMEOUT_SECS,
    ) {
        Ok(o) => o,
        Err(_) => return (String::new(), 0, 0),
    };
    let raw = String::from_utf8_lossy(&out.stdout);

    let added = b.is_empty();
    let deleted = c.is_empty();
    let mut adds = 0u32;
    let mut dels = 0u32;
    let mut hdr_minus = false;
    let mut hdr_plus = false;
    let mut lines_out: Vec<String> = Vec::new();
    for line in raw.lines() {
        if line.starts_with("diff --git") {
            lines_out.push(format!("diff --git a/{rel_label} b/{rel_label}"));
            continue;
        }
        // Drop the temp-file `index <oid>..<oid>` line that precedes the headers.
        if !hdr_minus && line.starts_with("index ") {
            continue;
        }
        if !hdr_minus && line.starts_with("--- ") {
            hdr_minus = true;
            lines_out.push(if added {
                "--- /dev/null".to_string()
            } else {
                format!("--- a/{rel_label}")
            });
            continue;
        }
        if !hdr_plus && line.starts_with("+++ ") {
            hdr_plus = true;
            lines_out.push(if deleted {
                "+++ /dev/null".to_string()
            } else {
                format!("+++ b/{rel_label}")
            });
            continue;
        }
        // Body: count by leading byte (headers already consumed above).
        match line.as_bytes().first().copied() {
            Some(b'+') => adds += 1,
            Some(b'-') => dels += 1,
            _ => {}
        }
        lines_out.push(line.to_string());
    }

    let mut diff = lines_out.join("\n");
    if !diff.is_empty() {
        diff.push('\n');
    }
    if diff.len() > MAX_DIFF_BYTES {
        diff.truncate(MAX_DIFF_BYTES);
        diff.push_str("\n\\ Diff truncated (> 2 MB)\n");
    }
    (diff, adds, dels)
}

fn collect_session_changes(jsonl_path: &Path, cwd: &str) -> Vec<SessionFileChange> {
    let session_id = jsonl_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let content = match fs::read_to_string(jsonl_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    // norm key -> (min version, Option<backup file name>)  (None => created)
    let mut backups: HashMap<String, (i64, Option<String>)> = HashMap::new();
    // norm key -> display absolute path
    let mut disp: HashMap<String, String> = HashMap::new();
    // norm keys touched via Edit/Write/etc. tool_use
    let mut touched: HashSet<String> = HashSet::new();

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("file-history-snapshot") => {
                if let Some(tb) = v
                    .pointer("/snapshot/trackedFileBackups")
                    .and_then(|x| x.as_object())
                {
                    for (rel, info) in tb {
                        let abs = join_abs(cwd, rel);
                        let key = norm_key(&abs);
                        let ver = info.get("version").and_then(|x| x.as_i64()).unwrap_or(1);
                        let name = info
                            .get("backupFileName")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string());
                        disp.entry(key.clone()).or_insert_with(|| abs.clone());
                        // Keep the lowest-version backup (the pre-session original).
                        let slot = backups.entry(key).or_insert((ver, name.clone()));
                        if ver < slot.0 {
                            *slot = (ver, name);
                        }
                    }
                }
            }
            Some("assistant") => {
                if let Some(arr) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    for item in arr {
                        if item.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                            continue;
                        }
                        let nm = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if !FILE_TOOLS.contains(&nm) {
                            continue;
                        }
                        let fp = item
                            .pointer("/input/file_path")
                            .or_else(|| item.pointer("/input/notebook_path"))
                            .and_then(|f| f.as_str());
                        if let Some(fp) = fp {
                            let key = norm_key(fp);
                            disp.entry(key.clone()).or_insert_with(|| fp.to_string());
                            touched.insert(key);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut keys: HashSet<String> = backups.keys().cloned().collect();
    keys.extend(touched.iter().cloned());

    let mut out: Vec<SessionFileChange> = Vec::new();
    for key in keys {
        let abs = disp.get(&key).cloned().unwrap_or_else(|| key.clone());
        let baseline = match backups.get(&key) {
            Some((_, Some(name))) => read_backup(&session_id, name).unwrap_or_default(),
            Some((_, None)) => String::new(), // created during the session
            None => git_head_content(cwd, &abs), // tool_use only (older Claude) fallback
        };
        let current = fs::read_to_string(&abs).unwrap_or_default();

        let baseline_empty = baseline.replace("\r\n", "\n").is_empty();
        let current_empty = current.replace("\r\n", "\n").is_empty();
        let (diff, adds, dels) = unified_diff(&baseline, &current, &rel_label(&abs, cwd));
        let status = if baseline_empty && !current_empty {
            "added"
        } else if !baseline_empty && current_empty {
            "deleted"
        } else if adds == 0 && dels == 0 {
            "unchanged"
        } else {
            "modified"
        }
        .to_string();

        // Ship raw content for the CodeMirror diff unless it's binary or too
        // large, in which case the frontend renders the `diff` patch instead.
        let is_binary = looks_binary(&baseline) || looks_binary(&current);
        let too_large = baseline.len() > DIFF_CONTENT_CAP || current.len() > DIFF_CONTENT_CAP;
        // Normalize CRLF -> LF on both sides so an autocrlf line-ending
        // difference (LF baseline vs CRLF working copy) doesn't render every
        // line as changed in the CodeMirror merge view. The +/- counts above
        // already use CRLF-normalized content via `unified_diff`.
        let (original_content, modified_content) = if is_binary || too_large {
            (String::new(), String::new())
        } else {
            (baseline.replace("\r\n", "\n"), current.replace("\r\n", "\n"))
        };

        out.push(SessionFileChange {
            path: abs,
            diff,
            additions: adds,
            deletions: dels,
            status,
            original_content,
            modified_content,
            is_binary: is_binary || too_large,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Return every file a Claude session changed, each with a unified diff
/// (computed against the file-history baseline) and +/- line counts.
#[tauri::command]
pub async fn session_changes(jsonl_path: String, cwd: String) -> Vec<SessionFileChange> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&jsonl_path);
        if !is_safe_claude_jsonl_path(path) {
            return vec![];
        }
        collect_session_changes(path, &cwd)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod session_changes_tests {
    use super::{join_abs, norm_key, rel_label, unified_diff};

    #[test]
    fn norm_key_lowercases_and_unifies_separators() {
        assert_eq!(
            norm_key(r"C:\Users\Dev\Src\App.tsx"),
            "c:/users/dev/src/app.tsx"
        );
    }

    #[test]
    fn rel_label_strips_cwd_prefix() {
        assert_eq!(
            rel_label(r"C:\proj\src\a.ts", r"C:\proj"),
            "src/a.ts"
        );
        // Path outside cwd falls back to the (slash-normalized) absolute path.
        assert_eq!(rel_label(r"D:\other\x.ts", r"C:\proj"), "D:/other/x.ts");
    }

    #[test]
    fn join_abs_resolves_relative_backup_keys() {
        assert_eq!(
            join_abs(r"C:\proj", r"src\a.ts").replace('\\', "/"),
            "C:/proj/src/a.ts"
        );
        // Already-absolute (drive-prefixed) keys pass through unchanged.
        assert_eq!(join_abs(r"C:\proj", r"C:\elsewhere\b.ts"), r"C:\elsewhere\b.ts");
    }

    #[test]
    fn unified_diff_counts_and_rewrites_headers() {
        let (diff, adds, dels) =
            unified_diff("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n", "foo.txt");
        assert_eq!(adds, 1);
        assert_eq!(dels, 1);
        assert!(diff.contains("--- a/foo.txt"), "diff was: {diff}");
        assert!(diff.contains("+++ b/foo.txt"), "diff was: {diff}");
        // Temp file paths must not leak into the rewritten headers.
        assert!(!diff.contains(".tmp"), "diff leaked temp path: {diff}");
    }

    #[test]
    fn unified_diff_treats_empty_baseline_as_addition() {
        let (diff, adds, dels) = unified_diff("", "one\ntwo\n", "new.txt");
        assert_eq!(adds, 2);
        assert_eq!(dels, 0);
        assert!(diff.contains("--- /dev/null"), "diff was: {diff}");
        assert!(diff.contains("+++ b/new.txt"), "diff was: {diff}");
    }

    #[test]
    fn unified_diff_identical_content_is_empty() {
        let (diff, adds, dels) = unified_diff("same\n", "same\n", "x.txt");
        assert!(diff.is_empty());
        assert_eq!((adds, dels), (0, 0));
    }
}
