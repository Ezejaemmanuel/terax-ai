use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

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

/// Last known status per live pty, so a viewer that connects mid-session sees
/// which terminals are open right now instead of waiting for the next
/// transition (or, worse, seeing every terminal that ever existed because the
/// session index is built from history files on disk).
static SNAPSHOT: OnceLock<Mutex<HashMap<u32, SnapshotEntry>>> = OnceLock::new();

#[derive(Clone, Debug, Default)]
struct SnapshotEntry {
    kind: String,
    agent: Option<String>,
    session: Option<String>,
}

fn snapshot_map() -> &'static Mutex<HashMap<u32, SnapshotEntry>> {
    SNAPSHOT.get_or_init(|| Mutex::new(HashMap::new()))
}

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
    if let Event::AgentStatus { pty_id, ref kind, ref agent, ref session } = event {
        record_snapshot(pty_id, kind, agent.as_deref(), session.as_deref());
    }
    if let Some(tx) = SENDER.get() {
        // Err just means nobody is listening yet.
        let _ = tx.send(event);
    }
}

/// Folds one status transition into the live snapshot. Mirrors the merge the
/// frontend does client-side: `agent` and `session` only ride on the events
/// that first learn them, so they're carried forward; `session` markers don't
/// carry a status `kind` of their own, so they update the mapping without
/// clobbering the last real transition.
fn record_snapshot(pty_id: u32, kind: &str, agent: Option<&str>, session: Option<&str>) {
    let mut map = snapshot_map().lock().expect("snapshot poisoned");
    if kind == "exited" {
        map.remove(&pty_id);
        return;
    }
    let entry = map.entry(pty_id).or_default();
    if let Some(a) = agent {
        entry.agent = Some(a.to_string());
    }
    if let Some(s) = session {
        entry.session = Some(s.to_string());
    }
    if kind != "session" {
        entry.kind = kind.to_string();
    }
}

/// Snapshot of every pty currently known to be running an identified agent
/// session, shaped as the same `AgentStatus` events the live stream sends so a
/// new viewer can replay them through identical client-side merge logic.
pub fn snapshot() -> Vec<Event> {
    snapshot_map()
        .lock()
        .expect("snapshot poisoned")
        .iter()
        .filter(|(_, e)| e.agent.is_some() && e.session.is_some())
        .map(|(&pty_id, e)| Event::AgentStatus {
            pty_id,
            kind: e.kind.clone(),
            agent: e.agent.clone(),
            session: e.session.clone(),
        })
        .collect()
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

        // A pty only shows up in the snapshot once both its agent and its
        // session id are known — the two arrive on separate events.
        publish(Event::AgentStatus {
            pty_id: 99,
            kind: "started".into(),
            agent: Some("claude".into()),
            session: None,
        });
        assert!(snapshot().is_empty(), "no session id yet");
        publish(Event::AgentStatus {
            pty_id: 99,
            kind: "session".into(),
            agent: None,
            session: Some("s1".into()),
        });
        let snap = snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(
            snap[0],
            Event::AgentStatus {
                pty_id: 99,
                kind: "started".into(),
                agent: Some("claude".into()),
                session: Some("s1".into()),
            }
        );

        // A later real transition replaces the carried-forward kind...
        publish(Event::AgentStatus {
            pty_id: 99,
            kind: "attention".into(),
            agent: None,
            session: None,
        });
        assert_eq!(snapshot()[0].clone(), Event::AgentStatus {
            pty_id: 99,
            kind: "attention".into(),
            agent: Some("claude".into()),
            session: Some("s1".into()),
        });

        // ...and exit drops the pty from the snapshot entirely.
        publish(Event::AgentStatus {
            pty_id: 99,
            kind: "exited".into(),
            agent: None,
            session: None,
        });
        assert!(snapshot().is_empty());

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
