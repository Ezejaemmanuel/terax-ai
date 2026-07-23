use serde_json::Value;

use super::{
    text_block, thinking_block, tool_call_block, tool_result_block, Block, Message, Role,
};

/// Command Code stores AI SDK style records under
/// `~/.commandcode/projects/<encoded-cwd>/<session-id>.jsonl`: one record per
/// message with a `role` and a `content` array of typed parts.
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
    let v: Value = serde_json::from_str(line).ok()?;

    // Tool results are their own records but belong to the user side of the
    // transcript, matching how the other agents lay it out.
    let role = match v.get("role").and_then(Value::as_str)? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::User,
        "system" => Role::System,
        _ => return None,
    };

    let blocks: Vec<Block> = v
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(content_block)
        .collect();

    if blocks.is_empty() {
        return None;
    }

    Some(Message {
        id: v
            .get("id")
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
        "text" => text_block(b.get("text").and_then(Value::as_str)?),
        "reasoning" => thinking_block(b.get("text").and_then(Value::as_str)?),
        "tool-call" => Some(tool_call_block(
            b.get("toolCallId").and_then(Value::as_str).unwrap_or_default(),
            b.get("toolName").and_then(Value::as_str).unwrap_or("tool"),
            b.get("input").unwrap_or(&Value::Null),
        )),
        "tool-result" => {
            let (text, is_error) = output_text(b.get("output"));
            Some(tool_result_block(
                b.get("toolCallId").and_then(Value::as_str).unwrap_or_default(),
                &text,
                is_error,
            ))
        }
        "file" | "image" => Some(Block::Image {
            alt: "attachment".to_string(),
        }),
        _ => None,
    }
}

/// AI SDK tool output is a tagged value: `text`, `json`, `error-text`,
/// `error-json`, or a `content` array.
fn output_text(output: Option<&Value>) -> (String, bool) {
    let Some(o) = output else {
        return (String::new(), false);
    };
    match o {
        Value::String(s) => (s.clone(), false),
        Value::Object(_) => {
            let kind = o.get("type").and_then(Value::as_str).unwrap_or("");
            let is_error = kind.starts_with("error");
            let text = match o.get("value") {
                Some(v) => super::value_to_text(v),
                None => match o.get("content").and_then(Value::as_array) {
                    Some(items) => items
                        .iter()
                        .filter_map(|c| c.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    None => super::value_to_text(o),
                },
            };
            (text, is_error)
        }
        other => (super::value_to_text(other), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_reasoning_and_tool_call() {
        let line = r#"{"id":"m1","timestamp":"t","role":"assistant","content":[
            {"type":"reasoning","text":"checking the build"},
            {"type":"tool-call","toolCallId":"c1","toolName":"shell_command","input":{"command":"cargo test"}}
        ]}"#;
        let m = parse_line(line, 2).expect("message");
        assert_eq!(m.role, Role::Assistant);
        assert_eq!(m.id, "m1");
        assert_eq!(m.line, 2);
        assert!(matches!(&m.blocks[0], Block::Thinking { text, .. } if text == "checking the build"));
        assert!(matches!(&m.blocks[1], Block::ToolCall { name, .. } if name == "shell_command"));
    }

    #[test]
    fn tool_records_render_on_the_user_side() {
        let line = r#"{"id":"t1","role":"tool","content":[{"type":"tool-result","toolCallId":"c1","toolName":"shell_command","output":{"type":"text","value":"ok"}}]}"#;
        let m = parse_line(line, 0).expect("message");
        assert_eq!(m.role, Role::User);
        assert!(matches!(&m.blocks[0], Block::ToolResult { output, is_error, .. } if output == "ok" && !is_error));
    }

    #[test]
    fn error_output_kinds_are_flagged() {
        let line = r#"{"id":"t","role":"tool","content":[{"type":"tool-result","toolCallId":"c","output":{"type":"error-text","value":"exit 1"}}]}"#;
        let m = parse_line(line, 0).expect("message");
        assert!(matches!(&m.blocks[0], Block::ToolResult { is_error, .. } if *is_error));
    }

    #[test]
    fn content_array_output_is_joined() {
        let o = serde_json::json!({"type":"content","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]});
        assert_eq!(output_text(Some(&o)), ("a\nb".to_string(), false));
    }

    #[test]
    fn missing_output_is_empty_not_a_panic() {
        assert_eq!(output_text(None), (String::new(), false));
    }

    #[test]
    fn unknown_roles_and_torn_lines_are_ignored() {
        assert!(parse_line(r#"{"role":"checkpoint","content":[]}"#, 0).is_none());
        assert!(parse_line(r#"{"role":"user","conte"#, 0).is_none());
    }
}
