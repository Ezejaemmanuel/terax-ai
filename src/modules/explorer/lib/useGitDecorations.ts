import { CASE_INSENSITIVE_FS } from "@/lib/platform";
import type { SourceControlSummary } from "@/modules/source-control";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildDecorationMap,
  normalizePath,
  type GitDecoration,
} from "./gitDecoration";
import { listenFsChanged } from "./watch";

// Git spawns a process per status read, so coalesce bursts of file-watcher
// events (e.g. a save that touches several files) into one refresh.
const REFRESH_DEBOUNCE_MS = 400;

export type GitDecorations = {
  decorationFor: (path: string) => GitDecoration | undefined;
  refreshGit: () => void;
};

/**
 * Exposes a per-path git decoration lookup for the file tree, driven by the
 * single app-wide {@link SourceControlSummary} that also feeds the Source
 * Control panel and the status-bar badge. Sharing that one instance means the
 * tree, panel, and badge always render the same snapshot — staging/committing
 * in the panel updates the tree, and the tree's file-watcher refresh updates
 * the panel — without spawning a second `git status` pipeline.
 */
export function useGitDecorations(
  sourceControl: SourceControlSummary,
): GitDecorations {
  const { status, refresh } = sourceControl;

  // Reuse decoration object identity for unchanged paths across refreshes, so
  // the memoized EntryRow can bail out instead of re-rendering every visible
  // row on each (debounced) status refresh.
  const prevDecorationsRef = useRef<Map<string, GitDecoration>>(new Map());
  const decorations = useMemo(() => {
    const next = status
      ? buildDecorationMap(status.repoRoot, status.changedFiles, CASE_INSENSITIVE_FS)
      : new Map<string, GitDecoration>();
    const prev = prevDecorationsRef.current;
    for (const [key, value] of next) {
      const old = prev.get(key);
      if (
        old &&
        old.status === value.status &&
        old.badge === value.badge &&
        old.isDir === value.isDir
      ) {
        next.set(key, old);
      }
    }
    prevDecorationsRef.current = next;
    return next;
  }, [status]);

  // Keep a stable ref to refresh so the watcher effect subscribes once and
  // never re-binds when refresh's identity changes (it depends on contextPath).
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Only refresh on file changes when we're actually inside a repo, so churn in
  // a non-git workspace doesn't spawn git.
  const hasRepoRef = useRef(sourceControl.hasRepo);
  useEffect(() => {
    hasRepoRef.current = sourceControl.hasRepo;
  }, [sourceControl.hasRepo]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;

    void listenFsChanged(() => {
      if (!hasRepoRef.current) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshRef.current({ remote: "never" });
      }, REFRESH_DEBOUNCE_MS);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  const decorationFor = useCallback(
    (path: string): GitDecoration | undefined =>
      decorations.get(normalizePath(path, CASE_INSENSITIVE_FS)),
    [decorations],
  );

  const refreshGit = useCallback(() => {
    void refreshRef.current({ remote: "never" });
  }, []);

  return { decorationFor, refreshGit };
}
