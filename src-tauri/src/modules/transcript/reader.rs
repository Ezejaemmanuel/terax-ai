use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use super::{Format, Message};

/// Backward paging starts by parsing this many lines and doubles until it has
/// a full page. Keeps a 50-message request off a 20k-line transcript.
const MIN_WINDOW: usize = 64;

/// Ceiling on a single append read. A runaway agent appending faster than the
/// client drains must not be able to pull unbounded bytes into memory.
const MAX_APPEND_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub messages: Vec<Message>,
    /// True when older messages exist before `messages[0]`.
    pub has_more: bool,
    /// Cursor to pass back as `before` for the previous page.
    pub oldest_line: usize,
    /// Byte length at read time; the client hands this back to resume appends
    /// without re-reading what it already has.
    pub byte_len: u64,
    pub total_lines: usize,
}

#[derive(Debug)]
pub struct Append {
    pub messages: Vec<Message>,
    pub byte_offset: u64,
    pub next_line: usize,
}

/// Read the newest `limit` messages, or the newest before line `before`.
pub fn read_page(
    path: &Path,
    format: Format,
    before: Option<usize>,
    limit: usize,
) -> std::io::Result<Page> {
    let bytes = std::fs::read(path)?;
    let byte_len = bytes.len() as u64;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split('\n').collect();
    let total_lines = lines.len();

    let end = before.unwrap_or(total_lines).min(total_lines);
    let limit = limit.max(1);

    let mut window = limit.saturating_mul(4).max(MIN_WINDOW);
    let (window_start, mut messages) = loop {
        let start = end.saturating_sub(window);
        let messages = format.parse(&lines[start..end], start);
        if messages.len() >= limit || start == 0 {
            break (start, messages);
        }
        window = window.saturating_mul(2);
    };

    let mut has_more = window_start > 0;
    if messages.len() > limit {
        messages.drain(..messages.len() - limit);
        has_more = true;
    }
    let oldest_line = messages.first().map(|m| m.line).unwrap_or(window_start);

    Ok(Page {
        oldest_line,
        has_more,
        byte_len,
        total_lines,
        messages,
    })
}

/// Read everything appended since `byte_offset`. Stops at the last complete
/// line so a record still being written is picked up on the next call instead
/// of being parsed torn.
pub fn read_append(
    path: &Path,
    format: Format,
    byte_offset: u64,
    next_line: usize,
) -> std::io::Result<Append> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();

    // Truncated or rotated underneath us: start over rather than seek past EOF.
    if len < byte_offset {
        let page = read_page(path, format, None, usize::MAX)?;
        return Ok(Append {
            next_line: page.total_lines,
            byte_offset: page.byte_len,
            messages: page.messages,
        });
    }
    if len == byte_offset {
        return Ok(Append {
            messages: Vec::new(),
            byte_offset,
            next_line,
        });
    }

    let take = (len - byte_offset).min(MAX_APPEND_BYTES);
    file.seek(SeekFrom::Start(byte_offset))?;
    let mut buf = vec![0u8; take as usize];
    let read = file.read(&mut buf)?;
    buf.truncate(read);

    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        // No complete line yet; leave the offset where it was.
        return Ok(Append {
            messages: Vec::new(),
            byte_offset,
            next_line,
        });
    };
    let complete = &buf[..last_nl];
    let text = String::from_utf8_lossy(complete);
    let lines: Vec<&str> = text.split('\n').collect();
    let consumed = lines.len();

    Ok(Append {
        messages: format.parse(&lines, next_line),
        byte_offset: byte_offset + last_nl as u64 + 1,
        next_line: next_line + consumed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn claude_line(uuid: &str, text: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"t","message":{{"content":"{text}"}}}}"#
        )
    }

    fn write(dir: &Path, name: &str, lines: &[String]) -> std::path::PathBuf {
        let p = dir.join(name);
        let mut f = File::create(&p).expect("create");
        for l in lines {
            writeln!(f, "{l}").expect("write");
        }
        p
    }

    #[test]
    fn page_returns_the_newest_messages_and_a_cursor() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lines: Vec<String> = (0..200)
            .map(|i| claude_line(&format!("u{i}"), &format!("msg {i}")))
            .collect();
        let p = write(dir.path(), "s.jsonl", &lines);

        let page = read_page(&p, Format::Claude, None, 50).expect("page");
        assert_eq!(page.messages.len(), 50);
        assert!(page.has_more);
        assert_eq!(page.messages.last().expect("last").id, "u199");
        assert_eq!(page.messages.first().expect("first").id, "u150");
        assert_eq!(page.oldest_line, page.messages[0].line);
    }

    #[test]
    fn paging_backwards_walks_to_the_start_without_gaps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lines: Vec<String> = (0..120)
            .map(|i| claude_line(&format!("u{i}"), "x"))
            .collect();
        let p = write(dir.path(), "s.jsonl", &lines);

        let mut seen = Vec::new();
        let mut before = None;
        loop {
            let page = read_page(&p, Format::Claude, before, 25).expect("page");
            let mut ids: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
            ids.extend(seen);
            seen = ids;
            if !page.has_more {
                break;
            }
            before = Some(page.oldest_line);
        }
        assert_eq!(seen.len(), 120);
        assert_eq!(seen[0], "u0");
        assert_eq!(seen[119], "u119");
    }

    #[test]
    fn append_reads_only_new_complete_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write(
            dir.path(),
            "s.jsonl",
            &[claude_line("u0", "a"), claude_line("u1", "b")],
        );
        let page = read_page(&p, Format::Claude, None, 10).expect("page");

        let mut f = std::fs::OpenOptions::new().append(true).open(&p).expect("open");
        writeln!(f, "{}", claude_line("u2", "c")).expect("append");

        let app = read_append(&p, Format::Claude, page.byte_len, page.total_lines)
            .expect("append");
        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].id, "u2");

        // Nothing new: no messages, offset unchanged.
        let again = read_append(&p, Format::Claude, app.byte_offset, app.next_line).expect("again");
        assert!(again.messages.is_empty());
        assert_eq!(again.byte_offset, app.byte_offset);
    }

    #[test]
    fn a_half_written_line_is_deferred_not_parsed_torn() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write(dir.path(), "s.jsonl", &[claude_line("u0", "a")]);
        let page = read_page(&p, Format::Claude, None, 10).expect("page");

        let mut f = std::fs::OpenOptions::new().append(true).open(&p).expect("open");
        write!(f, r#"{{"type":"user","uuid":"u1","messa"#).expect("partial");
        f.flush().expect("flush");

        let app = read_append(&p, Format::Claude, page.byte_len, page.total_lines).expect("append");
        assert!(app.messages.is_empty());
        assert_eq!(app.byte_offset, page.byte_len);

        // Completing the line delivers it exactly once.
        writeln!(f, r#"ge":{{"content":"b"}}}}"#).expect("finish");
        let app = read_append(&p, Format::Claude, app.byte_offset, app.next_line).expect("append");
        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].id, "u1");
    }

    #[test]
    fn truncation_resets_instead_of_seeking_past_eof() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write(dir.path(), "s.jsonl", &[claude_line("u0", "a")]);
        let app = read_append(&p, Format::Claude, 9_000_000, 500).expect("append");
        assert_eq!(app.messages.len(), 1);
        assert_eq!(app.messages[0].id, "u0");
    }

    #[test]
    fn empty_file_yields_an_empty_page() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write(dir.path(), "s.jsonl", &[]);
        let page = read_page(&p, Format::Claude, None, 50).expect("page");
        assert!(page.messages.is_empty());
        assert!(!page.has_more);
    }
}
