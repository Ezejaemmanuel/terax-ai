// `file:` URI conversion. The language server speaks URIs; every other layer in
// Terax speaks canonical display paths (forward slashes, no verbatim prefix).

use std::path::Path;

use crate::modules::fs::to_canon;

/// Bytes that survive unescaped in a path segment. `/` and `:` are kept so a
/// Windows path stays readable (`file:///C:/x`), which servers accept and which
/// matches what editors send.
fn is_safe(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
}

pub fn path_to_uri(path: impl AsRef<Path>) -> String {
    let canon = to_canon(path);
    let mut out = String::with_capacity(canon.len() + 8);
    out.push_str("file://");
    if !canon.starts_with('/') {
        out.push('/');
    }
    for byte in canon.bytes() {
        if is_safe(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `None` for anything that is not a `file:` URI: a server may report
/// diagnostics for virtual documents that have no path on disk.
pub fn uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    // An empty authority is the only one that names a local path.
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let decoded = percent_decode(rest);

    // `C:/x` on Windows, `/home/x` elsewhere: the leading slash was consumed
    // above, so put it back unless a drive letter follows.
    let path = if has_drive_letter(&decoded) {
        decoded
    } else {
        format!("/{decoded}")
    };

    // Canonicalizing normalizes drive-letter case and 8.3 names so the result
    // compares equal to the paths the rest of the app holds. A file the server
    // knows about but that is gone from disk still deserves its raw path.
    Some(match std::fs::canonicalize(&path) {
        Ok(real) => to_canon(real),
        Err(_) => path,
    })
}

fn has_drive_letter(s: &str) -> bool {
    let mut chars = s.chars();
    matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
}

fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_spaces_and_unicode_but_not_separators() {
        assert_eq!(path_to_uri("/home/u/a b.ts"), "file:///home/u/a%20b.ts");
        assert_eq!(path_to_uri("/home/u/ré.ts"), "file:///home/u/r%C3%A9.ts");
        assert_eq!(path_to_uri("/home/u/a#b.ts"), "file:///home/u/a%23b.ts");
    }

    #[test]
    fn windows_paths_get_the_third_slash() {
        assert_eq!(path_to_uri("C:/src/a.ts"), "file:///C:/src/a.ts");
    }

    #[test]
    fn decodes_the_escapes_a_server_sends() {
        // tsgo percent-encodes the drive colon and lowercases the letter.
        assert_eq!(uri_to_path("file:///c%3A/src/a.ts").as_deref(), Some("c:/src/a.ts"));
        assert_eq!(uri_to_path("file:///home/u/a%20b.ts").as_deref(), Some("/home/u/a b.ts"));
    }

    #[test]
    fn round_trips_a_path_without_a_disk_lookup() {
        let uri = path_to_uri("/home/u/nested dir/x.ts");
        assert_eq!(uri_to_path(&uri).as_deref(), Some("/home/u/nested dir/x.ts"));
    }

    #[test]
    fn rejects_non_file_schemes() {
        assert_eq!(uri_to_path("untitled:Untitled-1"), None);
        assert_eq!(uri_to_path("https://example.com/a.ts"), None);
    }

    #[test]
    fn malformed_escapes_are_left_alone_rather_than_dropped() {
        assert_eq!(uri_to_path("file:///home/u/100%.ts").as_deref(), Some("/home/u/100%.ts"));
    }
}
