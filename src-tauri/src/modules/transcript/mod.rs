pub mod claude;
pub mod codex;
pub mod command_code;
pub mod cursor;
pub mod reader;

use serde::Serialize;

/// Per-block payload cap for a transcript page or append. Tool results
/// routinely carry whole files; a phone on a LAN link should never have to pull
/// megabytes to render one message. What the cap drops is not lost — every
/// block reports its `full_bytes`, and the client fetches the remainder on
/// demand through `reader::read_block_chunk`.
pub const MAX_BLOCK_BYTES: usize = 16 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// `full_bytes` is the payload's length *before* any transport cap, so a client
/// holding a clamped block knows both that there is more and exactly how much,
/// and can page the remainder by byte offset.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Block {
    Text {
        text: String,
        truncated: bool,
        full_bytes: usize,
    },
    Thinking {
        text: String,
        truncated: bool,
        full_bytes: usize,
    },
    ToolCall {
        id: String,
        name: String,
        input: String,
        truncated: bool,
        full_bytes: usize,
    },
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
        truncated: bool,
        full_bytes: usize,
    },
    Image {
        alt: String,
    },
}

impl Block {
    /// The block's payload text, or `None` for blocks that carry none.
    pub fn payload(&self) -> Option<&str> {
        match self {
            Block::Text { text, .. } | Block::Thinking { text, .. } => Some(text),
            Block::ToolCall { input, .. } => Some(input),
            Block::ToolResult { output, .. } => Some(output),
            Block::Image { .. } => None,
        }
    }

    fn payload_mut(&mut self) -> Option<(&mut String, &mut bool)> {
        match self {
            Block::Text { text, truncated, .. } | Block::Thinking { text, truncated, .. } => {
                Some((text, truncated))
            }
            Block::ToolCall { input, truncated, .. } => Some((input, truncated)),
            Block::ToolResult { output, truncated, .. } => Some((output, truncated)),
            Block::Image { .. } => None,
        }
    }
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
    /// SQLite-backed, not line-oriented — every `reader` entry point branches
    /// out to its `cursor` counterpart before this format's `parse` (which is
    /// never called) would come into play.
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

/// Largest index at or below `at` that splits `s` between characters.
pub fn char_boundary(s: &str, at: usize) -> usize {
    let mut end = at.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// Apply the transport cap to every block of every message.
///
/// Parsers deliberately build blocks with their payload intact and the cap is
/// applied here instead, at the boundary where messages are about to be
/// serialized to a client. That way the very same parse can also serve the
/// range reads that fetch back what the cap dropped — no second, subtly
/// different code path for "the full text".
pub fn clamp_all(messages: &mut [Message], cap: usize) {
    for m in messages {
        for b in &mut m.blocks {
            let Some((text, truncated)) = b.payload_mut() else {
                continue;
            };
            if text.len() > cap {
                let end = char_boundary(text, cap);
                text.truncate(end);
                *truncated = true;
            }
        }
    }
}

pub fn text_block(s: &str) -> Option<Block> {
    if s.trim().is_empty() {
        return None;
    }
    Some(Block::Text {
        full_bytes: s.len(),
        text: s.to_string(),
        truncated: false,
    })
}

pub fn thinking_block(s: &str) -> Option<Block> {
    if s.trim().is_empty() {
        return None;
    }
    Some(Block::Thinking {
        full_bytes: s.len(),
        text: s.to_string(),
        truncated: false,
    })
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
    let input = value_to_text(input);
    Block::ToolCall {
        id: id.to_string(),
        name: name.to_string(),
        full_bytes: input.len(),
        input,
        truncated: false,
    }
}

pub fn tool_result_block(id: &str, output: &str, is_error: bool) -> Block {
    Block::ToolResult {
        id: id.to_string(),
        full_bytes: output.len(),
        output: output.to_string(),
        is_error,
        truncated: false,
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

    fn message_with(text: &str) -> Message {
        Message {
            id: "m".into(),
            role: Role::User,
            timestamp: String::new(),
            line: 0,
            blocks: vec![text_block(text).expect("block")],
        }
    }

    #[test]
    fn clamp_never_splits_a_char_and_keeps_the_full_length() {
        let s = "é".repeat(MAX_BLOCK_BYTES);
        let mut messages = [message_with(&s)];
        clamp_all(&mut messages, MAX_BLOCK_BYTES);

        let Block::Text { text, truncated, full_bytes } = &messages[0].blocks[0] else {
            panic!("expected text");
        };
        assert!(truncated);
        assert!(text.len() <= MAX_BLOCK_BYTES);
        assert!(s.starts_with(text.as_str()));
        // The dropped tail is still addressable: the client is told how far the
        // payload actually runs.
        assert_eq!(*full_bytes, s.len());
    }

    #[test]
    fn clamp_passes_short_strings_through() {
        let mut messages = [message_with("hello")];
        clamp_all(&mut messages, MAX_BLOCK_BYTES);
        assert_eq!(
            messages[0].blocks,
            vec![Block::Text {
                text: "hello".into(),
                truncated: false,
                full_bytes: 5,
            }]
        );
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
