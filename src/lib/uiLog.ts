import { invoke } from "@tauri-apps/api/core";

export type UiLogLevel = "info" | "warn" | "error";

/**
 * Log a UI breadcrumb to both the devtools console and the on-disk log
 * (terax.log via the `ui_log` command). Disk logging matters for windows
 * without a devtools shortcut (e.g. the settings window) and for diagnosing
 * issues from a released build. Best-effort: a failed invoke never throws.
 */
export function uiLog(level: UiLogLevel, message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.info(message);
  void invoke("ui_log", { level, message }).catch(() => {});
}
