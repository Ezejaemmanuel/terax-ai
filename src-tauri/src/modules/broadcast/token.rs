/// 128 bits of entropy, hex encoded. Long enough that guessing it over a LAN
/// is not a threat, short enough to survive a QR code comfortably.
const TOKEN_BYTES: usize = 16;

pub fn generate() -> String {
    let mut buf = [0u8; TOKEN_BYTES];
    // A failure here means the OS RNG is unavailable. Refusing to serve is the
    // only safe outcome, so panic rather than fall back to a weak token.
    getrandom::fill(&mut buf).expect("OS RNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Length-independent, byte-constant-time comparison. Rejects on length
/// mismatch without leaking where the difference is via early return timing.
pub fn matches(expected: &str, provided: &str) -> bool {
    let a = expected.as_bytes();
    let b = provided.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Pull the token from `Authorization: Bearer <t>` or a `?t=` query parameter.
/// The query form exists so a QR code can carry it; the header form so fetches
/// from the page do not have to.
pub fn extract(auth_header: Option<&str>, query: Option<&str>) -> Option<String> {
    if let Some(h) = auth_header {
        if let Some(rest) = h.strip_prefix("Bearer ") {
            return Some(rest.trim().to_string());
        }
    }
    let q = query?;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("t=") {
            return Some(v.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_distinct_hex_tokens() {
        let a = generate();
        let b = generate();
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn matches_only_on_exact_equality() {
        assert!(matches("abc123", "abc123"));
        assert!(!matches("abc123", "abc124"));
        assert!(!matches("abc123", "abc12"));
        assert!(!matches("abc123", ""));
        assert!(!matches("", "x"));
    }

    #[test]
    fn extracts_from_header_and_query() {
        assert_eq!(extract(Some("Bearer tok"), None).as_deref(), Some("tok"));
        assert_eq!(extract(None, Some("t=tok")).as_deref(), Some("tok"));
        assert_eq!(
            extract(None, Some("before=10&t=tok&limit=5")).as_deref(),
            Some("tok")
        );
    }

    #[test]
    fn header_wins_and_malformed_yields_none() {
        assert_eq!(extract(Some("Bearer h"), Some("t=q")).as_deref(), Some("h"));
        assert_eq!(extract(Some("Basic xyz"), None), None);
        assert_eq!(extract(None, Some("limit=5")), None);
        assert_eq!(extract(None, None), None);
    }

    #[test]
    fn a_token_named_prefix_is_not_mistaken_for_the_token() {
        assert_eq!(extract(None, Some("token=nope")), None);
    }
}
