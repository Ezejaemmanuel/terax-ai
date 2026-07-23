use serde::{Deserialize, Serialize};

/// Push notifications cannot go over the LAN server itself: service workers and
/// the Notification API both require a secure context, which `http://<lan-ip>`
/// is not. Routing them through ntfy also means they arrive when the phone is
/// off wifi.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NtfyConfig {
    pub enabled: bool,
    /// Base URL, e.g. `https://ntfy.sh`. Self-hosted instances work unchanged.
    pub server: String,
    pub topic: String,
}

impl NtfyConfig {
    pub fn endpoint(&self) -> Option<String> {
        if !self.enabled || self.topic.trim().is_empty() {
            return None;
        }
        let base = if self.server.trim().is_empty() {
            "https://ntfy.sh"
        } else {
            self.server.trim().trim_end_matches('/')
        };
        Some(format!("{base}/{}", self.topic.trim()))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Push {
    pub title: String,
    pub body: String,
    pub priority: &'static str,
    pub click: Option<String>,
}

/// Map an agent transition to a push, or None when it is not worth a buzz.
/// `working` and `started` fire constantly during a run and are deliberately
/// silent; only the two states that want a human are notified.
pub fn push_for(kind: &str, agent: Option<&str>, project: Option<&str>) -> Option<Push> {
    let name = agent.unwrap_or("Agent");
    let where_ = project.unwrap_or("");
    let suffix = if where_.is_empty() {
        String::new()
    } else {
        format!(" in {where_}")
    };
    match kind {
        "attention" => Some(Push {
            title: format!("{name} needs you"),
            body: format!("Waiting for approval or input{suffix}"),
            priority: "high",
            click: None,
        }),
        "finished" => Some(Push {
            title: format!("{name} finished"),
            body: format!("Turn complete{suffix}"),
            priority: "default",
            click: None,
        }),
        _ => None,
    }
}

/// Per-session debounce so a chatty agent cannot buzz a phone in a loop.
pub struct Debouncer {
    window: std::time::Duration,
    last: std::collections::HashMap<String, std::time::Instant>,
}

impl Debouncer {
    pub fn new(window: std::time::Duration) -> Self {
        Self {
            window,
            last: std::collections::HashMap::new(),
        }
    }

    pub fn allow(&mut self, key: &str, now: std::time::Instant) -> bool {
        match self.last.get(key) {
            Some(prev) if now.duration_since(*prev) < self.window => false,
            _ => {
                self.last.insert(key.to_string(), now);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn endpoint_requires_enabled_and_a_topic() {
        let mut c = NtfyConfig {
            enabled: false,
            server: String::new(),
            topic: "mine".into(),
        };
        assert_eq!(c.endpoint(), None);
        c.enabled = true;
        assert_eq!(c.endpoint().as_deref(), Some("https://ntfy.sh/mine"));
        c.topic = "  ".into();
        assert_eq!(c.endpoint(), None);
    }

    #[test]
    fn self_hosted_servers_are_normalized() {
        let c = NtfyConfig {
            enabled: true,
            server: "https://push.example.com/".into(),
            topic: "t".into(),
        };
        assert_eq!(c.endpoint().as_deref(), Some("https://push.example.com/t"));
    }

    #[test]
    fn only_attention_and_finished_notify() {
        assert!(push_for("attention", Some("Claude"), Some("terax")).is_some());
        assert!(push_for("finished", Some("Claude"), None).is_some());
        assert!(push_for("working", Some("Claude"), None).is_none());
        assert!(push_for("started", Some("Claude"), None).is_none());
        assert!(push_for("exited", Some("Claude"), None).is_none());
    }

    #[test]
    fn attention_outranks_completion() {
        let a = push_for("attention", Some("Codex"), Some("api")).expect("push");
        assert_eq!(a.priority, "high");
        assert_eq!(a.title, "Codex needs you");
        assert!(a.body.contains("in api"));

        let f = push_for("finished", None, None).expect("push");
        assert_eq!(f.priority, "default");
        assert_eq!(f.title, "Agent finished");
        assert_eq!(f.body, "Turn complete");
    }

    #[test]
    fn debounce_suppresses_repeats_within_the_window() {
        let mut d = Debouncer::new(Duration::from_secs(10));
        let t0 = Instant::now();
        assert!(d.allow("s1", t0));
        assert!(!d.allow("s1", t0 + Duration::from_secs(3)));
        assert!(d.allow("s2", t0 + Duration::from_secs(3)));
        assert!(d.allow("s1", t0 + Duration::from_secs(11)));
    }
}
