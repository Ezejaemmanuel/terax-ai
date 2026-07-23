use serde_json::Value;

use super::{
    text_block, thinking_block, tool_call_block, tool_result_block, Block, Message, Role,
};

/// Claude Code writes one JSON record per line into
/// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Only `user` and
/// `assistant` records carry conversation; the rest is bookkeeping
/// (mode, ai-title, file-history-snapshot, queue-operation, ...).
pub fn parse(lines: &[&str], first_line: usize) -> Vec<Message> {
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(m) = parse_line(line, first_line + i) {
            out.push(m);
        }
    }
    out
}

fn parse_line(line: &str, index: usize) -> Option<Message> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // Records are written while the agent runs, so a torn final line is normal.
    let v: Value = serde_json::from_str(line).ok()?;

    let role = match v.get("type").and_then(Value::as_str)? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => return None,
    };

    // Injected context (command stdout replays, caveats) rather than turns.
    if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }

    let message = v.get("message")?;
    let blocks = match message.get("content") {
        Some(Value::String(s)) => strip_reminders(s)
            .as_deref()
            .and_then(text_block)
            .into_iter()
            .collect(),
        Some(Value::Array(items)) => items.iter().filter_map(content_block).collect(),
        _ => Vec::new(),
    };

    if blocks.is_empty() {
        return None;
    }

    Some(Message {
        id: v
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("line-{index}")),
        role,
        timestamp: v
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        line: index,
        blocks,
    })
}

fn content_block(b: &Value) -> Option<Block> {
    match b.get("type").and_then(Value::as_str)? {
        "text" => {
            let raw = b.get("text").and_then(Value::as_str)?;
            strip_reminders(raw).as_deref().and_then(text_block)
        }
        // Extended thinking arrives redacted (empty text plus a signature) when
        // the transcript was written by a summarizing model; skip those.
        "thinking" => thinking_block(b.get("thinking").and_then(Value::as_str)?),
        "tool_use" => Some(tool_call_block(
            b.get("id").and_then(Value::as_str).unwrap_or_default(),
            b.get("name").and_then(Value::as_str).unwrap_or("tool"),
            b.get("input").unwrap_or(&Value::Null),
        )),
        "tool_result" => Some(tool_result_block(
            b.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
            &result_text(b.get("content")),
            b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        )),
        "image" => Some(Block::Image {
            alt: "image".to_string(),
        }),
        _ => None,
    }
}

/// A tool result is either a plain string or a content-block array that may mix
/// text and images.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `<system-reminder>` blocks are harness-injected and dominate user turns.
/// Returns None when nothing was stripped so the common path avoids a copy.
fn strip_reminders(s: &str) -> Option<String> {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    if !s.contains(OPEN) {
        return Some(s.to_string());
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(CLOSE) {
            Some(end) => &rest[start + end + CLOSE.len()..],
            // Unterminated: drop the remainder rather than leaking the block.
            None => "",
        };
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_user_string_message() {
        let line = r#"{"type":"user","uuid":"u1","timestamp":"t","message":{"role":"user","content":"hello there"}}"#;
        let m = parse_line(line, 0).expect("message");
        assert_eq!(m.role, Role::User);
        assert_eq!(m.id, "u1");
        assert_eq!(
            m.blocks,
            vec![Block::Text {
                text: "hello there".into(),
                truncated: false
            }]
        );
    }

    #[test]
    fn parses_assistant_tool_use_and_thinking() {
        let line = r#"{"type":"assistant","uuid":"a1","timestamp":"t","message":{"role":"assistant","content":[
            {"type":"thinking","thinking":"pondering"},
            {"type":"text","text":"running it"},
            {"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"a.rs"}}
        ]}}"#;
        let m = parse_line(line, 3).expect("message");
        assert_eq!(m.role, Role::Assistant);
        assert_eq!(m.line, 3);
        assert_eq!(m.blocks.len(), 3);
        assert!(matches!(m.blocks[0], Block::Thinking { .. }));
        assert!(matches!(m.blocks[2], Block::ToolCall { ref name, .. } if name == "Read"));
    }

    #[test]
    fn tool_result_accepts_string_and_array_content() {
        let s = r#"{"type":"user","uuid":"u","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}"#;
        let m = parse_line(s, 0).expect("message");
        assert!(matches!(m.blocks[0], Block::ToolResult { ref output, .. } if output == "done"));

        let a = r#"{"type":"user","uuid":"u","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}"#;
        let m = parse_line(a, 0).expect("message");
        assert!(
            matches!(m.blocks[0], Block::ToolResult { ref output, is_error, .. } if output == "boom" && is_error)
        );
    }

    #[test]
    fn skips_bookkeeping_and_meta_records() {
        assert!(parse_line(r#"{"type":"ai-title","aiTitle":"x"}"#, 0).is_none());
        assert!(parse_line(r#"{"type":"file-history-snapshot"}"#, 0).is_none());
        assert!(parse_line(
            r#"{"type":"user","isMeta":true,"message":{"content":"noise"}}"#,
            0
        )
        .is_none());
    }

    #[test]
    fn redacted_thinking_produces_no_block() {
        let line = r#"{"type":"assistant","uuid":"a","message":{"content":[{"type":"thinking","thinking":"","signature":"sig"}]}}"#;
        assert!(parse_line(line, 0).is_none());
    }

    #[test]
    fn torn_and_blank_lines_are_ignored() {
        assert!(parse_line("", 0).is_none());
        assert!(parse_line(r#"{"type":"user","message":{"cont"#, 0).is_none());
    }

    #[test]
    fn system_reminders_are_stripped() {
        let line = r#"{"type":"user","uuid":"u","message":{"content":"real ask<system-reminder>injected junk</system-reminder> tail"}}"#;
        let m = parse_line(line, 0).expect("message");
        assert_eq!(
            m.blocks,
            vec![Block::Text {
                text: "real ask tail".into(),
                truncated: false
            }]
        );
    }

    #[test]
    fn unterminated_reminder_drops_the_remainder() {
        assert_eq!(
            strip_reminders("keep<system-reminder>leak").as_deref(),
            Some("keep")
        );
    }
}
