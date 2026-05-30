use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
pub struct AiSession {
    pub id: String,
    pub title: String,
    pub updated_at: String, // zero-padded unix-ms or ISO 8601; sorts lexicographically
    pub cwd: String,
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
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
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
        .last()
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
        if title.is_none() {
            if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                title = v.get("aiTitle").and_then(|t| t.as_str()).map(|s| s.to_string());
            }
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
        if title.is_none() {
            if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(text) = v
                    .pointer("/message/content/0/text")
                    .and_then(|t| t.as_str())
                {
                    let truncated: String = text.chars().take(60).collect();
                    title = Some(truncated);
                }
            }
        }

        if title.is_some() && cwd.is_some() {
            break;
        }
    }

    (title, cwd)
}

#[tauri::command]
pub fn ai_history_claude() -> Vec<AiProject> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return vec![];
    }

    // Group sessions by their actual CWD (read from JSONL content).
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
            // Skip subdirectories (subagents/, tool-results/)
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

            // Use the CWD read directly from the JSONL content.
            // This avoids the lossy path-encoding decode that breaks hyphenated paths.
            let full_path = match cwd_opt {
                Some(c) if !c.is_empty() => c,
                // Last-resort fallback: skip sessions with no readable cwd
                _ => continue,
            };

            let updated_at = file_mtime_ms_str(&s_path);
            let session = AiSession {
                id: session_id,
                title,
                updated_at,
                cwd: full_path.clone(),
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

    // Sort sessions newest first within each project.
    for p in &mut projects {
        p.sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }

    // Sort projects by their most-recent session.
    projects.sort_by(|a, b| {
        let a_ts = a.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
        let b_ts = b.sessions.first().map(|s| s.updated_at.as_str()).unwrap_or("");
        b_ts.cmp(a_ts)
    });

    projects
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

#[tauri::command]
pub fn ai_history_codex() -> Vec<AiProject> {
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

    // Build the session-id → file-path index once (O(files) instead of O(sessions × files)).
    let file_index = if sessions_dir.exists() {
        build_codex_file_index(&sessions_dir)
    } else {
        HashMap::new()
    };

    // Group sessions by cwd into projects.
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
        // ISO 8601 strings sort lexicographically — no chrono dependency needed.
        let updated_at = entry
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Look up the session file in O(1) using the pre-built index.
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
}
