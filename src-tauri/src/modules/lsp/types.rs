use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerState {
    Starting,
    Ready,
    Failed,
    Stopped,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    pub root: String,
    pub state: ServerState,
    /// Present once the binary is located, so the UI can show which tsgo ran.
    pub exe: Option<String>,
    pub error: Option<String>,
    pub open_documents: usize,
}

impl LspStatus {
    pub fn stopped(root: &str) -> Self {
        Self {
            root: root.to_string(),
            state: ServerState::Stopped,
            exe: None,
            error: None,
            open_documents: 0,
        }
    }

    pub fn failed(root: &str, error: String) -> Self {
        Self {
            root: root.to_string(),
            state: ServerState::Failed,
            exe: None,
            error: Some(error),
            open_documents: 0,
        }
    }
}

/// Zero-based, matching LSP. The frontend maps to CodeMirror offsets.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
    /// 1 error, 2 warning, 3 information, 4 hint.
    pub severity: u8,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
}

impl LspDiagnostic {
    pub fn from_lsp(value: &Value) -> Option<Self> {
        let range = value.get("range")?;
        let point = |key: &str| -> Option<(u32, u32)> {
            let p = range.get(key)?;
            Some((
                p.get("line")?.as_u64().unwrap_or(0) as u32,
                p.get("character")?.as_u64().unwrap_or(0) as u32,
            ))
        };
        let (start_line, start_character) = point("start")?;
        let (end_line, end_character) = point("end").unwrap_or((start_line, start_character));
        Some(Self {
            start_line,
            start_character,
            end_line,
            end_character,
            severity: value
                .get("severity")
                .and_then(Value::as_u64)
                .filter(|s| (1u64..=4).contains(s))
                .unwrap_or(1) as u8,
            code: match value.get("code") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => Some(n.to_string()),
                _ => None,
            },
            source: value
                .get("source")
                .and_then(Value::as_str)
                .map(str::to_string),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsEvent {
    pub root: String,
    pub path: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub path: String,
    pub line: u32,
    pub character: u32,
}

/// One file's worth of findings from the on-demand whole-project check.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFileProblems {
    pub path: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_a_typescript_diagnostic() {
        let raw = json!({
            "range": { "start": { "line": 2, "character": 6 }, "end": { "line": 2, "character": 7 } },
            "severity": 1, "code": 2322, "source": "ts",
            "message": "Type 'string' is not assignable to type 'number'."
        });
        let d = LspDiagnostic::from_lsp(&raw).unwrap();
        assert_eq!((d.start_line, d.start_character, d.end_line, d.end_character), (2, 6, 2, 7));
        assert_eq!(d.severity, 1);
        assert_eq!(d.code.as_deref(), Some("2322"));
        assert_eq!(d.source.as_deref(), Some("ts"));
    }

    #[test]
    fn defaults_to_error_when_severity_is_absent_or_bogus() {
        let base = json!({ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "message": "x" });
        assert_eq!(LspDiagnostic::from_lsp(&base).unwrap().severity, 1);
        let mut bogus = base.clone();
        bogus["severity"] = json!(99);
        assert_eq!(LspDiagnostic::from_lsp(&bogus).unwrap().severity, 1);
    }

    #[test]
    fn a_diagnostic_without_a_range_is_dropped_not_defaulted() {
        assert!(LspDiagnostic::from_lsp(&json!({ "message": "x" })).is_none());
    }

    #[test]
    fn string_codes_survive() {
        let raw = json!({
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } },
            "code": "no-unused", "message": "x"
        });
        assert_eq!(LspDiagnostic::from_lsp(&raw).unwrap().code.as_deref(), Some("no-unused"));
    }
}
