import { listen } from "@tauri-apps/api/event";
import type { LspDiagnostic } from "@/modules/ai/lib/native";
import { lspWarn } from "./log";
import { normalizeRoot, useLspStore } from "./store";

type DiagnosticsEvent = { root: string; path: string; diagnostics: LspDiagnostic[] };
type RootEvent = { root: string };

let attached = false;

/**
 * Attached the first time a project is enabled, never before: a window that
 * never turns TypeScript on registers no listeners at all. Detaching again
 * would race with a second project being enabled, so once on it stays on for
 * the life of the window.
 */
export function attachLspEvents(): void {
  if (attached) return;
  attached = true;

  void listen<DiagnosticsEvent>("lsp:diagnostics", (event) => {
    const { root, path, diagnostics } = event.payload;
    useLspStore.getState().setFileProblems(root, path, diagnostics);
  });

  void listen<RootEvent>("lsp:exited", (event) => {
    const root = normalizeRoot(event.payload.root);
    const { enabled, status, setStatus } = useLspStore.getState();
    // Only report a crash for a project the user still wants on; a normal stop
    // already cleared its entry.
    if ((enabled[root] ?? "off") === "off") return;
    lspWarn(`server for ${root} exited`);
    setStatus({
      root,
      state: "failed",
      exe: status[root]?.exe ?? null,
      error: "The TypeScript server exited. Toggle it to restart.",
      openDocuments: 0,
    });
  });
}
