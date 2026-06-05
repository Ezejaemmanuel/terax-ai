import { invoke } from "@tauri-apps/api/core";

import { useAgentStore } from "../store/agentStore";

// The first hook marker only fires on the first UserPromptSubmit, so a quiet
// window after launch is normal (the user may not have typed yet). We wait
// generously and word the log as informational, not a hard failure: we cannot
// distinguish "hook broken" from "user hasn't prompted yet" from here.
const HOOK_MARKER_TIMEOUT_MS = 30_000;

/**
 * Diagnostic breadcrumb: if no agent-status marker has arrived a while after
 * launching `claude` in a leaf, note it to disk via `agent_log` (→ terax.log)
 * with a pointer to the per-invocation hook log — so a released build is
 * debuggable from logs alone.
 *
 * Safe to call for any leaf; it only logs when nothing arrived, and the message
 * makes clear this is expected if the user simply hasn't prompted yet.
 */
export function watchForHookMarker(leafId: number): void {
  setTimeout(() => {
    // A session is registered as soon as any started/working marker arrives.
    if (useAgentStore.getState().sessions[leafId]) return;
    void invoke("agent_log", {
      level: "info",
      message:
        `no agent hook marker ${HOOK_MARKER_TIMEOUT_MS}ms after launching claude in leaf ${leafId}. ` +
        `This is normal if no prompt was submitted yet; it only indicates a problem if status ` +
        `never updates after you prompt. If broken, check ~/.cache/terax/agent-hook/terax-hooks.log ` +
        `(did the hook run?) and ensure node is on PATH`,
    }).catch(() => {});
  }, HOOK_MARKER_TIMEOUT_MS);
}
