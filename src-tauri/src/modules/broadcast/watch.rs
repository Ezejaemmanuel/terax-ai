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
/// `build_index()` re-scans and re-reads every session in every project, so it
/// is not cheap enough to run on every message of an active turn. Structural
/// changes (a session file created/removed) still refresh immediately — that's
/// rare and exactly when staleness is most visible. Plain touches (a session
/// gaining a title/cwd, or bumping its sort position) are coalesced to this
/// interval instead, which still surfaces a brand-new chat within a few
/// seconds without rebuilding the whole index on every keystroke-driven write.
const TOUCH_INDEX_REFRESH_COOLDOWN: Duration = Duration::from_secs(3);

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
    // Tracks the last touch-only index refresh so bursts of ordinary message
    // activity coalesce onto `TOUCH_INDEX_REFRESH_COOLDOWN` instead of
    // rebuilding the index on every debounce window. Lives for the thread's
    // whole run, not per-batch, since it's the throttle across batches.
    let mut last_touch_refresh: Option<Instant> = None;

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

        for path in batch.touched.iter() {
            bus::publish(BusEvent::SessionTouched {
                path: path.to_string_lossy().into_owned(),
            });
        }

        if should_refresh_index(&batch, last_touch_refresh, TOUCH_INDEX_REFRESH_COOLDOWN, Instant::now()) {
            bus::publish(BusEvent::IndexChanged);
            last_touch_refresh = Some(Instant::now());
        }
    }
}

/// A brand-new session's file is often created before it carries enough to be
/// indexed (e.g. Claude Code's jsonl has no `cwd` until the first message
/// lands, so it's filtered out of the index entirely until then). That later
/// write is a Modify, not a Create/Remove, so gating the refetch on
/// `structural` alone means the sidebar never learns the session exists once
/// it *does* become indexable — only a Create elsewhere would coincidentally
/// rescue it. Structural changes refresh right away since they're rare and
/// staleness there is most visible; plain touches are throttled by
/// `cooldown` since rebuilding the whole index on every message is not free.
fn should_refresh_index(
    batch: &Batch,
    last_touch_refresh: Option<Instant>,
    cooldown: Duration,
    now: Instant,
) -> bool {
    if batch.structural {
        return true;
    }
    if batch.touched.is_empty() {
        return false;
    }
    last_touch_refresh.is_none_or(|t| now.saturating_duration_since(t) >= cooldown)
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
            if let Some(t) = transcript_path_for(&p) {
                self.touched.insert(t);
            }
        }
    }
}

/// Maps a changed file to the transcript path `SessionMeta.path` uses, or
/// `None` for sidecars that shouldn't drive an append (`*.checkpoints.jsonl`,
/// meta.json, session_index.jsonl, ...).
///
/// Cursor is SQLite in WAL mode, so writes land on `store.db-wal`/`store.db-
/// shm`, never `store.db` itself — those get mapped back to the sibling
/// `store.db`, which is what the session index actually points at.
fn transcript_path_for(p: &Path) -> Option<PathBuf> {
    let name = p.file_name().and_then(|n| n.to_str())?;
    if name.ends_with(".jsonl") && !name.ends_with(".checkpoints.jsonl") && name != "session_index.jsonl" {
        return Some(p.to_path_buf());
    }
    if name == "store.db" || name == "store.db-wal" || name == "store.db-shm" {
        return Some(p.with_file_name("store.db"));
    }
    None
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
        home.join(".cursor").join("chats"),
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
        assert!(transcript_path_for(Path::new("/a/s.jsonl")).is_some());
        assert!(transcript_path_for(Path::new("/a/s.checkpoints.jsonl")).is_none());
        assert!(transcript_path_for(Path::new("/a/session_index.jsonl")).is_none());
        assert!(transcript_path_for(Path::new("/a/meta.json")).is_none());
        assert!(transcript_path_for(Path::new("/a")).is_none());
    }

    #[test]
    fn cursor_wal_and_shm_writes_map_back_to_store_db() {
        let wal = transcript_path_for(Path::new("/chats/h/c/store.db-wal")).expect("mapped");
        assert_eq!(wal, Path::new("/chats/h/c/store.db"));
        let shm = transcript_path_for(Path::new("/chats/h/c/store.db-shm")).expect("mapped");
        assert_eq!(shm, Path::new("/chats/h/c/store.db"));
        let direct = transcript_path_for(Path::new("/chats/h/c/store.db")).expect("mapped");
        assert_eq!(direct, Path::new("/chats/h/c/store.db"));
        assert!(transcript_path_for(Path::new("/chats/h/c/prompt_history.json")).is_none());
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
    fn structural_batches_always_refresh_the_index() {
        let mut b = Batch::default();
        b.add(ev(EventKind::Create(CreateKind::File), "/a/s.jsonl"));
        assert!(should_refresh_index(&b, None, Duration::from_secs(3), Instant::now()));
    }

    #[test]
    fn a_plain_touch_refreshes_the_index_when_never_refreshed_before() {
        // Regression: a session that just gained its `cwd` (and thus became
        // indexable) arrives as a Modify, not a Create. If only `structural`
        // batches triggered a refetch, the sidebar would never learn about it.
        let mut b = Batch::default();
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/s.jsonl"));
        assert!(!b.structural);
        assert!(should_refresh_index(&b, None, Duration::from_secs(3), Instant::now()));
    }

    #[test]
    fn a_plain_touch_is_throttled_within_the_cooldown() {
        let mut b = Batch::default();
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/s.jsonl"));
        let now = Instant::now();
        let last = now;
        assert!(
            !should_refresh_index(&b, Some(last), Duration::from_secs(3), now),
            "a touch right after the last refresh must be coalesced"
        );
    }

    #[test]
    fn a_plain_touch_refreshes_again_once_the_cooldown_elapses() {
        let mut b = Batch::default();
        b.add(ev(EventKind::Modify(ModifyKind::Any), "/a/s.jsonl"));
        let last = Instant::now();
        let later = last + Duration::from_secs(4);
        assert!(should_refresh_index(&b, Some(last), Duration::from_secs(3), later));
    }

    #[test]
    fn an_empty_batch_never_refreshes_the_index() {
        assert!(!should_refresh_index(&Batch::default(), None, Duration::from_secs(3), Instant::now()));
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
