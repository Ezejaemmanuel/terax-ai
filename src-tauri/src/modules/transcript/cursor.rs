use std::io;
use std::path::Path;

use serde_json::Value;

use super::reader::{Append, Page};
use super::{clamp, text_block, thinking_block, tool_call_block, tool_result_block, Block, Message, Role};

/// Cursor CLI stores each chat as a SQLite database (`store.db`) with a single
/// `blobs(id TEXT PRIMARY KEY, data BLOB)` table: content-addressed, no
/// explicit ordering or parent-pointer column. Writes are append-only, so
/// `rowid` — SQLite's own insertion order — is the closest thing to a
/// timeline available without decoding Cursor's internal binary/CRDT blob
/// format.
///
/// Not every row is a renderable message: some blobs are an internal binary
/// encoding of the same turn and don't parse as JSON, or are the system
/// prompt/injected context rather than something the user or model said.
/// Those are silently skipped; the plain-JSON sibling row (handled here)
/// carries the actual text/reasoning/tool-call/tool-result payload.
///
/// Histories here are a few hundred rows at most, so re-reading the whole
/// database per request/append is simpler and safer than tracking a partial
/// cursor across calls the way the JSONL formats do.
fn load_messages(path: &Path) -> rusqlite::Result<Vec<Message>> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut stmt = conn.prepare("SELECT rowid, id, data FROM blobs ORDER BY rowid ASC")?;
    let mut rows = stmt.query([])?;

    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let rowid: i64 = row.get(0)?;
        let blob_id: String = row.get(1)?;
        let data: Vec<u8> = row.get(2)?;
        if let Some(message) = parse_row(rowid, &blob_id, &data) {
            out.push(message);
        }
    }
    Ok(out)
}

fn parse_row(rowid: i64, blob_id: &str, data: &[u8]) -> Option<Message> {
    let text = std::str::from_utf8(data).ok()?;
    let v: Value = serde_json::from_str(text).ok()?;

    // The system prompt/injected project context is internal plumbing, not
    // something the user wrote or the assistant said.
    let role = match v.get("role").and_then(Value::as_str)? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::User,
        _ => return None,
    };

    let content = v.get("content")?;
    let blocks: Vec<Block> = match content {
        // User messages are sometimes a bare string rather than a typed array.
        Value::String(s) => text_block(s).into_iter().collect(),
        Value::Array(items) => items.iter().filter_map(content_block).collect(),
        _ => return None,
    };
    if blocks.is_empty() {
        return None;
    }

    Some(Message {
        // The embedded `id` field is a per-turn ordinal ("1", "2", ...), not
        // unique across the chat; the blob's own content hash always is.
        id: blob_id.to_string(),
        role,
        timestamp: String::new(),
        line: rowid.max(0) as usize,
        blocks,
    })
}

fn content_block(b: &Value) -> Option<Block> {
    match b.get("type").and_then(Value::as_str)? {
        "text" => text_block(b.get("text").and_then(Value::as_str)?),
        "reasoning" => thinking_block(b.get("text").and_then(Value::as_str)?),
        // Anthropic/OpenAI "redacted" reasoning ships as an opaque signed
        // blob with no plain text — say so rather than showing nothing.
        "redacted-reasoning" => thinking_block("[reasoning hidden by the model]"),
        "tool-call" => Some(tool_call_block(
            b.get("toolCallId").and_then(Value::as_str).unwrap_or_default(),
            b.get("toolName").and_then(Value::as_str).unwrap_or("tool"),
            // Cursor calls this `args`, not `input` like Codex/Command Code.
            b.get("args").unwrap_or(&Value::Null),
        )),
        "tool-result" => {
            let (text, is_error) = tool_result_text(b);
            Some(tool_result_block(
                b.get("toolCallId").and_then(Value::as_str).unwrap_or_default(),
                &text,
                is_error,
            ))
        }
        "image" | "file" => Some(Block::Image {
            alt: "attachment".to_string(),
        }),
        _ => None,
    }
}

/// Cursor's tool-result shape differs from the AI-SDK one Codex/Command Code
/// use: the text lives in `result` (string) or `experimental_content`
/// (array), and the error flag is nested under `providerOptions`.
fn tool_result_text(b: &Value) -> (String, bool) {
    let text = match b.get("result").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => b
            .get("experimental_content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|c| c.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
    };
    let is_error = b
        .pointer("/providerOptions/cursor/highLevelToolCallResult/isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (text, _) = clamp(&text);
    (text, is_error)
}

fn to_io_err(e: rusqlite::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Other, e.to_string())
}

/// `before`/`limit` mirror `reader::read_page`'s line-cursor semantics, but
/// positions are message indices (derived from `rowid`) rather than byte
/// offsets. The client only ever echoes these back opaquely, so no protocol
/// change is needed to support a non-line-oriented source.
pub fn read_page(path: &Path, before: Option<usize>, limit: usize) -> io::Result<Page> {
    let messages = load_messages(path).map_err(to_io_err)?;
    let total_lines = messages.len();
    let end = before.unwrap_or(total_lines).min(total_lines);
    let limit = limit.max(1);
    let start = end.saturating_sub(limit);

    let has_more = start > 0;
    let page = messages[start..end].to_vec();
    let oldest_line = page.first().map(|m| m.line).unwrap_or(start);

    Ok(Page {
        oldest_line,
        has_more,
        // Not a byte length for this format — just a stable position the
        // client hands back unchanged as `offset` on the next append poll.
        byte_len: total_lines as u64,
        total_lines,
        messages: page,
    })
}

