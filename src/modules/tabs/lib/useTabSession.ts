import { getLaunchDir } from "@/lib/launchDir";
import { leafIds } from "@/modules/terminal/lib/panes";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { loadTabSession, saveTabSession, type PersistedTab } from "./tabStore";
import type { Tab } from "./useTabs";

function serializeTab(t: Tab): PersistedTab | null {
  switch (t.kind) {
    case "terminal":
      return { kind: "terminal", id: t.id, title: t.title, cwd: t.cwd, pinned: t.pinned, color: t.color };
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

  // Debounced save on every tab/activeId change (skip until first restore attempt done)
  useEffect(() => {
    if (!initialized.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const serializable = tabs
        .map(serializeTab)
        .filter(Boolean) as PersistedTab[];
      void saveTabSession({ tabs: serializable, activeId });
    }, 100);
    // Do NOT clear the timer on cleanup — let the pending save fire even if tabs
    // change again quickly. The next effect run replaces it anyway.
  }, [tabs, activeId]);

  // Final save when the window is about to close, in case the 100ms timer
  // hasn't fired yet.
  useEffect(() => {
    const handleUnload = () => {
      if (!initialized.current) return;
      const serializable = tabs
        .map(serializeTab)
        .filter(Boolean) as PersistedTab[];
      void saveTabSession({ tabs: serializable, activeId });
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [tabs, activeId]);
}
