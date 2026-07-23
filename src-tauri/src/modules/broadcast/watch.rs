use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::bus::{self, Event as BusEvent};

/// Short enough that a message appears on the phone as it lands, long enough
/// that one agent turn does not produce a burst of reads.
const DEBOUNCE: Duration = Duration::from_millis(120);
const MAX_WINDOW: Duration = Duration::from_millis(800);

/// Dropping this stops the watcher and its thread.
pub struct WatchHandle {
    _watchers: Vec<RecommendedWatcher>,
}

/// Watch the agent history roots and turn file activity into bus events.
/// Missing roots are skipped: not every agent is installed.
pub fn spawn(roots: &[PathBuf]) -> WatchHandle {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watchers = Vec::new();

    for root in roots.iter().filter(|r| r.is_dir()) {
        let tx = tx.clone();
        let Ok(mut w) = RecommendedWatcher::new(move |res| { let _ = tx.send(res); }, Config::default())
        else {
            continue;
        };
        if w.watch(root, RecursiveMode::Recursive).is_ok() {
            watchers.push(w);
        }
    }

    if watchers.is_empty() {
        return WatchHandle { _watchers: watchers };
    }

    let _ = std::thread::Builder::new()
        .name("terax-broadcast-watch".into())
        .spawn(move || pump(rx));

    WatchHandle { _watchers: watchers }
}

fn pump(rx: mpsc::Receiver<notify::Result<Event>>) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut batch = Batch::default();
        batch.add(first);

        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(DEBOUNCE.min(remaining)) {
                Ok(ev) => batch.add(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        for path in batch.touched {
            bus::publish(BusEvent::SessionTouched {
                path: path.to_string_lossy().into_owned(),
            });
        }
        if batch.structural {
            bus::publish(BusEvent::IndexChanged);
        }
    }
}

#[derive(Default)]
struct Batch {
    touched: HashSet<PathBuf>,
    structural: bool,
}

impl Batch {
    fn add(&mut self, ev: notify::Result<Event>) {
        let Ok(ev) = ev else { return };
        // Reads are noise; the JSONL is being scanned by other tooling too.
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        if matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_)) {
            self.structural = true;
        }
        for p in ev.paths {
            if is_transcript(&p) {
                self.touched.insert(p);
            }
        }
    }
}

/// Only transcript files drive appends. Sidecars (`*.checkpoints.jsonl`,
/// meta.json, session_index.jsonl) would otherwise cause pointless reads.
fn is_transcript(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.ends_with(".jsonl")
        && !name.ends_with(".checkpoints.jsonl")
        && name != "session_index.jsonl"
}

/// History roots for the agents whose transcripts we can parse.
pub fn default_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![
        home.join(".claude").join("projects"),
        home.join(".codex").join("sessions"),
        home.join(".commandcode").join("projects"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    fn ev(kind: EventKind, path: &str) -> notify::Result<Event> {
        Ok(Event {
            kind,
            paths: vec![PathBuf::from(path)],
            attrs: Default::default(),
        })
    }

    #[test]
    fn transcript_files_are_recognized_and_sidecars_are_not() {
        assert!(is_transcript(Path::new("/a/s.jsonl")));
        assert!(!is_transcript(Path::new("/a/s.checkpoints.jsonl")));
        assert!(!is_transcript(Path::new("/a/session_index.jsonl")));
        assert!(!is_transcript(Path::new("/a/meta.json")));
        assert!(!is_transcript(Path::new("/a")));
    }

    #[test]
    fn writes_are_batched_and_deduped() {
        let mut b = Batch::default();
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/s.jsonl"));
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/s.jsonl"));
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/t.jsonl"));
        assert_eq!(b.touched.len(), 2);
        assert!(!b.structural);
    }

    #[test]
    fn create_and_remove_mark_the_index_stale() {
        let mut b = Batch::default();
        b.add(ev(EventKind::Create(CreateKind::File), "/a/s.jsonl"));
        assert!(b.structural);

        let mut b = Batch::default();
        b.add(ev(EventKind::Remove(RemoveKind::File), "/a/s.jsonl"));
        assert!(b.structural);
    }

    #[test]
    fn access_events_are_ignored_entirely() {
        let mut b = Batch::default();
        b.add(ev(
            EventKind::Access(notify::event::AccessKind::Read),
            "/a/s.jsonl",
        ));
        assert!(b.touched.is_empty());
        assert!(!b.structural);
    }

    #[test]
    fn watch_errors_do_not_poison_the_batch() {
        let mut b = Batch::default();
        b.add(Err(notify::Error::generic("boom")));
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/s.jsonl"));
        assert_eq!(b.touched.len(), 1);
    }

    #[test]
    fn spawning_on_missing_roots_is_harmless() {
        let handle = spawn(&[PathBuf::from("/definitely/not/here")]);
        drop(handle);
    }
}
