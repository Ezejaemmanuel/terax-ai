use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
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
        .filter(|s| !s.is_empty())
        .next_back()
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
        other => return Err(format!("unknown tool: {other}")),
    };

    let slot = match tool.as_str() {
        "claude" => &state.claude,
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
        let _ = tx.send(std::process::Command::new("git").args(&args).output());
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

    const FILE_TOOLS: &[&str] = &["Edit", "Write", "Create", "MultiEdit", "NotebookEdit"];
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
