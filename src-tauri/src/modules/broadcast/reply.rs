//! Turning a remote viewer's text into keystrokes a TUI agent will accept.
//!
//! The agents read a pty, so a reply is not "a message" to them — it is typed
//! input. Two properties matter and neither is automatic: the whole body has to
//! arrive as one paste (otherwise an embedded newline submits a half-written
//! prompt), and the submit has to be a deliberate, separate act.

/// Long enough for a real instruction, short enough that a hostile or buggy
/// client cannot stuff a terminal's input buffer.
pub const MAX_LEN: usize = 4000;

/// Agents whose submit semantics have actually been verified. Codex and Cursor
/// read their prompts differently enough that assuming a trailing CR submits
/// cleanly would be a guess; they stay refused until each is checked.
pub const REPLYABLE_AGENTS: &[&str] = &["claude"];

#[derive(Debug, PartialEq, Eq)]
pub enum ReplyError {
    Empty,
    TooLong,
}

impl ReplyError {
    pub fn message(&self) -> String {
        match self {
            ReplyError::Empty => "reply is empty".into(),
            ReplyError::TooLong => format!("reply exceeds {MAX_LEN} characters"),
        }
    }
}

/// The bytes to write, split into the paste and the submit. They are handed to
/// the pty as two writes so the child sees a complete bracketed paste settle
/// before the Enter that acts on it — some TUIs coalesce otherwise and treat
/// the CR as part of the pasted body.
#[derive(Debug)]
pub struct Keystrokes {
    pub paste: Vec<u8>,
    pub submit: Vec<u8>,
}

/// Normalize what a phone keyboard produces into what a pty expects, then wrap
/// it for bracketed paste.
///
/// CRLF and lone CR both collapse to LF: a raw CR inside the payload reads as a
/// submit to the line discipline, which is the exact failure this wrapper
/// exists to prevent. Other C0 control bytes are dropped rather than escaped —
/// they can only arrive by accident or by intent to drive the TUI sideways, and
/// neither is a reply.
pub fn encode(text: &str) -> Result<Keystrokes, ReplyError> {
    let normalized: String = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    let trimmed = normalized.trim();

    if trimmed.is_empty() {
        return Err(ReplyError::Empty);
    }
    if trimmed.chars().count() > MAX_LEN {
        return Err(ReplyError::TooLong);
    }

    let mut paste = Vec::with_capacity(trimmed.len() + 12);
    paste.extend_from_slice(b"\x1b[200~");
    paste.extend_from_slice(trimmed.as_bytes());
    paste.extend_from_slice(b"\x1b[201~");

    Ok(Keystrokes {
        paste,
        submit: b"\r".to_vec(),
    })
}

/// Whether an agent in this state will read typed input as a prompt.
///
/// `attention` and `finished` are the states where the agent is sitting at its
/// input. While it is `working` the text still lands — the agents queue it —
/// but the sender should be the one deciding that, so it needs `force`.
/// `started` is the same deal: the TUI may not have drawn its prompt yet.
pub fn accepts(kind: &str, force: bool) -> bool {
    match kind {
        "attention" | "finished" => true,
        "working" | "started" => force,
        // "exited" and anything unrecognized: no prompt to type into.
        _ => false,
    }
}

/// True when the reply would be queued rather than acted on immediately, so the
/// client can say so instead of leaving the user waiting on a silent terminal.
pub fn is_busy(kind: &str) -> bool {
    matches!(kind, "working" | "started")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paste_body(text: &str) -> String {
        let k = encode(text).expect("encodes");
        String::from_utf8(k.paste).expect("utf8")
    }

    #[test]
    fn wraps_the_body_in_bracketed_paste_and_submits_separately() {
        let k = encode("ship it").expect("encodes");
        assert_eq!(k.paste, b"\x1b[200~ship it\x1b[201~".to_vec());
        assert_eq!(k.submit, b"\r".to_vec());
    }

    #[test]
    fn multiline_stays_one_paste_with_no_embedded_carriage_return() {
        // The whole point: a two-line reply must not submit after line one.
        let body = paste_body("first line\r\nsecond line\rthird");
        assert_eq!(body, "\x1b[200~first line\nsecond line\nthird\x1b[201~");
        assert!(
            !body.trim_end_matches("\x1b[201~").contains('\r'),
            "a bare CR inside the paste would submit early"
        );
    }

    #[test]
    fn control_bytes_that_would_drive_the_tui_are_dropped() {
        // ESC would let a sender inject its own escape sequences; \x03 is SIGINT.
        assert_eq!(paste_body("a\x1b[Bb\x03c"), "\x1b[200~a[Bbc\x1b[201~");
        // Tabs and newlines survive: they are ordinary text in a prompt.
        assert_eq!(paste_body("a\tb"), "\x1b[200~a\tb\x1b[201~");
    }

    #[test]
    fn empty_and_whitespace_only_replies_are_refused() {
        assert_eq!(encode("").unwrap_err(), ReplyError::Empty);
        assert_eq!(encode("   \n\t ").unwrap_err(), ReplyError::Empty);
        // A body of nothing but control bytes is empty too.
        assert_eq!(encode("\x00\x07").unwrap_err(), ReplyError::Empty);
    }

    #[test]
    fn oversized_replies_are_refused() {
        assert!(encode(&"a".repeat(MAX_LEN)).is_ok());
        assert_eq!(
            encode(&"a".repeat(MAX_LEN + 1)).unwrap_err(),
            ReplyError::TooLong
        );
        // Counted in characters, not bytes, so multibyte text is not penalized.
        assert!(encode(&"é".repeat(MAX_LEN)).is_ok());
    }

    #[test]
    fn only_idle_states_accept_input_unforced() {
        for kind in ["attention", "finished"] {
            assert!(accepts(kind, false), "{kind} should accept a reply");
        }
        for kind in ["working", "started"] {
            assert!(!accepts(kind, false), "{kind} needs an explicit force");
            assert!(accepts(kind, true));
            assert!(is_busy(kind));
        }
        for kind in ["exited", "session", ""] {
            assert!(!accepts(kind, false));
            assert!(!accepts(kind, true), "{kind} must not accept even forced");
        }
    }
}
