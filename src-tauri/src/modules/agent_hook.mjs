// terax-hook.mjs — Terax agent-status hook (cross-platform, no shell required).
//
// Claude Code invokes this once per lifecycle event as:
//     node "<abs path>/terax-hook.mjs" <status>
// where <status> is one of: working | attention | finished.
//
// Why node instead of an sh/bash/powershell one-liner: Claude Code requires
// Node.js on every platform, so `node` is always available. The previous POSIX
// command depended on Git Bash being installed AND correctly resolved on
// Windows (it can resolve to WSL's bash, or be missing from PATH), which made
// the status tracker silently dead on many Windows machines.
//
// Behaviour:
//   1. Read the hook JSON from stdin and pull out `session_id`.
//   2. If not running inside a Terax terminal (TERAX_TERMINAL unset) -> no-op.
//   3. Otherwise print {"terminalSequence":"<OSC 777 marker>"} to stdout. The
//      Terax PTY reader (agent_detect.rs) parses that marker to drive the
//      working / waiting / finished status and to bind the Claude session id to
//      the terminal it runs in.
//   4. Append a diagnostic line to terax-hooks.log (next to this script, or
//      TERAX_HOOK_LOG_DIR if set) so failures are debuggable from a user's
//      machine after release. Logging is best-effort and never breaks the hook.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LOG_BYTES = 512 * 1024; // rotate past ~0.5 MiB so the log can't grow unbounded

// OSC 777 framing: ESC (27) ] ... BEL (7). Built from char codes so the source
// stays free of raw control bytes; JSON.stringify re-escapes them on the wire.
const OSC_INTRO = String.fromCharCode(27) + "]";
const OSC_END = String.fromCharCode(7);

const status = process.argv[2] || "unknown";

function logDir() {
  const override = process.env.TERAX_HOOK_LOG_DIR;
  if (override && override.trim()) return override;
  return dirname(fileURLToPath(import.meta.url));
}

function logFilePath() {
  return join(logDir(), "terax-hooks.log");
}

// Best-effort append with crude size-based rotation. Any failure is swallowed:
// a broken log must never prevent the OSC marker from being emitted.
function log(fields) {
  try {
    const dir = logDir();
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
    const p = logFilePath();
    try {
      if (statSync(p).size > MAX_LOG_BYTES) renameSync(p, `${p}.1`);
    } catch {}
    appendFileSync(p, `${new Date().toISOString()} ${fields}\n`);
  } catch {}
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("error", (err) => {
  log(`status=${status} stdin_error=${String(err)}`);
  process.exit(0);
});
process.stdin.on("end", () => {
  let sid = "";
  try {
    sid = (JSON.parse(raw) || {}).session_id || "";
  } catch (err) {
    log(`status=${status} parse_error=${String(err)} stdin_len=${raw.length}`);
  }

  const inTerax = Boolean(process.env.TERAX_TERMINAL);
  if (!inTerax) {
    // Not a Terax terminal (e.g. the user runs claude in another terminal that
    // shares ~/.claude/settings.json). Stay silent so we don't pollute output.
    log(`status=${status} sid=${sid} terax=0 emitted=0 skipped=not-terax`);
    process.exit(0);
  }

  const marker = `${OSC_INTRO}777;notify;Terax;${status};${sid}${OSC_END}`;
  try {
    process.stdout.write(JSON.stringify({ terminalSequence: marker }));
  } catch (err) {
    log(`status=${status} sid=${sid} terax=1 emitted=0 stdout_error=${String(err)}`);
    process.exit(0);
  }
  log(
    `status=${status} sid=${sid} terax=1 emitted=1 pid=${process.pid} cwd=${process.cwd()}`,
  );
  process.exit(0);
});
