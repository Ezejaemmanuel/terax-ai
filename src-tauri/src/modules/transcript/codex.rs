use serde_json::Value;

use super::{text_block, thinking_block, tool_result_block, Block, Message, Role};

/// Codex writes rollout files under `~/.codex/sessions/<yyyy>/<mm>/<dd>/`.
/// Each line is `{type, timestamp, payload}`. `response_item` payloads carry
/// the model-facing conversation; `event_msg` payloads duplicate it as UI
/// events, so parsing only `response_item` avoids emitting every turn twice.
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
    if v.get("type").and_then(Value::as_str)? != "response_item" {
        return None;
    }
    let p = v.get("payload")?;
    let timestamp = v
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let (role, blocks) = match p.get("type").and_then(Value::as_str)? {
        "message" => {
            let role = match p.get("role").and_then(Value::as_str)? {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                // `developer` is the injected permissions/sandbox preamble.
                _ => return None,
            };
            (role, message_blocks(p)?)
        }
        "reasoning" => (Role::Assistant, reasoning_blocks(p)),
        "function_call" => (Role::Assistant, vec![call_block(p)]),
        "function_call_output" => (Role::User, vec![output_block(p)]),
        _ => return None,
    };

    if blocks.is_empty() {
        return None;
    }

    Some(Message {
        id: p
            .get("call_id")
            .or_else(|| p.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("line-{index}")),
        role,
        timestamp,
        line: index,
        blocks,
    })
}

fn message_blocks(p: &Value) -> Option<Vec<Block>> {
    let items = p.get("content")?.as_array()?;
    let mut blocks = Vec::new();
    for b in items {
        match b.get("type").and_then(Value::as_str) {
            Some("input_text") | Some("output_text") | Some("text") => {
                let text = b.get("text").and_then(Value::as_str).unwrap_or_default();
                if is_harness_context(text) {
                    continue;
                }
                blocks.extend(text_block(text));
            }
            Some("input_image") => blocks.push(Block::Image {
                alt: "image".to_string(),
            }),
            _ => {}
        }
    }
    Some(blocks)
}

/// Reasoning content is encrypted; only the plaintext summary is renderable.
fn reasoning_blocks(p: &Value) -> Vec<Block> {
    p.get("summary")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|s| s.get("text").and_then(Value::as_str))
                .filter_map(thinking_block)
                .collect()
        })
        .unwrap_or_default()
}

fn call_block(p: &Value) -> Block {
    let name = p.get("name").and_then(Value::as_str).unwrap_or("tool");
    let id = p.get("call_id").and_then(Value::as_str).unwrap_or_default();
    // `arguments` is a JSON string; re-parse so it renders as structure
    // rather than an escaped one-liner.
    let raw = p.get("arguments").and_then(Value::as_str).unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(raw).unwrap_or(Value::String(raw.to_string()));
    super::tool_call_block(id, name, &parsed)
}

fn output_block(p: &Value) -> Block {
    let id = p.get("call_id").and_then(Value::as_str).unwrap_or_default();
    let (text, is_error) = match p.get("output") {
        Some(Value::String(s)) => (s.clone(), false),
        Some(obj @ Value::Object(_)) => {
            let text = obj
                .get("output")
                .map(super::value_to_text)
                .unwrap_or_else(|| super::value_to_text(obj));
            let is_error = obj
                .pointer("/metadata/exit_code")
                .and_then(Value::as_i64)
                .map(|c| c != 0)
                .unwrap_or(false);
            (text, is_error)
        }
        _ => (String::new(), false),
    };
    tool_result_block(id, &text, is_error)
}

/// Codex replays sandbox rules and user instructions as ordinary user turns.
fn is_harness_context(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context")
        || t.starts_with("<user_instructions")
        || t.starts_with("<permissions")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_and_assistant_messages() {
        let u = r#"{"type":"response_item","timestamp":"t","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"explain this"}]}}"#;
        let m = parse_line(u, 0).expect("message");
        assert_eq!(m.role, Role::User);
        assert_eq!(
            m.blocks,
            vec![Block::Text {
                text: "explain this".into(),
                truncated: false
            }]
        );

        let a = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"here goes"}]}}"#;
        assert_eq!(parse_line(a, 0).expect("message").role, Role::Assistant);
    }

    #[test]
    fn ignores_event_msg_so_turns_are_not_doubled() {
        let e = r#"{"type":"event_msg","payload":{"type":"agent_message","message":"dup"}}"#;
        assert!(parse_line(e, 0).is_none());
    }

    #[test]
    fn skips_developer_and_harness_context() {
        let d = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"sandbox rules"}]}}"#;
        assert!(parse_line(d, 0).is_none());

        let u = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"#;
        assert!(parse_line(u, 0).is_none());
    }

    #[test]
    fn function_call_arguments_are_reparsed_into_structure() {
        let c = r#"{"type":"response_item","payload":{"type":"function_call","name":"shell_command","call_id":"c1","arguments":"{\"command\":\"ls\"}"}}"#;
        let m = parse_line(c, 0).expect("message");
        match &m.blocks[0] {
            Block::ToolCall { name, input, id, .. } => {
                assert_eq!(name, "shell_command");
                assert_eq!(id, "c1");
                assert!(input.contains("\"command\""));
                assert!(!input.contains("\\\""));
            }
            other => panic!("expected tool call, got {other:?}"),
        }
    }

    #[test]
    fn unparsable_arguments_fall_back_to_raw_text() {
        let c = r#"{"type":"response_item","payload":{"type":"function_call","name":"t","call_id":"c","arguments":"not json"}}"#;
        let m = parse_line(c, 0).expect("message");
        assert!(matches!(&m.blocks[0], Block::ToolCall { input, .. } if input == "not json"));
    }

    #[test]
    fn output_accepts_string_and_object_forms() {
        let s = r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"done"}}"#;
        let m = parse_line(s, 0).expect("message");
        assert!(matches!(&m.blocks[0], Block::ToolResult { output, is_error, .. } if output == "done" && !is_error));

        let o = r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":{"output":"boom","metadata":{"exit_code":1}}}}"#;
        let m = parse_line(o, 0).expect("message");
        assert!(matches!(&m.blocks[0], Block::ToolResult { output, is_error, .. } if output == "boom" && *is_error));
    }

    #[test]
    fn reasoning_uses_summary_and_skips_empty() {
        let r = r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"planning"}],"encrypted_content":"xx"}}"#;
        let m = parse_line(r, 0).expect("message");
        assert!(matches!(&m.blocks[0], Block::Thinking { text, .. } if text == "planning"));

        let empty = r#"{"type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"xx"}}"#;
        assert!(parse_line(empty, 0).is_none());
    }

    #[test]
    fn torn_lines_are_ignored() {
        assert!(parse_line(r#"{"type":"response_item","payl"#, 0).is_none());
    }
}
