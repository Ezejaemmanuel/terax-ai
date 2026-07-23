use std::path::PathBuf;

use serde::Serialize;

use crate::modules::transcript::Format;

/// One agent session as the sidebar sees it. Deliberately body-free: the index
/// must stay a few KB no matter how large the transcripts are.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    /// `claude` | `codex` | `command-code` | `cursor`
    pub agent: String,
    pub title: String,
    pub cwd: String,
    /// Zero-padded unix-ms, sorts lexicographically (matches ai_history).
    pub updated_at: String,
    /// False for agents whose transcripts we cannot parse (Cursor is SQLite),
    /// so the client can show the row without offering to open it.
    pub readable: bool,
    #[serde(skip)]
    pub path: Option<PathBuf>,
    #[serde(skip)]
    pub format: Option<Format>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub name: String,
    pub full_path: String,
    pub sessions: Vec<SessionMeta>,
}

impl SessionMeta {
    /// Only sessions with both a path and a known format can be opened.
    pub fn source(&self) -> Option<(&PathBuf, Format)> {
        match (&self.path, self.format) {
            (Some(p), Some(f)) => Some((p, f)),
            _ => None,
        }
    }
}

/// Flatten the project tree into a session lookup. Built per request; the index
/// is small and this keeps the server free of cache invalidation.
pub fn find_session<'a>(projects: &'a [ProjectMeta], id: &str) -> Option<&'a SessionMeta> {
    projects
        .iter()
        .flat_map(|p| p.sessions.iter())
        .find(|s| s.id == id)
}

/// Reverse lookup used by the file watcher: which session does this path back?
pub fn find_by_path<'a>(projects: &'a [ProjectMeta], path: &std::path::Path) -> Option<&'a SessionMeta> {
    projects
        .iter()
        .flat_map(|p| p.sessions.iter())
        .find(|s| s.path.as_deref() == Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, path: Option<&str>) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            agent: "claude".into(),
            title: "t".into(),
            cwd: "/w".into(),
            updated_at: "0".into(),
            readable: path.is_some(),
            path: path.map(PathBuf::from),
            format: path.map(|_| Format::Claude),
        }
    }

    fn projects() -> Vec<ProjectMeta> {
        vec![
            ProjectMeta {
                name: "a".into(),
                full_path: "/a".into(),
                sessions: vec![session("s1", Some("/a/s1.jsonl"))],
            },
            ProjectMeta {
                name: "b".into(),
                full_path: "/b".into(),
                sessions: vec![session("s2", Some("/b/s2.jsonl")), session("s3", None)],
            },
        ]
    }

    #[test]
    fn finds_sessions_across_projects() {
        let p = projects();
        assert_eq!(find_session(&p, "s2").expect("found").id, "s2");
        assert!(find_session(&p, "nope").is_none());
    }

    #[test]
    fn unreadable_sessions_have_no_source() {
        let p = projects();
        assert!(find_session(&p, "s3").expect("found").source().is_none());
        assert!(find_session(&p, "s1").expect("found").source().is_some());
    }

    #[test]
    fn reverse_path_lookup_works() {
        let p = projects();
        let m = find_by_path(&p, std::path::Path::new("/b/s2.jsonl")).expect("found");
        assert_eq!(m.id, "s2");
        assert!(find_by_path(&p, std::path::Path::new("/x")).is_none());
    }

    #[test]
    fn index_json_never_carries_paths() {
        let json = serde_json::to_string(&projects()).expect("json");
        assert!(!json.contains("s1.jsonl"));
        assert!(json.contains("\"readable\""));
    }
}
