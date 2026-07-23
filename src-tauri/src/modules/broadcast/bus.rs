use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tokio::sync::broadcast;

/// Bounded so a stalled subscriber cannot pin unbounded memory. Overflow drops
/// the oldest events for that subscriber only, which is correct here: status is
/// idempotent and transcript deltas are re-derived from the file offset.
const CAPACITY: usize = 256;

/// Checked on the PTY reader's hot path. Relaxed is right: a broadcast that
/// starts a few microseconds late is invisible, and no other state depends on
/// the ordering.
static ENABLED: AtomicBool = AtomicBool::new(false);
static SENDER: OnceLock<broadcast::Sender<Event>> = OnceLock::new();

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    /// Agent lifecycle from the PTY detector.
    AgentStatus {
        pty_id: u32,
        kind: String,
        agent: Option<String>,
        session: Option<String>,
    },
    /// A transcript file grew. Carries no bodies: subscribers that care read
    /// the delta from their own byte offset.
    SessionTouched { path: String },
    /// The set of sessions changed, so clients should refetch the index.
    IndexChanged,
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Idempotent. The channel is allocated once and reused across enable cycles so
/// subscribers established before a restart are not silently orphaned.
pub fn enable() -> broadcast::Sender<Event> {
    let tx = SENDER
        .get_or_init(|| broadcast::channel(CAPACITY).0)
        .clone();
    ENABLED.store(true, Ordering::Relaxed);
    tx
}

pub fn disable() {
    ENABLED.store(false, Ordering::Relaxed);
}

pub fn subscribe() -> Option<broadcast::Receiver<Event>> {
    SENDER.get().map(broadcast::Sender::subscribe)
}

/// No-op when broadcasting is off. Callers on hot paths should still gate on
/// `is_enabled()` so they skip building the event at all.
pub fn publish(event: Event) {
    if !is_enabled() {
        return;
    }
    if let Some(tx) = SENDER.get() {
        // Err just means nobody is listening yet.
        let _ = tx.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The globals are process-wide, so these run as one test to stay
    // deterministic under the parallel test harness.
    #[tokio::test]
    async fn enable_publish_disable_cycle() {
        assert!(!is_enabled());
        assert!(subscribe().is_none() || !is_enabled());

        let _tx = enable();
        assert!(is_enabled());
        let mut rx = subscribe().expect("subscriber");

        publish(Event::IndexChanged);
        assert_eq!(rx.recv().await.expect("event"), Event::IndexChanged);

        disable();
        assert!(!is_enabled());
        publish(Event::IndexChanged);
        assert!(rx.try_recv().is_err(), "publish must be a no-op when disabled");

        // Re-enabling reuses the same channel, so the existing receiver still works.
        enable();
        publish(Event::SessionTouched { path: "p".into() });
        assert_eq!(
            rx.recv().await.expect("event"),
            Event::SessionTouched { path: "p".into() }
        );
        disable();
    }

    #[test]
    fn agent_status_serializes_with_a_type_tag() {
        let json = serde_json::to_string(&Event::AgentStatus {
            pty_id: 3,
            kind: "attention".into(),
            agent: Some("claude".into()),
            session: None,
        })
        .expect("json");
        assert!(json.contains("\"type\":\"agentStatus\""));
        assert!(json.contains("\"ptyId\":3"));
    }
}
