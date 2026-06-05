use std::path::PathBuf;

use serde_json::{json, Value};

const HOOK_EVENTS: [(&str, &str); 3] = [
    ("UserPromptSubmit", "working"),
    ("Notification", "attention"),
    ("Stop", "finished"),
];

// The cross-platform Node hook, embedded at build time and written to disk on
// install. See agent_hook.mjs for why we no longer use an sh/bash one-liner.
const HOOK_SCRIPT: &str = include_str!("agent_hook.mjs");
const HOOK_SCRIPT_NAME: &str = "terax-hook.mjs";

// Substrings that identify a hook command as ours, across every generation:
//   - "terax-hook.mjs"  current Node hook
//   - "notify;Terax;"   the v2.1.139+ `terminalSequence` sh one-liner
//   - "terax;notify"    the pre-v2.1.139 /dev/tty variant
// Re-running install detects any of these and migrates them to the Node hook.
const OWNED_MARKERS: [&str; 3] = [HOOK_SCRIPT_NAME, "notify;Terax;", "terax;notify"];

// Command Claude Code runs for each event: invoke Node directly so we don't
// depend on which shell (cmd/bash/Git Bash/WSL) executes the command line.
// `node_cmd` is the (already-quoted, if needed) node invocation — either an
// absolute resolved path or bare `node`. `script_fwd` is the absolute script
// path with forward slashes — Node accepts those on Windows and they survive
// Git Bash, which still parses the command string.
fn hook_cmd(node_cmd: &str, status: &str, script_fwd: &str) -> String {
    format!(r#"{node_cmd} "{script_fwd}" {status}"#)
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// True only for the *current* Node hook. Used by the status check so we report
// "ready" based on the mechanism that actually works on this platform, not a
// stale sh hook that happens to still be in the file.
fn is_node_hook(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(HOOK_SCRIPT_NAME))
            })
        })
}

// A group with no hooks is inert cruft (e.g. left behind when someone deletes
// our command but not its wrapper). Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value, node_cmd: &str, script_fwd: &str) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, status) in HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        arr.push(json!({
            "hooks": [ { "type": "command", "command": hook_cmd(node_cmd, status, script_fwd) } ]
        }));
    }
    root
}

// Resolve the node invocation embedded in the hook command. Prefer an absolute,
// resolved path (more robust when Claude Code's hook shell has a narrower PATH
// than Terax) and fall back to bare `node`. The result is shell-ready: an
// absolute path is quoted (it can contain spaces, e.g. "Program Files"); bare
// `node` is returned unquoted. Forward slashes keep it valid under Git Bash.
fn resolve_node_cmd() -> String {
    match node_on_path() {
        Some(n) => {
            let fwd = n.to_string_lossy().replace('\\', "/");
            log::info!("[agent] node resolved on Terax PATH: {fwd}");
            format!(r#""{fwd}""#)
        }
        None => {
            log::warn!(
                "[agent] node NOT found on Terax's PATH; hook will use bare `node`, relying on \
                 Claude Code's shell PATH. If status tracking stays dead, install Node.js and \
                 ensure `node` is on PATH."
            );
            "node".to_string()
        }
    }
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!("{} is not valid JSON ({e}); refusing to overwrite", path.display())
        }),
        _ => Ok(json!({})),
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".claude")
        .join("settings.json"))
}

fn hook_script_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".cache")
        .join("terax")
        .join("agent-hook")
        .join(HOOK_SCRIPT_NAME))
}

// Write the embedded hook script to disk (atomic, only when changed) and return
// its path. Lives under ~/.cache/terax/agent-hook/; the runtime hook log
// (terax-hooks.log) lands alongside it.
fn write_hook_script() -> Result<PathBuf, String> {
    let path = hook_script_path()?;
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing == HOOK_SCRIPT {
            return Ok(path);
        }
    }
    let tmp = path.with_extension("mjs.terax-tmp");
    std::fs::write(&tmp, HOOK_SCRIPT).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })?;
    Ok(path)
}

