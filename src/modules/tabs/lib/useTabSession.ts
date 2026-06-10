import { getLaunchDir } from "@/lib/launchDir";
import { leafIds } from "@/modules/terminal/lib/panes";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { loadTabSession, saveTabSession, type PersistedTab } from "./tabStore";
import type { Tab } from "./useTabs";

const PERIODIC_SAVE_MS = 20_000;

function serializeTab(t: Tab): PersistedTab | null {
  switch (t.kind) {
    case "terminal":
      return { kind: "terminal", id: t.id, title: t.title, cwd: t.cwd, pinned: t.pinned, color: t.color, claudeSession: t.claudeSession, claudeSessionId: t.claudeSessionId, commandCodeSession: t.commandCodeSession, commandCodeSessionTitle: t.commandCodeSessionTitle };
    case "editor":
      return { kind: "editor", id: t.id, title: t.title, path: t.path, pinned: t.pinned, color: t.color };
    case "preview":
      return { kind: "preview", id: t.id, title: t.title, url: t.url, pinned: t.pinned, color: t.color };
    case "markdown":
      return { kind: "markdown", id: t.id, title: t.title, path: t.path, pinned: t.pinned, color: t.color };
    default:
      // ai-diff, git-diff, git-history, git-commit-file are transient — do not save
      return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return invoke("fs_stat", { path, workspace: null })
    .then(() => true)
    .catch(() => false);
}

function buildTabFromPersisted(p: PersistedTab, nextId: () => number): Tab {
  switch (p.kind) {
    case "terminal": {
      const leafId = nextId();
      return {
        id: p.id,
        kind: "terminal",
        title: p.title,
        cwd: p.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: p.cwd },
        activeLeafId: leafId,
        pinned: p.pinned,
        color: p.color,
        claudeSession: p.claudeSession,
        claudeSessionId: p.claudeSessionId,
        commandCodeSession: p.commandCodeSession,
        commandCodeSessionTitle: p.commandCodeSessionTitle,
      };
    }
    case "editor":
      return {
        id: p.id,
        kind: "editor",
        title: p.title,
        path: p.path!,
        dirty: false,
        preview: false,
        pinned: p.pinned,
        color: p.color,
      };
    case "preview":
      return {
        id: p.id,
        kind: "preview",
        title: p.title,
        url: p.url!,
        pinned: p.pinned,
        color: p.color,
      };
    case "markdown":
      return {
        id: p.id,
        kind: "markdown",
        title: p.title,
        path: p.path!,
        pinned: p.pinned,
        color: p.color,
      };
  }
}

