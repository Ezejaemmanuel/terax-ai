import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

// Every language-server call used to fail silently, which made a dead server
// and a healthy one look identical. These go to the devtools console and to
// the same terax.log the Rust side writes, so one file explains a bad session.

function text(parts: unknown[]): string {
  return parts
    .map((part) => (part instanceof Error ? part.message : String(part)))
    .join(" ");
}

export function lspInfo(...parts: unknown[]): void {
  const line = text(parts);
  console.info("[lsp]", line);
  void logInfo(`[lsp] ${line}`).catch(() => {});
}

export function lspWarn(...parts: unknown[]): void {
  const line = text(parts);
  console.warn("[lsp]", line);
  void logWarn(`[lsp] ${line}`).catch(() => {});
}

export function lspError(...parts: unknown[]): void {
  const line = text(parts);
  console.error("[lsp]", line);
  void logError(`[lsp] ${line}`).catch(() => {});
}
