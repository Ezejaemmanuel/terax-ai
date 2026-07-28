// Base-protocol framing for LSP over stdio: `Content-Length: N\r\n\r\n<body>`.
// Kept free of process and IO-source concerns so it can be tested directly.

use std::io::{self, BufRead};

/// Payload cap for a single inbound message. A server that claims more than
/// this is malfunctioning, and honoring it would let one message exhaust RAM.
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

pub fn encode(body: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    out.extend_from_slice(body.as_bytes());
    out
}

/// Read one message, or `None` at clean end of stream.
pub fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        // Header names are case-insensitive per the base protocol.
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }

    let len = content_length.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "message without Content-Length")
    })?;
    if len > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("message of {len} bytes exceeds the {MAX_MESSAGE_BYTES} byte cap"),
        ));
    }

    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn encodes_length_in_bytes_not_chars() {
        let framed = encode("{\"k\":\"é\"}");
        let text = String::from_utf8(framed).unwrap();
        assert!(text.starts_with("Content-Length: 10\r\n\r\n"));
    }

    #[test]
    fn reads_back_what_it_encodes() {
        let framed = encode("{\"a\":1}");
        let mut reader = BufReader::new(&framed[..]);
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn reads_consecutive_messages_from_one_stream() {
        let mut buf = encode("{\"a\":1}");
        buf.extend_from_slice(&encode("{\"b\":2}"));
        let mut reader = BufReader::new(&buf[..]);
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{\"b\":2}"));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn tolerates_extra_headers_and_odd_casing() {
        let raw = "content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: 7\r\n\r\n{\"a\":1}";
        let mut reader = BufReader::new(raw.as_bytes());
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn rejects_missing_content_length() {
        let mut reader = BufReader::new(&b"X-Thing: 1\r\n\r\n{}"[..]);
        assert!(read_message(&mut reader).is_err());
    }

    #[test]
    fn rejects_absurd_content_length_without_allocating() {
        let raw = format!("Content-Length: {}\r\n\r\n", u64::from(u32::MAX));
        let mut reader = BufReader::new(raw.as_bytes());
        assert!(read_message(&mut reader).is_err());
    }

    #[test]
    fn truncated_body_is_an_error_not_a_short_read() {
        let mut reader = BufReader::new(&b"Content-Length: 12\r\n\r\n{\"a\":1}"[..]);
        assert!(read_message(&mut reader).is_err());
    }
}
