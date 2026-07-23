pub mod claude;
pub mod codex;
pub mod command_code;
pub mod cursor;
pub mod reader;

use serde::Serialize;

/// Per-block payload cap. Tool results routinely carry whole files; a phone
/// on a LAN link should never have to pull megabytes to render one message.
pub const MAX_BLOCK_BYTES: usize = 16 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Block {
    Text {
        text: String,
        truncated: bool,
    },
    Thinking {
        text: String,
        truncated: bool,
    },
    ToolCall {
        id: String,
        name: String,
        input: String,
        truncated: bool,
    },
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
        truncated: bool,
    },
    Image {
        alt: String,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Stable within a session; used as the React key and for dedupe on append.
    pub id: String,
    pub role: Role,
    pub timestamp: String,
    /// Index of the source line this message came from. Doubles as the paging
    /// cursor, so a client can ask for everything before line N without the
    /// server holding any per-connection parse state.
    pub line: usize,
    pub blocks: Vec<Block>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    Claude,
    Codex,
    CommandCode,
    /// SQLite-backed, not line-oriented — `reader::read_page`/`read_append`
    /// branch out to `cursor::read_page`/`read_append` before this format's
    /// `parse` (which is never called) would come into play.
    Cursor,
}

impl Format {
    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Format::Claude),
            "codex" => Some(Format::Codex),
            "command-code" => Some(Format::CommandCode),
            "cursor" => Some(Format::Cursor),
            _ => None,
        }
    }

    /// Parse a contiguous run of JSONL lines. `first_line` is the absolute index
    /// of `lines[0]` in the file so cursors stay stable across calls. Not used
    /// for `Cursor`, whose transcript is a SQLite database, not line-oriented.
    pub fn parse(&self, lines: &[&str], first_line: usize) -> Vec<Message> {
        match self {
            Format::Claude => claude::parse(lines, first_line),
            Format::Codex => codex::parse(lines, first_line),
            Format::CommandCode => command_code::parse(lines, first_line),
            Format::Cursor => Vec::new(),
        }
    }
}

/// Truncate on a char boundary, reporting whether anything was dropped.
pub fn clamp(s: &str) -> (String, bool) {
    if s.len() <= MAX_BLOCK_BYTES {
        return (s.to_string(), false);
    }
    let mut end = MAX_BLOCK_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

pub fn text_block(s: &str) -> Option<Block> {
    if s.trim().is_empty() {
        return None;
    }
    let (text, truncated) = clamp(s);
    Some(Block::Text { text, truncated })
}

pub fn thinking_block(s: &str) -> Option<Block> {
    if s.trim().is_empty() {
        return None;
    }
    let (text, truncated) = clamp(s);
    Some(Block::Thinking { text, truncated })
}

/// Render a tool input/output value as display text. Strings pass through so a
/// shell command doesn't arrive JSON-escaped; everything else is pretty JSON.
pub fn value_to_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

pub fn tool_call_block(id: &str, name: &str, input: &serde_json::Value) -> Block {
    let (input, truncated) = clamp(&value_to_text(input));
    Block::ToolCall {
        id: id.to_string(),
        name: name.to_string(),
        input,
        truncated,
    }
}

pub fn tool_result_block(id: &str, output: &str, is_error: bool) -> Block {
    let (output, truncated) = clamp(output);
    Block::ToolResult {
        id: id.to_string(),
        output,
        is_error,
        truncated,
    }
}

/// AI SDK tool output is a tagged value: `text`, `json`, `error-text`,
/// `error-json`, or a `content` array. Shared by `command_code` and `cursor`,
/// whose stores both carry AI-SDK-shaped tool-result records.
pub fn output_text(output: Option<&serde_json::Value>) -> (String, bool) {
    let Some(o) = output else {
        return (String::new(), false);
    };
    match o {
        serde_json::Value::String(s) => (s.clone(), false),
        serde_json::Value::Object(_) => {
            let kind = o.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
            let is_error = kind.starts_with("error");
            let text = match o.get("value") {
                Some(v) => value_to_text(v),
                None => match o.get("content").and_then(serde_json::Value::as_array) {
                    Some(items) => items
                        .iter()
                        .filter_map(|c| c.get("text").and_then(serde_json::Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    None => value_to_text(o),
                },
            };
            (text, is_error)
        }
        other => (value_to_text(other), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_never_splits_a_char() {
        let s = "é".repeat(MAX_BLOCK_BYTES);
        let (out, truncated) = clamp(&s);
        assert!(truncated);
        assert!(out.len() <= MAX_BLOCK_BYTES);
        assert!(s.starts_with(&out));
    }

    #[test]
    fn clamp_passes_short_strings_through() {
        let (out, truncated) = clamp("hello");
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    #[test]
    fn empty_text_yields_no_block() {
        assert!(text_block("   \n ").is_none());
        assert!(thinking_block("").is_none());
    }

    #[test]
    fn string_tool_input_is_not_json_escaped() {
        let v = serde_json::Value::String("ls -la".into());
        assert_eq!(value_to_text(&v), "ls -la");
    }

    #[test]
    fn format_round_trips_known_ids() {
        assert_eq!(Format::from_id("claude"), Some(Format::Claude));
        assert_eq!(Format::from_id("codex"), Some(Format::Codex));
        assert_eq!(Format::from_id("command-code"), Some(Format::CommandCode));
        assert_eq!(Format::from_id("cursor"), Some(Format::Cursor));
    }
}
