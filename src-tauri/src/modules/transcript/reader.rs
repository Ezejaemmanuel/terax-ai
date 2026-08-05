use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use super::{char_boundary, clamp_all, cursor, Format, Message, MAX_BLOCK_BYTES};

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

/// A slice of one block's full payload, addressed by `(line, block index)`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub text: String,
    /// Byte offset to ask for next. Always on a char boundary.
    pub next_offset: usize,
    /// Total payload length, so a client can show progress before finishing.
    pub full_bytes: usize,
    /// True once `next_offset` has reached the end of the payload.
    pub eof: bool,
}

/// Read the newest `limit` messages, or the newest before line `before`.
pub fn read_page(
    path: &Path,
    format: Format,
    before: Option<usize>,
    limit: usize,
) -> std::io::Result<Page> {
    let mut page = page_uncapped(path, format, before, limit)?;
    clamp_all(&mut page.messages, MAX_BLOCK_BYTES);
    Ok(page)
}

/// Read everything appended since `byte_offset`.
pub fn read_append(
    path: &Path,
    format: Format,
    byte_offset: u64,
    next_line: usize,
) -> std::io::Result<Append> {
    let mut append = append_uncapped(path, format, byte_offset, next_line)?;
    clamp_all(&mut append.messages, MAX_BLOCK_BYTES);
    Ok(append)
}

/// Read `limit` bytes of one block's payload starting at `offset`, addressed by
/// the owning message's `line` cursor and the block's index within it.
///
/// Stateless like the rest of the reader: the one source record is re-parsed
/// per request with no cap applied, so a client can walk a multi-megabyte tool
/// result to its end in bounded steps without the server holding a session.
/// `None` means the address no longer resolves — the line was rewritten, or the
/// block carries no text.
pub fn read_block_chunk(
    path: &Path,
    format: Format,
    line: usize,
    index: usize,
    offset: usize,
    limit: usize,
) -> std::io::Result<Option<Chunk>> {
    let message = match format {
        Format::Cursor => cursor::find_message(path, line)?,
        _ => {
            let bytes = std::fs::read(path)?;
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.split('\n').collect();
            // Every JSONL format emits at most one message per line, so the
            // cursor addresses exactly one record to re-parse.
            match lines.get(line) {
                Some(l) => format.parse(&[*l], line).into_iter().next(),
                None => None,
            }
        }
    };

    Ok(message
        .as_ref()
        .and_then(|m| m.blocks.get(index))
        .and_then(|b| b.payload())
        .map(|payload| slice(payload, offset, limit)))
}

fn slice(payload: &str, offset: usize, limit: usize) -> Chunk {
    let full_bytes = payload.len();
    // Both ends walk back to a boundary: a client echoing `next_offset` always
    // lands on one, and a hand-written offset must not panic the server.
    let start = char_boundary(payload, offset);
    let end = char_boundary(payload, start.saturating_add(limit.max(1)));
    Chunk {
        text: payload[start..end].to_string(),
        next_offset: end,
        full_bytes,
        eof: end >= full_bytes,
    }
}

fn page_uncapped(
    path: &Path,
    format: Format,
    before: Option<usize>,
    limit: usize,
) -> std::io::Result<Page> {
    if format == Format::Cursor {
        return cursor::read_page(path, before, limit);
    }
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

/// Stops at the last complete line so a record still being written is picked up
/// on the next call instead of being parsed torn.
fn append_uncapped(
    path: &Path,
    format: Format,
    byte_offset: u64,
    next_line: usize,
) -> std::io::Result<Append> {
    if format == Format::Cursor {
        return cursor::read_append(path, byte_offset, next_line);
    }
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();

    // Truncated or rotated underneath us: start over rather than seek past EOF.
    if len < byte_offset {
        let page = page_uncapped(path, format, None, usize::MAX)?;
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
    use super::super::Block;
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

    /// Walks a block to its end the way the viewer does, returning everything
    /// the chunks carried plus how many requests it took.
    fn drain_block(p: &Path, line: usize, limit: usize) -> (String, usize) {
        let mut text = String::new();
        let mut offset = 0;
        let mut requests = 0;
        loop {
            let chunk = read_block_chunk(p, Format::Claude, line, 0, offset, limit)
                .expect("chunk")
                .expect("block exists");
            text.push_str(&chunk.text);
            offset = chunk.next_offset;
            requests += 1;
            if chunk.eof {
                assert_eq!(offset, chunk.full_bytes);
                break;
            }
            assert!(requests < 1000, "not converging on eof");
        }
        (text, requests)
    }

    #[test]
    fn a_clamped_block_reassembles_byte_identically_from_chunks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = "x".repeat(MAX_BLOCK_BYTES * 3 + 17);
        let p = write(dir.path(), "s.jsonl", &[claude_line("u0", &body)]);

        // The page itself is capped, and says how much it left behind.
        let page = read_page(&p, Format::Claude, None, 10).expect("page");
        let block = &page.messages[0].blocks[0];
        let Block::Text { text, truncated, full_bytes } = block else {
            panic!("expected text, got {block:?}");
        };
        assert!(truncated);
        assert_eq!(text.len(), MAX_BLOCK_BYTES);
        assert_eq!(*full_bytes, body.len());

        let (drained, requests) = drain_block(&p, page.messages[0].line, MAX_BLOCK_BYTES);
        assert_eq!(drained, body);
        assert_eq!(requests, 4);
    }

    #[test]
    fn a_multibyte_char_is_never_split_across_a_chunk_boundary() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 3-byte chars against a chunk size that is not a multiple of 3, so
        // every boundary lands mid-character unless it is walked back.
        let body = "☃".repeat(4000);
        let p = write(dir.path(), "s.jsonl", &[claude_line("u0", &body)]);

        let (drained, _) = drain_block(&p, 0, 1024);
        assert_eq!(drained, body);
    }

    #[test]
    fn a_block_that_fits_arrives_in_one_chunk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write(dir.path(), "s.jsonl", &[claude_line("u0", "short")]);

        let chunk = read_block_chunk(&p, Format::Claude, 0, 0, 0, MAX_BLOCK_BYTES)
            .expect("chunk")
            .expect("block exists");
        assert_eq!(chunk.text, "short");
        assert!(chunk.eof);
        assert_eq!(chunk.full_bytes, 5);
    }

    #[test]
    fn an_address_that_no_longer_resolves_is_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = write(dir.path(), "s.jsonl", &[claude_line("u0", "a")]);

        assert!(read_block_chunk(&p, Format::Claude, 99, 0, 0, 64)
            .expect("chunk")
            .is_none());
        assert!(read_block_chunk(&p, Format::Claude, 0, 7, 0, 64)
            .expect("chunk")
            .is_none());
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