export function useTabSession(
  tabs: Tab[],
  activeId: number,
  initFromSession: (tabs: Tab[], activeId: number, nextId: number) => void,
) {
  const initialized = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One-time restore on mount
  useEffect(() => {
    if (initialized.current) return;
    // If app was launched with a specific directory via CLI arg, skip restore
    if (getLaunchDir()) {
      initialized.current = true;
      return;
    }
    loadTabSession().then((saved) => {
      initialized.current = true;
      if (!saved || !saved.tabs.length) return;

      // We need leaf IDs for terminal tabs that don't conflict with tab IDs
      // Collect max existing id so we can assign fresh leaf IDs above it
      const maxTabId = Math.max(...saved.tabs.map((t) => t.id), 0);
      let leafCounter = maxTabId;
      const nextLeafId = () => ++leafCounter;

      Promise.all(
        saved.tabs.map(async (p): Promise<Tab | null> => {
          // Validate file-backed tabs still exist on disk
          if ((p.kind === "editor" || p.kind === "markdown") && p.path) {
            const ok = await fileExists(p.path);
            if (!ok) return null;
          }
          return buildTabFromPersisted(p, nextLeafId);
        }),
      ).then((results) => {
        const valid = results.filter(Boolean) as Tab[];
        if (!valid.length) return;
        const restoredActiveId =
          valid.find((t) => t.id === saved.activeId)?.id ?? valid[0].id;
        // Compute the correct nextIdRef: above all tab IDs and all leaf IDs
        const allIds = valid.flatMap((t) =>
          t.kind === "terminal" ? [t.id, ...leafIds(t.paneTree)] : [t.id],
        );
        const nextId = Math.max(...allIds, leafCounter) + 1;
        initFromSession(valid, restoredActiveId, nextId);
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a ref to the latest tabs/activeId so the close handler and interval
  // always read current values without re-registering their listeners.
  const latestTabs = useRef(tabs);
  const latestActiveId = useRef(activeId);
  useEffect(() => {
    latestTabs.current = tabs;
    latestActiveId.current = activeId;
  }, [tabs, activeId]);

  // dirty=true as soon as initialization is done AND tabs/activeId change.
  // Note: the flag is set unconditionally once initialized — even during the
  // render cycle that delivers the restored state — so that first-launch saves
  // are also captured correctly.
  const dirty = useRef(false);
  useEffect(() => {
    // Mark dirty as soon as the initialization effect has completed (even if
    // initialized.current was just set to true on this same render cycle).
    // We use a microtask so that the initialized.current assignment in the
    // restore effect (which runs in the same React flush) is visible first.
    Promise.resolve().then(() => {
      if (initialized.current) dirty.current = true;
    });
  }, [tabs, activeId]);

  // Helper: serialise current state and save with a 3-second safety timeout.
  // The timeout ensures the close handler never hangs the window indefinitely
  // if the Tauri IPC stalls (disk full, backend busy, etc.).
  const flushSave = () => {
    const serializable = latestTabs.current
      .map(serializeTab)
      .filter(Boolean) as PersistedTab[];
    const save = saveTabSession({ tabs: serializable, activeId: latestActiveId.current });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    // Race — if save wins, great. If timeout wins, we proceed without blocking.
    return Promise.race([save, timeout]);
  };

  // Layer 1 — debounced save (100ms) on every tab/activeId change.
  useEffect(() => {
    if (!initialized.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      dirty.current = false;
      void flushSave();
    }, 100);
  }, [tabs, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Layer 2 — periodic checkpoint every 20 seconds.
  // Only writes if something actually changed (dirty flag), so idle sessions
  // generate zero IPC calls.
  useEffect(() => {
    const id = setInterval(() => {
      if (!initialized.current || !dirty.current) return;
      dirty.current = false;
      void flushSave();
    }, PERIODIC_SAVE_MS);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Layer 3 — guaranteed save on graceful close (X button, Alt+F4).
  // The 3-second timeout inside flushSave ensures the window always closes
  // even if the IPC stalls.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onCloseRequested((event) => {
      // win.close() re-emits CloseRequested, so guard against re-entrancy.
      if ((win as unknown as { _teraxClosing?: boolean })._teraxClosing) return;
      (win as unknown as { _teraxClosing?: boolean })._teraxClosing = true;
      event.preventDefault();
      console.log("[terax] close requested — saving tabs");
      void flushSave()
        .catch((e) => console.warn("[terax] flushSave failed:", e))
        .finally(() => {
          console.log("[terax] save done — destroying window");
          // Use destroy() not close(): close() re-fires CloseRequested
          // causing an infinite loop that prevents the window from closing.
          // Requires the core:window:allow-destroy capability.
          win.destroy().catch((e) => {
            console.error("[terax] window.destroy() failed:", e);
            // Last-ditch fallback: exit the whole process.
            void invoke("exit_app").catch(() => {});
          });
        });
    });
    // Clean up on page unload — not on component unmount — to avoid
    // a known Tauri bug where calling unlisten() breaks window closing.
    const cleanup = () => { void unlistenPromise.then((fn) => fn()); };
    window.addEventListener("unload", cleanup);
    return () => window.removeEventListener("unload", cleanup);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