// Best-effort probe of whether `node` is reachable from Terax's own PATH. This
// is only a diagnostic: the hook actually runs in Claude Code's shell, which may
// have a different PATH — but if node is missing here it is a strong hint why
// the tracker is dead, so we log it loudly.
fn node_on_path() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for n in names {
            let candidate = dir.join(n);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[tauri::command]
pub fn agent_enable_claude_hooks() -> Result<(), String> {
    let path = settings_path()?;
    log::info!("[agent] enabling Claude hooks; settings file: {}", path.display());

    // 1. Materialize the Node hook script on disk.
    let script = match write_hook_script() {
        Ok(p) => p,
        Err(e) => {
            log::error!("[agent] failed to write hook script: {e}");
            return Err(e);
        }
    };
    let script_fwd = script.to_string_lossy().replace('\\', "/");
    log::info!("[agent] hook script ready: {}", script.display());
    if let Some(dir) = script.parent() {
        log::info!(
            "[agent] runtime hook log (per-invocation): {}",
            dir.join("terax-hooks.log").display()
        );
    }

    // 2. Resolve the node invocation (absolute path when we can find it; bare
    //    `node` otherwise). Logs whether node was found on Terax's PATH.
    let node_cmd = resolve_node_cmd();

    // 3. Merge our three hooks into ~/.claude/settings.json.
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| {
        log::error!("[agent] create {} failed: {e}", dir.display());
        format!("create {}: {e}", dir.display())
    })?;

    let (existed, existing) = match std::fs::read_to_string(&path) {
        Ok(s) => (true, existing_config(Some(&s), &path)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, json!({})),
        Err(e) => {
            log::error!("[agent] read {} failed: {e}", path.display());
            return Err(format!("read {}: {e}", path.display()));
        }
    };
    log::info!(
        "[agent] settings.json {}",
        if existed { "exists; merging hooks" } else { "absent; creating fresh" }
    );

    let merged = merge_hooks(existing, &node_cmd, &script_fwd);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;

    // Write to a sibling temp file then rename so a crash mid-write can't leave
    // a truncated settings.json.
    let tmp = path.with_extension("json.terax-tmp");
    std::fs::write(&tmp, out).map_err(|e| {
        log::error!("[agent] write {} failed: {e}", tmp.display());
        format!("write {}: {e}", tmp.display())
    })?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        log::error!("[agent] rename into {} failed: {e}", path.display());
        format!("rename into {}: {e}", path.display())
    })?;
    log::info!(
        "[agent] Claude hooks installed (UserPromptSubmit/Notification/Stop -> node {HOOK_SCRIPT_NAME})"
    );
    Ok(())
}

#[tauri::command]
pub fn agent_claude_hooks_status() -> bool {
    let Some(content) = settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    HOOK_EVENTS.iter().all(|(event, _)| {
        root.get("hooks")
            .and_then(|h| h.get(event))
            .and_then(Value::as_array)
            .is_some_and(|groups| groups.iter().any(is_node_hook))
    })
}

/// Bridge so the frontend can write diagnostics into the same on-disk log file
/// (`terax.log`) as the Rust side — used by the launch watchdog when a hook
/// marker never arrives. Keeps all agent-tracking breadcrumbs in one place.
#[tauri::command]
pub fn agent_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[agent/ui] {message}"),
        "warn" => log::warn!("[agent/ui] {message}"),
        _ => log::info!("[agent/ui] {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "/home/u/.cache/terax/agent-hook/terax-hook.mjs";
    const NODE: &str = "node";

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}), NODE, SCRIPT);
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        // Node invocation, not an sh one-liner.
        assert!(command(&out, "Notification", 0).contains("terax-hook.mjs"));
        assert!(command(&out, "Notification", 0).starts_with("node "));
        assert!(command(&out, "Notification", 0).ends_with(" attention"));
        assert!(command(&out, "Stop", 0).ends_with(" finished"));
        assert!(command(&out, "UserPromptSubmit", 0).ends_with(" working"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn is_idempotent() {
        let once = merge_hooks(json!({}), NODE, SCRIPT);
        let twice = merge_hooks(once.clone(), NODE, SCRIPT);
        assert_eq!(once, twice);
        assert_eq!(hook_count(&twice, "Notification"), 1);
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$TERAX_TERMINAL\" ] && printf '\\033]777;terax;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy, NODE, SCRIPT);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terax-hook.mjs"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    #[test]
    fn migrates_legacy_sh_terminalsequence_hook() {
        let legacy = json!({
            "hooks": {
                "Stop": [
                    { "hooks": [ {
                        "type": "command",
                        "command": r#"[ -n "$TERAX_TERMINAL" ] || exit 0; printf '{"terminalSequence":"\\u001b]777;notify;Terax;finished;%s\\u0007"}' "x""#
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy, NODE, SCRIPT);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Stop", 0).contains("terax-hook.mjs"));
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input, NODE, SCRIPT);
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn replaces_non_object_root() {
        let out = merge_hooks(json!("garbage"), NODE, SCRIPT);
        assert_eq!(hook_count(&out, "Notification"), 1);
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_cmd(NODE, "attention", SCRIPT) } ] }
                ]
            }
        });
        let out = merge_hooks(input, NODE, SCRIPT);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terax-hook.mjs"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }
}