/// `byte_offset` here means "how many messages the client has already seen",
/// reusing the same field the JSONL formats use for an actual byte position.
pub fn read_append(path: &Path, byte_offset: u64, next_line: usize) -> io::Result<Append> {
    let messages = load_messages(path).map_err(to_io_err)?;
    let total = messages.len();
    let start = (byte_offset as usize).min(total);

    Ok(Append {
        messages: messages[start..].to_vec(),
        byte_offset: total as u64,
        next_line: total.max(next_line),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db_with(rows: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("store.db")).expect("open");
        conn.execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)", [])
            .expect("create table");
        for (id, data) in rows {
            // Bind as bytes so the column round-trips as BLOB, matching how
            // the real Cursor CLI writes rows (a bound `&str` would insert
            // as TEXT affinity instead, which `load_messages`'s `Vec<u8>`
            // read then rejects).
            conn.execute(
                "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
                rusqlite::params![id, data.as_bytes()],
            )
            .expect("insert");
        }
        dir
    }

    #[test]
    fn parses_user_string_content_and_assistant_array_content() {
        let dir = db_with(&[
            ("b1", r#"{"role":"user","content":"hello there"}"#),
            (
                "b2",
                r#"{"id":"1","role":"assistant","content":[{"type":"text","text":"hi back"}]}"#,
            ),
        ]);
        let messages = load_messages(&dir.path().join("store.db")).expect("load");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].id, "b1");
        assert!(matches!(&messages[0].blocks[0], Block::Text { text, .. } if text == "hello there"));
        assert_eq!(messages[1].role, Role::Assistant);
    }

    #[test]
    fn skips_system_prompt_and_binary_rows() {
        let dir = db_with(&[
            ("b1", r#"{"role":"system","content":"you are an AI"}"#),
            ("b2", "not json at all"),
        ]);
        let messages = load_messages(&dir.path().join("store.db")).expect("load");
        assert!(messages.is_empty());
    }

    #[test]
    fn redacted_reasoning_becomes_a_placeholder_thinking_block() {
        let dir = db_with(&[(
            "b1",
            r#"{"role":"assistant","content":[{"type":"redacted-reasoning","data":"opaque"}]}"#,
        )]);
        let messages = load_messages(&dir.path().join("store.db")).expect("load");
        assert!(matches!(&messages[0].blocks[0], Block::Thinking { text, .. } if text.contains("hidden")));
    }

    #[test]
    fn tool_call_reads_args_not_input() {
        let dir = db_with(&[(
            "b1",
            r#"{"role":"assistant","content":[{"type":"tool-call","toolCallId":"c1","toolName":"Glob","args":{"glob_pattern":"**/*"}}]}"#,
        )]);
        let messages = load_messages(&dir.path().join("store.db")).expect("load");
        assert!(matches!(&messages[0].blocks[0], Block::ToolCall { name, input, .. }
            if name == "Glob" && input.contains("glob_pattern")));
    }

    #[test]
    fn tool_result_reads_result_string_and_error_flag() {
        let dir = db_with(&[(
            "b1",
            r#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"c1","result":"Timed out","providerOptions":{"cursor":{"highLevelToolCallResult":{"isError":true}}}}]}"#,
        )]);
        let messages = load_messages(&dir.path().join("store.db")).expect("load");
        assert!(matches!(&messages[0].blocks[0], Block::ToolResult { output, is_error, .. }
            if output == "Timed out" && *is_error));
    }

    #[test]
    fn tool_result_falls_back_to_experimental_content() {
        let dir = db_with(&[(
            "b1",
            r#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"c1","experimental_content":[{"type":"text","text":"ok"}]}]}"#,
        )]);
        let messages = load_messages(&dir.path().join("store.db")).expect("load");
        assert!(matches!(&messages[0].blocks[0], Block::ToolResult { output, is_error, .. }
            if output == "ok" && !*is_error));
    }

    #[test]
    fn read_page_and_read_append_paginate_by_row_position() {
        let rows: Vec<(String, String)> = (0..5)
            .map(|i| {
                (
                    format!("b{i}"),
                    format!(r#"{{"role":"user","content":"msg {i}"}}"#),
                )
            })
            .collect();
        let row_refs: Vec<(&str, &str)> = rows.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let dir = db_with(&row_refs);
        let path = dir.path().join("store.db");

        let page = read_page(&path, None, 3).expect("page");
        assert_eq!(page.messages.len(), 3);
        assert!(page.has_more);
        assert_eq!(page.messages.last().expect("last").id, "b4");

        let append = read_append(&path, page.byte_len, page.total_lines).expect("append");
        assert!(append.messages.is_empty());
    }

    #[test]
    fn read_append_reports_only_new_rows() {
        let dir = db_with(&[("b0", r#"{"role":"user","content":"a"}"#)]);
        let path = dir.path().join("store.db");
        let page = read_page(&path, None, 10).expect("page");

        let conn = Connection::open(&path).expect("reopen");
        conn.execute(
            "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
            rusqlite::params!["b1", r#"{"role":"assistant","content":"b"}"#.as_bytes()],
        )
        .expect("insert");

        let append = read_append(&path, page.byte_len, page.total_lines).expect("append");
        assert_eq!(append.messages.len(), 1);
        assert_eq!(append.messages[0].id, "b1");
    }
}
